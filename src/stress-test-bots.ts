/**
 * Stress Test: 1M-Trade Bilateral Bets — Parallel
 *
 * Fires concurrent bet creation cycles for a configurable duration.
 * Measures throughput per phase: generate → hash → compress → P2P → on-chain.
 *
 * Runs both maker and taker in-process to avoid IPC overhead.
 * On-chain commits are serialized (nonce ordering), but compute is pipelined.
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.stress bun run src/stress-test-bots.ts
 *
 * Requires SSH tunnel: ssh -L 33010:localhost:32795 index-maker/prod/be
 */

import { compressTrades, decompressTrades } from "./p2p/compression";
import { buildSimplifiedTrades } from "./p2p/fast-hash";
import { signBetCommitment, type BetCommitmentData } from "./p2p/commitment";
import { ChainClient } from "./chain-client";
import { startP2PServer } from "./p2p/server";
import { storeMerkleTree } from "./p2p/trade-storage";
import type { MerkleTree, Trade } from "./merkle-tree";
import type {
  P2PServerConfig,
  BilateralTradeProposal,
  CompressedTradesPayload,
} from "./p2p/types";

// ============================================================================
// Config
// ============================================================================

const NUM_ASSETS = parseInt(process.env.NUM_ASSETS || "1000000", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "3", 10);
const DURATION_S = parseInt(process.env.DURATION_S || "120", 10);
const MAX_MEMORY_GB = parseFloat(process.env.MAX_MEMORY_GB || "4");
const STAKE_AMOUNT = BigInt(process.env.STAKE_AMOUNT || "100000000000000");
const DEADLINE_OFFSET_SECS = parseInt(process.env.DEADLINE_OFFSET_SECS || "300", 10);
const CHAIN_ID = parseInt(process.env.CHAIN_ID || "111222333", 10);
const VAULT_ADDRESS = process.env.COLLATERAL_VAULT_ADDRESS!;
const P2P_PORT = parseInt(process.env.P2P_PORT || "7002", 10);
const P2P_ENDPOINT = process.env.P2P_ENDPOINT || `http://localhost:${P2P_PORT}`;
const TRADE_STORAGE_DIR = process.env.TRADE_STORAGE_DIR || "./data/stress-trades";

// Override storage dir for stress test isolation
process.env.TRADE_STORAGE_DIR = TRADE_STORAGE_DIR;

const MAKER_KEY = process.env.MAKER_PRIVATE_KEY!;
const MAKER_ADDRESS = process.env.MAKER_ADDRESS!;
const TAKER_KEY = process.env.TAKER_PRIVATE_KEY!;
const TAKER_ADDRESS = process.env.TAKER_ADDRESS!;

if (!MAKER_KEY || !TAKER_KEY || !VAULT_ADDRESS) {
  console.error("Missing required env vars: MAKER_PRIVATE_KEY, TAKER_PRIVATE_KEY, COLLATERAL_VAULT_ADDRESS");
  process.exit(1);
}

// ============================================================================
// Helpers
// ============================================================================

function memMB(): { heapMb: number; rssMb: number } {
  const mem = process.memoryUsage();
  return {
    heapMb: Math.round(mem.heapUsed / 1024 / 1024),
    rssMb: Math.round(mem.rss / 1024 / 1024),
  };
}

