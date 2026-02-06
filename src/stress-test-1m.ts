/**
 * Stress Test: 1 Million Asset Portfolio
 *
 * Benchmarks the full bilateral bet lifecycle at scale:
 * 1. MAKER: generate portfolio, hash, encode JSON, compress (gzip-1)
 * 2. TAKER: decompress, parse JSON, reconstruct trades, verify hash
 * 3. BOTH: compute outcome with exit prices
 * 4. Payload format comparison (JSON vs TSV vs columnar)
 * 5. Hash algorithm comparison (sha256 vs keccak256 vs blake3)
 *
 * P2P format: JSON + gzip-1
 *   - Simple, debuggable, fast to compress
 *   - Competitive E2E at typical VPS speeds (100 Mbps)
 *
 * Usage:
 *   bun run src/stress-test-1m.ts
 *   NUM_ASSETS=500000 bun run src/stress-test-1m.ts
 */

import { createHash } from "crypto";
import { keccak_256 } from "@noble/hashes/sha3";
import { blake3 } from "@noble/hashes/blake3";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  computeTradesHashUltraFast,
  type CompactTradeData,
} from "./p2p/fast-hash";
import { computeOutcomeFromTrades } from "./p2p/outcome-computer";
import { type Trade } from "./merkle-tree";

const NUM_ASSETS = parseInt(process.env.NUM_ASSETS || "1000000", 10);

// ============================================================================
// Helpers
// ============================================================================

