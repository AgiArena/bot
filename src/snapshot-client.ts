/**
 * Snapshot Client for Category-Based Betting
 *
 * Epic 8: Fetches snapshots and trade lists from backend API.
 * Story 9.2: Added bitmap upload and ETag caching for efficient position uploads.
 *
 * Bots use this to get market rankings and create trades.
 */

import type { Snapshot, TradeList, TradeListSize, Trade } from './types';
import { fetchWithTls } from './fetch-utils';
import {
  encodePositionBitmap,
  bitmapToBase64,
  computeBitmapHash,
  extractPositionsFromTrades,
  calculateSizeReduction,
  type BitmapPosition,
} from './bitmap-utils';
import { withExponentialBackoff } from './retry-utils';

/**
 * Backend response for current snapshots
 * Backend returns snapshotId (not id) due to Rust serde camelCase rename
 */
interface BackendSnapshotInfo {
  snapshotId: string;
  createdAt: string;
  expiresAt: string;
  hashes: Record<string, string>;
}

interface CurrentSnapshotsResponse {
  snapshots: Record<string, BackendSnapshotInfo>;
}

/**
 * Backend response for trade list
 */
interface TradeListResponse {
  snapshotId: string;
  categoryId: string;
  category: string;
  size: TradeListSize;
  trades: Trade[];
  tradesHash: string;
  tradesCount: number;
}

/**
 * Fetch current snapshots for all categories
 *
 * @param backendUrl - Backend API URL
 * @returns Map of categoryId -> Snapshot
 */
export async function getCurrentSnapshots(
  backendUrl: string
): Promise<Record<string, Snapshot>> {
  const response = await fetchWithTls(`${backendUrl}/api/snapshots/current`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch current snapshots: ${response.status}`);
  }

  const data = await response.json() as CurrentSnapshotsResponse;

  // Map backend snapshotId -> Snapshot.id (field name mismatch)
  const result: Record<string, Snapshot> = {};
  for (const [categoryId, info] of Object.entries(data.snapshots)) {
    result[categoryId] = {
      id: info.snapshotId,
      categoryId,
      createdAt: info.createdAt,
      expiresAt: info.expiresAt,
      isCurrent: true,
    };
  }
  return result;
}

/**
 * Fetch trade list for a specific snapshot and size
 *
 * Handles pagination (backend limits to 1000 per page).
 *
 * @param backendUrl - Backend API URL
 * @param snapshotId - Snapshot ID
 * @param size - List size ('1K', '10K', '100K')
 * @returns Trade list with trades and hash
 */
export async function getTradeList(
  backendUrl: string,
  snapshotId: string,
  size: TradeListSize
): Promise<TradeList> {
  const allTrades: Trade[] = [];
  let offset = 0;
  const pageSize = 1000;
  let tradesHash = '';
  let categoryId = '';
  let totalCount = 0;

  // Paginate through all trades
  while (true) {
    const url = `${backendUrl}/api/snapshots/${snapshotId}/trades/${size}?offset=${offset}&limit=${pageSize}`;
    const response = await fetchWithTls(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch trade list: ${response.status}`);
    }

    const data = await response.json() as TradeListResponse;
    tradesHash = data.tradesHash;
    categoryId = data.categoryId || data.category || '';
    totalCount = data.tradesCount || data.trades.length;

    allTrades.push(...data.trades);

    // Stop if we got all trades or got fewer than page size
    if (allTrades.length >= totalCount || data.trades.length < pageSize) {
      break;
    }

    offset += pageSize;
  }

  return {
    snapshotId,
    categoryId,
    size,
    trades: allTrades,
    tradesHash,
  };
}

/**
 * Fetch the latest snapshot for a specific category
 *
 * Uses GET /api/snapshots/current to find the current snapshot for the category.
 *
 * @param backendUrl - Backend API URL
 * @param categoryId - Category ID (e.g., 'predictions', 'crypto')
 * @returns Snapshot or null if not found
 */
