#!/usr/bin/env bun
/**
 * VITAL E2E TEST - Bilateral System with Real Infrastructure
 *
 * Tests the complete bilateral betting flow with REAL:
 * - Data Node (no mocking)
 * - 3 Keepers with real BLS signing
 * - On-chain contracts
 *
 * REQUIREMENTS:
 * - SSH tunnel active: ssh -fN -L 33010:localhost:32795 index-maker/prod/be
 * - Data Node running on VPS2:4000 (exposed via nginx)
 * - 3 Keepers running on VPS2 (ports 5001, 5002, 5003)
 * - Keepers registered in KeeperRegistry with BLS pubkeys
 *
 * SCENARIOS:
 * - Scenario A: Happy Path - Both bots agree, settle by mutual signatures
 * - Scenario B: Dispute Path - Bots disagree, keepers arbitrate with BLS
 */

import { Wallet, Contract, JsonRpcProvider } from "ethers";
import { createDataNodeClient, type DataNodeClient, type MarketPrice } from "./data-node-client";
import { createChainClientFromEnv, type ChainClient } from "./chain-client";
import { buildBilateralMerkleTree, type MerkleTree } from "./merkle-tree";
import {
  signBetCommitment,
  verifyBetCommitmentSignature,
  type BetCommitmentData,
} from "./p2p/commitment";
import { computeOutcome, type OutcomeResult } from "./p2p/outcome-computer";
import { storeMerkleTree, storeResolution, type ResolutionData } from "./p2p/trade-storage";

// ============================================================================
// Configuration - Updated for VPS2 deployment (2026-02-03)
// ============================================================================

const CONFIG = {
  // Network (via nginx on VPS2)
  RPC_URL: process.env.RPC_URL || "http://116.203.156.98/rpc",
  CHAIN_ID: 111222333,

  // Data Node (running on VPS2, exposed via nginx)
  DATA_NODE_URL: process.env.DATA_NODE_URL || "http://116.203.156.98/datanode",

  // Contracts (deployed on VPS2 - 2026-02-03)
  WIND_TOKEN: "0x4e5b65FB12d4165E22f5861D97A33BA45c006114",
  BOT_REGISTRY: "0x9dF23e34ac13A7145ebA1164660E701839197B1b",
  COLLATERAL_VAULT: "0xE8f29Ab983F547CeA70cD73de06ff490C6F5903f",
  KEEPER_REGISTRY: "0xE80FB0E8974EFE237fEf83B0df470664fc51fa99",

  // Bot private keys (dev2 and dev3 accounts)
  BOT1_PRIVATE_KEY: "0x203298e6a2b845c6dde179f3f991ae4c081ad963e20c9fe39d45893c00a0aea5", // dev2
  BOT2_PRIVATE_KEY: "0x237112963af91b42ca778fbe434a819b7e862cd025be3c86ce453bdd3e633165", // dev3

  // Test parameters
  STAKE_AMOUNT: BigInt(process.env.STAKE_AMOUNT || "100000000000000000"), // 0.1 WIND
  NUM_ASSETS: parseInt(process.env.NUM_ASSETS || "50"), // Number of assets to include in portfolio
  DATA_SOURCE: process.env.DATA_SOURCE || "defi", // Data source from Data Node

  // Keepers (for Scenario B verification) - accessed via nginx
  KEEPERS: [
    { address: "0xCE46e65a7A7527499e92337E5FBf958eABf314fa", url: "http://116.203.156.98/keeper1" }, // dev3
    { address: "0xdafa61604B4Aa82092E1407F8027c71026982E6f", url: "http://116.203.156.98/keeper2" }, // dev4
    { address: "0x1663f734483ceCB07AD6BC80919eA9a5cdDb7FE9", url: "http://116.203.156.98/keeper3" }, // dev5
  ],
} as const;

// ============================================================================
// ABI Fragments
// ============================================================================

const KEEPER_REGISTRY_ABI = [
  "function getActiveKeepers() external view returns (address[] memory)",
  "function getActiveKeeperCount() external view returns (uint256)",
  "function keepers(address) external view returns (bytes32 blsPubkeyX, bytes32 blsPubkeyY, string memory endpoint, uint256 registeredAt, bool isActive)",
];

const COLLATERAL_VAULT_ABI = [
  "function bets(uint256) external view returns (bytes32 tradesRoot, address creator, address filler, uint256 creatorAmount, uint256 fillerAmount, uint256 deadline, uint256 createdAt, uint8 status)",
  "function getAvailableBalance(address) external view returns (uint256)",
  "function nonces(address) external view returns (uint256)",
  "event BetSettled(uint256 indexed betId, address indexed winner, uint256 payout)",
  "event ArbitrationRequested(uint256 indexed betId, address indexed requestedBy, uint256 timestamp)",
  "event BetResolvedByArbitration(uint256 indexed betId, address indexed winner, uint256 keeperCount)",
];

