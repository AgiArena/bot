/**
 * Tests for Resilience Logging and Metrics System
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, readFileSync, mkdirSync, rmdirSync } from "fs";
import { join } from "path";
import {
  ResilienceLogger,
  buildMetricsResponse,
  getResilienceLogger,
  initResilienceLogger,
  DEFAULT_LOG_PATH,
  DEFAULT_METRICS_PATH,
  DEFAULT_MAX_LOG_SIZE,
  type ResilienceEventType,
  type MetricsResponse
} from "../src/resilience-logger";

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_DIR = "/tmp/test-resilience-logger";
const TEST_LOG_PATH = join(TEST_DIR, "resilience.log");
const TEST_METRICS_PATH = join(TEST_DIR, "resilience-metrics.json");

function cleanupTestFiles(): void {
  const files = [
    TEST_LOG_PATH,
    TEST_METRICS_PATH,
    `${TEST_METRICS_PATH}.tmp`
  ];

  for (const file of files) {
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }

  if (existsSync(TEST_DIR)) {
    try {
      rmdirSync(TEST_DIR);
    } catch {}
  }
}

function createTestLogger(): ResilienceLogger {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }

  return new ResilienceLogger({
    logPath: TEST_LOG_PATH,
    metricsPath: TEST_METRICS_PATH,
    rotateOnSize: false // Disable rotation for tests
  });
}

// ============================================================================
// ResilienceLogger Tests
// ============================================================================

describe("ResilienceLogger", () => {
  let logger: ResilienceLogger;

  beforeEach(() => {
    cleanupTestFiles();
    logger = createTestLogger();
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  describe("Basic Logging", () => {
    test("log writes entry to file", () => {
      logger.log("WATCHDOG_CHECK", "Test message");

      expect(existsSync(TEST_LOG_PATH)).toBe(true);

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("WATCHDOG_CHECK");
      expect(content).toContain("Test message");
    });

    test("log includes timestamp", () => {
      logger.log("WATCHDOG_CHECK", "Test");

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      // Should have ISO timestamp format
      expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    test("log includes data when provided", () => {
      logger.log("TASK_START", "Task started", { taskId: "task123", type: "RESEARCH" });

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("taskId");
      expect(content).toContain("task123");
    });

    test("multiple logs append to file", () => {
      logger.log("WATCHDOG_CHECK", "First");
      logger.log("RECOVERY_START", "Second");
      logger.log("TASK_COMPLETE", "Third");

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(3);
    });
  });

  describe("Convenience Logging Methods", () => {
    test("logWatchdogCheck logs correct event type", () => {
      logger.logWatchdogCheck(5000, "HEALTHY");

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("WATCHDOG_CHECK");
      expect(content).toContain("5000");
      expect(content).toContain("HEALTHY");
    });

    test("logRecoveryStart logs level and reason", () => {
      logger.logRecoveryStart("SOFT_RESET", "Test reason");

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("RECOVERY_START");
      expect(content).toContain("SOFT_RESET");
      expect(content).toContain("Test reason");
    });

    test("logRecoveryComplete logs duration", () => {
      logger.logRecoveryComplete("MEDIUM_RESET", 2500);

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("RECOVERY_COMPLETE");
      expect(content).toContain("2500");
    });

    test("logCircuitBreakerChange logs state transition", () => {
      logger.logCircuitBreakerChange("Polymarket API", "CLOSED", "OPEN", "3 failures");

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("CIRCUIT_BREAKER_OPEN");
      expect(content).toContain("Polymarket API");
    });

    test("logTaskStart logs task info", () => {
      logger.logTaskStart("task_123", "RESEARCH");

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("TASK_START");
      expect(content).toContain("task_123");
    });

    test("logTaskCheckpoint logs checkpoint name", () => {
      logger.logTaskCheckpoint("task_123", "MARKETS_FETCHED");

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("TASK_CHECKPOINT");
      expect(content).toContain("MARKETS_FETCHED");
    });

    test("logTaskComplete logs duration", () => {
      logger.logTaskComplete("task_123", 5000);

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("TASK_COMPLETE");
      expect(content).toContain("5000ms");
    });

    test("logTaskFailed logs error", () => {
      logger.logTaskFailed("task_123", "Connection timeout");

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("TASK_FAILED");
      expect(content).toContain("Connection timeout");
    });

    test("logTaskTimeout logs timeout value", () => {
      logger.logTaskTimeout("task_123", 30000);

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("TASK_TIMEOUT");
      expect(content).toContain("30000");
    });

    test("logTaskResume logs checkpoint", () => {
      logger.logTaskResume("task_123", "SEGMENTS_CREATED");

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("TASK_RESUME");
      expect(content).toContain("SEGMENTS_CREATED");
    });

    test("logFailoverStart logs primary PID", () => {
      logger.logFailoverStart(12345);

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("FAILOVER_START");
      expect(content).toContain("12345");
    });

    test("logFailoverComplete logs new primary PID", () => {
      logger.logFailoverComplete(12346);

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("FAILOVER_COMPLETE");
      expect(content).toContain("12346");
    });

    test("logAlertSent logs channel and message", () => {
      logger.logAlertSent("Telegram", "Agent crashed");

      const content = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(content).toContain("ALERT_SENT");
      expect(content).toContain("Telegram");
    });
  });

  describe("Metrics Tracking", () => {
    test("tracks watchdog checks", () => {
      logger.log("WATCHDOG_CHECK", "Check 1");
      logger.log("WATCHDOG_CHECK", "Check 2");
      logger.log("WATCHDOG_CHECK", "Check 3");

      const metrics = logger.getWatchdogMetrics();
      expect(metrics.checksPerformed).toBe(3);
    });

    test("tracks interventions", () => {
      logger.log("RECOVERY_START", "Recovery 1");
      logger.log("CONTEXT_CLEAR", "Clear 1");

      const metrics = logger.getWatchdogMetrics();
      expect(metrics.intervened).toBe(2);
      expect(metrics.lastIntervention).not.toBeNull();
    });

    test("tracks task completions", () => {
      logger.log("TASK_START", "Start");
      logger.log("TASK_COMPLETE", "Complete");

      const metrics = logger.getTaskMetrics();
      expect(metrics.completed).toBe(1);
      expect(metrics.inProgress).toBe(0);
    });

    test("tracks task failures", () => {
      logger.log("TASK_START", "Start");
      logger.log("TASK_FAILED", "Failed");

      const metrics = logger.getTaskMetrics();
      expect(metrics.failed).toBe(1);
      expect(metrics.inProgress).toBe(0);
    });

    test("calculates success rate correctly", () => {
      logger.log("TASK_START", "1");
      logger.log("TASK_COMPLETE", "1");
      logger.log("TASK_START", "2");
      logger.log("TASK_COMPLETE", "2");
      logger.log("TASK_START", "3");
      logger.log("TASK_FAILED", "3");

      const metrics = logger.getTaskMetrics();
      // 2 completed, 1 failed = 66.67% success rate
      expect(metrics.successRate).toBeCloseTo(66.67, 1);
    });

    test("success rate is 100% when no tasks", () => {
      const metrics = logger.getTaskMetrics();
      expect(metrics.successRate).toBe(100);
    });
  });

  describe("Metrics Persistence", () => {
    test("metrics persist to file", () => {
      logger.log("WATCHDOG_CHECK", "Test");

      expect(existsSync(TEST_METRICS_PATH)).toBe(true);

      const content = readFileSync(TEST_METRICS_PATH, "utf-8");
      const saved = JSON.parse(content);

      expect(saved.watchdogChecks).toBe(1);
    });

    test("metrics load from file on init", () => {
      // First logger
      logger.log("WATCHDOG_CHECK", "1");
      logger.log("WATCHDOG_CHECK", "2");

      // New logger instance should load saved metrics
      const logger2 = new ResilienceLogger({
        logPath: TEST_LOG_PATH,
        metricsPath: TEST_METRICS_PATH
      });

      const metrics = logger2.getWatchdogMetrics();
      expect(metrics.checksPerformed).toBe(2);
    });
  });

  describe("Reset Metrics", () => {
    test("resetMetrics clears all metrics", () => {
      logger.log("WATCHDOG_CHECK", "1");
      logger.log("RECOVERY_START", "1");
      logger.log("TASK_COMPLETE", "1");

      logger.resetMetrics();

      const watchdog = logger.getWatchdogMetrics();
      const tasks = logger.getTaskMetrics();

      expect(watchdog.checksPerformed).toBe(0);
      expect(watchdog.intervened).toBe(0);
      expect(tasks.completed).toBe(0);
    });
  });
});

// ============================================================================
// buildMetricsResponse Tests
// ============================================================================

describe("buildMetricsResponse", () => {
  test("builds complete metrics response", () => {
    const response = buildMetricsResponse({
      agentStatus: "healthy",
      uptime: 3600,
      lastHeartbeat: Date.now() - 5000,
      phase: "idle",
      recoveryLevel: 0,
      taskMetrics: {
        completed: 10,
        failed: 2,
        inProgress: 1,
        successRate: 83.33
      },
      circuitBreakers: {
        polymarketAPI: "CLOSED",
        baseRPC: "CLOSED",
        backend: "OPEN"
      },
      watchdogMetrics: {
        checksPerformed: 100,
        intervened: 3,
        lastIntervention: "2026-01-23T10:00:00Z"
      }
    });

    expect(response.agent.status).toBe("healthy");
    expect(response.agent.uptime).toBe(3600);
    expect(response.agent.phase).toBe("idle");
    expect(response.tasks.completed).toBe(10);
    expect(response.circuitBreakers.backend).toBe("OPEN");
    expect(response.watchdog.checksPerformed).toBe(100);
    expect(response.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("includes all required fields", () => {
    const response = buildMetricsResponse({
      agentStatus: "healthy",
      uptime: 0,
      lastHeartbeat: null,
      phase: "idle",
      recoveryLevel: 0,
      taskMetrics: { completed: 0, failed: 0, inProgress: 0, successRate: 100 },
      circuitBreakers: { polymarketAPI: "CLOSED", baseRPC: "CLOSED", backend: "CLOSED" },
      watchdogMetrics: { checksPerformed: 0, intervened: 0, lastIntervention: null }
    });

    expect(response).toHaveProperty("agent");
    expect(response).toHaveProperty("tasks");
    expect(response).toHaveProperty("circuitBreakers");
    expect(response).toHaveProperty("watchdog");
    expect(response).toHaveProperty("timestamp");
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

  test("getResilienceLogger returns same instance", () => {
    const logger1 = initResilienceLogger({
      logPath: TEST_LOG_PATH,
      metricsPath: TEST_METRICS_PATH
    });
    const logger2 = getResilienceLogger();

    expect(logger2).toBe(logger1);
  });
});

// ============================================================================
// Default Configuration Tests
// ============================================================================

describe("Default Configuration", () => {
  test("DEFAULT_LOG_PATH is set", () => {
    expect(DEFAULT_LOG_PATH).toBe("bot/agent/resilience.log");
  });

  test("DEFAULT_METRICS_PATH is set", () => {
    expect(DEFAULT_METRICS_PATH).toBe("bot/agent/resilience-metrics.json");
  });

  test("DEFAULT_MAX_LOG_SIZE is 10 MB", () => {
    expect(DEFAULT_MAX_LOG_SIZE).toBe(10 * 1024 * 1024);
  });
});
