/**
 * Fast Trade Hashing for Large Portfolios
 *
 * For bilateral bets, we don't need merkle proofs - both parties have all trades.
 * This module provides O(n) hashing instead of O(n log n) merkle tree construction.
 *
 * Uses Node crypto SHA-256 (hardware-accelerated via SHA-NI / ARM SHA extensions)
 * ~43x faster than keccak256 from @noble/hashes.
 *
 * NOT on-chain: on-chain commitment uses tradesRoot = keccak256(snapshotId, bitmap)
 * which is computed separately in chain-client.ts. This module is purely for
 * off-chain P2P verification between bots.
 */

import { createHash } from "crypto";
import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";

/**
 * Compact trade format for hashing
 * Only the essential fields that determine the bet
 */
export interface CompactTradeData {
  ticker: string;
  method: string;
  entryPrice: bigint;
}

/**
 * Compute a single hash of all trades (no merkle tree needed)
 * O(n) instead of O(n log n)
 *
 * Hash = keccak256(keccak256(trade1) || keccak256(trade2) || ...)
 *
 * For 1M trades: ~2M hash operations instead of ~20M
 */
export function computeTradesHash(
  snapshotId: string,
  trades: CompactTradeData[]
): `0x${string}` {
  // Build a buffer of all trade hashes
  const tradeHashes: Uint8Array[] = [];

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    // Hash each trade: keccak256(ticker, method, entryPrice, index)
    const tradeHash = keccak256(
      encodeAbiParameters(
        parseAbiParameters("string, string, uint256, uint256"),
        [trade.ticker, trade.method, trade.entryPrice, BigInt(i)]
      )
    );
    // Convert hex to bytes and add to buffer
    tradeHashes.push(hexToBytes(tradeHash));
  }

  // Hash snapshotId + all trade hashes
  const snapshotHash = keccak256(
    encodeAbiParameters(parseAbiParameters("string"), [snapshotId])
  );

  // Concatenate all hashes
  const totalLength = 32 + tradeHashes.length * 32; // snapshotHash + all trade hashes
  const buffer = new Uint8Array(totalLength);
  buffer.set(hexToBytes(snapshotHash), 0);

  let offset = 32;
  for (const hash of tradeHashes) {
    buffer.set(hash, offset);
    offset += 32;
  }

  // Final hash of the concatenated buffer
  return keccak256(buffer);
}

/**
 * Streaming hash for very large datasets
 * Hashes in chunks to avoid memory issues
 */
export function computeTradesHashStreaming(
  snapshotId: string,
  trades: CompactTradeData[],
  chunkSize = 10000
): `0x${string}` {
  // For very large datasets, hash in chunks then hash the chunk hashes
  const chunkHashes: Uint8Array[] = [];

  for (let i = 0; i < trades.length; i += chunkSize) {
    const chunk = trades.slice(i, Math.min(i + chunkSize, trades.length));
    const chunkBuffer = new Uint8Array(chunk.length * 32);

    chunk.forEach((trade, j) => {
      const tradeHash = keccak256(
        encodeAbiParameters(
          parseAbiParameters("string, string, uint256, uint256"),
          [trade.ticker, trade.method, trade.entryPrice, BigInt(i + j)]
        )
      );
      chunkBuffer.set(hexToBytes(tradeHash), j * 32);
    });

    const chunkHash = keccak256(chunkBuffer);
    chunkHashes.push(hexToBytes(chunkHash));
  }

  // Hash snapshotId + all chunk hashes
  const snapshotHash = keccak256(
    encodeAbiParameters(parseAbiParameters("string"), [snapshotId])
  );

  const finalBuffer = new Uint8Array(32 + chunkHashes.length * 32);
  finalBuffer.set(hexToBytes(snapshotHash), 0);

  let offset = 32;
  for (const hash of chunkHashes) {
    finalBuffer.set(hash, offset);
    offset += 32;
  }

  return keccak256(finalBuffer);
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: `0x${string}`): Uint8Array {
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return bytes;
}

/**
 * ULTRA-FAST: SHA-256 streaming hash (hardware-accelerated)
 *
 * Uses Node's native crypto SHA-256 which leverages CPU SHA extensions
 * (SHA-NI on x86-64, SHA2 on ARM). ~43x faster than keccak256.
 *
 * Safe for off-chain use: on-chain commitment uses a separate keccak256-based
 * tradesRoot computed in chain-client.ts.
 *
 * For 1M trades: ~0.1s
 */
