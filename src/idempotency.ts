/**
 * Idempotency Manager
 *
 * Prevents duplicate execution of critical operations like bet matching.
 * Uses operation IDs based on action + params hash.
 *
 * AC: #6
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";

// ============================================================================
// Types
// ============================================================================

export interface OperationResult<T = unknown> {
  result: T;
  timestamp: number;
  operationId: string;
}

export interface IdempotencyCache {
  operations: Record<string, OperationResult>;
  lastCleanup: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ============================================================================
// Hash Generation
// ============================================================================

/**
 * Hash an object deterministically
 */
export function hashObject(obj: unknown): string {
  // Sort keys for deterministic hashing
  const str = JSON.stringify(obj, (key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted: Record<string, unknown>, k) => {
        sorted[k] = value[k];
        return sorted;
      }, {});
    }
    return value;
  });

  return createHash("sha256").update(str).digest("hex").slice(0, 16);
}

/**
 * Generate operation ID from action and parameters
 */
export function generateOperationId(action: string, params: unknown): string {
  return `${action}-${hashObject(params)}`;
}

// ============================================================================
// Cache Persistence
// ============================================================================

/**
 * Get default idempotency cache
 */
export function getDefaultIdempotencyCache(): IdempotencyCache {
  return {
    operations: {},
    lastCleanup: Date.now()
  };
}

/**
 * Load idempotency cache from disk
 */
export function loadIdempotencyCache(cachePath: string): IdempotencyCache {
  if (!existsSync(cachePath)) {
    return getDefaultIdempotencyCache();
  }

  try {
    const content = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(content) as IdempotencyCache;

    return {
      operations: parsed.operations ?? {},
      lastCleanup: parsed.lastCleanup ?? Date.now()
    };
  } catch {
    return getDefaultIdempotencyCache();
  }
}

/**
 * Save idempotency cache atomically
 */
export function saveIdempotencyCache(cache: IdempotencyCache, cachePath: string): void {
  const dir = dirname(cachePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${cachePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(cache, null, 2));
  renameSync(tempPath, cachePath);
}

/**
 * Clean up expired entries from cache
 */
export function cleanupIdempotencyCache(cache: IdempotencyCache, ttl: number = DEFAULT_TTL): IdempotencyCache {
  const cutoff = Date.now() - ttl;
  const newOperations: Record<string, OperationResult> = {};

  for (const [id, op] of Object.entries(cache.operations)) {
    if (op.timestamp > cutoff) {
      newOperations[id] = op;
    }
  }

  return {
    operations: newOperations,
    lastCleanup: Date.now()
  };
}

// ============================================================================
// Idempotency Manager Class
// ============================================================================

export interface IdempotencyManagerConfig {
  cachePath: string;
  ttl: number;
  cleanupInterval: number;
}

export class IdempotencyManager {
  private readonly config: IdempotencyManagerConfig;
  private cache: IdempotencyCache;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: IdempotencyManagerConfig) {
    this.config = config;
    this.cache = loadIdempotencyCache(config.cachePath);

    // Run initial cleanup
    this.runCleanup();
  }

  /**
   * Execute an operation idempotently
   * Returns cached result if operation was already executed
   */
  async executeIdempotent<T>(
    action: string,
    params: unknown,
    operation: () => Promise<T>
  ): Promise<{ result: T; wasCached: boolean; operationId: string }> {
    const operationId = generateOperationId(action, params);

    // Check cache first
    const cached = this.cache.operations[operationId];
    if (cached) {
      return {
        result: cached.result as T,
        wasCached: true,
        operationId
      };
    }

    // Execute operation
    const result = await operation();

    // Cache result
    this.cache.operations[operationId] = {
      result,
      timestamp: Date.now(),
      operationId
    };
    this.save();

    return {
      result,
      wasCached: false,
      operationId
    };
  }

  /**
   * Check if an operation result is cached
   */
  isCached(action: string, params: unknown): boolean {
    const operationId = generateOperationId(action, params);
    return operationId in this.cache.operations;
  }

  /**
   * Get cached result if exists
   */
  getCached<T>(action: string, params: unknown): T | null {
    const operationId = generateOperationId(action, params);
    const cached = this.cache.operations[operationId];
    return cached ? (cached.result as T) : null;
  }

  /**
   * Manually cache a result
   */
  cacheResult<T>(action: string, params: unknown, result: T): string {
    const operationId = generateOperationId(action, params);
    this.cache.operations[operationId] = {
      result,
      timestamp: Date.now(),
      operationId
    };
    this.save();
    return operationId;
  }

  /**
   * Invalidate a cached operation
   */
  invalidate(action: string, params: unknown): boolean {
    const operationId = generateOperationId(action, params);
    if (operationId in this.cache.operations) {
      delete this.cache.operations[operationId];
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Get cache statistics
   */
  getStats(): { totalCached: number; oldestEntry: number | null; lastCleanup: number } {
    const operations = Object.values(this.cache.operations);
    const oldestEntry = operations.length > 0
      ? Math.min(...operations.map(op => op.timestamp))
      : null;

    return {
      totalCached: operations.length,
      oldestEntry,
      lastCleanup: this.cache.lastCleanup
    };
  }

  /**
   * Start periodic cleanup
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.runCleanup();
    }, this.config.cleanupInterval);
  }

  /**
   * Stop periodic cleanup
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Run cleanup manually
   */
  runCleanup(): void {
    this.cache = cleanupIdempotencyCache(this.cache, this.config.ttl);
    this.save();
  }

  /**
   * Clear all cached operations
   */
  clearAll(): void {
    this.cache = getDefaultIdempotencyCache();
    this.save();
  }

  /**
   * Save cache to disk
   */
  private save(): void {
    saveIdempotencyCache(this.cache, this.config.cachePath);
  }
}

/**
 * Get default idempotency manager configuration
 * @param botDir - Root directory of the bot
 * @returns IdempotencyManagerConfig with default cache path, TTL (24h), and cleanup interval (1h)
 */
export function getDefaultIdempotencyManagerConfig(botDir: string): IdempotencyManagerConfig {
  return {
    cachePath: join(botDir, "agent", "idempotency-cache.json"),
    ttl: DEFAULT_TTL,
    cleanupInterval: 60 * 60 * 1000 // 1 hour
  };
}
