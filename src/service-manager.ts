/**
 * Service Manager for Graceful Degradation
 *
 * Implements circuit breaker pattern and fallback strategies for external services:
 * - Polymarket API down → Use cached market data (up to 30 minutes old)
 * - Base RPC down → Switch to secondary RPC provider
 * - Backend down → Work in offline mode, sync when backend recovers
 *
 * AC: #4
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";

// ============================================================================
// Types
// ============================================================================

export type ServiceName = "polymarket" | "baseRPC" | "backend";
export type ServiceStatus = "HEALTHY" | "DEGRADED" | "DOWN";
export type FallbackStrategy = "CACHE" | "SECONDARY_RPC" | "LOCAL_STATE" | "NONE";
export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface ServiceHealth {
  status: ServiceStatus;
  fallback: FallbackStrategy;
  lastCheck: number;
  consecutiveFailures: number;
}

export interface ServiceConfig {
  polymarket: ServiceHealth;
  baseRPC: ServiceHealth;
  backend: ServiceHealth;
}

export interface CircuitBreaker {
  state: CircuitBreakerState;
  failures: number;
  lastFailure: number;
  openUntil: number;
}

export interface CachedMarket {
  id: string;
  question: string;
  outcomes: string[];
  timestamp: number;
  // Additional fields as needed
  [key: string]: unknown;
}

export interface MarketsCache {
  markets: CachedMarket[];
  cachedAt: number;
}

// ============================================================================
// Constants
// ============================================================================

const FAILURE_THRESHOLD = 3;
const OPEN_DURATION = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_AGE = 30 * 60 * 1000; // 30 minutes

// ============================================================================
// Circuit Breaker Implementation
// ============================================================================

/**
 * Create default circuit breaker state
 */
export function createDefaultCircuitBreaker(): CircuitBreaker {
  return {
    state: "CLOSED",
    failures: 0,
    lastFailure: 0,
    openUntil: 0
  };
}

/**
 * Record a failure for a circuit breaker
 */
export function recordCircuitBreakerFailure(cb: CircuitBreaker): CircuitBreaker {
  const now = Date.now();
  const newCb = { ...cb };

  newCb.failures++;
  newCb.lastFailure = now;

  if (newCb.failures >= FAILURE_THRESHOLD) {
    newCb.state = "OPEN";
    newCb.openUntil = now + OPEN_DURATION;
  }

  return newCb;
}

/**
 * Record a success for a circuit breaker
 */
export function recordCircuitBreakerSuccess(cb: CircuitBreaker): CircuitBreaker {
  return {
    ...cb,
    failures: 0,
    state: "CLOSED"
  };
}

/**
 * Check if a call can be made through the circuit breaker
 */
export function canCallThroughCircuitBreaker(cb: CircuitBreaker): boolean {
  if (cb.state === "CLOSED") return true;

  if (cb.state === "OPEN" && Date.now() > cb.openUntil) {
    // Transition to half-open, allow one test call
    return true;
  }

  // HALF_OPEN allows test calls
  return cb.state === "HALF_OPEN";
}

/**
 * Get the next state for a circuit breaker based on whether we can call
 */
export function getCircuitBreakerNextState(cb: CircuitBreaker): CircuitBreaker {
  if (cb.state === "OPEN" && Date.now() > cb.openUntil) {
    return { ...cb, state: "HALF_OPEN" };
  }
  return cb;
}

// ============================================================================
// Service Health Management
// ============================================================================

/**
 * Create default service health state
 */
export function createDefaultServiceHealth(): ServiceHealth {
  return {
    status: "HEALTHY",
    fallback: "NONE",
    lastCheck: Date.now(),
    consecutiveFailures: 0
  };
}

/**
 * Create default service configuration
 */
export function createDefaultServiceConfig(): ServiceConfig {
  return {
    polymarket: createDefaultServiceHealth(),
    baseRPC: createDefaultServiceHealth(),
    backend: createDefaultServiceHealth()
  };
}

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Load markets cache from disk
 */
export function loadMarketsCache(cachePath: string): MarketsCache | null {
  if (!existsSync(cachePath)) return null;

  try {
    const content = readFileSync(cachePath, "utf-8");
    return JSON.parse(content) as MarketsCache;
  } catch {
    return null;
  }
}