export function computeTradesHashUltraFast(
  snapshotId: string,
  trades: CompactTradeData[]
): `0x${string}` {
  const hash = createHash("sha256");

  hash.update(`${snapshotId}|`);

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    hash.update(`${t.ticker}:${t.method}:${t.entryPrice}|`);
  }

  return `0x${hash.digest("hex")}` as `0x${string}`;
}

/**
 * Simple trades root structure (replaces MerkleTree for bilateral bets)
 */
export interface SimplifiedTradesData {
  snapshotId: string;
  tradesHash: `0x${string}`;
  tradeCount: number;
  trades: CompactTradeData[];
}

/**
 * Build simplified trades data (no merkle tree construction)
 * Uses ultra-fast single-pass hashing
 */
export function buildSimplifiedTrades(
  snapshotId: string,
  tickers: string[],
  methods: string[],
  entryPrices: Map<number, bigint>
): SimplifiedTradesData {
  const trades: CompactTradeData[] = [];

  for (let i = 0; i < tickers.length; i++) {
    trades.push({
      ticker: tickers[i],
      method: methods[i],
      entryPrice: entryPrices.get(i) ?? 0n,
    });
  }

  // Use ultra-fast single-pass hash
  const tradesHash = computeTradesHashUltraFast(snapshotId, trades);

  return {
    snapshotId,
    tradesHash,
    tradeCount: trades.length,
    trades,
  };
}

/**
 * COLUMNAR-OPTIMIZED: Hash directly from columnar arrays
 *
 * Avoids creating CompactTradeData[] objects and ticker string reconstruction.
 * For 1M trades: ~170ms vs ~500ms for computeTradesHashUltraFast with reconstructed trades.
 *
 * @param snapshotId - Snapshot identifier
 * @param tickerPrefix - Ticker prefix (e.g., "ASSET-")
 * @param tickerPad - Ticker padding length (e.g., 7 for "0000000")
 * @param methodDict - Method dictionary (e.g., ["up:0", "down:5", ...])
 * @param methodIndices - Method index per trade (1 byte each)
 * @param prices - Entry prices (BigInt array or Buffer of uint128)
 */
export function computeTradesHashColumnar(
  snapshotId: string,
  tickerPrefix: string,
  tickerPad: number,
  methodDict: string[],
  methodIndices: Uint8Array | Buffer,
  prices: bigint[]
): `0x${string}` {
  const hash = createHash("sha256");
  const count = prices.length;

  hash.update(`${snapshotId}|`);

  for (let i = 0; i < count; i++) {
    // Build ticker: prefix + padded index
    const ticker = tickerPrefix + i.toString().padStart(tickerPad, "0");
    const method = methodDict[methodIndices[i]];
    hash.update(`${ticker}:${method}:${prices[i]}|`);
  }

  return `0x${hash.digest("hex")}` as `0x${string}`;
}

/**
 * COLUMNAR-OPTIMIZED V2: Hash from raw buffer without BigInt array
 *
 * Reads prices directly from Buffer, avoiding BigInt array allocation.
 * For 1M trades with buffer input: ~200ms
 *
 * @param snapshotId - Snapshot identifier
 * @param tickerPrefix - Ticker prefix (e.g., "ASSET-")
 * @param tickerPad - Ticker padding length
 * @param methodDict - Method dictionary
 * @param rawBuf - Raw decompressed buffer: [methods (count bytes)] [prices (count * 16 bytes)]
 * @param count - Number of trades
 */
export function computeTradesHashFromBuffer(
  snapshotId: string,
  tickerPrefix: string,
  tickerPad: number,
  methodDict: string[],
  rawBuf: Buffer,
  count: number
): `0x${string}` {
  const hash = createHash("sha256");

  hash.update(`${snapshotId}|`);

  for (let i = 0; i < count; i++) {
    // Method from first `count` bytes
    const methodIdx = rawBuf[i];
    const method = methodDict[methodIdx];

    // Price from uint128 at offset count + i*16
    const priceOff = count + i * 16;
    const high = rawBuf.readBigUInt64BE(priceOff);
    const low = rawBuf.readBigUInt64BE(priceOff + 8);
    const price = (high << 64n) | low;

    // Build ticker
    const ticker = tickerPrefix + i.toString().padStart(tickerPad, "0");

    hash.update(`${ticker}:${method}:${price}|`);
  }

  return `0x${hash.digest("hex")}` as `0x${string}`;
}