export async function getLatestSnapshot(
  backendUrl: string,
  categoryId: string
): Promise<Snapshot | null> {
  const snapshots = await getCurrentSnapshots(backendUrl);
  return snapshots[categoryId] || null;
}

/**
 * Upload trades for a bet after on-chain creation
 *
 * Supports two modes:
 * 1. REFERENCE MODE (recommended for large portfolios): provide snapshotId + tradesHash
 *    Backend looks up trades from existing trade_lists table - zero data transfer
 * 2. FULL UPLOAD MODE: provide trades array (for custom portfolios or backwards compat)
 *
 * @param backendUrl - Backend API URL
 * @param betId - Bet ID from on-chain creation
 * @param trades - Array of trades (optional if using reference mode)
 * @param tradesJsonString - Exact JSON string for hash verification
 * @param categoryId - Category ID
 * @param listSize - List size (1K, 10K, ALL)
 * @param snapshotId - Snapshot ID for reference mode
 * @param tradesHash - Trades hash for reference mode verification
 */
export async function uploadTradesToBackend(
  backendUrl: string,
  betId: number,
  trades: Trade[],
  tradesJsonString?: string,
  categoryId?: string,
  listSize?: string,
  snapshotId?: string,
  tradesHash?: string
): Promise<void> {
  // Build request body based on mode
  const body: Record<string, unknown> = {};

  if (snapshotId && tradesHash) {
    // REFERENCE MODE: Just send snapshot reference, backend looks up trades
    body.snapshotId = snapshotId;
    body.tradesHash = tradesHash;
    if (categoryId) body.categoryId = categoryId;
    if (listSize) body.listSize = listSize;
    console.log(`[SnapshotClient] Reference upload for bet ${betId}: snapshot=${snapshotId}, hash=${tradesHash.slice(0, 10)}...`);
  } else {
    // FULL UPLOAD MODE: Send all trades (for backwards compat or custom portfolios)
    body.tradesJson = trades;
    if (tradesJsonString) body.tradesJsonString = tradesJsonString;
    if (categoryId) body.categoryId = categoryId;
    if (listSize) body.listSize = listSize;
    console.log(`[SnapshotClient] Full upload for bet ${betId}: ${trades.length} trades`);
  }

  const response = await fetchWithTls(`${backendUrl}/api/bets/${betId}/trades`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to upload trades: ${response.status} - ${errorText}`);
  }
}

/**
 * Fetch trades for a bet (for verification before matching)
 *
 * @param backendUrl - Backend API URL
 * @param betId - Bet ID
 * @returns Array of trades
 */
export async function getBetTrades(
  backendUrl: string,
  betId: number
): Promise<Trade[]> {
  const response = await fetchWithTls(`${backendUrl}/api/bets/${betId}/trades`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return [];
    }
    throw new Error(`Failed to fetch bet trades: ${response.status}`);
  }

  const data = await response.json();
  return data.trades || [];
}

/**
 * Verify counterparty trades are valid before matching
 *
 * Checks:
 * 1. Trades exist for the bet
 * 2. Entry prices are reasonable (within tolerance of current market)
 *
 * @param backendUrl - Backend API URL
 * @param betId - Bet ID to verify
 * @param currentPrices - Map of ticker -> current price
 * @param tolerance - Max allowed price deviation (default 5%)
 * @returns Validation result
 */
export async function verifyCounterpartyTrades(
  backendUrl: string,
  betId: number,
  currentPrices: Map<string, number>,
  tolerance: number = 0.05
): Promise<{ valid: boolean; trades: Trade[]; reason?: string }> {
  const trades = await getBetTrades(backendUrl, betId);

  if (trades.length === 0) {
    return { valid: false, trades: [], reason: 'No trades found for bet' };
  }

  // Verify each trade's entry price is reasonable
  for (const trade of trades) {
    const currentPrice = currentPrices.get(trade.ticker);
    if (currentPrice === undefined) {
      // Can't verify - skip (might be ok for less liquid markets)
      continue;
    }

    const priceDiff = Math.abs(trade.entryPrice - currentPrice) / currentPrice;
    if (priceDiff > tolerance) {
      return {
        valid: false,
        trades,
        reason: `Trade ${trade.ticker} entry price ${trade.entryPrice} deviates ${(priceDiff * 100).toFixed(1)}% from current ${currentPrice}`,
      };
    }
  }

  return { valid: true, trades };
}

// ============================================================================
// Story 9.2: Bitmap Position Upload (Task 3)
// ============================================================================

/**
 * Response from bitmap position upload endpoint
 */
export interface BitmapUploadResponse {
  success: boolean;
  betId: number;
  tradesCount: number;
  bitmapSizeBytes: number;
  hashVerified: boolean;
  message: string;
}

/**
 * Result of bitmap upload operation
 */
export interface BitmapUploadResult {
  success: boolean;
  tradesCount?: number;
  bitmapSizeBytes?: number;
  hashVerified?: boolean;
  error?: string;
  code?: string;
}

/**
 * Valid list size values for bitmap uploads
 */
const VALID_LIST_SIZES = ['1K', '10K', '100K', 'ALL'] as const;
type ValidListSize = typeof VALID_LIST_SIZES[number];

/**
 * Upload positions using compact bitmap encoding
 *
 * Story 9.2: Replaces JSON upload with bitmap encoding.
 * Reduces payload from ~800KB to ~1.7KB for 10K trades.
 *
 * @param backendUrl - Backend API URL
 * @param betId - Bet ID from on-chain creation
 * @param snapshotId - Snapshot ID (e.g., "crypto-2026-01-28-12-00")
 * @param positions - Array of position values ('LONG'/'SHORT' or 'YES'/'NO')
 * @param listSize - Size of trade list (1K, 10K, 100K, ALL)
 * @returns Upload result with verification status
 */
export async function uploadPositionBitmap(
  backendUrl: string,
  betId: number,
  snapshotId: string,
  positions: BitmapPosition[],
  listSize: string = '10K'
): Promise<BitmapUploadResult> {
  // Validate listSize before making network request
  if (!VALID_LIST_SIZES.includes(listSize as ValidListSize)) {
    console.error(
      `[SnapshotClient] Invalid listSize "${listSize}" for bet ${betId}. ` +
      `Valid values: ${VALID_LIST_SIZES.join(', ')}`
    );
    return {
      success: false,
      error: `Invalid listSize: ${listSize}. Must be one of: ${VALID_LIST_SIZES.join(', ')}`,
      code: 'INVALID_LIST_SIZE',
    };
  }

  // Encode positions as bitmap
  const bitmap = encodePositionBitmap(positions);
  const base64Bitmap = bitmapToBase64(bitmap);

  // Log size reduction
  const sizeStats = calculateSizeReduction(positions.length);
  console.log(
    `[SnapshotClient] Bitmap upload for bet ${betId}: ` +
    `${positions.length} positions → ${bitmap.length} bytes → ${base64Bitmap.length} chars base64 ` +
    `(${sizeStats.reductionPercent.toFixed(1)}% reduction)`
  );

  const response = await fetchWithTls(`${backendUrl}/api/bets/${betId}/positions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      snapshotId,
      positionBitmap: base64Bitmap,
      listSize,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error', code: 'UNKNOWN' })) as {
      error?: string;
      code?: string;
    };
    console.error(`[SnapshotClient] Bitmap upload failed for bet ${betId}:`, errorData);

    return {
      success: false,
      error: errorData.error || `Upload failed: ${response.status}`,
      code: errorData.code || 'UPLOAD_FAILED',
    };
  }

  const result = await response.json() as BitmapUploadResponse;
  console.log(
    `[SnapshotClient] Bitmap uploaded for bet ${betId}: ` +
    `${result.tradesCount} trades, hash verified: ${result.hashVerified}`
  );

  return {
    success: true,
    tradesCount: result.tradesCount,
    bitmapSizeBytes: result.bitmapSizeBytes,
    hashVerified: result.hashVerified,
  };
}

