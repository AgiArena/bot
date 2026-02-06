/**
 * P2P Payload Compression
 *
 * JSON + gzip-1 for trade payloads.
 * Benchmarked at 1M trades: gzip-1 compresses fast (497ms) with
 * competitive E2E performance at typical VPS speeds.
 */

import { gzipSync, gunzipSync } from "node:zlib";
import type { Trade } from "../merkle-tree";

/**
 * Compressed payload wrapper
 */
export interface CompressedPayload {
  /** Base64-encoded gzipped JSON */
  compressed: string;
  /** Original size in bytes (for logging) */
  originalSize: number;
  /** Compressed size in bytes */
  compressedSize: number;
  /** Number of trades */
  count: number;
}

/**
 * Compress trades for P2P transfer using JSON + gzip-1
 */
export function compressTrades(trades: Trade[]): CompressedPayload {
  const json = JSON.stringify(trades.map(t => [t.ticker, t.method, t.entryPrice.toString()]));
  const originalSize = Buffer.byteLength(json, "utf8");

  const gz = gzipSync(Buffer.from(json, "utf8"), { level: 1 });
  const compressed = gz.toString("base64");

  return {
    compressed,
    originalSize,
    compressedSize: gz.length,
    count: trades.length,
  };
}

/**
 * Decompress trades from P2P transfer
 */
export function decompressTrades(payload: CompressedPayload, snapshotId: string): Trade[] {
  const gz = Buffer.from(payload.compressed, "base64");
  const json = gunzipSync(gz).toString("utf8");
  const arr: [string, string, string][] = JSON.parse(json);

  return arr.map(([ticker, method, price]) => ({
    tradeId: "" as `0x${string}`,
    ticker,
    source: snapshotId,
    method,
    entryPrice: BigInt(price),
    exitPrice: 0n,
    won: false,
    cancelled: false,
  }));
}

/**
 * Calculate compression ratio for logging
 */
export function compressionRatio(payload: CompressedPayload): string {
  const ratio = ((1 - payload.compressedSize / payload.originalSize) * 100).toFixed(1);
  return `${ratio}% (${formatBytes(payload.originalSize)} -> ${formatBytes(payload.compressedSize)})`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
