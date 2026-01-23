import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";

// Test directory setup
const TEST_DIR = join(dirname(import.meta.dir), "test-service-manager");
const TEST_CACHE_DIR = join(TEST_DIR, "cache");

beforeEach(() => {
  // Create test directories
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
  if (!existsSync(TEST_CACHE_DIR)) {
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
  }
});

afterEach(() => {
  // Cleanup test files
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ============================================================================
// Unit Tests: Circuit Breaker
// ============================================================================
describe("Circuit Breaker", () => {
  const {
    createDefaultCircuitBreaker,
    recordCircuitBreakerFailure,
    recordCircuitBreakerSuccess,
    canCallThroughCircuitBreaker,
    getCircuitBreakerNextState
  } = require("../src/service-manager");

  test("creates default circuit breaker in CLOSED state", () => {
    const cb = createDefaultCircuitBreaker();
    expect(cb.state).toBe("CLOSED");
    expect(cb.failures).toBe(0);
  });

  test("records failures and opens after threshold", () => {
    let cb = createDefaultCircuitBreaker();

    cb = recordCircuitBreakerFailure(cb);
    expect(cb.state).toBe("CLOSED");
    expect(cb.failures).toBe(1);

    cb = recordCircuitBreakerFailure(cb);
    expect(cb.state).toBe("CLOSED");
    expect(cb.failures).toBe(2);

    cb = recordCircuitBreakerFailure(cb);
    expect(cb.state).toBe("OPEN");
    expect(cb.failures).toBe(3);
  });

  test("records success and resets to CLOSED", () => {
    let cb = createDefaultCircuitBreaker();
    cb = recordCircuitBreakerFailure(cb);
    cb = recordCircuitBreakerFailure(cb);
    expect(cb.failures).toBe(2);

    cb = recordCircuitBreakerSuccess(cb);
    expect(cb.state).toBe("CLOSED");
    expect(cb.failures).toBe(0);
  });

  test("allows calls when CLOSED", () => {
    const cb = createDefaultCircuitBreaker();
    expect(canCallThroughCircuitBreaker(cb)).toBe(true);
  });

  test("blocks calls when OPEN", () => {
    let cb = createDefaultCircuitBreaker();
    cb = recordCircuitBreakerFailure(cb);
    cb = recordCircuitBreakerFailure(cb);
    cb = recordCircuitBreakerFailure(cb);

    expect(cb.state).toBe("OPEN");
    // Just opened, openUntil is in future
    expect(canCallThroughCircuitBreaker(cb)).toBe(false);
  });

  test("transitions to HALF_OPEN after timeout", () => {
    let cb = createDefaultCircuitBreaker();
    cb = recordCircuitBreakerFailure(cb);
    cb = recordCircuitBreakerFailure(cb);
    cb = recordCircuitBreakerFailure(cb);

    // Simulate time passing by setting openUntil in past
    cb.openUntil = Date.now() - 1000;

    cb = getCircuitBreakerNextState(cb);
    expect(cb.state).toBe("HALF_OPEN");
    expect(canCallThroughCircuitBreaker(cb)).toBe(true);
  });
});

// ============================================================================
// Unit Tests: Cache Management
// ============================================================================
describe("Cache Management", () => {
  const {
    loadMarketsCache,
    saveMarketsCache,
    isCacheFresh
  } = require("../src/service-manager");

  test("returns null for missing cache file", () => {
    expect(loadMarketsCache("/nonexistent/markets.json")).toBeNull();
  });

  test("saves and loads cache", () => {
    const cache = {
      markets: [{ id: "1", question: "Test?", outcomes: ["Yes", "No"], timestamp: Date.now() }],
      cachedAt: Date.now()
    };
    const cachePath = join(TEST_CACHE_DIR, "markets.json");

    saveMarketsCache(cache, cachePath);
    expect(existsSync(cachePath)).toBe(true);

    const loaded = loadMarketsCache(cachePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.markets.length).toBe(1);
    expect(loaded!.markets[0].id).toBe("1");
  });

  test("isCacheFresh returns true for fresh cache", () => {
    const cache = {
      markets: [],
      cachedAt: Date.now()
    };
    expect(isCacheFresh(cache)).toBe(true);
  });

  test("isCacheFresh returns false for stale cache", () => {
    const cache = {
      markets: [],
      cachedAt: Date.now() - 31 * 60 * 1000 // 31 minutes ago
    };
    expect(isCacheFresh(cache)).toBe(false);
  });

  test("isCacheFresh returns false for null cache", () => {
    expect(isCacheFresh(null)).toBe(false);
  });
});

// ============================================================================
// Unit Tests: Pending Sync Queue
// ============================================================================
describe("Pending Sync Queue", () => {
  const {
    loadPendingSyncQueue,
    savePendingSyncQueue,
    addToPendingSyncQueue
  } = require("../src/service-manager");

  test("returns empty queue for missing file", () => {
    const queue = loadPendingSyncQueue("/nonexistent/queue.json");
    expect(queue.items.length).toBe(0);
  });

  test("saves and loads queue", () => {
    const queue = {
      items: [{ id: "1", type: "bet_update", data: {}, timestamp: Date.now(), attempts: 0 }],
      lastSyncAttempt: Date.now()
    };
    const queuePath = join(TEST_CACHE_DIR, "pending-sync.json");

    savePendingSyncQueue(queue, queuePath);
    expect(existsSync(queuePath)).toBe(true);

    const loaded = loadPendingSyncQueue(queuePath);
    expect(loaded.items.length).toBe(1);
    expect(loaded.items[0].type).toBe("bet_update");
  });

  test("adds item to queue", () => {
    let queue = { items: [], lastSyncAttempt: 0 };

    queue = addToPendingSyncQueue(queue, {
      type: "bet_update",
      data: { betId: "123" }
    });

    expect(queue.items.length).toBe(1);
    expect(queue.items[0].type).toBe("bet_update");
    expect(queue.items[0].data.betId).toBe("123");
    expect(queue.items[0].id).toBeTruthy();
    expect(queue.items[0].timestamp).toBeGreaterThan(0);
    expect(queue.items[0].attempts).toBe(0);
  });
});

// ============================================================================
// Unit Tests: Service Manager Class
// ============================================================================
describe("ServiceManager Class", () => {
  const { ServiceManager, getDefaultServiceManagerConfig } = require("../src/service-manager");

  test("initializes with default config", () => {
    const config = {
      cacheDir: TEST_CACHE_DIR,
      primaryRpcUrl: "https://mainnet.base.org",
      secondaryRpcUrl: null,
      backendUrl: "http://localhost:3001"
    };

    const manager = new ServiceManager(config);

    const states = manager.getCircuitBreakerStates();
    expect(states.polymarket).toBe("CLOSED");
    expect(states.baseRPC).toBe("CLOSED");
    expect(states.backend).toBe("CLOSED");
  });

  test("getServiceHealth returns healthy status initially", () => {
    const config = {
      cacheDir: TEST_CACHE_DIR,
      primaryRpcUrl: "https://mainnet.base.org",
      secondaryRpcUrl: null,
      backendUrl: "http://localhost:3001"
    };

    const manager = new ServiceManager(config);
    const health = manager.getServiceHealth();

    expect(health.polymarket.status).toBe("HEALTHY");
    expect(health.baseRPC.status).toBe("HEALTHY");
    expect(health.backend.status).toBe("HEALTHY");
  });

  test("getCurrentRpcUrl returns primary by default", () => {
    const config = {
      cacheDir: TEST_CACHE_DIR,
      primaryRpcUrl: "https://primary.rpc.com",
      secondaryRpcUrl: "https://secondary.rpc.com",
      backendUrl: "http://localhost:3001"
    };

    const manager = new ServiceManager(config);
    expect(manager.getCurrentRpcUrl()).toBe("https://primary.rpc.com");
  });

  test("enableFallbacks updates service status", () => {
    const config = {
      cacheDir: TEST_CACHE_DIR,
      primaryRpcUrl: "https://primary.rpc.com",
      secondaryRpcUrl: "https://secondary.rpc.com",
      backendUrl: "http://localhost:3001"
    };

    const manager = new ServiceManager(config);
    manager.enableFallbacks(["polymarket", "baseRPC"]);

    const health = manager.getServiceHealth();
    expect(health.polymarket.status).toBe("DEGRADED");
    expect(health.polymarket.fallback).toBe("CACHE");
    expect(health.baseRPC.status).toBe("DEGRADED");
    expect(health.baseRPC.fallback).toBe("SECONDARY_RPC");
    expect(manager.getCurrentRpcUrl()).toBe("https://secondary.rpc.com");
  });

  test("resetFallbacks restores default state", () => {
    const config = {
      cacheDir: TEST_CACHE_DIR,
      primaryRpcUrl: "https://primary.rpc.com",
      secondaryRpcUrl: "https://secondary.rpc.com",
      backendUrl: "http://localhost:3001"
    };

    const manager = new ServiceManager(config);
    manager.enableFallbacks(["baseRPC"]);
    expect(manager.getCurrentRpcUrl()).toBe("https://secondary.rpc.com");

    manager.resetFallbacks("baseRPC");
    expect(manager.getCurrentRpcUrl()).toBe("https://primary.rpc.com");

    const health = manager.getServiceHealth();
    expect(health.baseRPC.status).toBe("HEALTHY");
    expect(health.baseRPC.fallback).toBe("NONE");
  });

  test("getPendingSyncCount returns queue size", () => {
    const config = {
      cacheDir: TEST_CACHE_DIR,
      primaryRpcUrl: "https://mainnet.base.org",
      secondaryRpcUrl: null,
      backendUrl: "http://localhost:3001"
    };

    const manager = new ServiceManager(config);
    expect(manager.getPendingSyncCount()).toBe(0);
  });
});

// ============================================================================
// Integration Tests: Graceful Degradation
// ============================================================================
describe("Graceful Degradation", () => {
  const { ServiceManager } = require("../src/service-manager");

  test("executePolymarketWithFallback uses cache on failure", async () => {
    const config = {
      cacheDir: TEST_CACHE_DIR,
      primaryRpcUrl: "https://mainnet.base.org",
      secondaryRpcUrl: null,
      backendUrl: "http://localhost:3001"
    };

    const manager = new ServiceManager(config);

    // Pre-populate cache
    const cache = {
      markets: [{ id: "cached-1", question: "Cached?", outcomes: ["Yes", "No"], timestamp: Date.now() }],
      cachedAt: Date.now()
    };
    writeFileSync(join(TEST_CACHE_DIR, "markets.json"), JSON.stringify(cache));

    // Simulate failing primary
    const failingFn = async () => {
      throw new Error("Service unavailable");
    };

    // First few calls should try and fail, opening circuit
    for (let i = 0; i < 3; i++) {
      await manager.executePolymarketWithFallback(failingFn, "markets");
    }

    // Now should fall back to cache
    const result = await manager.executePolymarketWithFallback(failingFn, "markets");

    expect(result.fromCache).toBe(true);
    expect(result.result).not.toBeNull();
    expect(result.result.length).toBe(1);
    expect(result.result[0].id).toBe("cached-1");
  });

  test("executeBackendWithFallback uses offline mode and queues sync", async () => {
    const config = {
      cacheDir: TEST_CACHE_DIR,
      primaryRpcUrl: "https://mainnet.base.org",
      secondaryRpcUrl: null,
      backendUrl: "http://localhost:3001"
    };

    const manager = new ServiceManager(config);

    // Simulate failing backend
    const failingFn = async () => {
      throw new Error("Backend unavailable");
    };

    const offlineFallback = () => ({ local: true });

    // Trigger enough failures to open circuit
    for (let i = 0; i < 3; i++) {
      await manager.executeBackendWithFallback(failingFn, offlineFallback, {
        type: "bet_update",
        data: { betId: `bet-${i}` }
      });
    }

    // Check queue was populated
    expect(manager.getPendingSyncCount()).toBe(3);

    // Verify result uses fallback
    const result = await manager.executeBackendWithFallback(failingFn, offlineFallback);
    expect(result.offline).toBe(true);
    expect(result.result.local).toBe(true);
  });
});

// ============================================================================
// AC Validation Tests
// ============================================================================
describe("AC#4 Validation: Graceful Degradation", () => {
  const { ServiceManager } = require("../src/service-manager");

  test("AC4: Polymarket API down → Use cached market data", async () => {
    const config = {
      cacheDir: TEST_CACHE_DIR,
      primaryRpcUrl: "https://mainnet.base.org",
      secondaryRpcUrl: null,
      backendUrl: "http://localhost:3001"
    };

    const manager = new ServiceManager(config);

    // Create cache with 25-minute-old data (within 30 min limit)
    const cache = {
      markets: [{ id: "market-1", question: "Will X happen?", outcomes: ["Yes", "No"], timestamp: Date.now() }],
      cachedAt: Date.now() - 25 * 60 * 1000
    };
    writeFileSync(join(TEST_CACHE_DIR, "markets.json"), JSON.stringify(cache));

    // Open circuit breaker
    for (let i = 0; i < 3; i++) {
      await manager.executePolymarketWithFallback(async () => { throw new Error("API down"); }, "markets");
    }

    // Should use cache
    const result = await manager.executePolymarketWithFallback(async () => { throw new Error("API down"); }, "markets");

    expect(result.fromCache).toBe(true);
    expect(result.result).not.toBeNull();
  });

  test("AC4: Base RPC down → Switch to secondary RPC provider", async () => {
    const config = {
      cacheDir: TEST_CACHE_DIR,
      primaryRpcUrl: "https://primary.rpc.com",
      secondaryRpcUrl: "https://secondary.rpc.com",
      backendUrl: "http://localhost:3001"
    };

    const manager = new ServiceManager(config);

    // Enable fallbacks
    manager.enableFallbacks(["baseRPC"]);

    expect(manager.getCurrentRpcUrl()).toBe("https://secondary.rpc.com");
    expect(manager.getServiceHealth().baseRPC.fallback).toBe("SECONDARY_RPC");
  });

  test("AC4: Backend down → Work in offline mode", async () => {
    const config = {
      cacheDir: TEST_CACHE_DIR,
      primaryRpcUrl: "https://mainnet.base.org",
      secondaryRpcUrl: null,
      backendUrl: "http://localhost:3001"
    };

    const manager = new ServiceManager(config);

    // Open circuit breaker
    for (let i = 0; i < 3; i++) {
      await manager.executeBackendWithFallback(
        async () => { throw new Error("Backend down"); },
        () => ({ offlineMode: true }),
        { type: "status_update", data: { status: "active" } }
      );
    }

    // Verify offline mode
    const result = await manager.executeBackendWithFallback(
      async () => { throw new Error("Backend down"); },
      () => ({ offlineMode: true })
    );

    expect(result.offline).toBe(true);
    expect(result.result.offlineMode).toBe(true);
    expect(manager.getServiceHealth().backend.fallback).toBe("LOCAL_STATE");

    // Verify items queued for sync
    expect(manager.getPendingSyncCount()).toBe(3);
  });
});
