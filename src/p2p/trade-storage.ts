/**
 * Local Trade Storage Module
 *
 * Story 2-3: Merkle Tree & Bet Commitment
 * Task 1.2, 1.3: Local file-based persistence for Merkle trees
 *
 * Stores Merkle trees to disk for persistence across restarts.
 * Trees are keyed by betId and stored as JSON files.
 *
 * Note: Async versions are preferred for production use.
 * Sync versions kept for backwards compatibility with tests.
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "fs";
import { mkdir, writeFile, readFile, unlink, readdir, stat } from "fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { join } from "path";
import { type MerkleTree, serializeTree, deserializeTree } from "../merkle-tree";

/** Threshold for using compressed storage (trades count) */
const COMPRESS_THRESHOLD = 1000;

/** Default storage directory for trade data */
const DEFAULT_TRADE_STORAGE_DIR = "./data/trades";

/** Default max age for tree files in milliseconds (7 days) */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Get the storage directory path from env or default
 */
function getStorageDir(): string {
  return process.env.TRADE_STORAGE_DIR || DEFAULT_TRADE_STORAGE_DIR;
}

/**
 * Get file path for a bet's Merkle tree
 */
function getTreeFilePath(betId: number, compressed = false): string {
  return join(getStorageDir(), `bet-${betId}.${compressed ? "json.gz" : "json"}`);
}

// ============================================================================
// Synchronous API (for backwards compatibility)
// ============================================================================

/**
 * Store Merkle tree to local filesystem (sync version)
 * Uses gzip-1 compression for large trees (>1000 trades) - saves ~90% space
 *
 * @param betId - The bet ID to associate with this tree
 * @param tree - The Merkle tree to store
 */
export function storeMerkleTree(betId: number, tree: MerkleTree): void {
  const storageDir = getStorageDir();
  mkdirSync(storageDir, { recursive: true });

  const useCompression = tree.trades.length >= COMPRESS_THRESHOLD;
  const json = serializeTree(tree);

  if (useCompression) {
    const filePath = getTreeFilePath(betId, true);
    const compressed = gzipSync(Buffer.from(json, "utf8"), { level: 1 });
    writeFileSync(filePath, compressed);
    const ratio = ((1 - compressed.length / json.length) * 100).toFixed(0);
    console.log(`[TradeStorage] Stored compressed tree for bet ${betId} (${ratio}% smaller)`);
  } else {
    const filePath = getTreeFilePath(betId, false);
    writeFileSync(filePath, json, "utf-8");
    console.log(`[TradeStorage] Stored Merkle tree for bet ${betId} at ${filePath}`);
  }
}

/**
 * Load Merkle tree from local filesystem (sync version)
 * Handles both compressed (.json.br) and uncompressed (.json) files
 *
 * @param betId - The bet ID to load tree for
 * @returns MerkleTree or null if not found
 */
