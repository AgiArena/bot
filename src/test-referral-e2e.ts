#!/usr/bin/env bun
/**
 * Referral System E2E Test (Story 7-1, Task 6)
 *
 * Tests the complete referral + fee flow:
 * 1. Register referral (Bot2 referred by Bot1)
 * 2. Place a bet between Bot1 and Bot2
 * 3. Settle the bet
 * 4. Verify protocol fee was deducted
 * 5. Verify mini-backend tracked referral rewards
 */

import { ethers, Wallet, Contract } from "ethers";

const RPC_URL = process.env.RPC_URL || "http://localhost:33010";
// Hardcode mini-backend URL (bun auto-loads .env which has wrong BACKEND_URL)
const BACKEND_URL = "http://142.132.164.24";

// New contracts
const VAULT_ADDRESS = "0x5F0053e7F8D70d14aa0Ec7590b99aa5f919dB607";
const WIND_ADDRESS = "0x4e5b65FB12d4165E22f5861D97A33BA45c006114";

// Bot keys
const BOT1_KEY = "0x203298e6a2b845c6dde179f3f991ae4c081ad963e20c9fe39d45893c00a0aea5";
const BOT2_KEY = "0x237112963af91b42ca778fbe434a819b7e862cd025be3c86ce453bdd3e633165";