function memMB(): string {
  return (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
}

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sec(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function pct(compressed: number, original: number): string {
  return `${((1 - compressed / original) * 100).toFixed(0)}%`;
}

// ============================================================================
// JSON + gzip-1 Encoder/Decoder
// ============================================================================

interface JsonGzipPayload {
  rawSize: number;
  compressedSize: number;
  data: Buffer; // gzip-compressed JSON
  snapshotId: string;
  tradesHash: string;
}

function encodeJsonGzip(
  trades: CompactTradeData[],
  snapshotId: string,
  tradesHash: string,
): JsonGzipPayload {
  const json = JSON.stringify({
    snapshotId,
    tradesHash,
    trades: trades.map(t => [t.ticker, t.method, t.entryPrice.toString()]),
  });
  const rawBuf = Buffer.from(json, "utf8");
  const rawSize = rawBuf.length;
  const compressed = gzipSync(rawBuf, { level: 1 });

  return { rawSize, compressedSize: compressed.length, data: compressed, snapshotId, tradesHash };
}

function decodeJsonGzip(payload: JsonGzipPayload): CompactTradeData[] {
  const json = gunzipSync(payload.data).toString("utf8");
  const parsed = JSON.parse(json);
  const arr: [string, string, string][] = parsed.trades;
  const trades: CompactTradeData[] = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    trades[i] = { ticker: arr[i][0], method: arr[i][1], entryPrice: BigInt(arr[i][2]) };
  }
  return trades;
}

// ============================================================================
// Main
// ============================================================================

console.log("=".repeat(70));
console.log(`STRESS TEST: ${NUM_ASSETS.toLocaleString()} Asset Portfolio`);
console.log("=".repeat(70));
console.log();

// ============================================================================
// [1/6] Generate Mock Data
// ============================================================================

console.log(`[1/6] Generating ${NUM_ASSETS.toLocaleString()} mock assets...`);
const t1 = performance.now();

const tickers: string[] = new Array(NUM_ASSETS);
const methods: string[] = new Array(NUM_ASSETS);
const entryPrices: bigint[] = new Array(NUM_ASSETS);
const methodOptions = ["up:0", "down:5", "flat:2", "up:10", "down:0"];

for (let i = 0; i < NUM_ASSETS; i++) {
  tickers[i] = `ASSET-${i.toString().padStart(7, "0")}`;
  methods[i] = methodOptions[i % methodOptions.length];
  entryPrices[i] = BigInt(Math.floor((Math.random() * 100000 + 0.01) * 1e18));
}

// Build compact trades array
const trades: CompactTradeData[] = new Array(NUM_ASSETS);
for (let i = 0; i < NUM_ASSETS; i++) {
  trades[i] = { ticker: tickers[i], method: methods[i], entryPrice: entryPrices[i] };
}

console.log(`   ${sec(performance.now() - t1)} | Mem: ${memMB()} MB`);
console.log();

// ============================================================================
// [2/6] MAKER: Hash + encode JSON + gzip-1
// ============================================================================

console.log(`[2/6] MAKER: Hash + encode + compress (JSON + gzip-1)...`);
const snapshotId = `stress-1m-${Date.now()}`;

// 2a. Hash all trades (SHA-256 streaming)
const t2a = performance.now();
const makerHash = computeTradesHashUltraFast(snapshotId, trades);
const dt2a = performance.now() - t2a;
console.log(`   Hash:     ${sec(dt2a)} | ${makerHash.slice(0, 18)}...`);

// 2b. Encode JSON + gzip-1
const t2b = performance.now();
const jsonPayload = encodeJsonGzip(trades, snapshotId, makerHash);
const dt2b = performance.now() - t2b;

const totalPayloadSize = jsonPayload.compressedSize;

console.log(`   Encode:   ${sec(dt2b)} | ${fmt(jsonPayload.rawSize)} -> ${fmt(jsonPayload.compressedSize)} (${pct(jsonPayload.compressedSize, jsonPayload.rawSize)} smaller)`);
console.log(`   P2P msg:  ${fmt(totalPayloadSize)}`);
console.log(`   Mem: ${memMB()} MB`);
console.log();

// ============================================================================
// [3/6] TAKER: Decompress + decode + verify (REVERSE PROCESS)
// ============================================================================

console.log(`[3/6] TAKER: Decompress, parse JSON, verify hash...`);

// 3a. Decompress + parse JSON
const t3a = performance.now();
const rxTrades = decodeJsonGzip(jsonPayload);
const dt3a = performance.now() - t3a;

// 3b. Re-hash and verify
const t3b = performance.now();
const rxHash = computeTradesHashUltraFast(snapshotId, rxTrades);
const dt3b = performance.now() - t3b;

const verified = rxHash === makerHash;
const dtReverse = dt3a + dt3b;

console.log(`   Decode:       ${sec(dt3a)} (decompress + parse ${NUM_ASSETS.toLocaleString()} trades)`);
console.log(`   Verify hash:  ${sec(dt3b)}`);
console.log(`   TOTAL:        ${sec(dtReverse)}`);
console.log(`   Hash match:   ${verified ? "YES" : "MISMATCH!"}`);
console.log(`   Mem: ${memMB()} MB`);
console.log();

// ============================================================================
// [4/6] Outcome Computation (both parties)
// ============================================================================

console.log(`[4/6] Outcome computation (${NUM_ASSETS.toLocaleString()} trades)...`);
const t4 = performance.now();

// Generate exit prices (random +-20%)
const exitPrices = new Map<number, bigint | null>();
for (let i = 0; i < NUM_ASSETS; i++) {
  exitPrices.set(i, BigInt(Math.floor(Number(entryPrices[i]) * (1 + (Math.random() - 0.5) * 0.4))));
}

// Build Trade[] for outcome
const tradesForOutcome: Trade[] = new Array(NUM_ASSETS);
for (let i = 0; i < NUM_ASSETS; i++) {
  tradesForOutcome[i] = {
    tradeId: `0x${i.toString(16).padStart(64, "0")}` as `0x${string}`,
    ticker: tickers[i],
    source: "snapshot",
    method: methods[i],
    entryPrice: entryPrices[i],
    exitPrice: 0n,
    won: false,
    cancelled: false,
  };
}

const maker = "0x6D819ceDC7B20b8F755Ec841CBd5934812Cbe13b";
const taker = "0xCE46e65a7A7527499e92337E5FBf958eABf314fa";
const outcome = computeOutcomeFromTrades(tradesForOutcome, exitPrices, maker, taker);

const dt4 = performance.now() - t4;
console.log(`   ${sec(dt4)} | Maker: ${outcome.makerWins.toLocaleString()} | Taker: ${outcome.takerWins.toLocaleString()} | Winner: ${outcome.winner === maker ? "MAKER" : "TAKER"}`);
console.log(`   Mem: ${memMB()} MB`);
console.log();

// ============================================================================
// [5/6] Payload Format Comparison
// ============================================================================

console.log(`[5/6] Payload format comparison...`);
console.log();

type CRow = { name: string; raw: number; compressed: number; compressor: string; time: number };
const cmp: CRow[] = [];

// 5a. JSON + gzip-1 (current format)
cmp.push({
  name: "JSON + gzip-1",
  raw: jsonPayload.rawSize,
  compressed: totalPayloadSize,
  compressor: "gzip-1",
  time: dt2b,
});

// 5b. TSV text + gzip-6
{
  const t = performance.now();
  const lines = new Array(NUM_ASSETS);
  for (let i = 0; i < NUM_ASSETS; i++) {
    lines[i] = `${tickers[i]}\t${methods[i]}\t${entryPrices[i]}`;
  }
  const raw = Buffer.from(lines.join("\n"), "utf8");
  const gz = gzipSync(raw, { level: 6 });
  cmp.push({ name: "TSV text", raw: raw.length, compressed: gz.length, compressor: "gzip-6", time: performance.now() - t });
}

// 5c. JSON + gzip-6 (higher compression)
{
  const t = performance.now();
  const json = JSON.stringify({
    snapshotId,
    tradesHash: makerHash,
    trades: trades.map((tr) => [tr.ticker, tr.method, tr.entryPrice.toString()]),
  });
  const raw = Buffer.from(json, "utf8");
  const gz = gzipSync(raw, { level: 6 });
  cmp.push({ name: "JSON + gzip-6", raw: raw.length, compressed: gz.length, compressor: "gzip-6", time: performance.now() - t });
}

cmp.sort((a, b) => a.compressed - b.compressed);

console.log(`  ${"Format".padEnd(26)} ${"Raw".padEnd(10)} ${"Payload".padEnd(10)} ${"Compressor".padEnd(12)} ${"Encode".padEnd(8)} ${"Note"}`);
console.log(`  ${"-".repeat(24)} ${"-".repeat(8)} ${"-".repeat(8)} ${"-".repeat(10)} ${"-".repeat(6)} ${"-".repeat(20)}`);
for (const r of cmp) {
  const gzip6Base = cmp.find(c => c.name === "JSON + gzip-6")!.compressed;
  const vs = `${pct(r.compressed, gzip6Base)} vs gzip-6`;
  console.log(`  ${r.name.padEnd(26)} ${fmt(r.raw).padEnd(10)} ${fmt(r.compressed).padEnd(10)} ${r.compressor.padEnd(12)} ${sec(r.time).padEnd(8)} ${vs}`);
}
console.log();

// ============================================================================
// [6/6] Hash Algorithm Comparison
// ============================================================================

console.log(`[6/6] Hash algorithm comparison (${NUM_ASSETS.toLocaleString()} trades)...`);
console.log();

// Pre-build per-trade strings once to isolate hash cost
const tradeStrings: string[] = new Array(NUM_ASSETS);
for (let i = 0; i < NUM_ASSETS; i++) {
  tradeStrings[i] = `${tickers[i]}:${methods[i]}:${entryPrices[i]}|`;
}
const headerStr = `${snapshotId}|`;

type HRow = { name: string; time: number; hash: string };
const hashes: HRow[] = [];

// SHA-256 (Node crypto - hardware accelerated)
{
  const t = performance.now();
  const h = createHash("sha256");
  h.update(headerStr);
  for (let i = 0; i < NUM_ASSETS; i++) h.update(tradeStrings[i]);
  const d = h.digest("hex");
  hashes.push({ name: "SHA-256 (crypto)", time: performance.now() - t, hash: d.slice(0, 16) });
}

// SHA-256 (Bun native)
{
  const t = performance.now();
  const h = new Bun.CryptoHasher("sha256");
  h.update(headerStr);
  for (let i = 0; i < NUM_ASSETS; i++) h.update(tradeStrings[i]);
  const d = Buffer.from(h.digest()).toString("hex");
  hashes.push({ name: "SHA-256 (Bun)", time: performance.now() - t, hash: d.slice(0, 16) });
}

// Keccak-256 (noble/hashes)
{
  const t = performance.now();
  const h = keccak_256.create();
  h.update(Buffer.from(headerStr));
  for (let i = 0; i < NUM_ASSETS; i++) h.update(Buffer.from(tradeStrings[i]));
  const d = Buffer.from(h.digest()).toString("hex");
  hashes.push({ name: "Keccak-256 (noble)", time: performance.now() - t, hash: d.slice(0, 16) });
}

// BLAKE3 (noble/hashes)
{
  const t = performance.now();
  const h = blake3.create({ dkLen: 32 });
  h.update(Buffer.from(headerStr));
  for (let i = 0; i < NUM_ASSETS; i++) h.update(Buffer.from(tradeStrings[i]));
  const d = Buffer.from(h.digest()).toString("hex");
  hashes.push({ name: "BLAKE3 (noble)", time: performance.now() - t, hash: d.slice(0, 16) });
}

// SHA-512/256 (Bun native)
{
  const t = performance.now();
  const h = new Bun.CryptoHasher("sha512-256");
  h.update(headerStr);
  for (let i = 0; i < NUM_ASSETS; i++) h.update(tradeStrings[i]);
  const d = Buffer.from(h.digest()).toString("hex");
  hashes.push({ name: "SHA-512/256 (Bun)", time: performance.now() - t, hash: d.slice(0, 16) });
}

hashes.sort((a, b) => a.time - b.time);
const fastest = hashes[0].time;

console.log(`  ${"Algorithm".padEnd(22)} ${"Time".padEnd(10)} ${"Speed".padEnd(12)} ${"Hash prefix"}`);
console.log(`  ${"-".repeat(20)} ${"-".repeat(8)} ${"-".repeat(10)} ${"-".repeat(16)}`);
for (const r of hashes) {
  const ratio = r.time / fastest;
  const speed = ratio < 1.1 ? "FASTEST" : `${ratio.toFixed(0)}x slower`;
  console.log(`  ${r.name.padEnd(22)} ${sec(r.time).padEnd(10)} ${speed.padEnd(12)} ${r.hash}...`);
}

// ============================================================================
// SUMMARY
// ============================================================================

console.log();
console.log("=".repeat(70));
console.log("SUMMARY");
console.log("=".repeat(70));
console.log();

const totalMaker = dt2a + dt2b;
const bestPayload = totalPayloadSize;

const rows = [
  ["Assets", NUM_ASSETS.toLocaleString()],
  ["---"],
  ["MAKER: hash + encode", sec(totalMaker)],
  ["  Hash (SHA-256)", sec(dt2a)],
  ["  Encode + gzip-1", sec(dt2b)],
  ["---"],
  ["TAKER: full reverse", sec(dtReverse)],
  ["  Decode (decompress+parse)", sec(dt3a)],
  ["  Verify hash", sec(dt3b)],
  ["---"],
  ["Outcome computation", sec(dt4)],
  ["---"],
  ["P2P payload", fmt(bestPayload)],
  ["  Format", "JSON + gzip-1"],
  ["  Precision", "18dp lossless (string)"],
  ["  vs TSV+gzip", `${pct(bestPayload, cmp.find(c => c.name === "TSV text")!.compressed)} smaller`],
  ["---"],
  ["Hash verified", verified ? "YES" : "FAILED"],
  ["Fastest hash algo", `${hashes[0].name} (${sec(hashes[0].time)})`],
  ["Peak memory", `${memMB()} MB`],
];

for (const row of rows) {
  if (row.length === 1 && row[0] === "---") {
    console.log("  " + "-".repeat(56));
  } else {
    console.log(`  ${(row[0] as string).padEnd(28)} ${row[1]}`);
  }
}

console.log();
console.log("  P2P Transfer times:");
const szPayload = bestPayload + 200;
for (const s of [
  { n: "1 Mbps", b: 125_000 }, { n: "10 Mbps", b: 1_250_000 },
  { n: "100 Mbps", b: 12_500_000 }, { n: "1 Gbps", b: 125_000_000 },
]) {
  const t = szPayload / s.b;
  console.log(`    ${s.n.padEnd(12)} ${t < 1 ? `${(t * 1000).toFixed(0)}ms` : `${t.toFixed(1)}s`}`);
}

console.log();
console.log("=".repeat(70));
const mem = process.memoryUsage();
console.log(`Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB | RSS: ${(mem.rss / 1024 / 1024).toFixed(0)} MB`);
console.log();