/**
 * Upload positions from trades array using bitmap encoding
 *
 * Convenience function that extracts positions from trades and uploads.
 *
 * @param backendUrl - Backend API URL
 * @param betId - Bet ID from on-chain creation
 * @param snapshotId - Snapshot ID
 * @param trades - Array of trades with position field
 * @param listSize - Size of trade list
 * @returns Upload result
 */
export async function uploadTradesAsBitmap(
  backendUrl: string,
  betId: number,
  snapshotId: string,
  trades: Trade[],
  listSize: string = '10K'
): Promise<BitmapUploadResult> {
  const positions = extractPositionsFromTrades(trades);
  return uploadPositionBitmap(backendUrl, betId, snapshotId, positions, listSize);
}

/**
 * Upload positions with retry and exponential backoff
 *
 * Story 9.2 AC#3: Add retry logic with exponential backoff
 *
 * @param backendUrl - Backend API URL
 * @param betId - Bet ID
 * @param snapshotId - Snapshot ID
 * @param positions - Array of position values
 * @param listSize - Size of trade list
 * @param maxRetries - Maximum retry attempts (default: 5)
 * @param initialDelayMs - Initial delay between retries (default: 1000ms)
 * @returns Upload result
 */
export async function uploadPositionBitmapWithRetry(
  backendUrl: string,
  betId: number,
  snapshotId: string,
  positions: BitmapPosition[],
  listSize: string = '10K',
  maxRetries: number = 5,
  initialDelayMs: number = 1000
): Promise<BitmapUploadResult> {
  return withExponentialBackoff(
    async () => {
      const result = await uploadPositionBitmap(backendUrl, betId, snapshotId, positions, listSize);

      // Retry only on transient errors that may resolve
      if (!result.success) {
        // DB_ERROR is the only truly retryable error - transient database issues
        // BET_NOT_FOUND, TRADE_LIST_NOT_FOUND are permanent failures - bet/snapshot doesn't exist
        // HASH_MISMATCH, INVALID_BITMAP, POSITIONS_EXIST are also permanent - won't change on retry
        const retryableCodes = ['DB_ERROR'];
        if (result.code && retryableCodes.includes(result.code)) {
          throw new Error(`${result.code}: ${result.error}`);
        }
        // Non-retryable errors - return immediately without wasting retries
        return result;
      }

      return result;
    },
    maxRetries,
    initialDelayMs,
    (attempt, error) => {
      console.log(`[SnapshotClient] Retry ${attempt}/${maxRetries} for bet ${betId}: ${error.message}`);
    }
  );
}

