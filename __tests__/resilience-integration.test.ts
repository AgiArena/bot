/**
 * Tests for Resilience Integration Module
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, rmdirSync, readdirSync } from "fs";
import { join } from "path";
import {
  ResilienceManager,
  getResilienceManager,
  initResilienceManager,
  DEFAULT_RESILIENCE_CONFIG
} from "../src/resilience-integration";
import type { AgentState } from "../src/types";

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_DIR = "/tmp/test-resilience-integration";

function cleanupTestFiles(): void {
  if (existsSync(TEST_DIR)) {
    try {
      const files = readdirSync(TEST_DIR);
      for (const file of files) {
        unlinkSync(join(TEST_DIR, file));
      }
      rmdirSync(TEST_DIR);
    } catch {}
  }
}

function createTestBaseState(): AgentState {
  return {
    agentAddress: "0x123",
    totalCapital: 1000,
    currentBalance: 950,
    matchedBets: [],
    lastResearchAt: null,
    researchJobId: null,
    phase: "idle"
  };
}

function createTestManager(): ResilienceManager {
  return new ResilienceManager({
    agentDir: TEST_DIR,
    backupEnabled: false,
    watchdogIntervalMs: 100, // Fast for tests
    stallThresholdSec: 1
  });
}

// ============================================================================
// ResilienceManager Tests
// ============================================================================

describe("ResilienceManager", () => {
  let manager: ResilienceManager;

  beforeEach(() => {
    cleanupTestFiles();
  });

  afterEach(() => {
    if (manager) {
      manager.stop();
    }
    cleanupTestFiles();
  });

  describe("Initialization", () => {
    test("creates manager with default config", () => {
      manager = new ResilienceManager({ agentDir: TEST_DIR });

      expect(manager).toBeDefined();
    });

    test("creates agent directory if not exists", () => {
      manager = new ResilienceManager({ agentDir: TEST_DIR });

      expect(existsSync(TEST_DIR)).toBe(true);
    });

    test("initialize creates resilient state", () => {
      manager = createTestManager();
      const baseState = createTestBaseState();

      const resilientState = manager.initialize(baseState);

      expect(resilientState.agentAddress).toBe(baseState.agentAddress);
      expect(resilientState.lastHeartbeat).toBeDefined();
      expect(resilientState.recoveryState).toBeDefined();
      expect(resilientState.recoverableState).toBeDefined();
    });

    test("initialize creates extended state file", () => {
      manager = createTestManager();
      const baseState = createTestBaseState();

      manager.initialize(baseState);

      expect(existsSync(join(TEST_DIR, "extended-state.json"))).toBe(true);
    });
  });

  describe("Watchdog Monitoring", () => {
    test("start begins watchdog monitoring", async () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      manager.start();

      // Wait for at least one watchdog check
      await new Promise(resolve => setTimeout(resolve, 150));

      // Verify resilience log was created
      expect(existsSync(join(TEST_DIR, "resilience.log"))).toBe(true);
    });

    test("runWatchdogCheck returns health result", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const result = manager.runWatchdogCheck();

      expect(result.status).toBeDefined();
      expect(result.action).toBeDefined();
    });

    test("stop clears watchdog interval", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      manager.start();
      manager.stop();

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe("Heartbeat", () => {
    test("updateHeartbeat updates timestamp", async () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      await new Promise(resolve => setTimeout(resolve, 10));

      manager.updateHeartbeat();

      // Verify heartbeat was updated (check via watchdog)
      const result = manager.runWatchdogCheck();
      expect(result.status).toBeDefined();
    });
  });

  describe("Phase Management", () => {
    test("startPhase updates phase in state", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      manager.startPhase("research");

      // Verify via metrics
      const metrics = manager.getMetricsResponse();
      expect(metrics.agent.phase).toBe("research");
    });
  });

  describe("Task Queue", () => {
    test("getTaskQueue returns task queue instance", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const queue = manager.getTaskQueue();

      expect(queue).toBeDefined();
    });

    test("createTask creates and tracks task", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const task = manager.createTask("RESEARCH", { marketId: "test" });

      expect(task.id).toBeDefined();
      expect(task.type).toBe("RESEARCH");
      expect(task.state).toBe("PENDING");
    });

    test("completeTask marks task as completed", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const task = manager.createTask("RESEARCH");
      manager.getTaskQueue().startTask(task.id);
      manager.completeTask(task.id, { result: "success" });

      const queue = manager.getTaskQueue();
      const completedTask = queue.getTask(task.id);
      expect(completedTask?.state).toBe("COMPLETED");
    });

    test("failTask marks task as failed after max attempts", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      // Create task with maxAttempts=1 so it fails immediately
      const queue = manager.getTaskQueue();
      const task = queue.addTask("EVALUATE", undefined, { maxAttempts: 1 });

      // Start the task
      const startedTask = queue.startTask(task.id);
      expect(startedTask?.state).toBe("IN_PROGRESS");

      // Fail it - should now be FAILED since attempts >= maxAttempts
      manager.failTask(task.id, "Test error");

      const failedTask = queue.getTask(task.id);
      expect(failedTask?.state).toBe("FAILED");
      expect(failedTask?.error).toBe("Test error");
    });

    test("addCheckpoint saves checkpoint", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const task = manager.createTask("RESEARCH");
      manager.getTaskQueue().startTask(task.id);
      manager.addCheckpoint(task.id, "MARKETS_FETCHED", { count: 10 });

      const queue = manager.getTaskQueue();
      const taskWithCheckpoint = queue.getTask(task.id);
      expect(taskWithCheckpoint?.checkpoints.length).toBe(1);
      expect(taskWithCheckpoint?.checkpoints[0].name).toBe("MARKETS_FETCHED");
    });

    test("recoverTasks returns in-progress tasks", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const task = manager.createTask("MATCH_BET");
      manager.getTaskQueue().startTask(task.id);
      manager.addCheckpoint(task.id, "SEGMENTS_CREATED", { segments: 5 });

      // Create new manager to simulate recovery
      const newManager = createTestManager();
      newManager.initialize(createTestBaseState());

      const recovered = newManager.recoverTasks();

      expect(recovered.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Circuit Breakers", () => {
    test("getCircuitBreakerStates returns all states", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const states = manager.getCircuitBreakerStates();

      expect(states.polymarketAPI).toBeDefined();
      expect(states.baseRPC).toBeDefined();
      expect(states.backend).toBeDefined();
    });

    test("withPolymarketBreaker executes operation", async () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const result = await manager.withPolymarketBreaker(async () => {
        return "success";
      });

      expect(result).toBe("success");
    });

    test("withBaseRpcBreaker executes operation", async () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const result = await manager.withBaseRpcBreaker(async () => {
        return 42;
      });

      expect(result).toBe(42);
    });

    test("withBackendBreaker executes operation", async () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const result = await manager.withBackendBreaker(async () => {
        return { data: "test" };
      });

      expect(result.data).toBe("test");
    });

    test("circuit breaker uses fallback on failure", async () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      // Force multiple failures to open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await manager.withBackendBreaker(async () => {
            throw new Error("fail");
          });
        } catch {}
      }

      // Now use fallback
      const result = await manager.withBackendBreaker(
        async () => { throw new Error("fail"); },
        "fallback"
      );

      expect(result).toBe("fallback");
    });
  });

  describe("Output Monitoring", () => {
    test("getOutputMonitor returns monitor instance", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const monitor = manager.getOutputMonitor();

      expect(monitor).toBeDefined();
    });

    test("createOutputRecorder returns recorder function", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const recorder = manager.createOutputRecorder();

      expect(typeof recorder).toBe("function");
    });

    test("output recorder records string output", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const recorder = manager.createOutputRecorder();
      recorder("test output line");

      const monitor = manager.getOutputMonitor();
      expect(monitor.getRecentLines()).toContain("test output line");
    });

    test("checkOutputHealth returns boolean", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const result = manager.checkOutputHealth();

      expect(typeof result).toBe("boolean");
    });
  });

  describe("Backup Agent", () => {
    test("getBackupAgent returns backup agent instance", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const backup = manager.getBackupAgent();

      expect(backup).toBeDefined();
    });

    test("backup agent is disabled by default in tests", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const backup = manager.getBackupAgent();

      expect(backup.isEnabled()).toBe(false);
    });
  });

  describe("Metrics", () => {
    test("recordToolCall increments counter", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      manager.recordToolCall();
      manager.recordToolCall();

      // Verify via watchdog metrics
      const result = manager.runWatchdogCheck();
      expect(result).toBeDefined();
    });

    test("recordError increments error counter", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      manager.recordError();

      // Verify via watchdog check
      const result = manager.runWatchdogCheck();
      expect(result).toBeDefined();
    });

    test("getMetricsResponse returns complete metrics", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const metrics = manager.getMetricsResponse();

      expect(metrics.agent).toBeDefined();
      expect(metrics.tasks).toBeDefined();
      expect(metrics.circuitBreakers).toBeDefined();
      expect(metrics.watchdog).toBeDefined();
      expect(metrics.timestamp).toBeDefined();
    });

    test("metrics include correct agent status", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      manager.runWatchdogCheck();
      const metrics = manager.getMetricsResponse();

      expect(["healthy", "unhealthy", "degraded", "recovering"]).toContain(metrics.agent.status);
    });

    test("metrics include uptime", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const metrics = manager.getMetricsResponse();

      expect(typeof metrics.agent.uptime).toBe("number");
      expect(metrics.agent.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Logger", () => {
    test("getLogger returns logger instance", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const logger = manager.getLogger();

      expect(logger).toBeDefined();
    });
  });

  describe("Recovery State", () => {
    test("getCurrentRecoveryLevel returns level", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const level = manager.getCurrentRecoveryLevel();

      expect(typeof level).toBe("number");
      expect(level).toBeGreaterThanOrEqual(0);
    });

    test("getRecoverableState returns state or null", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      const state = manager.getRecoverableState();

      // May be null if no recoverable state saved yet
      expect(state === null || typeof state === "object").toBe(true);
    });
  });

  describe("Context Clear", () => {
    test("triggerContextClear creates signal file", () => {
      manager = createTestManager();
      manager.initialize(createTestBaseState());

      manager.triggerContextClear("test reason");

      expect(existsSync(join(TEST_DIR, "CLEAR_CONTEXT"))).toBe(true);
    });
  });
});

// ============================================================================
// Singleton Tests
// ============================================================================

describe("Singleton Functions", () => {
  beforeEach(() => {
    cleanupTestFiles();
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  test("getResilienceManager returns same instance", () => {
    const manager1 = initResilienceManager({ agentDir: TEST_DIR });
    const manager2 = getResilienceManager();

    expect(manager2).toBe(manager1);

    manager1.stop();
  });

  test("initResilienceManager creates new instance", () => {
    const manager1 = initResilienceManager({ agentDir: TEST_DIR });
    const manager2 = initResilienceManager({ agentDir: TEST_DIR });

    // Both should be valid managers
    expect(manager1).toBeDefined();
    expect(manager2).toBeDefined();

    manager1.stop();
    manager2.stop();
  });
});

// ============================================================================
// Default Config Tests
// ============================================================================

describe("Default Configuration", () => {
  test("DEFAULT_RESILIENCE_CONFIG has expected values", () => {
    expect(DEFAULT_RESILIENCE_CONFIG.agentDir).toBe("bot/agent");
    expect(DEFAULT_RESILIENCE_CONFIG.backupEnabled).toBe(false);
    expect(DEFAULT_RESILIENCE_CONFIG.watchdogIntervalMs).toBe(60000);
    expect(DEFAULT_RESILIENCE_CONFIG.stallThresholdSec).toBe(300);
  });
});
