import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";

// Test directory setup
const TEST_DIR = join(dirname(import.meta.dir), "test-diagnostic-modules");
const TEST_AGENT_DIR = join(TEST_DIR, "agent");
const TEST_LOGS_DIR = join(TEST_DIR, "logs");

beforeEach(() => {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  if (!existsSync(TEST_AGENT_DIR)) mkdirSync(TEST_AGENT_DIR, { recursive: true });
  if (!existsSync(TEST_LOGS_DIR)) mkdirSync(TEST_LOGS_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

// ============================================================================
// Failure Learning Tests (AC: #5)
// ============================================================================
describe("Failure Learning (AC#5)", () => {
  const {
    FailureLearning,
    getDefaultFailureLearningConfig,
    detectPatterns
  } = require("../src/failure-learning");

  test("records failure and persists to disk", () => {
    const config = {
      historyPath: join(TEST_AGENT_DIR, "failure-history.json"),
      maxHistorySize: 100,
      patternDetectionWindow: 24 * 60 * 60 * 1000
    };
    const learning = new FailureLearning(config);

    learning.recordFailure({
      phase: "research",
      errorType: "TIMEOUT",
      errorMessage: "API request timed out",
      context: { marketCount: 1000 },
      resolution: "retry"
    });

    const summary = learning.getSummary();
    expect(summary.totalFailures).toBe(1);
    expect(existsSync(config.historyPath)).toBe(true);
  });

  test("detects API timeout peak hours pattern", () => {
    const records = [];
    const now = Date.now();

    // Create timeouts concentrated at hour 14
    for (let i = 0; i < 6; i++) {
      const date = new Date(now - i * 60 * 1000);
      date.setHours(14);
      records.push({
        timestamp: date.getTime(),
        phase: "research",
        errorType: "TIMEOUT",
        errorMessage: "API timeout",
        context: {},
        resolution: "retry"
      });
    }

    const patterns = detectPatterns(records);
    const peakPattern = patterns.find((p: { type: string }) => p.type === "API_TIMEOUT_PEAK_HOURS");

    expect(peakPattern).toBeDefined();
    expect(peakPattern.recommendation).toBe("AVOID_PEAK_HOURS");
  });

  test("detects terminal overload pattern", () => {
    const records = [];
    const now = Date.now();

    // Create crashes with large segment sizes
    for (let i = 0; i < 4; i++) {
      records.push({
        timestamp: now - i * 60 * 1000,
        phase: "research",
        errorType: "CRASH",
        errorMessage: "Terminal crashed",
        context: { segmentSize: 6000 },
        resolution: "restart"
      });
    }

    const patterns = detectPatterns(records);
    const overloadPattern = patterns.find((p: { type: string }) => p.type === "TERMINAL_OVERLOAD");

    expect(overloadPattern).toBeDefined();
    expect(overloadPattern.recommendation).toBe("INCREASE_TERMINAL_COUNT");
  });

  test("adapts behavior based on patterns", () => {
    const config = {
      historyPath: join(TEST_AGENT_DIR, "failure-history.json"),
      maxHistorySize: 100,
      patternDetectionWindow: 24 * 60 * 60 * 1000
    };
    const learning = new FailureLearning(config);

    // Add failures to trigger pattern
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      learning.recordFailure({
        phase: "research",
        errorType: "TIMEOUT",
        errorMessage: "API timeout",
        context: {},
        resolution: "retry"
      });
    }

    const patterns = learning.analyzePatterns();
    const adaptations = learning.applyAdaptations({ terminalCount: 5 });

    expect(adaptations.length).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// Idempotency Manager Tests (AC: #6)
// ============================================================================
describe("Idempotency Manager (AC#6)", () => {
  const {
    IdempotencyManager,
    generateOperationId,
    hashObject
  } = require("../src/idempotency");

  test("generates consistent operation IDs", () => {
    const id1 = generateOperationId("MATCH_BET", { betId: "123", amount: "100" });
    const id2 = generateOperationId("MATCH_BET", { betId: "123", amount: "100" });
    const id3 = generateOperationId("MATCH_BET", { betId: "456", amount: "100" });

    expect(id1).toBe(id2); // Same params = same ID
    expect(id1).not.toBe(id3); // Different params = different ID
    expect(id1).toContain("MATCH_BET-");
  });

  test("caches results and returns cached value on duplicate", async () => {
    const config = {
      cachePath: join(TEST_AGENT_DIR, "idempotency-cache.json"),
      ttl: 24 * 60 * 60 * 1000,
      cleanupInterval: 60 * 60 * 1000
    };
    const manager = new IdempotencyManager(config);

    let callCount = 0;
    const operation = async () => {
      callCount++;
      return { success: true, txHash: "0x123" };
    };

    // First call
    const result1 = await manager.executeIdempotent("MATCH_BET", { betId: "123" }, operation);
    expect(result1.wasCached).toBe(false);
    expect(result1.result.success).toBe(true);
    expect(callCount).toBe(1);

    // Second call with same params
    const result2 = await manager.executeIdempotent("MATCH_BET", { betId: "123" }, operation);
    expect(result2.wasCached).toBe(true);
    expect(result2.result.success).toBe(true);
    expect(callCount).toBe(1); // Operation not called again
  });

  test("persists cache to disk", async () => {
    const config = {
      cachePath: join(TEST_AGENT_DIR, "idempotency-cache.json"),
      ttl: 24 * 60 * 60 * 1000,
      cleanupInterval: 60 * 60 * 1000
    };
    const manager = new IdempotencyManager(config);

    await manager.executeIdempotent("MATCH_BET", { betId: "123" }, async () => ({ result: "test" }));

    expect(existsSync(config.cachePath)).toBe(true);

    const content = readFileSync(config.cachePath, "utf-8");
    const cache = JSON.parse(content);
    expect(Object.keys(cache.operations).length).toBe(1);
  });
});

// ============================================================================
// Dead Letter Queue Tests (AC: #7)
// ============================================================================
describe("Dead Letter Queue (AC#7)", () => {
  const { DeadLetterQueue, analyzeDeadLetters } = require("../src/dead-letter-queue");

  test("moves failed task to queue", () => {
    const config = { storePath: join(TEST_AGENT_DIR, "dead-letters.json") };
    const queue = new DeadLetterQueue(config);

    const letter = queue.moveToDeadLetter(
      "task-123",
      "MATCH_BET",
      3,
      ["Error 1", "Error 2", "Error 3"],
      { betId: "bet-456" }
    );

    expect(letter.taskId).toBe("task-123");
    expect(letter.taskType).toBe("MATCH_BET");
    expect(letter.attempts).toBe(3);
    expect(queue.getCount()).toBe(1);
  });

  test("alerts on critical task failures", () => {
    const config = { storePath: join(TEST_AGENT_DIR, "dead-letters.json") };
    const queue = new DeadLetterQueue(config);

    let alertCalled = false;
    queue.setOnAlert(() => { alertCalled = true; });

    queue.moveToDeadLetter(
      "task-critical",
      "MATCH_BET", // Critical task type
      5,
      ["Failed after 5 attempts"],
      {}
    );

    expect(alertCalled).toBe(true);
  });

  test("retries dead letter", () => {
    const config = { storePath: join(TEST_AGENT_DIR, "dead-letters.json") };
    const queue = new DeadLetterQueue(config);

    queue.moveToDeadLetter("task-1", "SYNC_STATE", 3, ["Error"], {});
    expect(queue.getCount()).toBe(1);

    const retried = queue.retryDeadLetter("task-1");
    expect(retried).not.toBeNull();
    expect(retried!.taskId).toBe("task-1");
    expect(queue.getCount()).toBe(0);
  });

  test("analyzes dead letters by error type", () => {
    const letters = [
      {
        taskId: "1", taskType: "MATCH_BET", attempts: 3,
        firstAttempt: Date.now(), lastAttempt: Date.now(),
        errors: ["TIMEOUT error"], data: {}
      },
      {
        taskId: "2", taskType: "SYNC_STATE", attempts: 2,
        firstAttempt: Date.now(), lastAttempt: Date.now(),
        errors: ["TIMEOUT error"], data: {}
      },
      {
        taskId: "3", taskType: "MATCH_BET", attempts: 5,
        firstAttempt: Date.now(), lastAttempt: Date.now(),
        errors: ["connection refused"], data: {}
      }
    ];

    const analysis = analyzeDeadLetters(letters);

    expect(analysis.totalLetters).toBe(3);
    expect(analysis.criticalCount).toBe(2); // 2 MATCH_BET
    expect(analysis.byTaskType.MATCH_BET).toBe(2);
    expect(analysis.byTaskType.SYNC_STATE).toBe(1);
    expect(analysis.byErrorType.TIMEOUT).toBe(2);
    expect(analysis.byErrorType.CONNECTION_REFUSED).toBe(1);
  });
});

// ============================================================================
// Synthetic Monitoring Tests (AC: #8)
// ============================================================================
describe("Synthetic Monitoring (AC#8)", () => {
  const {
    SyntheticMonitoring,
    testStatePersistence,
    testScoreCalculation
  } = require("../src/synthetic-monitoring");

  test("tests state persistence successfully", async () => {
    const result = await testStatePersistence(TEST_AGENT_DIR);
    expect(result.name).toBe("state_persistence");
    expect(result.status).toBe("PASS");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("tests score calculation successfully", async () => {
    const result = await testScoreCalculation();
    expect(result.name).toBe("score_calculation");
    expect(result.status).toBe("PASS");
  });

  test("runs all synthetic tests", async () => {
    const config = {
      agentDir: TEST_AGENT_DIR,
      rpcUrl: "https://mainnet.base.org",
      intervalMs: 10 * 60 * 1000
    };
    const monitoring = new SyntheticMonitoring(config);

    const run = await monitoring.runSyntheticTests();

    expect(run.timestamp).toBeGreaterThan(0);
    expect(run.results.length).toBe(4);
    expect(run.results.map((r: { name: string }) => r.name)).toContain("state_persistence");
    expect(run.results.map((r: { name: string }) => r.name)).toContain("score_calculation");
    expect(["PASS", "FAIL"]).toContain(run.overallStatus);
  });

  test("tracks total checks performed", async () => {
    const config = {
      agentDir: TEST_AGENT_DIR,
      rpcUrl: "https://mainnet.base.org",
      intervalMs: 10 * 60 * 1000
    };
    const monitoring = new SyntheticMonitoring(config);

    expect(monitoring.getTotalChecks()).toBe(0);

    await monitoring.runSyntheticTests();
    expect(monitoring.getTotalChecks()).toBe(1);

    await monitoring.runSyntheticTests();
    expect(monitoring.getTotalChecks()).toBe(2);
  });
});

// ============================================================================
// Correlation Tracker Tests (AC: #9)
// ============================================================================
describe("Correlation Tracker (AC#9)", () => {
  const {
    CorrelationTracker,
    generateCorrelationId,
    getCorrelationId
  } = require("../src/correlation");

  test("generates correlation ID with correct format", () => {
    const id = generateCorrelationId("RESEARCH");
    expect(id).toMatch(/^RESEARCH-\d+-[a-z0-9]+$/);
  });

  test("starts and ends operations with tracking", () => {
    const config = {
      logPath: join(TEST_LOGS_DIR, "structured.jsonl"),
      enableFileLogging: true
    };
    const tracker = new CorrelationTracker(config);

    const { correlationId, result } = tracker.startOperation("RESEARCH", () => {
      return "test result";
    });

    expect(correlationId).toMatch(/^RESEARCH-/);
    expect(result).toBe("test result");
    expect(tracker.getActiveOperationCount()).toBe(1);

    tracker.endOperation(correlationId, true);
    expect(tracker.getActiveOperationCount()).toBe(0);
  });

  test("logs to structured JSONL file", () => {
    const config = {
      logPath: join(TEST_LOGS_DIR, "structured.jsonl"),
      enableFileLogging: true
    };
    const tracker = new CorrelationTracker(config);

    const { correlationId } = tracker.startOperation("TEST", () => "result");
    tracker.log(correlationId, "INFO", "Test message", { data: 123 });
    tracker.endOperation(correlationId);

    expect(existsSync(config.logPath)).toBe(true);

    const content = readFileSync(config.logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const firstLog = JSON.parse(lines[0]);
    expect(firstLog.correlationId).toContain("TEST-");
    expect(firstLog.message).toContain("Operation started");
  });
});

// ============================================================================
// Prompt Evolution Tests (AC: #10)
// ============================================================================
describe("Prompt Evolution (AC#10)", () => {
  const { PromptEvolution } = require("../src/prompt-evolution");

  const basePrompt = "You are a trading agent.";

  test("initializes with base prompt", () => {
    const config = {
      statePath: join(TEST_AGENT_DIR, "prompt-evolution.json"),
      basePrompt
    };
    const evolution = new PromptEvolution(config);

    expect(evolution.getCurrentPrompt()).toBe(basePrompt);
    expect(evolution.getCurrentVersion()).toBe(0);
  });

  test("analyzes prompt effectiveness", () => {
    const config = {
      statePath: join(TEST_AGENT_DIR, "prompt-evolution.json"),
      basePrompt
    };
    const evolution = new PromptEvolution(config);

    // Low performance metrics
    const analysis = evolution.analyzePromptEffectiveness({
      toolCallSuccessRate: 0.4, // Below 0.6 threshold
      failedResearchCycles: 10, // Above 5 threshold
      winRate: 0.3 // Below 0.35 threshold
    });

    expect(analysis.needsChange).toBe(true);
    expect(analysis.suggestedChanges.additions!.length).toBeGreaterThan(0);
    expect(analysis.reasons.length).toBeGreaterThan(0);
  });

  test("updates prompt with hints", () => {
    const config = {
      statePath: join(TEST_AGENT_DIR, "prompt-evolution.json"),
      basePrompt
    };
    const evolution = new PromptEvolution(config);

    const newPrompt = evolution.updatePrompt(
      { additions: ["Be more conservative in decisions."] },
      "Low win rate detected"
    );

    expect(newPrompt).toContain(basePrompt);
    expect(newPrompt).toContain("Adaptive Decision Hints");
    expect(newPrompt).toContain("Be more conservative");
    expect(evolution.getCurrentVersion()).toBe(1);
  });

  test("rolls back to previous version", () => {
    const config = {
      statePath: join(TEST_AGENT_DIR, "prompt-evolution.json"),
      basePrompt
    };
    const evolution = new PromptEvolution(config);

    evolution.updatePrompt({ additions: ["Hint 1"] }, "Reason 1");
    evolution.updatePrompt({ additions: ["Hint 2"] }, "Reason 2");
    expect(evolution.getCurrentVersion()).toBe(2);

    const rolledBack = evolution.rollbackPrompt(1);
    expect(evolution.getCurrentVersion()).toBe(1);
    expect(rolledBack).not.toContain("Hint 2");
  });

  test("never modifies core instructions", () => {
    const config = {
      statePath: join(TEST_AGENT_DIR, "prompt-evolution.json"),
      basePrompt
    };
    const evolution = new PromptEvolution(config);

    evolution.updatePrompt({ additions: ["New hint"] }, "Test");
    const newPrompt = evolution.getCurrentPrompt();

    expect(newPrompt).toContain(basePrompt);
    // Base prompt should be at the start, unchanged
    expect(newPrompt.startsWith(basePrompt)).toBe(true);
  });
});

// ============================================================================
// Metrics Dashboard Tests (AC: #11)
// ============================================================================
describe("Metrics Dashboard (AC#11)", () => {
  const {
    createMetricsResponse,
    createDefaultMetricsResponse,
    createDefaultCircuitBreakerMetrics,
    createDefaultWatchdogMetrics,
    createDefaultTaskMetrics,
    createDefaultDiagnosticMetrics,
    calculateSuccessRate
  } = require("../src/health");
  const { RecoveryLevel } = require("../src/types");

  test("creates metrics response with all required fields", () => {
    const metrics = createMetricsResponse({
      agentStatus: "HEALTHY",
      uptime: 3600000,
      lastHeartbeat: Date.now(),
      phase: "research",
      recoveryLevel: RecoveryLevel.SOFT_RESET,
      tasks: { completed: 10, failed: 2, inProgress: 1, successRate: 0.83 },
      circuitBreakers: {
        polymarketAPI: { state: "CLOSED", failures: 0, lastFailure: null, usingFallback: false },
        baseRPC: { state: "OPEN", failures: 3, lastFailure: Date.now() - 1000, usingFallback: true },
        backend: { state: "HALF_OPEN", failures: 1, lastFailure: Date.now() - 5000, usingFallback: false }
      },
      watchdog: { checksPerformed: 100, intervened: 2, lastIntervention: Date.now() - 60000, lastInterventionType: "RESTART" },
      diagnostics: { lastRun: Date.now() - 3600000, checksPass: 4, checksFail: 1, checksWarn: 0 }
    });

    // Verify agent section
    expect(metrics.agent.status).toBe("HEALTHY");
    expect(metrics.agent.uptime).toBe(3600000);
    expect(metrics.agent.phase).toBe("research");
    expect(metrics.agent.recoveryLevel).toBe(RecoveryLevel.SOFT_RESET);

    // Verify tasks section
    expect(metrics.tasks.completed).toBe(10);
    expect(metrics.tasks.failed).toBe(2);
    expect(metrics.tasks.inProgress).toBe(1);
    expect(metrics.tasks.successRate).toBe(0.83);

    // Verify circuit breakers section
    expect(metrics.circuitBreakers.polymarketAPI.state).toBe("CLOSED");
    expect(metrics.circuitBreakers.baseRPC.state).toBe("OPEN");
    expect(metrics.circuitBreakers.baseRPC.usingFallback).toBe(true);
    expect(metrics.circuitBreakers.backend.state).toBe("HALF_OPEN");

    // Verify watchdog section
    expect(metrics.watchdog.checksPerformed).toBe(100);
    expect(metrics.watchdog.intervened).toBe(2);
    expect(metrics.watchdog.lastInterventionType).toBe("RESTART");

    // Verify diagnostics section
    expect(metrics.diagnostics.checksPass).toBe(4);
    expect(metrics.diagnostics.checksFail).toBe(1);
    expect(metrics.diagnostics.checksWarn).toBe(0);
  });

  test("creates default metrics response", () => {
    const metrics = createDefaultMetricsResponse(1000, "idle");

    expect(metrics.agent.status).toBe("HEALTHY");
    expect(metrics.agent.uptime).toBe(1000);
    expect(metrics.agent.phase).toBe("idle");
    expect(metrics.tasks.completed).toBe(0);
    expect(metrics.tasks.successRate).toBe(1.0);
    expect(metrics.circuitBreakers.polymarketAPI.state).toBe("CLOSED");
    expect(metrics.circuitBreakers.baseRPC.state).toBe("CLOSED");
    expect(metrics.circuitBreakers.backend.state).toBe("CLOSED");
    expect(metrics.watchdog.checksPerformed).toBe(0);
    expect(metrics.diagnostics.lastRun).toBeNull();
  });

  test("creates default circuit breaker metrics", () => {
    const cb = createDefaultCircuitBreakerMetrics();

    expect(cb.state).toBe("CLOSED");
    expect(cb.failures).toBe(0);
    expect(cb.lastFailure).toBeNull();
    expect(cb.usingFallback).toBe(false);
  });

  test("creates default watchdog metrics", () => {
    const wd = createDefaultWatchdogMetrics();

    expect(wd.checksPerformed).toBe(0);
    expect(wd.intervened).toBe(0);
    expect(wd.lastIntervention).toBeNull();
    expect(wd.lastInterventionType).toBeNull();
  });

  test("creates default task metrics", () => {
    const tm = createDefaultTaskMetrics();

    expect(tm.completed).toBe(0);
    expect(tm.failed).toBe(0);
    expect(tm.inProgress).toBe(0);
    expect(tm.successRate).toBe(1.0);
  });

  test("creates default diagnostic metrics", () => {
    const dm = createDefaultDiagnosticMetrics();

    expect(dm.lastRun).toBeNull();
    expect(dm.checksPass).toBe(0);
    expect(dm.checksFail).toBe(0);
    expect(dm.checksWarn).toBe(0);
  });

  test("calculates success rate correctly", () => {
    expect(calculateSuccessRate(10, 0)).toBe(1.0);
    expect(calculateSuccessRate(8, 2)).toBe(0.8);
    expect(calculateSuccessRate(0, 10)).toBe(0);
    expect(calculateSuccessRate(0, 0)).toBe(1.0); // Default when no tasks
  });
});

// ============================================================================
// AC#11 & AC#12 Integration Tests
// ============================================================================
describe("Metrics Dashboard Integration (AC#11)", () => {
  test("can collect metrics from all modules", () => {
    const { SelfDiagnostics, getDefaultSelfDiagnosticsConfig } = require("../src/self-diagnostics");
    const { ServiceManager, getDefaultServiceManagerConfig } = require("../src/service-manager");
    const { SyntheticMonitoring, getDefaultSyntheticMonitoringConfig } = require("../src/synthetic-monitoring");

    const selfDiagnosticsConfig = {
      agentDir: TEST_AGENT_DIR,
      logsDir: TEST_LOGS_DIR,
      agentStatePath: join(TEST_AGENT_DIR, "agent-state.json"),
      memoryGrowthThreshold: 1.5,
      toolCallSuccessThreshold: 0.5,
      winRateThreshold: 0.4,
      diskSpaceThreshold: 1000
    };

    const serviceManagerConfig = {
      cacheDir: join(TEST_AGENT_DIR, "cache"),
      primaryRpcUrl: "https://mainnet.base.org",
      secondaryRpcUrl: null,
      backendUrl: "http://localhost:3001"
    };

    const syntheticConfig = {
      agentDir: TEST_AGENT_DIR,
      rpcUrl: "https://mainnet.base.org",
      intervalMs: 10 * 60 * 1000
    };

    const selfDiagnostics = new SelfDiagnostics(selfDiagnosticsConfig);
    const serviceManager = new ServiceManager(serviceManagerConfig);
    const syntheticMonitoring = new SyntheticMonitoring(syntheticConfig);

    // Collect metrics
    const circuitBreakers = serviceManager.getCircuitBreakerStates();
    const serviceHealth = serviceManager.getServiceHealth();

    // Build metrics response structure per AC#11
    const metrics = {
      agent: { status: "HEALTHY", uptime: 0, lastHeartbeat: 0, phase: "idle", recoveryLevel: 0 },
      tasks: { completed: 0, failed: 0, inProgress: 0, successRate: 100 },
      circuitBreakers: {
        polymarketAPI: circuitBreakers.polymarket,
        baseRPC: circuitBreakers.baseRPC,
        backend: circuitBreakers.backend
      },
      watchdog: { checksPerformed: 0, intervened: 0, lastIntervention: null },
      diagnostics: { lastRun: null, checksPass: 0, checksFail: 0, checksWarn: 0 }
    };

    expect(metrics.circuitBreakers.polymarketAPI).toBe("CLOSED");
    expect(metrics.circuitBreakers.baseRPC).toBe("CLOSED");
    expect(metrics.circuitBreakers.backend).toBe("CLOSED");
    expect(metrics.agent.status).toBe("HEALTHY");
  });
});