/**
 * Save markets cache to disk atomically
 */
export function saveMarketsCache(cache: MarketsCache, cachePath: string): void {
  const dir = dirname(cachePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${cachePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(cache, null, 2));
  renameSync(tempPath, cachePath);
}

/**
 * Check if cache is still fresh (within max age)
 */
export function isCacheFresh(cache: MarketsCache | null, maxAge: number = CACHE_MAX_AGE): boolean {
  if (!cache) return false;
  return Date.now() - cache.cachedAt < maxAge;
}

// ============================================================================
// Pending Sync Queue
// ============================================================================

export interface PendingSyncItem {
  id: string;
  type: "bet_update" | "agent_registration" | "status_update";
  data: unknown;
  timestamp: number;
  attempts: number;
}

export interface PendingSyncQueue {
  items: PendingSyncItem[];
  lastSyncAttempt: number;
}

/**
 * Load pending sync queue from disk
 */
export function loadPendingSyncQueue(queuePath: string): PendingSyncQueue {
  if (!existsSync(queuePath)) {
    return { items: [], lastSyncAttempt: 0 };
  }

  try {
    const content = readFileSync(queuePath, "utf-8");
    return JSON.parse(content) as PendingSyncQueue;
  } catch {
    return { items: [], lastSyncAttempt: 0 };
  }
}

/**
 * Save pending sync queue to disk atomically
 */
export function savePendingSyncQueue(queue: PendingSyncQueue, queuePath: string): void {
  const dir = dirname(queuePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${queuePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(queue, null, 2));
  renameSync(tempPath, queuePath);
}

/**
 * Add item to pending sync queue
 */
export function addToPendingSyncQueue(
  queue: PendingSyncQueue,
  item: Omit<PendingSyncItem, "id" | "timestamp" | "attempts">
): PendingSyncQueue {
  const newItem: PendingSyncItem = {
    id: `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    timestamp: Date.now(),
    attempts: 0,
    ...item
  };

  return {
    ...queue,
    items: [...queue.items, newItem]
  };
}

// ============================================================================
// Service Manager Class
// ============================================================================

export interface ServiceManagerConfig {
  cacheDir: string;
  primaryRpcUrl: string;
  secondaryRpcUrl: string | null;
  backendUrl: string;
}

export class ServiceManager {
  private readonly config: ServiceManagerConfig;
  private readonly circuitBreakers: Record<ServiceName, CircuitBreaker>;
  private readonly serviceHealth: ServiceConfig;
  private pendingSyncQueue: PendingSyncQueue;
  private currentRpcUrl: string;

  constructor(config: ServiceManagerConfig) {
    this.config = config;
    this.circuitBreakers = {
      polymarket: createDefaultCircuitBreaker(),
      baseRPC: createDefaultCircuitBreaker(),
      backend: createDefaultCircuitBreaker()
    };
    this.serviceHealth = createDefaultServiceConfig();
    this.pendingSyncQueue = loadPendingSyncQueue(join(config.cacheDir, "pending-sync.json"));
    this.currentRpcUrl = config.primaryRpcUrl;
  }

  /**
   * Get current circuit breaker states (for metrics/dashboard)
   */
  getCircuitBreakerStates(): Record<ServiceName, CircuitBreakerState> {
    return {
      polymarket: this.circuitBreakers.polymarket.state,
      baseRPC: this.circuitBreakers.baseRPC.state,
      backend: this.circuitBreakers.backend.state
    };
  }

  /**
   * Get current service health status
   */
  getServiceHealth(): ServiceConfig {
    return { ...this.serviceHealth };
  }

  /**
   * Execute a function with graceful degradation for Polymarket
   * Falls back to cached data if primary fails
   */
  async executePolymarketWithFallback<T>(
    primaryFn: () => Promise<T>,
    cacheKey: string
  ): Promise<{ result: T | null; fromCache: boolean; error?: string }> {
    // Update circuit breaker state
    this.circuitBreakers.polymarket = getCircuitBreakerNextState(this.circuitBreakers.polymarket);

    // Check if we can make the call
    if (canCallThroughCircuitBreaker(this.circuitBreakers.polymarket)) {
      try {
        const result = await primaryFn();

        // Success - record it and update cache
        this.circuitBreakers.polymarket = recordCircuitBreakerSuccess(this.circuitBreakers.polymarket);
        this.serviceHealth.polymarket = {
          status: "HEALTHY",
          fallback: "NONE",
          lastCheck: Date.now(),
          consecutiveFailures: 0
        };

        // Cache the result for future fallback
        if (cacheKey === "markets") {
          const cache: MarketsCache = {
            markets: result as unknown as CachedMarket[],
            cachedAt: Date.now()
          };
          saveMarketsCache(cache, join(this.config.cacheDir, "markets.json"));
        }

        return { result, fromCache: false };
      } catch (error) {
        // Failure - record it
        this.circuitBreakers.polymarket = recordCircuitBreakerFailure(this.circuitBreakers.polymarket);
        this.serviceHealth.polymarket.consecutiveFailures++;

        if (this.circuitBreakers.polymarket.state === "OPEN") {
          this.serviceHealth.polymarket.status = "DOWN";
          this.serviceHealth.polymarket.fallback = "CACHE";
        } else {
          this.serviceHealth.polymarket.status = "DEGRADED";
        }
      }
    }

    // Try fallback from cache
    if (cacheKey === "markets") {
      const cache = loadMarketsCache(join(this.config.cacheDir, "markets.json"));
      if (isCacheFresh(cache)) {
        return {
          result: cache!.markets as unknown as T,
          fromCache: true,
          error: "Using cached data due to service unavailability"
        };
      }
    }

    return { result: null, fromCache: false, error: "Service unavailable and no valid cache" };
  }

  /**
   * Execute a function with graceful degradation for RPC
   * Falls back to secondary RPC if primary fails
   */
  async executeRpcWithFallback<T>(
    rpcFn: (rpcUrl: string) => Promise<T>
  ): Promise<{ result: T | null; usedSecondary: boolean; error?: string }> {
    // Update circuit breaker state
    this.circuitBreakers.baseRPC = getCircuitBreakerNextState(this.circuitBreakers.baseRPC);

    // Try primary RPC
    if (canCallThroughCircuitBreaker(this.circuitBreakers.baseRPC)) {
      try {
        const result = await rpcFn(this.config.primaryRpcUrl);

        // Success - record it
        this.circuitBreakers.baseRPC = recordCircuitBreakerSuccess(this.circuitBreakers.baseRPC);
        this.serviceHealth.baseRPC = {
          status: "HEALTHY",
          fallback: "NONE",
          lastCheck: Date.now(),
          consecutiveFailures: 0
        };
        this.currentRpcUrl = this.config.primaryRpcUrl;

        return { result, usedSecondary: false };
      } catch {
        // Failure - record it
        this.circuitBreakers.baseRPC = recordCircuitBreakerFailure(this.circuitBreakers.baseRPC);
        this.serviceHealth.baseRPC.consecutiveFailures++;
      }
    }

    // Try secondary RPC if available
    if (this.config.secondaryRpcUrl) {
      try {
        const result = await rpcFn(this.config.secondaryRpcUrl);

        this.serviceHealth.baseRPC.status = "DEGRADED";
        this.serviceHealth.baseRPC.fallback = "SECONDARY_RPC";
        this.currentRpcUrl = this.config.secondaryRpcUrl;

        return { result, usedSecondary: true };
      } catch {
        // Both RPCs failed
      }
    }

    this.serviceHealth.baseRPC.status = "DOWN";
    return { result: null, usedSecondary: false, error: "Both RPC endpoints unavailable" };
  }

  /**
   * Execute a function with graceful degradation for Backend
   * Falls back to local state and queues for later sync
   */
  async executeBackendWithFallback<T>(
    primaryFn: () => Promise<T>,
    offlineFallback: () => T,
    syncData?: { type: PendingSyncItem["type"]; data: unknown }
  ): Promise<{ result: T; offline: boolean; error?: string }> {
    // Update circuit breaker state
    this.circuitBreakers.backend = getCircuitBreakerNextState(this.circuitBreakers.backend);

    // Check if we can make the call
    if (canCallThroughCircuitBreaker(this.circuitBreakers.backend)) {
      try {
        const result = await primaryFn();

        // Success - record it
        this.circuitBreakers.backend = recordCircuitBreakerSuccess(this.circuitBreakers.backend);
        this.serviceHealth.backend = {
          status: "HEALTHY",
          fallback: "NONE",
          lastCheck: Date.now(),
          consecutiveFailures: 0
        };

        // Try to sync pending items
        await this.syncPendingItems();

        return { result, offline: false };
      } catch {
        // Failure - record it
        this.circuitBreakers.backend = recordCircuitBreakerFailure(this.circuitBreakers.backend);
        this.serviceHealth.backend.consecutiveFailures++;

        if (this.circuitBreakers.backend.state === "OPEN") {
          this.serviceHealth.backend.status = "DOWN";
          this.serviceHealth.backend.fallback = "LOCAL_STATE";
        } else {
          this.serviceHealth.backend.status = "DEGRADED";
        }
      }
    }

    // Use offline fallback
    const result = offlineFallback();

    // Queue the data for later sync if provided
    if (syncData) {
      this.pendingSyncQueue = addToPendingSyncQueue(this.pendingSyncQueue, syncData);
      savePendingSyncQueue(this.pendingSyncQueue, join(this.config.cacheDir, "pending-sync.json"));
    }

    return {
      result,
      offline: true,
      error: "Backend unavailable, using local state"
    };
  }

  /**
   * Get current RPC URL (primary or secondary based on health)
   */
  getCurrentRpcUrl(): string {
    return this.currentRpcUrl;
  }

  /**
   * Sync pending items when backend becomes available
   */
  private async syncPendingItems(): Promise<void> {
    if (this.pendingSyncQueue.items.length === 0) return;

    const synced: string[] = [];
    const backendUrl = this.config.backendUrl;

    for (const item of this.pendingSyncQueue.items) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        // Attempt to sync the item
        const response = await fetch(`${backendUrl}/api/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (response.ok) {
          synced.push(item.id);
        } else {
          item.attempts++;
        }
      } catch {
        item.attempts++;
      }
    }

    // Remove synced items
    if (synced.length > 0) {
      this.pendingSyncQueue.items = this.pendingSyncQueue.items.filter(
        item => !synced.includes(item.id)
      );
      this.pendingSyncQueue.lastSyncAttempt = Date.now();
      savePendingSyncQueue(this.pendingSyncQueue, join(this.config.cacheDir, "pending-sync.json"));
    }
  }

  /**
   * Get pending sync queue size
   */
  getPendingSyncCount(): number {
    return this.pendingSyncQueue.items.length;
  }

  /**
   * Enable fallbacks for a specific service
   * Called by self-diagnostics when issues detected
   */
  enableFallbacks(services: ServiceName[]): void {
    for (const service of services) {
      switch (service) {
        case "polymarket":
          this.serviceHealth.polymarket.status = "DEGRADED";
          this.serviceHealth.polymarket.fallback = "CACHE";
          break;
        case "baseRPC":
          this.serviceHealth.baseRPC.status = "DEGRADED";
          this.serviceHealth.baseRPC.fallback = "SECONDARY_RPC";
          if (this.config.secondaryRpcUrl) {
            this.currentRpcUrl = this.config.secondaryRpcUrl;
          }
          break;
        case "backend":
          this.serviceHealth.backend.status = "DEGRADED";
          this.serviceHealth.backend.fallback = "LOCAL_STATE";
          break;
      }
    }
  }

  /**
   * Reset fallbacks for a specific service
   */
  resetFallbacks(service: ServiceName): void {
    this.circuitBreakers[service] = createDefaultCircuitBreaker();
    this.serviceHealth[service] = createDefaultServiceHealth();

    if (service === "baseRPC") {
      this.currentRpcUrl = this.config.primaryRpcUrl;
    }
  }
}

/**
 * Get default service manager configuration
 */
export function getDefaultServiceManagerConfig(botDir: string): ServiceManagerConfig {
  return {
    cacheDir: join(botDir, "agent", "cache"),
    primaryRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    secondaryRpcUrl: process.env.SECONDARY_BASE_RPC_URL || null,
    backendUrl: process.env.BACKEND_URL || "http://localhost:3001"
  };
}