const VAULT_ABI = [
  // Struct-based commitBet: (BetCommitment, creatorSig, fillerSig)
  "function commitBet(tuple(bytes32 tradesRoot, address creator, address filler, uint256 creatorAmount, uint256 fillerAmount, uint256 deadline, uint256 nonce, uint256 expiry) commitment, bytes creatorSig, bytes fillerSig) external returns (uint256 betId)",
  // Struct-based settleByAgreement: (SettlementAgreement, creatorSig, fillerSig)
  "function settleByAgreement(tuple(uint256 betId, address winner, uint256 nonce, uint256 expiry) agreement, bytes creatorSig, bytes fillerSig) external",
  "function nextBetId() view returns (uint256)",
  "function bets(uint256) view returns (bytes32 tradesRoot, address creator, address filler, uint256 creatorAmount, uint256 fillerAmount, uint256 deadline, uint256 createdAt, uint8 status)",
  "function availableBalance(address) view returns (uint256)",
  "function lockedBalance(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function protocolFeeBps() view returns (uint256)",
  "function feeCollector() view returns (address)",
  "function accumulatedFees() view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function BET_COMMITMENT_TYPEHASH() view returns (bytes32)",
  "function SETTLEMENT_AGREEMENT_TYPEHASH() view returns (bytes32)",
  "event BetCommitted(uint256 indexed betId, address indexed creator, address indexed filler, bytes32 tradesRoot, uint256 creatorAmount, uint256 fillerAmount, uint256 deadline)",
  "event BetSettled(uint256 indexed betId, address indexed winner, uint256 payout)",
  "event FeeCollected(uint256 indexed betId, uint256 feeAmount, address collector)",
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== Story 7-1 E2E Test: Referral + Protocol Fee ===\n");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const bot1 = new Wallet(BOT1_KEY, provider);
  const bot2 = new Wallet(BOT2_KEY, provider);
  const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, bot1);

  const bot1Addr = bot1.address.toLowerCase();
  const bot2Addr = bot2.address.toLowerCase();
  console.log(`Bot1 (maker/referrer): ${bot1Addr}`);
  console.log(`Bot2 (taker/referred): ${bot2Addr}\n`);

  // Step 1: Verify referral is registered
  console.log("--- Step 1: Verify referral registration ---");
  let stats: any = { referralCount: 0, referrals: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `${BACKEND_URL}/api/referrals/${bot1Addr}`;
      console.log(`  Fetching: ${url} (attempt ${attempt + 1})`);
      const statsRes = await fetch(url);
      console.log(`  HTTP ${statsRes.status}`);
      if (statsRes.ok) {
        stats = await statsRes.json();
        break;
      }
      await sleep(2000);
    } catch (e: any) {
      console.log(`  Fetch error: ${e.message}`);
      await sleep(2000);
    }
  }
  console.log(`  Referral count: ${stats.referralCount}`);
  console.log(`  Referred users: ${stats.referrals.map((r: any) => r.referred).join(", ")}`);

  if (stats.referralCount === 0) {
    console.log("  Registering referral (Bot2 referred by Bot1)...");
    const regRes = await fetch(`${BACKEND_URL}/api/referrals/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referrer: bot1Addr, referred: bot2Addr }),
    });
    console.log(`  Register response: HTTP ${regRes.status}`);
  } else {
    console.log("  Already registered");
  }

  // Step 2: Verify fee config
  console.log("\n--- Step 2: Verify fee config ---");
  const feeBps = await vault.protocolFeeBps();
  const collector = await vault.feeCollector();
  console.log(`  Fee: ${feeBps} bps (${Number(feeBps) / 100}%)`);
  console.log(`  Collector: ${collector}`);

  // Step 3: Place a bet
  console.log("\n--- Step 3: Place a bet ---");
  const domainSeparator = await vault.DOMAIN_SEPARATOR();
  const commitTypehash = await vault.BET_COMMITMENT_TYPEHASH();
  const settlementTypehash = await vault.SETTLEMENT_AGREEMENT_TYPEHASH();

  // Read current nonces
  const nonce = await vault.nonces(bot1.address);
  const nonce2 = await vault.nonces(bot2.address);
  console.log(`  Bot1 nonce: ${nonce}, Bot2 nonce: ${nonce2}`);
  if (nonce !== nonce2) {
    console.log(`  WARNING: Nonces differ — contract requires matching nonces. Aborting.`);
    process.exit(1);
  }

  const stakeAmount = ethers.parseEther("1"); // 1 WIND each
  const tradesRoot = ethers.keccak256(ethers.toUtf8Bytes(`test-referral-e2e-${Date.now()}`));
  const block = await provider.getBlock("latest");
  const now = Math.floor(Date.now() / 1000);
  // Use real wall-clock time (Kurtosis L3 block.timestamp can lag behind query time)
  const baseTime = Math.max(block!.timestamp, now);
  console.log(`  block.timestamp=${block!.timestamp}, wall-clock=${now}, using baseTime=${baseTime}`);
  // Deadline must be in the future at commit-time, but we want it to pass quickly for settlement
  const deadline = baseTime + 30; // 30 seconds from now
  const expiry = baseTime + 7200; // 2 hours

  // Build BetCommitment struct hash matching contract's _hashBetCommitment:
  // keccak256(abi.encode(TYPEHASH, tradesRoot, creator, filler, creatorAmount, fillerAmount, deadline, nonce, expiry))
  const commitmentHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "address", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
      [commitTypehash, tradesRoot, bot1.address, bot2.address, stakeAmount, stakeAmount, deadline, nonce, expiry]
    )
  );
  const digest = ethers.keccak256(
    ethers.solidityPacked(["bytes2", "bytes32", "bytes32"], ["0x1901", domainSeparator, commitmentHash])
  );

  const bot1CommitSig = bot1.signingKey.sign(digest).serialized;
  const bot2CommitSig = bot2.signingKey.sign(digest).serialized;

  // Get balances before
  const bot1BalBefore = await vault.availableBalance(bot1.address);
  const bot2BalBefore = await vault.availableBalance(bot2.address);
  const feesBefore = await vault.accumulatedFees();
  console.log(`  Bot1 vault balance before: ${ethers.formatEther(bot1BalBefore)} WIND`);
  console.log(`  Bot2 vault balance before: ${ethers.formatEther(bot2BalBefore)} WIND`);

  if (bot1BalBefore < stakeAmount || bot2BalBefore < stakeAmount) {
    console.log("  ERROR: Insufficient vault balance. Need at least 1 WIND each.");
    process.exit(1);
  }

  // Submit commitment with struct
  const commitment = {
    tradesRoot,
    creator: bot1.address,
    filler: bot2.address,
    creatorAmount: stakeAmount,
    fillerAmount: stakeAmount,
    deadline,
    nonce,
    expiry,
  };

  const commitTx = await vault.commitBet(commitment, bot1CommitSig, bot2CommitSig);
  const commitReceipt = await commitTx.wait();
  const betCommittedLog = commitReceipt.logs.find(
    (l: any) => l.topics[0] === vault.interface.getEvent("BetCommitted")!.topicHash
  );
  const betId = BigInt(betCommittedLog.topics[1]);
  console.log(`  Bet committed! betId=${betId}, tx=${commitTx.hash}`);

  // Step 4: Wait for deadline to pass, then settle
  console.log("\n--- Step 4: Settle bet (Bot1 wins) ---");
  console.log(`  Waiting for deadline to pass (${deadline})...`);
  // Kurtosis L3 only produces blocks on transactions (~1s per block).
  // Send dummy txs to advance block.timestamp past the deadline.
  for (let i = 0; i < 60; i++) {
    const latestBlock = await provider.getBlock("latest");
    if (latestBlock!.timestamp > deadline) {
      console.log(`  Deadline passed (block.timestamp=${latestBlock!.timestamp})`);
      break;
    }
    if (i % 10 === 0) {
      console.log(`  block.timestamp=${latestBlock!.timestamp}, need ${deadline - latestBlock!.timestamp}s more...`);
    }
    const dummyTx = await bot1.sendTransaction({ to: bot1.address, value: 0 });
    await dummyTx.wait();
    await sleep(500);
  }
  // Send a couple extra dummy txs to ensure we're safely past deadline
  for (let i = 0; i < 3; i++) {
    const dummyTx = await bot1.sendTransaction({ to: bot1.address, value: 0 });
    await dummyTx.wait();
  }

  const winner = bot1.address;

  // Read updated nonces (incremented after commitBet)
  const settleNonce = await vault.nonces(bot1.address);
  console.log(`  Settlement nonce: ${settleNonce}`);

  // Build SettlementAgreement struct hash matching contract's _hashSettlementAgreement:
  // keccak256(abi.encode(TYPEHASH, betId, winner, nonce, expiry))
  const settlementHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "uint256", "uint256"],
      [settlementTypehash, betId, winner, settleNonce, expiry]
    )
  );
  const settlementDigest = ethers.keccak256(
    ethers.solidityPacked(["bytes2", "bytes32", "bytes32"], ["0x1901", domainSeparator, settlementHash])
  );

  const bot1SettleSig = bot1.signingKey.sign(settlementDigest).serialized;
  const bot2SettleSig = bot2.signingKey.sign(settlementDigest).serialized;

  const agreement = {
    betId,
    winner,
    nonce: settleNonce,
    expiry,
  };

  const settleTx = await vault.settleByAgreement(agreement, bot1SettleSig, bot2SettleSig);
  const settleReceipt = await settleTx.wait();
  console.log(`  Settled! tx=${settleTx.hash}`);

  // Parse events
  for (const log of settleReceipt.logs) {
    try {
      const parsed = vault.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed) {
        if (parsed.name === "BetSettled") {
          console.log(`  BetSettled: winner=${parsed.args.winner}, payout=${ethers.formatEther(parsed.args.payout)} WIND`);
        }
        if (parsed.name === "FeeCollected") {
          console.log(`  FeeCollected: betId=${parsed.args.betId}, fee=${ethers.formatEther(parsed.args.feeAmount)} WIND, collector=${parsed.args.collector}`);
        }
      }
    } catch {}
  }

  // Step 5: Verify fee deduction
  console.log("\n--- Step 5: Verify fee deduction ---");
  const bot1BalAfter = await vault.availableBalance(bot1.address);
  const feesAfter = await vault.accumulatedFees();
  const totalPot = stakeAmount * 2n;
  const expectedFee = (totalPot * feeBps) / 10000n;
  const expectedPayout = totalPot - expectedFee;

  console.log(`  Total pot: ${ethers.formatEther(totalPot)} WIND`);
  console.log(`  Expected fee (${Number(feeBps)} bps): ${ethers.formatEther(expectedFee)} WIND`);
  console.log(`  Expected payout: ${ethers.formatEther(expectedPayout)} WIND`);
  console.log(`  Bot1 vault balance after: ${ethers.formatEther(bot1BalAfter)} WIND`);
  console.log(`  Accumulated fees: ${ethers.formatEther(feesBefore)} -> ${ethers.formatEther(feesAfter)} WIND`);
  console.log(`  Fee collected: ${ethers.formatEther(feesAfter - feesBefore)} WIND`);

  const feeCorrect = feesAfter - feesBefore === expectedFee;
  console.log(`  Fee amount correct: ${feeCorrect ? "PASS" : "FAIL"}`);

  // Bot1 balance should be: before - stake + payout (winner) + fee (as feeCollector)
  const expectedBot1Bal = bot1BalBefore - stakeAmount + expectedPayout + expectedFee;
  const bot1BalCorrect = bot1BalAfter === expectedBot1Bal;
  console.log(`  Bot1 balance correct: ${bot1BalCorrect ? "PASS" : "FAIL"} (expected ${ethers.formatEther(expectedBot1Bal)})`);

  // Step 6: Wait for indexer and verify backend
  console.log("\n--- Step 6: Wait for indexer to catch up ---");
  await sleep(12000); // Wait 12 seconds for indexer

  try {
    const statsAfter = await fetch(`${BACKEND_URL}/api/referrals/${bot1Addr}`).then((r) => r.json());
    console.log(`  Referral stats after settlement:`);
    console.log(`    Total fee generated: ${statsAfter.totalFeeGenerated}`);
    console.log(`    Total rewards: ${statsAfter.totalRewards}`);

    const rewardsRes = await fetch(`${BACKEND_URL}/api/referrals/${bot1Addr}/rewards`).then((r) => r.json());
    console.log(`  Rewards epochs: ${JSON.stringify(rewardsRes.epochs)}`);
  } catch (e: any) {
    console.log(`  Backend fetch error: ${e.message}`);
  }

  // Step 7: Verify bet in backend
  try {
    const betsRes = await fetch(`${BACKEND_URL}/api/bets/recent`).then((r) => r.json());
    const ourBet = betsRes.find?.((b: any) => b.bet_id === Number(betId));
    if (ourBet) {
      console.log(`\n  Backend bet found: status=${ourBet.status}, winner=${ourBet.winner}`);
    } else {
      console.log(`\n  Backend: bet ${betId} not yet indexed (may need more time)`);
    }
  } catch (e: any) {
    console.log(`\n  Backend bets fetch error: ${e.message}`);
  }

  console.log("\n=== E2E Test Complete ===");
  console.log(`  Protocol fee deduction: ${feeCorrect ? "PASS" : "FAIL"}`);
  console.log(`  Winner balance correct: ${bot1BalCorrect ? "PASS" : "FAIL"}`);
}

main().catch(console.error);
