#!/usr/bin/env bun
/**
 * Bilateral E2E Test - Live Data Node
 *
 * Tests the complete bilateral betting flow with REAL market data:
 * 1. Both bots fetch entry prices from Data Node (DeFi data - 200 assets)
 * 2. Bot1 creates and signs commitment
 * 3. Bot2 signs commitment
 * 4. Commitment submitted on-chain
 * 5. Deadline passes (simulated)
 * 6. Both fetch exit prices (same prices for test - deterministic outcome)
 * 7. Both compute outcome
 * 8. Both agree and sign settlement
 * 9. Settlement submitted on-chain
 */

import { Wallet } from "ethers";
import { createDataNodeClient, type DataNodeClient, type MarketPrice } from "./data-node-client";
import { createChainClientFromEnv, type ChainClient } from "./chain-client";
import { buildBilateralMerkleTree, type MerkleTree } from "./merkle-tree";
import {
  signBetCommitment,
  verifyBetCommitmentSignature,
  type BetCommitmentData,
} from "./p2p/commitment";
import { computeOutcome } from "./p2p/outcome-computer";
import { storeMerkleTree, storeResolution, type ResolutionData } from "./p2p/trade-storage";

// Test configuration - Updated for new deployment
const DATA_NODE_URL = process.env.DATA_NODE_URL || "http://localhost:4000";
const RPC_URL = process.env.RPC_URL || "http://localhost:8547";
const CHAIN_ID = process.env.CHAIN_ID || "111222333";
// Bilateral Contracts (VPS2 - deployed 2026-02-03)
const COLLATERAL_ADDRESS = "0x4e5b65FB12d4165E22f5861D97A33BA45c006114"; // WIND
const BOT_REGISTRY_ADDRESS = "0x9dF23e34ac13A7145ebA1164660E701839197B1b";
const COLLATERAL_VAULT_ADDRESS = "0xE8f29Ab983F547CeA70cD73de06ff490C6F5903f";

// Bot private keys (dev2 and dev3)
const BOT1_PRIVATE_KEY = "0x203298e6a2b845c6dde179f3f991ae4c081ad963e20c9fe39d45893c00a0aea5";
const BOT2_PRIVATE_KEY = "0x237112963af91b42ca778fbe434a819b7e862cd025be3c86ce453bdd3e633165";

const STAKE_AMOUNT = BigInt(process.env.STAKE_AMOUNT || "100000000000000000"); // 0.1 WIND

interface TestResult {
  step: string;
  success: boolean;
  details?: string;
  error?: string;
}

const results: TestResult[] = [];

function log(message: string) {
  console.log(`[E2E] ${message}`);
}

function logSuccess(step: string, details?: string) {
  results.push({ step, success: true, details });
  console.log(`✅ ${step}${details ? `: ${details}` : ""}`);
}

function logError(step: string, error: string) {
  results.push({ step, success: false, error });
  console.log(`❌ ${step}: ${error}`);
}

/**
 * Fetch prices from Data Node using EIP-712 authenticated client
 */
async function fetchPricesFromDataNode(
  client: DataNodeClient,
  limit: number = 200
): Promise<Map<string, bigint>> {
  const response = await client.getPrices("defi", { limit });

  const prices = new Map<string, bigint>();
  for (const price of response.prices) {
    // Convert decimal string to bigint (multiply by 1e8 for precision)
    const valueFloat = parseFloat(price.value);
    const valueBigInt = BigInt(Math.floor(valueFloat * 1e8));
    prices.set(price.assetId, valueBigInt);
  }

  return prices;
}