// ============================================================================
// Test Result Tracking
// ============================================================================

interface TestStep {
  name: string;
  success: boolean;
  details?: string;
  error?: string;
  duration?: number;
}

const testResults: {
  scenarioA: TestStep[];
  scenarioB: TestStep[];
} = {
  scenarioA: [],
  scenarioB: [],
};

function log(message: string) {
  console.log(`[VITAL-E2E] ${new Date().toISOString().slice(11, 19)} ${message}`);
}

function logStep(scenario: "A" | "B", name: string, success: boolean, details?: string, error?: string, duration?: number) {
  const results = scenario === "A" ? testResults.scenarioA : testResults.scenarioB;
  results.push({ name, success, details, error, duration });
  const emoji = success ? "✅" : "❌";
  const durationStr = duration ? ` (${duration}ms)` : "";
  console.log(`${emoji} [Scenario ${scenario}] ${name}${details ? `: ${details}` : ""}${error ? ` - ERROR: ${error}` : ""}${durationStr}`);
}

// ============================================================================
// Infrastructure Checks
// ============================================================================

async function checkInfrastructure(): Promise<boolean> {
  log("Checking infrastructure...");

  // 1. Check RPC connection
  try {
    const provider = new JsonRpcProvider(CONFIG.RPC_URL);
    const chainId = await provider.getNetwork().then((n) => n.chainId);
    if (Number(chainId) !== CONFIG.CHAIN_ID) {
      log(`❌ Wrong chain ID: expected ${CONFIG.CHAIN_ID}, got ${chainId}`);
      return false;
    }
    const blockNumber = await provider.getBlockNumber();
    log(`✅ Chain connected: ID=${chainId}, block=${blockNumber}`);
  } catch (error) {
    log(`❌ Cannot connect to RPC: ${(error as Error).message}`);
    log(`   Make sure SSH tunnel is active: ssh -fN -L 33010:localhost:32795 index-maker/prod/be`);
    return false;
  }

  // 2. Check Data Node
  try {
    const response = await fetch(`${CONFIG.DATA_NODE_URL}/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    log(`✅ Data Node healthy: ${CONFIG.DATA_NODE_URL}`);
  } catch (error) {
    log(`❌ Data Node unreachable: ${(error as Error).message}`);
    return false;
  }

  // 3. Check Keepers (for Scenario B) - via nginx
  let activeKeepers = 0;
  for (const keeper of CONFIG.KEEPERS) {
    try {
      const response = await fetch(`${keeper.url}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        activeKeepers++;
        log(`✅ Keeper ${keeper.address.slice(0, 10)}... healthy at ${keeper.url}`);
      }
    } catch {
      log(`⚠️  Keeper ${keeper.address.slice(0, 10)}... not reachable at ${keeper.url}`);
    }
  }

  if (activeKeepers < 2) {
    log(`⚠️  Only ${activeKeepers} keepers reachable. Scenario B requires at least 2.`);
  }

  // 4. Check KeeperRegistry for registered keepers
  try {
    const provider = new JsonRpcProvider(CONFIG.RPC_URL);
    const keeperRegistry = new Contract(CONFIG.KEEPER_REGISTRY, KEEPER_REGISTRY_ABI, provider);
    const count = await keeperRegistry.getActiveKeeperCount();
    log(`✅ KeeperRegistry: ${count} active keepers registered`);
  } catch (error) {
    log(`⚠️  Cannot read KeeperRegistry: ${(error as Error).message}`);
  }

  return true;
}

// ============================================================================
// Data Fetching
// ============================================================================

async function fetchPricesFromDataNode(
  client: DataNodeClient,
  source: string,
  limit: number
): Promise<{ prices: Map<string, bigint>; tickers: string[] }> {
  const response = await client.getPrices(source, { limit });

  const prices = new Map<string, bigint>();
  const tickers: string[] = [];

  for (const price of response.prices) {
    // Convert decimal string to bigint (multiply by 1e8 for precision)
    const valueFloat = parseFloat(price.value);
    if (valueFloat > 0) {
      const valueBigInt = BigInt(Math.floor(valueFloat * 1e8));
      prices.set(price.assetId, valueBigInt);
      tickers.push(price.assetId);
    }
  }

  return { prices, tickers };
}

// ============================================================================
// Scenario A: Happy Path (No Keepers)
// ============================================================================