export function loadMerkleTree(betId: number): MerkleTree | null {
  // Try compressed first (more likely for large trees)
  const compressedPath = getTreeFilePath(betId, true);
  if (existsSync(compressedPath)) {
    try {
      const compressed = readFileSync(compressedPath);
      const json = gunzipSync(compressed).toString("utf8");
      return deserializeTree(json);
    } catch (error) {
      console.error(`[TradeStorage] Failed to load compressed tree for bet ${betId}: ${(error as Error).message}`);
      return null;
    }
  }

  // Try uncompressed
  const filePath = getTreeFilePath(betId, false);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const json = readFileSync(filePath, "utf-8");
    return deserializeTree(json);
  } catch (error) {
    console.error(`[TradeStorage] Failed to load tree for bet ${betId}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Check if tree exists for bet (compressed or uncompressed)
 *
 * @param betId - The bet ID to check
 * @returns True if tree file exists
 */
export function hasMerkleTree(betId: number): boolean {
  return existsSync(getTreeFilePath(betId, true)) || existsSync(getTreeFilePath(betId, false));
}

/**
 * Delete tree file for a bet (sync version)
 *
 * @param betId - The bet ID to delete tree for
 * @returns True if deleted successfully
 */
export function deleteMerkleTree(betId: number): boolean {
  const filePath = getTreeFilePath(betId);
  if (!existsSync(filePath)) {
    return false;
  }
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all stored bet IDs
 *
 * @returns Array of bet IDs that have stored trees
 */
export function listStoredBets(): number[] {
  const storageDir = getStorageDir();
  if (!existsSync(storageDir)) {
    return [];
  }
  try {
    const files = readdirSync(storageDir) as string[];
    return files
      .filter((f: string) => f.startsWith("bet-") && (f.endsWith(".json") || f.endsWith(".json.gz")))
      .map((f: string) => parseInt(f.replace("bet-", "").replace(".json.gz", "").replace(".json", ""), 10))
      .filter((id: number) => !isNaN(id));
  } catch {
    return [];
  }
}

// ============================================================================
// Asynchronous API (preferred for production)
// ============================================================================

/**
 * Store Merkle tree to local filesystem (async version)
 *
 * @param betId - The bet ID to associate with this tree
 * @param tree - The Merkle tree to store
 */
export async function storeMerkleTreeAsync(betId: number, tree: MerkleTree): Promise<void> {
  const storageDir = getStorageDir();
  await mkdir(storageDir, { recursive: true });
  const filePath = getTreeFilePath(betId);
  await writeFile(filePath, serializeTree(tree), "utf-8");
  console.log(`[TradeStorage] Stored Merkle tree for bet ${betId} at ${filePath}`);
}

/**
 * Load Merkle tree from local filesystem (async version)
 *
 * @param betId - The bet ID to load tree for
 * @returns MerkleTree or null if not found
 */
export async function loadMerkleTreeAsync(betId: number): Promise<MerkleTree | null> {
  const filePath = getTreeFilePath(betId);
  try {
    const json = await readFile(filePath, "utf-8");
    return deserializeTree(json);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    console.error(`[TradeStorage] Failed to load tree for bet ${betId}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Delete tree file for a bet (async version)
 *
 * @param betId - The bet ID to delete tree for
 * @returns True if deleted successfully
 */
export async function deleteMerkleTreeAsync(betId: number): Promise<boolean> {
  const filePath = getTreeFilePath(betId);
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// ============================================================================
// Cleanup Utilities
// ============================================================================

/**
 * Clean up old tree files beyond max age
 *
 * @param maxAgeMs - Maximum age in milliseconds (default: 7 days)
 * @returns Number of files deleted
 */
export async function cleanupOldTrees(maxAgeMs: number = DEFAULT_MAX_AGE_MS): Promise<number> {
  const storageDir = getStorageDir();
  const now = Date.now();
  let deletedCount = 0;

  try {
    const files = await readdir(storageDir);

    for (const file of files) {
      if (!file.startsWith("bet-") || (!file.endsWith(".json") && !file.endsWith(".json.gz"))) {
        continue;
      }

      const filePath = join(storageDir, file);
      try {
        const stats = await stat(filePath);
        const age = now - stats.mtimeMs;

        if (age > maxAgeMs) {
          await unlink(filePath);
          deletedCount++;
          console.log(`[TradeStorage] Cleaned up old tree: ${file} (age: ${Math.floor(age / 1000 / 60 / 60)}h)`);
        }
      } catch {
        // Skip files that can't be accessed
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[TradeStorage] Cleanup error: ${(error as Error).message}`);
    }
  }

  if (deletedCount > 0) {
    console.log(`[TradeStorage] Cleanup complete: deleted ${deletedCount} old tree files`);
  }

  return deletedCount;
}

// ============================================================================
// Resolution Storage (Exit Prices & Outcomes)
// ============================================================================

/**
 * Resolution data stored after bet settlement
 */
export interface ResolutionData {
  betId: number;
  resolvedAt: string; // ISO timestamp
  winner: string; // Winner address
  makerWins: number;
  takerWins: number;
  totalTrades: number;
  /** Exit prices keyed by trade index */
  exitPrices: Record<number, string>;
  /** Resolved trades with filled exit prices */
  resolvedTrades: Array<{
    index: number;
    ticker: string;
    method: string;
    entryPrice: string;
    exitPrice: string;
    makerWon: boolean;
  }>;
}

/**
 * Get file path for resolution data
 */
function getResolutionFilePath(betId: number): string {
  return join(getStorageDir(), `bet-${betId}-resolution.json`);
}

/**
 * Store resolution data (exit prices and outcome) for a bet
 *
 * @param betId - The bet ID
 * @param data - Resolution data including exit prices and outcome
 */
export function storeResolution(betId: number, data: ResolutionData): void {
  const storageDir = getStorageDir();
  mkdirSync(storageDir, { recursive: true });
  const filePath = getResolutionFilePath(betId);
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  console.log(`[TradeStorage] Stored resolution for bet ${betId} at ${filePath}`);
}

/**
 * Store resolution data (async version)
 */
export async function storeResolutionAsync(betId: number, data: ResolutionData): Promise<void> {
  const storageDir = getStorageDir();
  await mkdir(storageDir, { recursive: true });
  const filePath = getResolutionFilePath(betId);
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  console.log(`[TradeStorage] Stored resolution for bet ${betId} at ${filePath}`);
}

/**
 * Load resolution data for a bet
 *
 * @param betId - The bet ID
 * @returns Resolution data or null if not found
 */
export function loadResolution(betId: number): ResolutionData | null {
  const filePath = getResolutionFilePath(betId);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const json = readFileSync(filePath, "utf-8");
    return JSON.parse(json) as ResolutionData;
  } catch (error) {
    console.error(`[TradeStorage] Failed to load resolution for bet ${betId}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Load resolution data (async version)
 */
export async function loadResolutionAsync(betId: number): Promise<ResolutionData | null> {
  const filePath = getResolutionFilePath(betId);
  try {
    const json = await readFile(filePath, "utf-8");
    return JSON.parse(json) as ResolutionData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    console.error(`[TradeStorage] Failed to load resolution for bet ${betId}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Check if resolution exists for bet
 */
export function hasResolution(betId: number): boolean {
  return existsSync(getResolutionFilePath(betId));
}

/**
 * Get storage statistics
 *
 * @returns Storage stats including file count and total size
 */
export async function getStorageStats(): Promise<{
  fileCount: number;
  totalSizeBytes: number;
  oldestFileMs: number | null;
  newestFileMs: number | null;
}> {
  const storageDir = getStorageDir();

  try {
    const files = await readdir(storageDir);
    let totalSizeBytes = 0;
    let oldestFileMs: number | null = null;
    let newestFileMs: number | null = null;
    let fileCount = 0;

    for (const file of files) {
      if (!file.startsWith("bet-") || (!file.endsWith(".json") && !file.endsWith(".json.gz"))) {
        continue;
      }

      const filePath = join(storageDir, file);
      try {
        const stats = await stat(filePath);
        totalSizeBytes += stats.size;
        fileCount++;

        if (oldestFileMs === null || stats.mtimeMs < oldestFileMs) {
          oldestFileMs = stats.mtimeMs;
        }
        if (newestFileMs === null || stats.mtimeMs > newestFileMs) {
          newestFileMs = stats.mtimeMs;
        }
      } catch {
        // Skip files that can't be accessed
      }
    }

    return { fileCount, totalSizeBytes, oldestFileMs, newestFileMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { fileCount: 0, totalSizeBytes: 0, oldestFileMs: null, newestFileMs: null };
    }
    throw error;
  }
}
