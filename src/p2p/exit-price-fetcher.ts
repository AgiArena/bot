/**
 * Exit Price Fetcher Module
 *
 * Story 2-4: P2P Settlement (Happy Path)
 * Task 7: Implement Exit Price Fetching
 *
 * Fetches exit prices for bet resolution from various price sources.
 * Uses the same price sources as entry prices for fairness.
 */

import { ethers } from "ethers";
import type { MerkleTree, Trade } from "../merkle-tree";

// ============================================================================
// Types
// ============================================================================

/**
 * Result of fetching exit prices
 */
export interface ExitPriceResult {
  /** Map of trade index -> exit price (18 decimals) */
  prices: Map<number, bigint>;
  /** Timestamp when prices were fetched */
  timestamp: number;
  /** Source identifier (e.g., "crypto", "stocks") */
  source: string;
}

/**
 * Price source configuration
 */
export interface PriceSourceConfig {
  /** Base URL for the price API */
  apiUrl: string;
  /** API key (if required) */
  apiKey?: string;
  /** Request timeout in ms */
  timeoutMs?: number;
}

// ============================================================================
// Price Source Constants
// ============================================================================

/** Default timeout for price fetches */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Backend URL for price data */
const DEFAULT_BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";

// ============================================================================
// Exit Price Fetching
// ============================================================================

/**
 * Fetch exit prices for a bet at resolution time
 *
 * Story 2-4 Task 7.1: fetchExitPrices implementation
 *
 * Uses the same price sources as the original snapshot for fairness.
 *
 * @param snapshotId - The snapshot ID (e.g., "crypto-2026-01-28-18")
 * @param tickers - Array of tickers to fetch prices for
 * @param backendUrl - Optional backend URL override
 * @returns Exit prices for all tickers
 */