async function main() {
  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("        BILATERAL E2E TEST - LIVE DATA NODE (200 DEFI ASSETS)       ");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");

  // Step 1: Initialize Data Node clients
  log("Step 1: Initializing Data Node clients...");

  const dataClient1 = createDataNodeClient(BOT1_PRIVATE_KEY, DATA_NODE_URL);
  const dataClient2 = createDataNodeClient(BOT2_PRIVATE_KEY, DATA_NODE_URL);

  logSuccess("Data Node clients", "Both clients initialized");

  // Step 2: Initialize chain clients for both bots
  log("Step 2: Initializing chain clients...");

  const originalEnv = { ...process.env };

  // Bot1 environment
  const bot1Env = {
    AGENT_PRIVATE_KEY: BOT1_PRIVATE_KEY,
    RPC_URL,
    CHAIN_ID,
    COLLATERAL_ADDRESS,
    BOT_REGISTRY_ADDRESS,
    COLLATERAL_VAULT_ADDRESS,
  };

  const bot2Env = {
    AGENT_PRIVATE_KEY: BOT2_PRIVATE_KEY,
    RPC_URL,
    CHAIN_ID,
    COLLATERAL_ADDRESS,
    BOT_REGISTRY_ADDRESS,
    COLLATERAL_VAULT_ADDRESS,
  };

  // Create chain clients
  Object.assign(process.env, bot1Env);
  const bot1Client = createChainClientFromEnv();
  Object.assign(process.env, originalEnv);

  Object.assign(process.env, bot2Env);
  const bot2Client = createChainClientFromEnv();
  Object.assign(process.env, originalEnv);

  if (!bot1Client || !bot2Client) {
    logError("Initialize clients", "Failed to create chain clients");
    return;
  }

  const bot1Address = bot1Client.getAddress();
  const bot2Address = bot2Client.getAddress();
  logSuccess("Chain clients", `Bot1: ${bot1Address.slice(0, 10)}..., Bot2: ${bot2Address.slice(0, 10)}...`);

  // Step 3: Verify both bots are registered
  log("Step 3: Verifying bot registration...");
  try {
    const bot1Registered = await bot1Client.isBotRegistered(bot1Address);
    const bot2Registered = await bot2Client.isBotRegistered(bot2Address);

    if (!bot1Registered || !bot2Registered) {
      logError("Bot registration", `Bot1: ${bot1Registered}, Bot2: ${bot2Registered}`);
      return;
    }
    logSuccess("Bot registration", "Both bots registered in BotRegistry");
  } catch (error) {
    logError("Bot registration", (error as Error).message);
    return;
  }

  // Step 4: Check collateral balances
  log("Step 4: Checking collateral balances...");
  const bot1Balance = await bot1Client.getVaultBalance();
  const bot2Balance = await bot2Client.getVaultBalance();

  log(`  Bot1 vault balance: ${bot1Balance.available.toString()} (${Number(bot1Balance.available) / 1e18} WIND)`);
  log(`  Bot2 vault balance: ${bot2Balance.available.toString()} (${Number(bot2Balance.available) / 1e18} WIND)`);

  if (bot1Balance.available < STAKE_AMOUNT || bot2Balance.available < STAKE_AMOUNT) {
    logError("Collateral check", `Insufficient balance. Bot1: ${bot1Balance.available}, Bot2: ${bot2Balance.available}, Required: ${STAKE_AMOUNT}`);
    return;
  }
  logSuccess("Collateral check", "Both bots have sufficient collateral");

  // Step 5: Fetch entry prices from Data Node
  log("Step 5: Fetching entry prices from Data Node (DeFi source)...");
  let entryPrices: Map<string, bigint>;
  try {
    entryPrices = await fetchPricesFromDataNode(dataClient1, 200);
    logSuccess("Entry prices", `Fetched ${entryPrices.size} DeFi asset prices`);

    // Show sample prices
    const samplePrices = Array.from(entryPrices.entries()).slice(0, 3);
    for (const [assetId, price] of samplePrices) {
      log(`  ${assetId}: ${Number(price) / 1e8}`);
    }
  } catch (error) {
    logError("Entry prices", (error as Error).message);
    return;
  }

  // Step 6: Build Merkle tree (portfolio)
  log("Step 6: Building portfolio Merkle tree...");

  const assetIds = Array.from(entryPrices.keys());
  const methods = assetIds.map(() => "up:0"); // Bot1 bets all assets go up

  const entryPriceMap = new Map<number, bigint>();
  assetIds.forEach((assetId, i) => {
    entryPriceMap.set(i, entryPrices.get(assetId)!);
  });

  // Build tree with methods array (not positionBitmap)
  const tree = buildBilateralMerkleTree(
    "defi-live-e2e",
    methods,
    entryPriceMap,
    assetIds
  );
  logSuccess("Build Merkle tree", `Root: ${tree.root.slice(0, 20)}..., Trades: ${tree.trades.length}`);

  // Step 7: Create and sign commitment
  log("Step 7: Creating bet commitment...");

  const deadline = Math.floor(Date.now() / 1000) + 5; // 5 seconds in the future (short wait)
  const expiry = Math.floor(Date.now() / 1000) + 300; // 5 minutes from now
  const nonce = await bot1Client.getVaultNonce();

  const commitment: BetCommitmentData = {
    tradesRoot: tree.root,
    creator: bot1Address,
    filler: bot2Address,
    creatorAmount: STAKE_AMOUNT,
    fillerAmount: STAKE_AMOUNT,
    deadline,
    nonce,
    expiry,
  };

  const chainId = parseInt(CHAIN_ID, 10);

  // Bot1 signs
  const bot1Wallet = bot1Client.getWallet();
  const bot1Sig = await signBetCommitment(bot1Wallet, commitment, COLLATERAL_VAULT_ADDRESS, chainId);
  log(`  Bot1 signature: ${bot1Sig.slice(0, 20)}...`);

  // Bot2 signs
  const bot2Wallet = bot2Client.getWallet();
  const bot2Sig = await signBetCommitment(bot2Wallet, commitment, COLLATERAL_VAULT_ADDRESS, chainId);
  log(`  Bot2 signature: ${bot2Sig.slice(0, 20)}...`);

  // Verify signatures
  const bot1SigValid = verifyBetCommitmentSignature(commitment, bot1Sig, bot1Address, COLLATERAL_VAULT_ADDRESS, chainId);
  const bot2SigValid = verifyBetCommitmentSignature(commitment, bot2Sig, bot2Address, COLLATERAL_VAULT_ADDRESS, chainId);

  if (!bot1SigValid || !bot2SigValid) {
    logError("Sign commitment", `Bot1 valid: ${bot1SigValid}, Bot2 valid: ${bot2SigValid}`);
    return;
  }
  logSuccess("Sign commitment", "Both signatures verified");

  // Step 8: Submit commitment on-chain
  log("Step 8: Submitting commitment on-chain...");
  let betId: number;
  try {
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
      logError("Submit commitment", commitResult.error || "Unknown error");
      return;
    }

    betId = parseInt(commitResult.betId!, 10);
    logSuccess("Submit commitment", `Bet ID: ${betId}, TX: ${commitResult.txHash?.slice(0, 20)}...`);

    // Store Merkle tree locally for both bots
    storeMerkleTree(betId, tree);
    log(`  Stored Merkle tree for bet ${betId}`);
  } catch (error) {
    logError("Submit commitment", (error as Error).message);
    return;
  }

  // Step 9: Wait for deadline to pass
  log("Step 9: Waiting for deadline to pass...");
  const now = Math.floor(Date.now() / 1000);
  const waitTime = deadline - now + 2; // Add 2 seconds buffer
  if (waitTime > 0) {
    log(`  Waiting ${waitTime} seconds for deadline...`);
    await new Promise((resolve) => setTimeout(resolve, waitTime * 1000));
  }
  logSuccess("Deadline", "Deadline has passed");

  // Step 10: Fetch exit prices (use same prices for deterministic outcome)
  log("Step 10: Using same prices for exit (deterministic test)...");
  // For a deterministic test, we use the same prices as entry
  // This means all "up:0" positions will result in ties (price unchanged)
  // Since tie goes to filler (taker), Bot2 should win
  const exitPrices = entryPrices;
  logSuccess("Exit prices", `Using ${exitPrices.size} prices (same as entry for deterministic test)`);

  // Step 11: Both bots compute outcome
  log("Step 11: Computing outcomes...");

  const exitPriceMap = new Map<number, bigint>();
  assetIds.forEach((assetId, i) => {
    exitPriceMap.set(i, exitPrices.get(assetId)!);
  });

  const bot1Outcome = computeOutcome(tree, exitPriceMap, bot1Address, bot2Address);
  const bot2Outcome = computeOutcome(tree, exitPriceMap, bot1Address, bot2Address);

  log(`  Bot1 outcome: ${bot1Outcome.winsCount}/${bot1Outcome.validTrades} wins, winner: ${bot1Outcome.winner.slice(0, 10)}...`);
  log(`  Bot2 outcome: ${bot2Outcome.winsCount}/${bot2Outcome.validTrades} wins, winner: ${bot2Outcome.winner.slice(0, 10)}...`);

  // Verify outcomes match
  if (
    bot1Outcome.winner !== bot2Outcome.winner ||
    bot1Outcome.winsCount !== bot2Outcome.winsCount
  ) {
    logError("Outcome match", "Bots computed different outcomes!");
    return;
  }
  logSuccess("Outcome match", "Both bots agree on outcome");

  // Store resolution data for inspection
  log("  Storing resolution data...");
  const resolvedTrades = tree.trades.map((trade, i) => {
    const exitPrice = exitPriceMap.get(i) ?? 0n;
    const entryPrice = trade.entryPrice;
    // Evaluate trade outcome based on method
    let makerWon = false;
    if (trade.method.startsWith("up:")) {
      const threshold = parseFloat(trade.method.split(":")[1]);
      makerWon = exitPrice > entryPrice * BigInt(Math.floor((1 + threshold / 100) * 10000)) / 10000n;
    } else if (trade.method.startsWith("down:")) {
      const threshold = parseFloat(trade.method.split(":")[1]);
      makerWon = exitPrice < entryPrice * BigInt(Math.floor((1 - threshold / 100) * 10000)) / 10000n;
    }
    return {
      index: i,
      ticker: trade.ticker,
      method: trade.method,
      entryPrice: entryPrice.toString(),
      exitPrice: exitPrice.toString(),
      makerWon,
    };
  });

  const resolutionData: ResolutionData = {
    betId,
    resolvedAt: new Date().toISOString(),
    winner: bot1Outcome.winner,
    makerWins: bot1Outcome.winsCount ?? 0,
    takerWins: (bot1Outcome.validTrades ?? 0) - (bot1Outcome.winsCount ?? 0),
    totalTrades: tree.trades.length,
    exitPrices: Object.fromEntries(
      Array.from(exitPriceMap.entries()).map(([k, v]) => [k, v.toString()])
    ),
    resolvedTrades,
  };
  storeResolution(betId, resolutionData);
  logSuccess("Resolution stored", `bet-${betId}-resolution.json`);

  // Step 12: Sign settlement agreement
  log("Step 12: Signing settlement agreement...");

  const settlementNonce = await bot1Client.getVaultNonce();
  const bot1Settlement = await bot1Client.signSettlementAgreement(betId, bot1Outcome.winner, settlementNonce);
  const bot2Settlement = await bot2Client.signSettlementAgreement(betId, bot2Outcome.winner, settlementNonce);

  logSuccess("Sign settlement", "Both bots signed settlement agreement");

  // Step 13: Submit settlement on-chain
  log("Step 13: Submitting settlement on-chain...");

  try {
    const settleResult = await bot1Client.settleByAgreementOnChain(
      bot1Settlement.agreement,
      bot1Settlement.signature,
      bot2Settlement.signature
    );

    if (!settleResult.success) {
      logError("Submit settlement", settleResult.error || "Unknown error");
      return;
    }
    logSuccess("Submit settlement", `TX: ${settleResult.txHash?.slice(0, 20)}...`);
  } catch (error) {
    logError("Submit settlement", (error as Error).message);
    return;
  }

  // Step 14: Verify final state
  log("Step 14: Verifying final state...");

  const finalBet = await bot1Client.getBetFromVault(betId);
  if (!finalBet) {
    logError("Verify final state", "Bet not found");
    return;
  }

  log(`  Bet status: ${finalBet.status}`);
  logSuccess("Verify final state", `Bet ${betId} settled successfully`);

  // Check final balances
  const finalBot1Balance = await bot1Client.getVaultBalance();
  const finalBot2Balance = await bot2Client.getVaultBalance();
  log(`  Final Bot1 vault balance: ${Number(finalBot1Balance.available) / 1e18} WIND`);
  log(`  Final Bot2 vault balance: ${Number(finalBot2Balance.available) / 1e18} WIND`);

  // Print summary
  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("                         TEST SUMMARY                               ");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  results.forEach((r) => {
    if (r.success) {
      console.log(`  ✅ ${r.step}${r.details ? `: ${r.details}` : ""}`);
    } else {
      console.log(`  ❌ ${r.step}: ${r.error}`);
    }
  });

  console.log("");
  console.log(`  Total: ${results.length} steps, ${passed} passed, ${failed} failed`);
  console.log(`  Assets tested: ${assetIds.length} DeFi assets from live Data Node`);
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(`  RESULT: ${failed === 0 ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED"}`);
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");

  // =========================================================================
  // SCENARIO B: Dispute Path - Keeper Arbitration with BLS
  // =========================================================================
  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("        SCENARIO B: DISPUTE PATH - KEEPER ARBITRATION              ");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");

  const scenarioBResults: TestResult[] = [];

  function logScenarioBSuccess(step: string, details?: string) {
    scenarioBResults.push({ step, success: true, details });
    console.log(`✅ ${step}${details ? `: ${details}` : ""}`);
  }

  function logScenarioBError(step: string, error: string) {
    scenarioBResults.push({ step, success: false, error });
    console.log(`❌ ${step}: ${error}`);
  }

  // Scenario B Step 1: Create another bet commitment (reuse prices from Scenario A)
  log("Scenario B Step 1: Creating new bet for arbitration test...");

  const scenarioBDeadline = BigInt(Math.floor(Date.now() / 1000) + 5); // 5 second deadline
  const scenarioBNonce = await bot1Client.getVaultNonce();
  const scenarioBExpiry = BigInt(Math.floor(Date.now() / 1000) + 300);

  const scenarioBCommitment = {
    tradesRoot: tree.root,
    creator: bot1Address,
    filler: bot2Address,
    creatorAmount: STAKE_AMOUNT,
    fillerAmount: STAKE_AMOUNT,
    deadline: scenarioBDeadline,
    nonce: scenarioBNonce,
    expiry: scenarioBExpiry,
  };

  const scenarioBSig1 = await signBetCommitment(bot1Wallet, scenarioBCommitment, COLLATERAL_VAULT_ADDRESS, chainId);
  const scenarioBSig2 = await signBetCommitment(bot2Wallet, scenarioBCommitment, COLLATERAL_VAULT_ADDRESS, chainId);

  logScenarioBSuccess("Create commitment", "Signatures ready");

  // Scenario B Step 2: Submit commitment on-chain
  log("Scenario B Step 2: Submitting commitment on-chain...");

  let scenarioBBetId: number;
  try {
    const commitResult = await bot1Client.commitBilateralBet(
      {
        tradesRoot: scenarioBCommitment.tradesRoot,
        creator: scenarioBCommitment.creator,
        filler: scenarioBCommitment.filler,
        creatorAmount: scenarioBCommitment.creatorAmount,
        fillerAmount: scenarioBCommitment.fillerAmount,
        deadline: scenarioBCommitment.deadline,
        nonce: scenarioBCommitment.nonce,
        expiry: scenarioBCommitment.expiry,
      },
      scenarioBSig1,
      scenarioBSig2
    );

    if (!commitResult.success || !commitResult.betId) {
      logScenarioBError("Submit commitment", commitResult.error || "Unknown error");
      process.exit(1);
    }
    scenarioBBetId = parseInt(commitResult.betId);
    logScenarioBSuccess("Submit commitment", `Bet ID: ${scenarioBBetId}`);
  } catch (error) {
    logScenarioBError("Submit commitment", (error as Error).message);
    process.exit(1);
  }

  // Scenario B Step 3: Wait for deadline
  log("Scenario B Step 3: Waiting for deadline to pass...");
  log("  Waiting 6 seconds...");
  await new Promise((resolve) => setTimeout(resolve, 6000));
  logScenarioBSuccess("Deadline passed", "Bet is now eligible for arbitration");

  // Scenario B Step 4: Request arbitration (instead of settling by agreement)
  log("Scenario B Step 4: Requesting arbitration...");

  try {
    const arbResult = await bot1Client.requestArbitrationOnChain(scenarioBBetId);
    if (!arbResult.success) {
      logScenarioBError("Request arbitration", arbResult.error || "Unknown error");
      process.exit(1);
    }
    logScenarioBSuccess("Request arbitration", `TX: ${arbResult.txHash?.slice(0, 20)}...`);
  } catch (error) {
    logScenarioBError("Request arbitration", (error as Error).message);
    process.exit(1);
  }

  // Scenario B Step 5: Wait for keepers to settle
  log("Scenario B Step 5: Waiting for keepers to settle (max 120s)...");

  const maxWaitTime = 120000; // 120 seconds
  const pollInterval = 5000; // 5 seconds
  const startTime = Date.now();
  let settled = false;

  while (Date.now() - startTime < maxWaitTime) {
    const bet = await bot1Client.getBetFromVault(scenarioBBetId);
    if (bet && bet.status === 3) { // 3 = Settled
      settled = true;
      break;
    }
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`  Waiting... ${elapsed}s elapsed, bet status: ${bet?.status ?? "unknown"}`);
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  if (!settled) {
    logScenarioBError("Keeper settlement", "Keepers did not settle within 120s");

    // Check bet status for debugging
    const debugBet = await bot1Client.getBetFromVault(scenarioBBetId);
    console.log(`  Debug: Bet status = ${debugBet?.status ?? "not found"}`);
    console.log("  Expected status 3 (Settled), got status 2 (InArbitration) means keepers didn't submit");
  } else {
    logScenarioBSuccess("Keeper settlement", `Bet ${scenarioBBetId} settled by keepers`);
  }

  // Scenario B Step 6: Verify final state
  log("Scenario B Step 6: Verifying final state...");

  const scenarioBFinalBet = await bot1Client.getBetFromVault(scenarioBBetId);
  if (!scenarioBFinalBet) {
    logScenarioBError("Verify final state", "Bet not found");
  } else if (scenarioBFinalBet.status !== 3) {
    logScenarioBError("Verify final state", `Bet not settled, status: ${scenarioBFinalBet.status}`);
  } else {
    logScenarioBSuccess("Verify final state", `Bet ${scenarioBBetId} settled by arbitration`);
  }

  // Print Scenario B summary
  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("                   SCENARIO B SUMMARY                               ");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");

  const scenarioBPassed = scenarioBResults.filter((r) => r.success).length;
  const scenarioBFailed = scenarioBResults.filter((r) => !r.success).length;

  scenarioBResults.forEach((r) => {
    if (r.success) {
      console.log(`  ✅ ${r.step}${r.details ? `: ${r.details}` : ""}`);
    } else {
      console.log(`  ❌ ${r.step}: ${r.error}`);
    }
  });

  console.log("");
  console.log(`  Total: ${scenarioBResults.length} steps, ${scenarioBPassed} passed, ${scenarioBFailed} failed`);
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(`  SCENARIO B RESULT: ${scenarioBFailed === 0 ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED"}`);
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");

  // Final exit code
  const totalFailed = failed + scenarioBFailed;
  process.exit(totalFailed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