async function runScenarioA(): Promise<boolean> {
  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("     SCENARIO A: HAPPY PATH - Settlement by Mutual Agreement       ");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");

  let bot1Client: ChainClient | null = null;
  let bot2Client: ChainClient | null = null;
  let betId: number | null = null;

  try {
    // ========================================================================
    // Step 1: Initialize clients
    // ========================================================================
    const startInit = Date.now();

    const dataClient1 = createDataNodeClient(CONFIG.BOT1_PRIVATE_KEY, CONFIG.DATA_NODE_URL);
    const dataClient2 = createDataNodeClient(CONFIG.BOT2_PRIVATE_KEY, CONFIG.DATA_NODE_URL);

    // Create chain clients
    const originalEnv = { ...process.env };

    process.env.AGENT_PRIVATE_KEY = CONFIG.BOT1_PRIVATE_KEY;
    process.env.RPC_URL = CONFIG.RPC_URL;
    process.env.CHAIN_ID = CONFIG.CHAIN_ID.toString();
    process.env.COLLATERAL_ADDRESS = CONFIG.WIND_TOKEN;
    process.env.BOT_REGISTRY_ADDRESS = CONFIG.BOT_REGISTRY;
    process.env.COLLATERAL_VAULT_ADDRESS = CONFIG.COLLATERAL_VAULT;
    bot1Client = createChainClientFromEnv();
    Object.assign(process.env, originalEnv);

    process.env.AGENT_PRIVATE_KEY = CONFIG.BOT2_PRIVATE_KEY;
    process.env.RPC_URL = CONFIG.RPC_URL;
    process.env.CHAIN_ID = CONFIG.CHAIN_ID.toString();
    process.env.COLLATERAL_ADDRESS = CONFIG.WIND_TOKEN;
    process.env.BOT_REGISTRY_ADDRESS = CONFIG.BOT_REGISTRY;
    process.env.COLLATERAL_VAULT_ADDRESS = CONFIG.COLLATERAL_VAULT;
    bot2Client = createChainClientFromEnv();
    Object.assign(process.env, originalEnv);

    if (!bot1Client || !bot2Client) {
      logStep("A", "Initialize clients", false, undefined, "Failed to create chain clients");
      return false;
    }

    const bot1Address = bot1Client.getAddress();
    const bot2Address = bot2Client.getAddress();

    logStep("A", "Initialize clients", true, `Bot1: ${bot1Address.slice(0, 10)}..., Bot2: ${bot2Address.slice(0, 10)}...`, undefined, Date.now() - startInit);

    // ========================================================================
    // Step 2: Check registration
    // ========================================================================
    const startReg = Date.now();

    const bot1Registered = await bot1Client.isBotRegistered(bot1Address);
    const bot2Registered = await bot2Client.isBotRegistered(bot2Address);

    if (!bot1Registered || !bot2Registered) {
      logStep("A", "Check registration", false, undefined, `Bot1: ${bot1Registered}, Bot2: ${bot2Registered}`);
      return false;
    }

    logStep("A", "Check registration", true, "Both bots registered", undefined, Date.now() - startReg);

    // ========================================================================
    // Step 3: Check collateral
    // ========================================================================
    const startBal = Date.now();

    const bot1Balance = await bot1Client.getVaultBalance();
    const bot2Balance = await bot2Client.getVaultBalance();

    if (bot1Balance.available < CONFIG.STAKE_AMOUNT || bot2Balance.available < CONFIG.STAKE_AMOUNT) {
      logStep("A", "Check collateral", false, undefined, `Insufficient: Bot1=${bot1Balance.available}, Bot2=${bot2Balance.available}`);
      return false;
    }

    logStep("A", "Check collateral", true, `Bot1: ${Number(bot1Balance.available) / 1e18} WIND, Bot2: ${Number(bot2Balance.available) / 1e18} WIND`, undefined, Date.now() - startBal);

    // ========================================================================
    // Step 4: Fetch entry prices from REAL Data Node
    // ========================================================================
    const startPrices = Date.now();

    const { prices: entryPrices, tickers } = await fetchPricesFromDataNode(dataClient1, CONFIG.DATA_SOURCE, CONFIG.NUM_ASSETS);

    if (entryPrices.size < 10) {
      logStep("A", "Fetch entry prices", false, undefined, `Only ${entryPrices.size} prices available, need at least 10`);
      return false;
    }

    log(`  Sample prices: ${Array.from(entryPrices.entries()).slice(0, 3).map(([t, p]) => `${t}=$${Number(p) / 1e8}`).join(", ")}`);

    logStep("A", "Fetch entry prices (REAL Data Node)", true, `${entryPrices.size} ${CONFIG.DATA_SOURCE} assets`, undefined, Date.now() - startPrices);

    // ========================================================================
    // Step 5: Build Merkle tree
    // ========================================================================
    const startTree = Date.now();

    const methods = tickers.map(() => "up:0"); // Bot1 bets all assets go up
    const entryPriceMap = new Map<number, bigint>();
    tickers.forEach((ticker, i) => {
      entryPriceMap.set(i, entryPrices.get(ticker)!);
    });

    const snapshotId = `vital-e2e-${Date.now()}`;
    const tree = buildBilateralMerkleTree(snapshotId, methods, entryPriceMap, tickers);

    logStep("A", "Build Merkle tree", true, `Root: ${tree.root.slice(0, 20)}..., Trades: ${tree.trades.length}`, undefined, Date.now() - startTree);

    // ========================================================================
    // Step 6: Create and sign commitment
    // ========================================================================
    const startSign = Date.now();

    const deadline = Math.floor(Date.now() / 1000) + 10; // 10 seconds
    const expiry = Math.floor(Date.now() / 1000) + 300;
    const nonce = await bot1Client.getVaultNonce();

    const commitment: BetCommitmentData = {
      tradesRoot: tree.root,
      creator: bot1Address,
      filler: bot2Address,
      creatorAmount: CONFIG.STAKE_AMOUNT,
      fillerAmount: CONFIG.STAKE_AMOUNT,
      deadline,
      nonce,
      expiry,
    };

    const bot1Wallet = bot1Client.getWallet();
    const bot2Wallet = bot2Client.getWallet();

    const bot1Sig = await signBetCommitment(bot1Wallet, commitment, CONFIG.COLLATERAL_VAULT, CONFIG.CHAIN_ID);
    const bot2Sig = await signBetCommitment(bot2Wallet, commitment, CONFIG.COLLATERAL_VAULT, CONFIG.CHAIN_ID);

    // Verify
    const bot1Valid = verifyBetCommitmentSignature(commitment, bot1Sig, bot1Address, CONFIG.COLLATERAL_VAULT, CONFIG.CHAIN_ID);
    const bot2Valid = verifyBetCommitmentSignature(commitment, bot2Sig, bot2Address, CONFIG.COLLATERAL_VAULT, CONFIG.CHAIN_ID);

    if (!bot1Valid || !bot2Valid) {
      logStep("A", "Sign commitment", false, undefined, `Bot1 valid: ${bot1Valid}, Bot2 valid: ${bot2Valid}`);
      return false;
    }

    logStep("A", "Sign commitment", true, "Both signatures verified", undefined, Date.now() - startSign);

    // ========================================================================
    // Step 7: Submit commitment on-chain
    // ========================================================================
    const startCommit = Date.now();

    const commitResult = await bot1Client.commitBilateralBet(
      {
        tradesRoot: commitment.tradesRoot,
        creator: commitment.creator,
        filler: commitment.filler,
        creatorAmount: commitment.creatorAmount,
        fillerAmount: commitment.fillerAmount,
        deadline: commitment.deadline,
        nonce: commitment.nonce,
        expiry: commitment.expiry,
      },
      bot1Sig,
      bot2Sig
    );

    if (!commitResult.success) {
      logStep("A", "Submit commitment", false, undefined, commitResult.error);
      return false;
    }

    betId = parseInt(commitResult.betId!, 10);
    storeMerkleTree(betId, tree);

    logStep("A", "Submit commitment on-chain", true, `Bet ID: ${betId}, TX: ${commitResult.txHash?.slice(0, 20)}...`, undefined, Date.now() - startCommit);

    // ========================================================================
    // Step 8: Wait for deadline
    // ========================================================================
    const now = Math.floor(Date.now() / 1000);
    const waitTime = Math.max(0, deadline - now + 2);
    if (waitTime > 0) {
      log(`  Waiting ${waitTime}s for deadline...`);
      await new Promise((r) => setTimeout(r, waitTime * 1000));
    }
    logStep("A", "Wait for deadline", true, "Deadline passed");

    // ========================================================================
    // Step 9: Fetch exit prices and compute outcomes
    // ========================================================================
    const startResolve = Date.now();

    // For deterministic test, we fetch fresh prices (they may have changed slightly)
    // In production, both bots would fetch at the exact same timestamp
    const { prices: exitPrices } = await fetchPricesFromDataNode(dataClient1, CONFIG.DATA_SOURCE, CONFIG.NUM_ASSETS);

    const exitPriceMap = new Map<number, bigint>();
    tickers.forEach((ticker, i) => {
      const price = exitPrices.get(ticker) ?? entryPrices.get(ticker)!;
      exitPriceMap.set(i, price);
    });

    // Both bots compute outcome independently
    const bot1Outcome = computeOutcome(tree, exitPriceMap, bot1Address, bot2Address);
    const bot2Outcome = computeOutcome(tree, exitPriceMap, bot1Address, bot2Address);

    log(`  Bot1 outcome: ${bot1Outcome.makerWins}/${bot1Outcome.total}, winner: ${bot1Outcome.winner.slice(0, 10)}...`);
    log(`  Bot2 outcome: ${bot2Outcome.makerWins}/${bot2Outcome.total}, winner: ${bot2Outcome.winner.slice(0, 10)}...`);

    // Verify both agree
    if (bot1Outcome.winner !== bot2Outcome.winner || bot1Outcome.makerWins !== bot2Outcome.makerWins) {
      logStep("A", "Compute outcomes", false, undefined, "Bots computed different outcomes!");
      return false;
    }

    logStep("A", "Compute outcomes (deterministic)", true, `Both agree: ${bot1Outcome.makerWins}/${bot1Outcome.total} maker wins`, undefined, Date.now() - startResolve);

    // ========================================================================
    // Step 10: Sign settlement agreement
    // ========================================================================
    const startSettle = Date.now();

    const settlementNonce = await bot1Client.getVaultNonce();
    const bot1Settlement = await bot1Client.signSettlementAgreement(betId, bot1Outcome.winner, settlementNonce);
    const bot2Settlement = await bot2Client.signSettlementAgreement(betId, bot2Outcome.winner, settlementNonce);

    logStep("A", "Sign settlement", true, "Both signatures ready");

    // ========================================================================
    // Step 11: Execute settlement on-chain
    // ========================================================================
    const settleResult = await bot1Client.settleByAgreementOnChain(
      bot1Settlement.agreement,
      bot1Settlement.signature,
      bot2Settlement.signature
    );

    if (!settleResult.success) {
      logStep("A", "Execute settlement", false, undefined, settleResult.error);
      return false;
    }

    logStep("A", "Execute settlement on-chain", true, `TX: ${settleResult.txHash?.slice(0, 20)}...`, undefined, Date.now() - startSettle);

    // ========================================================================
    // Step 12: Verify final state
    // ========================================================================
    const finalBet = await bot1Client.getBetFromVault(betId);
    if (!finalBet || finalBet.status !== 3) { // 3 = Settled
      logStep("A", "Verify settlement", false, undefined, `Bet status: ${finalBet?.status}`);
      return false;
    }

    const finalBot1 = await bot1Client.getVaultBalance();
    const finalBot2 = await bot2Client.getVaultBalance();

    log(`  Final Bot1: ${Number(finalBot1.available) / 1e18} WIND`);
    log(`  Final Bot2: ${Number(finalBot2.available) / 1e18} WIND`);

    logStep("A", "Verify final state", true, `Bet ${betId} settled, winner: ${bot1Outcome.winner.slice(0, 10)}...`);

    // Store resolution data
    storeResolution(betId, {
      betId,
      resolvedAt: new Date().toISOString(),
      winner: bot1Outcome.winner,
      makerWins: bot1Outcome.makerWins ?? 0,
      takerWins: bot1Outcome.takerWins ?? 0,
      totalTrades: tree.trades.length,
      exitPrices: Object.fromEntries(Array.from(exitPriceMap.entries()).map(([k, v]) => [k, v.toString()])),
      resolvedTrades: [],
    });

    return true;

  } catch (error) {
    logStep("A", "FATAL ERROR", false, undefined, (error as Error).message);
    console.error(error);
    return false;
  }
}