function sec(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function checkMemoryPressure(): boolean {
  const mem = process.memoryUsage();
  const rssMb = mem.rss / 1024 / 1024;
  return rssMb > MAX_MEMORY_GB * 1024 * 0.85;
}

// ============================================================================
// Mock Data Generator
// ============================================================================

const methodOptions = ["up:0", "down:5", "flat:2", "up:10", "down:0"];

function generateMockTrades(count: number, snapshotId: string): {
  tickers: string[];
  methods: string[];
  entryPriceMap: Map<number, bigint>;
  trades: Trade[];
} {
  const tickers: string[] = new Array(count);
  const methods: string[] = new Array(count);
  const entryPriceMap = new Map<number, bigint>();
  const trades: Trade[] = new Array(count);

  for (let i = 0; i < count; i++) {
    tickers[i] = `STRESS-${i.toString().padStart(7, "0")}`;
    methods[i] = methodOptions[i % methodOptions.length];
    const price = BigInt(Math.floor((Math.random() * 100000 + 0.01) * 1e18));
    entryPriceMap.set(i, price);
    trades[i] = {
      tradeId: `0x${i.toString(16).padStart(64, "0")}` as `0x${string}`,
      ticker: tickers[i],
      source: snapshotId,
      method: methods[i],
      entryPrice: price,
      exitPrice: 0n,
      won: false,
      cancelled: false,
    };
  }

  return { tickers, methods, entryPriceMap, trades };
}

// ============================================================================
// Metrics
// ============================================================================

interface WaveMetrics {
  wave: number;
  betsAttempted: number;
  betsCommitted: number;
  genMs: number;
  hashMs: number;
  compressMs: number;
  p2pMs: number;
  chainMs: number;
  memMb: number;
  errors: string[];
}

interface PipelineTimings {
  genMs: number;
  hashMs: number;
  compressMs: number;
  p2pMs: number;
  chainMs: number;
}

const allTimings: PipelineTimings[] = [];
const waveResults: WaveMetrics[] = [];
let totalBetsCommitted = 0;
let totalErrors = 0;
let totalSkipped = 0;
let peakRssMb = 0;
let peakHeapMb = 0;

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=".repeat(64));
  console.log(`STRESS TEST: ${fmt(NUM_ASSETS)}-trade bilateral bets (${DURATION_S}s, concurrency=${CONCURRENCY})`);
  console.log("=".repeat(64));
  console.log();

  // Init chain clients
  const commonConfig = {
    collateralAddress: process.env.COLLATERAL_ADDRESS,
    botRegistryAddress: process.env.BOT_REGISTRY_ADDRESS,
    collateralVaultAddress: VAULT_ADDRESS,
    rpcUrl: process.env.RPC_URL,
    chainId: CHAIN_ID,
  };

  const makerClient = new ChainClient({ privateKey: MAKER_KEY, ...commonConfig });
  const takerClient = new ChainClient({ privateKey: TAKER_KEY, ...commonConfig });

  console.log(`Maker: ${makerClient.getAddress()}`);
  console.log(`Taker: ${takerClient.getAddress()}`);
  console.log();

  // Check balances
  try {
    const makerBal = await makerClient.getVaultBalance();
    const takerBal = await takerClient.getVaultBalance();
    console.log(`Maker vault: available=${makerBal.available.toString()}, locked=${makerBal.locked.toString()}`);
    console.log(`Taker vault: available=${takerBal.available.toString()}, locked=${takerBal.locked.toString()}`);
  } catch (e) {
    console.log(`Balance check failed: ${(e as Error).message}`);
  }
  console.log();

  // Start in-process taker P2P server (auto-accepts everything)
  const takerServerConfig: P2PServerConfig = {
    port: P2P_PORT,
    endpoint: P2P_ENDPOINT,
    address: TAKER_ADDRESS,
    pubkeyHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    rateLimitPerSecond: 1000, // High limit for stress test
  };

  const serverHandle = startP2PServer(takerServerConfig, {
    onBilateralProposal: async (proposal: BilateralTradeProposal, from: string) => {
      try {
        const commitment: BetCommitmentData = {
          tradesRoot: proposal.tradesRoot,
          creator: proposal.creator,
          filler: TAKER_ADDRESS,
          creatorAmount: BigInt(proposal.creatorAmount),
          fillerAmount: BigInt(proposal.fillerAmount),
          deadline: proposal.deadline,
          nonce: BigInt(proposal.nonce),
          expiry: proposal.expiry,
        };

        const sig = await signBetCommitment(
          takerClient.getWallet(),
          commitment,
          VAULT_ADDRESS,
          CHAIN_ID,
        );

        return { accepted: true, signature: sig, signer: TAKER_ADDRESS };
      } catch (error) {
        return { accepted: false, reason: (error as Error).message };
      }
    },
  });

  console.log(`Taker P2P server started on port ${P2P_PORT}`);
  console.log();

  // Run stress loop
  const startTime = Date.now();
  const endTime = startTime + DURATION_S * 1000;
  let waveNum = 0;

  while (Date.now() < endTime) {
    waveNum++;
    const waveStart = Date.now();

    // Memory check
    const mem = memMB();
    if (mem.rssMb > peakRssMb) peakRssMb = mem.rssMb;
    if (mem.heapMb > peakHeapMb) peakHeapMb = mem.heapMb;

    if (checkMemoryPressure()) {
      console.log(`Wave ${waveNum}: SKIPPED — memory pressure (RSS: ${mem.rssMb}MB, limit: ${MAX_MEMORY_GB}GB)`);
      totalSkipped++;
      // Wait and try GC
      if (typeof global.gc === "function") global.gc();
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    // Phase 1: Generate + hash + compress in parallel (CONCURRENCY pipelines)
    const pipelines: Array<{
      snapshotId: string;
      tree: MerkleTree;
      compressedTrades: CompressedTradesPayload;
      tradesRoot: string;
      genMs: number;
      hashMs: number;
      compressMs: number;
    }> = [];

    const prepStart = Date.now();
    const prepResults = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, async (_, i) => {
        const snapshotId = `stress-w${waveNum}-p${i}-${Date.now()}`;

        // Generate
        const t0 = performance.now();
        const { tickers, methods, entryPriceMap, trades } = generateMockTrades(NUM_ASSETS, snapshotId);
        const genMs = performance.now() - t0;

        // Hash
        const t1 = performance.now();
        const simplified = buildSimplifiedTrades(snapshotId, tickers, methods, entryPriceMap);
        const hashMs = performance.now() - t1;

        // Build tree structure
        const treeTrades: Trade[] = trades;
        const tree: MerkleTree = {
          snapshotId,
          root: simplified.tradesHash,
          trades: treeTrades,
          leaves: [],
        };

        // Compress
        const t2 = performance.now();
        const compressedTrades = compressTrades(tree.trades);
        const compressMs = performance.now() - t2;

        return {
          snapshotId,
          tree,
          compressedTrades: compressedTrades as CompressedTradesPayload,
          tradesRoot: simplified.tradesHash,
          genMs,
          hashMs,
          compressMs,
        };
      })
    );

    // Collect successful preps
    const waveErrors: string[] = [];
    for (const result of prepResults) {
      if (result.status === "fulfilled") {
        pipelines.push(result.value);
      } else {
        waveErrors.push(result.reason?.message || "Prep failed");
        totalErrors++;
      }
    }

    // Phase 2: P2P propose + on-chain commit (sequential for nonce ordering)
    let p2pTotalMs = 0;
    let chainTotalMs = 0;
    let committed = 0;

    // Get nonce once before the sequential loop
    let currentNonce: bigint;
    try {
      currentNonce = await makerClient.getVaultNonce();
    } catch (e) {
      console.log(`Wave ${waveNum}: FAILED to get nonce: ${(e as Error).message}`);
      totalErrors++;
      continue;
    }

    for (const pipeline of pipelines) {
      const deadline = Math.floor(Date.now() / 1000) + DEADLINE_OFFSET_SECS;
      const expiry = Math.floor(Date.now() / 1000) + 300;

      const commitment: BetCommitmentData = {
        tradesRoot: pipeline.tradesRoot,
        creator: MAKER_ADDRESS,
        filler: TAKER_ADDRESS,
        creatorAmount: STAKE_AMOUNT,
        fillerAmount: STAKE_AMOUNT,
        deadline,
        nonce: currentNonce,
        expiry,
      };

      // Sign as maker
      let makerSig: string;
      try {
        makerSig = await signBetCommitment(makerClient.getWallet(), commitment, VAULT_ADDRESS, CHAIN_ID);
      } catch (e) {
        waveErrors.push(`Maker sign: ${(e as Error).message}`);
        totalErrors++;
        continue;
      }

      // P2P: POST proposal to taker
      const t3 = performance.now();
      let takerSig: string;
      try {
        const proposal = {
          tradesRoot: pipeline.tradesRoot,
          creator: MAKER_ADDRESS,
          creatorAmount: STAKE_AMOUNT.toString(),
          fillerAmount: STAKE_AMOUNT.toString(),
          deadline,
          nonce: currentNonce.toString(),
          expiry,
          creatorSignature: makerSig,
          compressedTrades: pipeline.compressedTrades,
          snapshotId: pipeline.snapshotId,
        };

        const resp = await fetch(`${P2P_ENDPOINT}/p2p/proposal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(proposal),
        });

        const result = await resp.json() as { accepted: boolean; signature?: string; reason?: string };
        if (!result.accepted || !result.signature) {
          waveErrors.push(`P2P rejected: ${result.reason || "no signature"}`);
          totalErrors++;
          p2pTotalMs += performance.now() - t3;
          continue;
        }
        takerSig = result.signature;
      } catch (e) {
        waveErrors.push(`P2P: ${(e as Error).message}`);
        totalErrors++;
        p2pTotalMs += performance.now() - t3;
        continue;
      }
      const p2pMs = performance.now() - t3;
      p2pTotalMs += p2pMs;

      // On-chain commit
      const t4 = performance.now();
      try {
        const commitResult = await makerClient.commitBilateralBet(commitment, makerSig, takerSig);
        if (commitResult.success) {
          committed++;
          totalBetsCommitted++;
          const betId = parseInt(commitResult.betId || "0", 10);

          // Store tree (async-ish, won't block much)
          try {
            storeMerkleTree(betId, pipeline.tree);
          } catch {
            // Non-critical — don't fail the pipeline
          }

          // Free trade data from memory
          pipeline.tree.trades = [];
          pipeline.tree.leaves = [];
        } else {
          waveErrors.push(`Chain: ${commitResult.error || "unknown"}`);
          totalErrors++;
        }
      } catch (e) {
        waveErrors.push(`Chain: ${(e as Error).message}`);
        totalErrors++;
      }
      const chainMs = performance.now() - t4;
      chainTotalMs += chainMs;

      // Increment nonce for next bet
      currentNonce++;

      // Record per-pipeline timings
      allTimings.push({
        genMs: pipeline.genMs,
        hashMs: pipeline.hashMs,
        compressMs: pipeline.compressMs,
        p2pMs,
        chainMs,
      });
    }

    // Wave summary
    const avgGen = pipelines.length > 0 ? avg(pipelines.map(p => p.genMs)) : 0;
    const avgHash = pipelines.length > 0 ? avg(pipelines.map(p => p.hashMs)) : 0;
    const avgCompress = pipelines.length > 0 ? avg(pipelines.map(p => p.compressMs)) : 0;

    const currentMem = memMB();
    if (currentMem.rssMb > peakRssMb) peakRssMb = currentMem.rssMb;
    if (currentMem.heapMb > peakHeapMb) peakHeapMb = currentMem.heapMb;

    const waveMetrics: WaveMetrics = {
      wave: waveNum,
      betsAttempted: pipelines.length,
      betsCommitted: committed,
      genMs: avgGen,
      hashMs: avgHash,
      compressMs: avgCompress,
      p2pMs: pipelines.length > 0 ? p2pTotalMs / pipelines.length : 0,
      chainMs: pipelines.length > 0 ? chainTotalMs / pipelines.length : 0,
      memMb: currentMem.rssMb,
      errors: waveErrors,
    };
    waveResults.push(waveMetrics);

    const errStr = waveErrors.length > 0 ? ` | ERR: ${waveErrors.length}` : "";
    console.log(
      `Wave ${String(waveNum).padStart(3)}: ${committed}/${pipelines.length} bets` +
      ` | gen ${sec(avgGen)} | hash ${sec(avgHash)} | gzip ${sec(avgCompress)}` +
      ` | p2p ${sec(waveMetrics.p2pMs)} | chain ${sec(waveMetrics.chainMs)}` +
      ` | mem ${currentMem.rssMb}MB${errStr}`
    );
  }

  // ============================================================================
  // Final Report
  // ============================================================================

  const totalElapsedS = (Date.now() - startTime) / 1000;
  const throughputPerMin = totalElapsedS > 0 ? (totalBetsCommitted / totalElapsedS) * 60 : 0;
  const totalTrades = totalBetsCommitted * NUM_ASSETS;

  console.log();
  console.log("=".repeat(64));
  console.log(`RESULTS (${totalElapsedS.toFixed(0)}s)`);
  console.log("=".repeat(64));
  console.log();

  console.log(`Total bets:         ${fmt(totalBetsCommitted)}`);
  console.log(`Throughput:         ${throughputPerMin.toFixed(1)} bets/min (${fmt(Math.round(throughputPerMin * NUM_ASSETS))} trades/min)`);
  console.log(`Total trades:       ${fmt(totalTrades)}`);
  console.log(`Waves:              ${waveResults.length}`);
  console.log();

  if (allTimings.length > 0) {
    console.log("Per-phase timing (avg / p95):");
    console.log(`  Mock data gen:    ${sec(avg(allTimings.map(t => t.genMs)))} / ${sec(percentile(allTimings.map(t => t.genMs), 95))}`);
    console.log(`  Hash (SHA-256):   ${sec(avg(allTimings.map(t => t.hashMs)))} / ${sec(percentile(allTimings.map(t => t.hashMs), 95))}`);
    console.log(`  Compress (gz1):   ${sec(avg(allTimings.map(t => t.compressMs)))} / ${sec(percentile(allTimings.map(t => t.compressMs), 95))}`);
    console.log(`  P2P round-trip:   ${sec(avg(allTimings.map(t => t.p2pMs)))} / ${sec(percentile(allTimings.map(t => t.p2pMs), 95))}`);
    console.log(`  On-chain commit:  ${sec(avg(allTimings.map(t => t.chainMs)))} / ${sec(percentile(allTimings.map(t => t.chainMs), 95))}`);
    console.log();
  }

  console.log("Memory:");
  console.log(`  Peak RSS:         ${peakRssMb} MB`);
  console.log(`  Peak heap:        ${peakHeapMb} MB`);
  console.log(`  Max active bets:  ${totalBetsCommitted}`);
  console.log();

  console.log(`Errors:  ${totalErrors} | Skipped:  ${totalSkipped}`);

  if (totalErrors > 0) {
    // Show unique error types
    const errorTypes = new Map<string, number>();
    for (const w of waveResults) {
      for (const e of w.errors) {
        const key = e.slice(0, 80);
        errorTypes.set(key, (errorTypes.get(key) || 0) + 1);
      }
    }
    console.log();
    console.log("Error breakdown:");
    for (const [msg, count] of errorTypes) {
      console.log(`  ${count}x  ${msg}`);
    }
  }

  console.log("=".repeat(64));

  // Cleanup
  serverHandle.stop();
  process.exit(0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