// ============================================================================
// Story 9.2: ETag Caching for Snapshots (Task 4)
// ============================================================================

/**
 * Cached snapshot data with ETag
 */
interface CachedSnapshot {
  snapshot: Snapshot;
  tradeList: TradeList;
  etag: string;
  cachedAt: number;
  expiresAt: number;
}

/**
 * Cache for snapshots with ETag support
 * Key: `${categoryId}:${listSize}`
 */
const snapshotCache = new Map<string, CachedSnapshot>();

/**
 * Default cache TTL in milliseconds (5 minutes)
 */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Get snapshot with ETag caching
 *
 * Story 9.2 AC#4: Cache snapshots locally with ETag
 *
 * @param backendUrl - Backend API URL
 * @param categoryId - Category ID
 * @param listSize - Trade list size
 * @param cacheTtlMs - Cache TTL in milliseconds (default: 5 minutes)
 * @returns Snapshot and trade list with cache status
 */
export async function getSnapshotWithCache(
  backendUrl: string,
  categoryId: string,
  listSize: TradeListSize,
  cacheTtlMs: number = DEFAULT_CACHE_TTL_MS
): Promise<{
  snapshot: Snapshot;
  tradeList: TradeList;
  fromCache: boolean;
}> {
  const cacheKey = `${categoryId}:${listSize}`;
  const cached = snapshotCache.get(cacheKey);
  const now = Date.now();

  // Check if cached and not expired
  if (cached && cached.expiresAt > now) {
    console.log(`[SnapshotClient] Cache hit for ${cacheKey}`);
    return {
      snapshot: cached.snapshot,
      tradeList: cached.tradeList,
      fromCache: true,
    };
  }

  // Build headers for conditional request
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
  };

  if (cached?.etag) {
    headers['If-None-Match'] = cached.etag;
  }

  // Fetch current snapshot for this category
  const response = await fetchWithTls(`${backendUrl}/api/snapshots/current`, {
    method: 'GET',
    headers,
  });

  // Handle 304 Not Modified - use cached data
  if (response.status === 304 && cached) {
    console.log(`[SnapshotClient] 304 Not Modified for ${cacheKey}, using cache`);

    // Extend cache expiry
    snapshotCache.set(cacheKey, {
      ...cached,
      expiresAt: now + cacheTtlMs,
    });

    return {
      snapshot: cached.snapshot,
      tradeList: cached.tradeList,
      fromCache: true,
    };
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch snapshot: ${response.status}`);
  }

  // Parse response and extract category's snapshot
  const data = await response.json() as CurrentSnapshotsResponse;
  const snapshotInfo = data.snapshots[categoryId];

  if (!snapshotInfo) {
    throw new Error(`No snapshot found for category: ${categoryId}`);
  }

  const snapshot: Snapshot = {
    id: snapshotInfo.snapshotId,
    categoryId,
    createdAt: snapshotInfo.createdAt,
    expiresAt: snapshotInfo.expiresAt,
    isCurrent: true,
  };

  // Fetch trade list
  const tradeList = await getTradeList(backendUrl, snapshot.id, listSize);

  // Get ETag from response headers
  const etag = response.headers.get('ETag') || response.headers.get('etag') || '';

  // Update cache
  snapshotCache.set(cacheKey, {
    snapshot,
    tradeList,
    etag,
    cachedAt: now,
    expiresAt: now + cacheTtlMs,
  });

  console.log(
    `[SnapshotClient] Cache updated for ${cacheKey}: ` +
    `snapshot=${snapshot.id}, ${tradeList.trades.length} trades, etag=${etag.slice(0, 20)}...`
  );

  return {
    snapshot,
    tradeList,
    fromCache: false,
  };
}

/**
 * Invalidate cached snapshot for a category
 *
 * @param categoryId - Category ID
 * @param listSize - Optional list size (invalidates all sizes if not specified)
 */
export function invalidateSnapshotCache(categoryId: string, listSize?: TradeListSize): void {
  if (listSize) {
    const cacheKey = `${categoryId}:${listSize}`;
    snapshotCache.delete(cacheKey);
    console.log(`[SnapshotClient] Cache invalidated for ${cacheKey}`);
  } else {
    // Invalidate all list sizes for this category
    for (const key of snapshotCache.keys()) {
      if (key.startsWith(`${categoryId}:`)) {
        snapshotCache.delete(key);
      }
    }
    console.log(`[SnapshotClient] Cache invalidated for category ${categoryId}`);
  }
}

/**
 * Clear all snapshot cache
 */
export function clearSnapshotCache(): void {
  snapshotCache.clear();
  console.log('[SnapshotClient] Cache cleared');
}

/**
 * Get cache statistics for debugging
 */
export function getSnapshotCacheStats(): {
  entries: number;
  keys: string[];
  totalTrades: number;
} {
  let totalTrades = 0;
  const keys: string[] = [];

  for (const [key, value] of snapshotCache.entries()) {
    keys.push(key);
    totalTrades += value.tradeList.trades.length;
  }

  return {
    entries: snapshotCache.size,
    keys,
    totalTrades,
  };
}