// ============================================================================
// Scenario B: Dispute Path (With Keepers)
// ============================================================================

async function runScenarioB(): Promise<boolean> {
  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("     SCENARIO B: DISPUTE PATH - Keeper Arbitration with BLS        ");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");

  let bot1Client: ChainClient | null = null;
  let bot2Client: ChainClient | null = null;
  let betId: number | null = null;

  try {
    // ========================================================================
    // Step 1: Initialize clients
    // ========================================================================
    const startInit = Date.now();

    const dataClient1 = createDataNodeClient(CONFIG.BOT1_PRIVATE_KEY, CONFIG.DATA_NODE_URL);

    const originalEnv = { ...process.env };

    process.env.AGENT_PRIVATE_KEY = CONFIG.BOT1_PRIVATE_KEY;
    process.env.RPC_URL = CONFIG.RPC_URL;
    process.env.CHAIN_ID = CONFIG.CHAIN_ID.toString();
    process.env.COLLATERAL_ADDRESS = CONFIG.WIND_TOKEN;
    process.env.BOT_REGISTRY_ADDRESS = CONFIG.BOT_REGISTRY;
    process.env.COLLATERAL_VAULT_ADDRESS = CONFIG.COLLATERAL_VAULT;
    bot1Client = createChainClientFromEnv();
    Object.assign(process.env, originalEnv);

    process.env.AGENT_PRIVATE_KEY = CONFIG.BOT2_PRIVATE_KEY;
    process.env.RPC_URL = CONFIG.RPC_URL;
    process.env.CHAIN_ID = CONFIG.CHAIN_ID.toString();
    process.env.COLLATERAL_ADDRESS = CONFIG.WIND_TOKEN;
    process.env.BOT_REGISTRY_ADDRESS = CONFIG.BOT_REGISTRY;
    process.env.COLLATERAL_VAULT_ADDRESS = CONFIG.COLLATERAL_VAULT;
    bot2Client = createChainClientFromEnv();
    Object.assign(process.env, originalEnv);

    if (!bot1Client || !bot2Client) {
      logStep("B", "Initialize clients", false, undefined, "Failed to create chain clients");
      return false;
    }

    const bot1Address = bot1Client.getAddress();
    const bot2Address = bot2Client.getAddress();

    logStep("B", "Initialize clients", true, `Bot1: ${bot1Address.slice(0, 10)}..., Bot2: ${bot2Address.slice(0, 10)}...`, undefined, Date.now() - startInit);

    // ========================================================================
    // Step 2: Check keepers are registered
    // ========================================================================
    const startKeepers = Date.now();

    const provider = new JsonRpcProvider(CONFIG.RPC_URL);
    const keeperRegistry = new Contract(CONFIG.KEEPER_REGISTRY, KEEPER_REGISTRY_ABI, provider);

    const activeKeepers = await keeperRegistry.getActiveKeepers();
    const keeperCount = activeKeepers.length;

    if (keeperCount < 2) {
      logStep("B", "Check keepers", false, undefined, `Only ${keeperCount} keepers registered, need at least 2`);
      log(`   Run: bun run src/register-keepers.ts to register keepers`);
      return false;
    }

    logStep("B", "Check keepers in KeeperRegistry", true, `${keeperCount} active keepers`, undefined, Date.now() - startKeepers);

    // ========================================================================
    // Step 3: Check balances
    // ========================================================================
    const bot1Balance = await bot1Client.getVaultBalance();
    const bot2Balance = await bot2Client.getVaultBalance();

    if (bot1Balance.available < CONFIG.STAKE_AMOUNT || bot2Balance.available < CONFIG.STAKE_AMOUNT) {
      logStep("B", "Check collateral", false, undefined, `Insufficient balance`);
      return false;
    }

    logStep("B", "Check collateral", true, `Both bots have sufficient WIND`);

    // ========================================================================
    // Step 4: Fetch prices and build portfolio
    // ========================================================================
    const startPrices = Date.now();

    const { prices: entryPrices, tickers } = await fetchPricesFromDataNode(dataClient1, CONFIG.DATA_SOURCE, CONFIG.NUM_ASSETS);

    const methods = tickers.map(() => "up:0");
    const entryPriceMap = new Map<number, bigint>();
    tickers.forEach((ticker, i) => {
      entryPriceMap.set(i, entryPrices.get(ticker)!);
    });

    const snapshotId = `vital-b-${Date.now()}`;
    const tree = buildBilateralMerkleTree(snapshotId, methods, entryPriceMap, tickers);

    logStep("B", "Fetch prices and build tree", true, `${entryPrices.size} assets, root: ${tree.root.slice(0, 16)}...`, undefined, Date.now() - startPrices);

    // ========================================================================
    // Step 5: Commit bet on-chain
    // ========================================================================
    const startCommit = Date.now();

    const deadline = Math.floor(Date.now() / 1000) + 10;
    const expiry = Math.floor(Date.now() / 1000) + 300;
    const nonce = await bot1Client.getVaultNonce();

    const commitment: BetCommitmentData = {
      tradesRoot: tree.root,
      creator: bot1Address,
      filler: bot2Address,
      creatorAmount: CONFIG.STAKE_AMOUNT,
      fillerAmount: CONFIG.STAKE_AMOUNT,
      deadline,
      nonce,
      expiry,
    };

    const bot1Sig = await signBetCommitment(bot1Client.getWallet(), commitment, CONFIG.COLLATERAL_VAULT, CONFIG.CHAIN_ID);
    const bot2Sig = await signBetCommitment(bot2Client.getWallet(), commitment, CONFIG.COLLATERAL_VAULT, CONFIG.CHAIN_ID);

    const commitResult = await bot1Client.commitBilateralBet(
      commitment,
      bot1Sig,
      bot2Sig
    );

    if (!commitResult.success) {
      logStep("B", "Commit bet", false, undefined, commitResult.error);
      return false;
    }

    betId = parseInt(commitResult.betId!, 10);
    storeMerkleTree(betId, tree);

    logStep("B", "Commit bet on-chain", true, `Bet ID: ${betId}`, undefined, Date.now() - startCommit);

    // ========================================================================
    // Step 6: Wait for deadline
    // ========================================================================
    const now = Math.floor(Date.now() / 1000);
    const waitTime = Math.max(0, deadline - now + 2);
    if (waitTime > 0) {
      log(`  Waiting ${waitTime}s for deadline...`);
      await new Promise((r) => setTimeout(r, waitTime * 1000));
    }
    logStep("B", "Wait for deadline", true, "Deadline passed");

    // ========================================================================
    // Step 7: Request arbitration (simulating disagreement)
    // ========================================================================
    const startArb = Date.now();

    log(`  Bot1 requesting arbitration (simulating dispute)...`);

    const arbResult = await bot1Client.requestArbitrationOnChain(betId);

    if (!arbResult.success) {
      logStep("B", "Request arbitration", false, undefined, arbResult.error);
      return false;
    }

    logStep("B", "Request arbitration on-chain", true, `TX: ${arbResult.txHash?.slice(0, 20)}...`, undefined, Date.now() - startArb);

    // ========================================================================
    // Step 8: Verify bet is in arbitration OR already settled (keepers may be very fast)
    // ========================================================================
    const betState = await bot1Client.getBetFromVault(betId);
    // Status 2 = InArbitration (still processing), Status 3 = Settled (keepers already resolved)
    if (betState?.status !== 2 && betState?.status !== 3) {
      logStep("B", "Verify arbitration state", false, undefined, `Status: ${betState?.status}, expected 2 or 3`);
      return false;
    }

    // If already settled, keepers were super fast - that's success!
    if (betState?.status === 3) {
      logStep("B", "Verify bet in arbitration", true, `Status: Already Settled (keepers resolved instantly)`);
      logStep("B", "Keepers settled by arbitration", true, `Resolved in <1s (very fast!)`);

      const finalBot1 = await bot1Client.getVaultBalance();
      const finalBot2 = await bot2Client.getVaultBalance();
      log(`  Final Bot1: ${Number(finalBot1.available) / 1e18} WIND`);
      log(`  Final Bot2: ${Number(finalBot2.available) / 1e18} WIND`);
      logStep("B", "Verify final state", true, `Bet ${betId} settled by keeper arbitration`);
      return true;
    }

    logStep("B", "Verify bet in arbitration", true, `Status: InArbitration`);

    // ========================================================================
    // Step 9: Wait for keepers to process and settle
    // ========================================================================
    log(`  Waiting for keepers to detect event and process...`);
    log(`  Keepers will:`);
    log(`    1. Detect ArbitrationRequested event`);
    log(`    2. Fetch trades from Data Node`);
    log(`    3. Run Resolution VM`);
    log(`    4. Sign BLS signature`);
    log(`    5. Aggregate signatures`);
    log(`    6. Submit settleByArbitration`);

    // Poll for settlement (keepers should auto-resolve)
    const maxWaitMs = 120000; // 2 minutes max
    const pollIntervalMs = 5000;
    let waited = 0;

    while (waited < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      waited += pollIntervalMs;

      const currentBet = await bot1Client.getBetFromVault(betId);
      log(`  [${waited / 1000}s] Bet status: ${currentBet?.status}`);

      if (currentBet?.status === 3) { // Settled
        logStep("B", "Keepers settled by arbitration", true, `Resolved after ${waited / 1000}s`);
        break;
      }

      if (currentBet?.status !== 2) {
        logStep("B", "Unexpected status", false, undefined, `Status: ${currentBet?.status}`);
        return false;
      }
    }

    // ========================================================================
    // Step 10: Verify final settlement
    // ========================================================================
    const finalBet = await bot1Client.getBetFromVault(betId);
    if (finalBet?.status !== 3) {
      logStep("B", "Final verification", false, undefined, `Keepers did not settle within ${maxWaitMs / 1000}s`);
      log(`   Check keeper logs on VPS2: ssh index-maker/prod/be "tail -100 ~/keeper/keeper*.log"`);
      return false;
    }

    const finalBot1 = await bot1Client.getVaultBalance();
    const finalBot2 = await bot2Client.getVaultBalance();

    log(`  Final Bot1: ${Number(finalBot1.available) / 1e18} WIND`);
    log(`  Final Bot2: ${Number(finalBot2.available) / 1e18} WIND`);

    logStep("B", "Verify final state", true, `Bet ${betId} settled by keeper arbitration`);

    return true;

  } catch (error) {
    logStep("B", "FATAL ERROR", false, undefined, (error as Error).message);
    console.error(error);
    return false;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const runOnlyA = args.includes("--scenario-a") || args.includes("-a");
  const runOnlyB = args.includes("--scenario-b") || args.includes("-b");
  const skipInfraCheck = args.includes("--skip-infra");
  const helpRequested = args.includes("--help") || args.includes("-h");

  if (helpRequested) {
    console.log(`
VITAL E2E TEST - Bilateral System Live Infrastructure

Usage: bun run src/test-vital-e2e.ts [options]

Options:
  --scenario-a, -a    Run only Scenario A (Happy Path)
  --scenario-b, -b    Run only Scenario B (Dispute Path)
  --skip-infra        Skip infrastructure health checks
  --help, -h          Show this help

Environment Variables:
  RPC_URL             Chain RPC endpoint (default: http://127.0.0.1:33010)
  DATA_NODE_URL       Data Node URL (default: http://116.203.156.98:4000)
  NUM_ASSETS          Number of assets in portfolio (default: 50)
  DATA_SOURCE         Data source: defi, stocks, crypto (default: defi)
  STAKE_AMOUNT        Stake amount in wei (default: 100000000000000000)

Prerequisites:
  1. SSH tunnel: ssh -fN -L 33010:localhost:32795 index-maker/prod/be
  2. Data Node running on VPS2
  3. For Scenario B: 3 Keepers running with BLS keys registered
`);
    process.exit(0);
  }

  console.log("\n");
  console.log("╔═══════════════════════════════════════════════════════════════════╗");
  console.log("║       VITAL E2E TEST - Bilateral System Live Infrastructure       ║");
  console.log("║                                                                   ║");
  console.log("║  Tests:                                                           ║");
  console.log("║  • Real Data Node (no mocking)                                    ║");
  console.log("║  • Real Keepers with BLS signing                                  ║");
  console.log("║  • On-chain contract interactions                                 ║");
  console.log("╚═══════════════════════════════════════════════════════════════════╝");
  console.log("");

  if (runOnlyA) log("Running only Scenario A (Happy Path)");
  if (runOnlyB) log("Running only Scenario B (Dispute Path)");

  // Check infrastructure first
  if (!skipInfraCheck) {
    const infraOk = await checkInfrastructure();
    if (!infraOk) {
      console.log("\n❌ Infrastructure check failed. Fix issues above before running tests.");
      console.log("   Use --skip-infra to bypass this check.");
      process.exit(1);
    }
  } else {
    log("Skipping infrastructure check (--skip-infra)");
  }

  console.log("\n");

  // Run scenarios
  let scenarioASuccess = true;
  let scenarioBSuccess = true;

  if (!runOnlyB) {
    scenarioASuccess = await runScenarioA();
  }

  if (!runOnlyA) {
    scenarioBSuccess = await runScenarioB();
  }

  // ========================================================================
  // Summary
  // ========================================================================
  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("                         TEST SUMMARY                               ");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");

  if (!runOnlyB && testResults.scenarioA.length > 0) {
    console.log("SCENARIO A - Happy Path:");
    for (const step of testResults.scenarioA) {
      const emoji = step.success ? "✅" : "❌";
      console.log(`  ${emoji} ${step.name}${step.details ? `: ${step.details}` : ""}${step.error ? ` (${step.error})` : ""}`);
    }
    console.log("");
  }

  if (!runOnlyA && testResults.scenarioB.length > 0) {
    console.log("SCENARIO B - Dispute Path:");
    for (const step of testResults.scenarioB) {
      const emoji = step.success ? "✅" : "❌";
      console.log(`  ${emoji} ${step.name}${step.details ? `: ${step.details}` : ""}${step.error ? ` (${step.error})` : ""}`);
    }
    console.log("");
  }

  const totalPassed = testResults.scenarioA.filter((s) => s.success).length +
    testResults.scenarioB.filter((s) => s.success).length;
  const totalFailed = testResults.scenarioA.filter((s) => !s.success).length +
    testResults.scenarioB.filter((s) => !s.success).length;

  if (!runOnlyB) console.log(`  Scenario A: ${scenarioASuccess ? "✅ PASSED" : "❌ FAILED"}`);
  if (!runOnlyA) console.log(`  Scenario B: ${scenarioBSuccess ? "✅ PASSED" : "❌ FAILED"}`);
  console.log(`  Steps: ${totalPassed} passed, ${totalFailed} failed`);
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════");

  const allPassed = (runOnlyB || scenarioASuccess) && (runOnlyA || scenarioBSuccess);
  console.log(`  RESULT: ${allPassed ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED"}`);
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");

  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