export async function fetchExitPrices(
  snapshotId: string,
  tickers: string[],
  backendUrl?: string,
): Promise<ExitPriceResult> {
  const apiUrl = backendUrl || DEFAULT_BACKEND_URL;

  // Task 7.2: Use existing snapshot service to get exit prices at resolution time
  // Parse snapshot ID to get source (e.g., "crypto-2026-01-28-18" -> "crypto")
  const [source] = snapshotId.split("-");

  const prices = new Map<number, bigint>();

  // Fetch prices from backend snapshot service
  try {
    const response = await fetch(`${apiUrl}/api/snapshots/latest?source=${source}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(`[ExitPriceFetcher] Failed to fetch from snapshot service: ${response.status}`);
      // Fall back to fetching individual prices
      return fetchExitPricesIndividually(source, tickers, apiUrl);
    }

    const data = await response.json() as {
      snapshotId: string;
      prices: { ticker: string; price: string }[];
      timestamp: number;
    };

    // Map prices to ticker indices
    const priceMap = new Map<string, bigint>();
    for (const p of data.prices) {
      priceMap.set(p.ticker.toLowerCase(), BigInt(p.price));
    }

    for (let i = 0; i < tickers.length; i++) {
      const price = priceMap.get(tickers[i].toLowerCase());
      if (price !== undefined) {
        prices.set(i, price);
      }
    }

    return {
      prices,
      timestamp: data.timestamp || Date.now(),
      source,
    };
  } catch (error) {
    console.warn(`[ExitPriceFetcher] Snapshot service error: ${(error as Error).message}`);
    // Fall back to individual fetching
    return fetchExitPricesIndividually(source, tickers, apiUrl);
  }
}

/**
 * Fetch exit prices individually when batch fetch fails
 */
async function fetchExitPricesIndividually(
  source: string,
  tickers: string[],
  apiUrl: string,
): Promise<ExitPriceResult> {
  const prices = new Map<number, bigint>();

  // Fetch each ticker's price individually
  await Promise.all(
    tickers.map(async (ticker, index) => {
      try {
        const price = await fetchSinglePrice(source, ticker, apiUrl);
        if (price !== null) {
          prices.set(index, price);
        }
      } catch (error) {
        console.warn(`[ExitPriceFetcher] Failed to fetch ${ticker}: ${(error as Error).message}`);
      }
    })
  );

  return {
    prices,
    timestamp: Date.now(),
    source,
  };
}

/**
 * Fetch a single ticker's price
 */
async function fetchSinglePrice(
  source: string,
  ticker: string,
  apiUrl: string,
): Promise<bigint | null> {
  try {
    const response = await fetch(`${apiUrl}/api/prices/${source}/${ticker}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as { price: string };
    return BigInt(data.price);
  } catch {
    return null;
  }
}

/**
 * Fetch exit prices from MerkleTree trades
 *
 * Story 2-4 Task 7.1: Convenience wrapper for fetchExitPrices
 *
 * @param tree - MerkleTree containing trades with tickers
 * @param backendUrl - Optional backend URL override
 * @returns Exit prices indexed by trade position
 */
export async function fetchExitPricesForTree(
  tree: MerkleTree,
  backendUrl?: string,
): Promise<ExitPriceResult> {
  const tickers = tree.trades.map(t => t.ticker);
  return fetchExitPrices(tree.snapshotId, tickers, backendUrl);
}

// ============================================================================
// Price Caching
// ============================================================================

/**
 * Simple in-memory cache for exit prices
 */
const exitPriceCache = new Map<string, { result: ExitPriceResult; expiresAt: number }>();

/** Cache TTL in milliseconds (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch exit prices with caching
 *
 * Story 2-4 Task 7.3: Cache exit prices for bet to ensure consistency
 *
 * @param betId - The bet ID (used as cache key)
 * @param snapshotId - The snapshot ID
 * @param tickers - Array of tickers
 * @param backendUrl - Optional backend URL
 * @returns Cached or fresh exit prices
 */
export async function fetchExitPricesCached(
  betId: number,
  snapshotId: string,
  tickers: string[],
  backendUrl?: string,
): Promise<ExitPriceResult> {
  // Include snapshotId in cache key to prevent stale price issues
  const cacheKey = `bet-${betId}-${snapshotId}`;
  const now = Date.now();

  // Check cache
  const cached = exitPriceCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  // Fetch fresh prices
  const result = await fetchExitPrices(snapshotId, tickers, backendUrl);

  // Cache the result
  exitPriceCache.set(cacheKey, {
    result,
    expiresAt: now + CACHE_TTL_MS,
  });

  return result;
}

/**
 * Clear cached prices for a bet
 *
 * @param betId - The bet ID to clear cache for
 */
export function clearExitPriceCache(betId: number): void {
  exitPriceCache.delete(`bet-${betId}`);
}

/**
 * Clear all cached prices
 */
export function clearAllExitPriceCache(): void {
  exitPriceCache.clear();
}

/**
 * Clean up expired cache entries
 */
export function cleanupExitPriceCache(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, entry] of exitPriceCache.entries()) {
    if (entry.expiresAt <= now) {
      exitPriceCache.delete(key);
      cleaned++;
    }
  }

  return cleaned;
}

/**
 * Compute a deterministic hash of exit prices for validation
 * Both parties should compute the same hash if they have the same prices
 *
 * @param prices - Map of trade index to exit price
 * @param tradeCount - Expected number of trades
 * @returns Hash of exit prices or null if incomplete
 */
export function computeExitPricesHash(
  prices: Map<number, bigint>,
  tradeCount: number,
): string | null {
  // Verify we have all prices
  if (prices.size !== tradeCount) {
    return null;
  }

  // Build sorted array of prices by index
  const sortedPrices: bigint[] = [];
  for (let i = 0; i < tradeCount; i++) {
    const price = prices.get(i);
    if (price === undefined) {
      return null; // Missing price
    }
    sortedPrices.push(price);
  }

  // Compute keccak256 hash of packed prices
  const types = sortedPrices.map(() => "uint256");
  return ethers.solidityPackedKeccak256(types, sortedPrices);
}

/**
 * Validate that all exit prices are present
 *
 * @param prices - Map of trade index to exit price
 * @param tradeCount - Expected number of trades
 * @returns Object with validation result and missing indices
 */
export function validateExitPricesComplete(
  prices: Map<number, bigint>,
  tradeCount: number,
): { complete: boolean; missingIndices: number[] } {
  const missingIndices: number[] = [];

  for (let i = 0; i < tradeCount; i++) {
    if (!prices.has(i)) {
      missingIndices.push(i);
    }
  }

  return {
    complete: missingIndices.length === 0,
    missingIndices,
  };
}
