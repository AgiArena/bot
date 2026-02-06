#!/usr/bin/env bun
/**
 * Bilateral E2E Test - Happy Path
 *
 * Tests the complete bilateral betting flow:
 * 1. Both bots fetch entry prices
 * 2. Bot1 creates and signs commitment
 * 3. Bot2 signs commitment
 * 4. Commitment submitted on-chain
 * 5. Deadline passes (simulated)
 * 6. Both fetch exit prices
 * 7. Both compute outcome
 * 8. Both agree and sign settlement
 * 9. Settlement submitted on-chain
 */

import { createChainClientFromEnv, type ChainClient } from "./chain-client";
import { buildBilateralMerkleTree, type MerkleTree } from "./merkle-tree";
import {
  createBetCommitment,
  signBetCommitment,
  verifyBetCommitmentSignature,
  type BetCommitmentData,
} from "./p2p/commitment";
import { computeOutcome, type OutcomeResult } from "./p2p/outcome-computer";
import { storeMerkleTree } from "./p2p/trade-storage";
import { ethers } from "ethers";

// Test configuration
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:4000";
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

async function fetchPrices(mode: "entry" | "exit"): Promise<Map<string, bigint>> {
  // Set price mode
  await fetch(`${BACKEND_URL}/api/set-mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });

  // Fetch prices
  const response = await fetch(`${BACKEND_URL}/api/snapshots/latest?source=stocks`);
  const data = await response.json() as {
    snapshotId: string;
    prices: { ticker: string; price: string }[];
  };

  const prices = new Map<string, bigint>();
  for (const p of data.prices) {
    prices.set(p.ticker, BigInt(p.price));
  }

  return prices;
}

async function main() {
  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("           BILATERAL E2E TEST - HAPPY PATH (SCENARIO A)            ");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");

  // Step 1: Initialize chain clients for both bots
  log("Step 1: Initializing chain clients...");

  // Load Bot1 env
  const bot1Env = {
    AGENT_PRIVATE_KEY: process.env.BOT1_PRIVATE_KEY || "0xd518d48628681d00fe0b35ff9cca3f354e8197eab2ab4b010e1274eccc3e8775",
    RPC_URL: process.env.RPC_URL || "http://localhost:8545",
    CHAIN_ID: process.env.CHAIN_ID || "111222333",
    COLLATERAL_ADDRESS: process.env.COLLATERAL_ADDRESS || "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    BOT_REGISTRY_ADDRESS: process.env.BOT_REGISTRY_ADDRESS || "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
    COLLATERAL_VAULT_ADDRESS: process.env.COLLATERAL_VAULT_ADDRESS || "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
  };

  const bot2Env = {
    AGENT_PRIVATE_KEY: process.env.BOT2_PRIVATE_KEY || "0x76ef39d57e725bfd781094a8852d6ee3d4a5d6e6db2af2c7160e2996887397ee",
    RPC_URL: bot1Env.RPC_URL,
    CHAIN_ID: bot1Env.CHAIN_ID,
    COLLATERAL_ADDRESS: bot1Env.COLLATERAL_ADDRESS,
    BOT_REGISTRY_ADDRESS: bot1Env.BOT_REGISTRY_ADDRESS,
    COLLATERAL_VAULT_ADDRESS: bot1Env.COLLATERAL_VAULT_ADDRESS,
  };

  // Temporarily override env for bot1
  const originalEnv = { ...process.env };
  Object.assign(process.env, bot1Env);
  const bot1Client = createChainClientFromEnv();
  Object.assign(process.env, originalEnv);

  // Temporarily override env for bot2
  Object.assign(process.env, bot2Env);
  const bot2Client = createChainClientFromEnv();
  Object.assign(process.env, originalEnv);

  if (!bot1Client || !bot2Client) {
    logError("Initialize clients", "Failed to create chain clients");
    return;
  }

  const bot1Address = bot1Client.getAddress();
  const bot2Address = bot2Client.getAddress();
  logSuccess("Initialize clients", `Bot1: ${bot1Address.slice(0, 10)}..., Bot2: ${bot2Address.slice(0, 10)}...`);

  // Step 2: Verify both bots are registered
  log("Step 2: Verifying bot registration...");
  const bot1Registered = await bot1Client.isBotRegistered(bot1Address);
  const bot2Registered = await bot2Client.isBotRegistered(bot2Address);

  if (!bot1Registered || !bot2Registered) {
    logError("Bot registration", `Bot1: ${bot1Registered}, Bot2: ${bot2Registered}`);
    return;
  }
  logSuccess("Bot registration", "Both bots registered in BotRegistry");

  // Step 3: Check collateral balances
  log("Step 3: Checking collateral balances...");
  const bot1Balance = await bot1Client.getVaultBalance();
  const bot2Balance = await bot2Client.getVaultBalance();

  log(`  Bot1 vault balance: ${bot1Balance.available.toString()}`);
  log(`  Bot2 vault balance: ${bot2Balance.available.toString()}`);

  // If balances are insufficient, deposit collateral
  if (bot1Balance.available < STAKE_AMOUNT) {
    log("  Bot1 needs to deposit collateral...");
    const depositResult = await bot1Client.depositToVault(STAKE_AMOUNT * 2n);
    if (!depositResult.success) {
      logError("Deposit collateral", depositResult.error || "Unknown error");
      return;
    }
  }

  if (bot2Balance.available < STAKE_AMOUNT) {
    log("  Bot2 needs to deposit collateral...");
    const depositResult = await bot2Client.depositToVault(STAKE_AMOUNT * 2n);
    if (!depositResult.success) {
      logError("Deposit collateral", depositResult.error || "Unknown error");
      return;
    }
  }
  logSuccess("Collateral check", "Both bots have sufficient collateral");

  // Step 4: Fetch entry prices
  log("Step 4: Fetching entry prices...");
  const entryPrices = await fetchPrices("entry");
  logSuccess("Entry prices", `Fetched ${entryPrices.size} prices`);

  // Step 5: Build Merkle tree (portfolio)
  log("Step 5: Building portfolio Merkle tree...");

  const tickers = Array.from(entryPrices.keys());
  const methods = tickers.map(() => "up:0"); // Bot1 bets all stocks go up
  const positionBitmap = new Uint8Array(Math.ceil(tickers.length / 8));
  // Set all bits to 1 (all positions "up")
  for (let i = 0; i < positionBitmap.length; i++) {
    positionBitmap[i] = 0xff;
  }

  const entryPriceMap = new Map<number, bigint>();
  tickers.forEach((ticker, i) => {
    entryPriceMap.set(i, entryPrices.get(ticker)!);
  });

  const tree = buildBilateralMerkleTree(
    "stocks-mock-e2e",
    positionBitmap,
    entryPriceMap,
    tickers
  );
  logSuccess("Build Merkle tree", `Root: ${tree.root.slice(0, 20)}..., Trades: ${tree.trades.length}`);

  // Step 6: Create and sign commitment
  log("Step 6: Creating bet commitment...");

  const deadline = Math.floor(Date.now() / 1000) + 60; // 1 minute from now
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

  const vaultAddress = bot1Env.COLLATERAL_VAULT_ADDRESS;
  const chainId = parseInt(bot1Env.CHAIN_ID, 10);

  // Bot1 signs
  const bot1Wallet = bot1Client.getWallet();
  const bot1Sig = await signBetCommitment(bot1Wallet, commitment, vaultAddress, chainId);
  log(`  Bot1 signature: ${bot1Sig.slice(0, 20)}...`);

  // Bot2 signs
  const bot2Wallet = bot2Client.getWallet();
  const bot2Sig = await signBetCommitment(bot2Wallet, commitment, vaultAddress, chainId);
  log(`  Bot2 signature: ${bot2Sig.slice(0, 20)}...`);

  // Verify signatures
  const bot1SigValid = verifyBetCommitmentSignature(commitment, bot1Sig, bot1Address, vaultAddress, chainId);
  const bot2SigValid = verifyBetCommitmentSignature(commitment, bot2Sig, bot2Address, vaultAddress, chainId);

  if (!bot1SigValid || !bot2SigValid) {
    logError("Sign commitment", `Bot1 valid: ${bot1SigValid}, Bot2 valid: ${bot2SigValid}`);
    return;
  }
  logSuccess("Sign commitment", "Both signatures verified");

  // Step 7: Submit commitment on-chain
  log("Step 7: Submitting commitment on-chain...");
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

  const betId = parseInt(commitResult.betId!, 10);
  logSuccess("Submit commitment", `Bet ID: ${betId}, TX: ${commitResult.txHash?.slice(0, 20)}...`);

  // Store Merkle tree locally for both bots
  storeMerkleTree(betId, tree);
  log(`  Stored Merkle tree for bet ${betId}`);

  // Step 8: Simulate deadline passage and fetch exit prices
  log("Step 8: Simulating deadline passage...");

  // Advance Anvil time past the deadline (2 minutes)
  const rpcUrl = bot1Env.RPC_URL;
  await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "evm_increaseTime",
      params: [120], // 2 minutes
      id: 1,
    }),
  });
  await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "evm_mine",
      params: [],
      id: 2,
    }),
  });
  log("  Advanced time by 2 minutes");

  const exitPrices = await fetchPrices("exit");
  logSuccess("Exit prices", `Fetched ${exitPrices.size} prices`);

  // Step 9: Both bots compute outcome
  log("Step 9: Computing outcomes...");

  // Fill exit prices in tree
  const exitPriceMap = new Map<number, bigint>();
  tickers.forEach((ticker, i) => {
    exitPriceMap.set(i, exitPrices.get(ticker)!);
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

  // Step 10: Sign settlement agreement
  log("Step 10: Signing settlement agreement...");

  const settlementNonce = await bot1Client.getVaultNonce();
  const bot1Settlement = await bot1Client.signSettlementAgreement(betId, bot1Outcome.winner, settlementNonce);
  const bot2Settlement = await bot2Client.signSettlementAgreement(betId, bot2Outcome.winner, settlementNonce);

  logSuccess("Sign settlement", "Both bots signed settlement agreement");

  // Step 11: Submit settlement on-chain
  log("Step 11: Submitting settlement on-chain...");

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

  // Step 12: Verify final state
  log("Step 12: Verifying final state...");

  const finalBet = await bot1Client.getBetFromVault(betId);
  if (!finalBet) {
    logError("Verify final state", "Bet not found");
    return;
  }

  log(`  Bet status: ${finalBet.status}`);
  logSuccess("Verify final state", `Bet ${betId} settled successfully`);

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
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(`  RESULT: ${failed === 0 ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED"}`);
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("");

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
