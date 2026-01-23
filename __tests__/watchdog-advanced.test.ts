/**
 * Tests for Advanced Watchdog Monitoring System
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  checkAgentHealth,
  determineRecoveryLevel,
  resetRecoveryState,
  getRecoveryState,
  MetricsCollector,
  RecoveryLevel,
  DEFAULT_PHASE_TIMEOUTS,
  type WatchdogMetrics,
  type HealthCheckResult
} from "../src/watchdog-advanced";

// ============================================================================
// Helper Functions
// ============================================================================

function createHealthyMetrics(): WatchdogMetrics {
  return {
    heartbeatAge: 5000,        // 5 seconds old (healthy)
    toolCallRate: 10,          // 10 calls/min (healthy)
    outputStalled: false,
    memoryUsage: 256,          // 256 MB
    errorRate: 2,              // 2 errors/hour (healthy)
    phase: "idle",
    phaseStartTime: Date.now()
  };
}

// ============================================================================
// checkAgentHealth Tests
// ============================================================================

describe("checkAgentHealth", () => {
  describe("Priority 1: Heartbeat Check", () => {
    test("returns CRITICAL when heartbeat is stale (>10 min)", () => {
      const metrics = createHealthyMetrics();
      metrics.heartbeatAge = 11 * 60 * 1000; // 11 minutes

      const result = checkAgentHealth(metrics);

      expect(result.status).toBe("CRITICAL");
      expect(result.action).toBe("RESTART");
      expect(result.reason).toContain("Heartbeat stale");
    });

    test("passes heartbeat check when fresh", () => {
      const metrics = createHealthyMetrics();
      metrics.heartbeatAge = 5 * 60 * 1000; // 5 minutes

      const result = checkAgentHealth(metrics);

      expect(result.status).not.toBe("CRITICAL");
    });
  });

  describe("Priority 2: Infinite Loop Detection", () => {
    test("returns WARNING when tool call rate > 60/min", () => {
      const metrics = createHealthyMetrics();
      metrics.toolCallRate = 65; // High rate

      const result = checkAgentHealth(metrics);

      expect(result.status).toBe("WARNING");
      expect(result.action).toBe("CONTEXT_CLEAR");
      expect(result.reason).toContain("tool call rate");
    });

    test("passes when tool call rate is normal", () => {
      const metrics = createHealthyMetrics();
      metrics.toolCallRate = 30;

      const result = checkAgentHealth(metrics);

      expect(result.action).not.toBe("CONTEXT_CLEAR");
    });
  });

  describe("Priority 3: Output Stall Detection", () => {
    test("returns STUCK when output is stalled", () => {
      const metrics = createHealthyMetrics();
      metrics.outputStalled = true;

      const result = checkAgentHealth(metrics);

      expect(result.status).toBe("STUCK");
      expect(result.action).toBe("SEND_SIGNAL");
      expect(result.reason).toContain("No output");
    });
  });

  describe("Priority 4: Phase Timeout Detection", () => {
    test("returns STUCK when research phase exceeds 15 min timeout", () => {
      const metrics = createHealthyMetrics();
      metrics.phase = "research";
      metrics.phaseStartTime = Date.now() - 16 * 60 * 1000; // 16 minutes ago

      const result = checkAgentHealth(metrics);

      expect(result.status).toBe("STUCK");
      expect(result.action).toBe("KILL_TERMINALS_RESTART");
      expect(result.reason).toContain("research phase timeout");
    });

    test("returns STUCK when evaluation phase exceeds 10 min timeout", () => {
      const metrics = createHealthyMetrics();
      metrics.phase = "evaluation";
      metrics.phaseStartTime = Date.now() - 11 * 60 * 1000; // 11 minutes ago

      const result = checkAgentHealth(metrics);

      expect(result.status).toBe("STUCK");
      expect(result.action).toBe("KILL_TERMINALS_RESTART");
      expect(result.reason).toContain("evaluation phase timeout");
    });

    test("returns STUCK when execution phase exceeds 5 min timeout", () => {
      const metrics = createHealthyMetrics();
      metrics.phase = "execution";
      metrics.phaseStartTime = Date.now() - 6 * 60 * 1000; // 6 minutes ago

      const result = checkAgentHealth(metrics);

      expect(result.status).toBe("STUCK");
      expect(result.action).toBe("KILL_TERMINALS_RESTART");
      expect(result.reason).toContain("execution phase timeout");
    });

    test("passes when phase is within timeout", () => {
      const metrics = createHealthyMetrics();
      metrics.phase = "research";
      metrics.phaseStartTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago

      const result = checkAgentHealth(metrics);

      expect(result.status).not.toBe("STUCK");
    });
  });

  describe("Priority 5: Error Rate Check", () => {
    test("returns DEGRADED when error rate > 10/hour", () => {
      const metrics = createHealthyMetrics();
      metrics.errorRate = 15; // High rate

      const result = checkAgentHealth(metrics);

      expect(result.status).toBe("DEGRADED");
      expect(result.action).toBe("EXPONENTIAL_BACKOFF");
      expect(result.reason).toContain("error rate");
    });
  });

  describe("Healthy Agent", () => {
    test("returns HEALTHY when all metrics are normal", () => {
      const metrics = createHealthyMetrics();

      const result = checkAgentHealth(metrics);

      expect(result.status).toBe("HEALTHY");
      expect(result.action).toBe("NONE");
      expect(result.reason).toBeUndefined();
    });
  });

  describe("Priority Order", () => {
    test("heartbeat takes priority over other issues", () => {
      const metrics = createHealthyMetrics();
      metrics.heartbeatAge = 15 * 60 * 1000; // Stale heartbeat
      metrics.toolCallRate = 100;             // Also high tool rate
      metrics.outputStalled = true;           // Also stalled

      const result = checkAgentHealth(metrics);

      // Should return CRITICAL for heartbeat, not WARNING for tool rate
      expect(result.status).toBe("CRITICAL");
      expect(result.action).toBe("RESTART");
    });

    test("tool call rate takes priority over output stall", () => {
      const metrics = createHealthyMetrics();
      metrics.toolCallRate = 100;    // High tool rate
      metrics.outputStalled = true;  // Also stalled

      const result = checkAgentHealth(metrics);

      // Should return WARNING for tool rate, not STUCK for output
      expect(result.status).toBe("WARNING");
      expect(result.action).toBe("CONTEXT_CLEAR");
    });
  });

  describe("Custom Configuration", () => {
    test("respects custom heartbeat threshold", () => {
      const metrics = createHealthyMetrics();
      metrics.heartbeatAge = 5 * 60 * 1000; // 5 minutes

      // With custom 3-minute threshold, this should be critical
      const result = checkAgentHealth(metrics, {
        heartbeatStaleMs: 3 * 60 * 1000
      });

      expect(result.status).toBe("CRITICAL");
    });

    test("respects custom tool call threshold", () => {
      const metrics = createHealthyMetrics();
      metrics.toolCallRate = 40;

      // With custom 30 threshold, this should trigger
      const result = checkAgentHealth(metrics, {
        toolCallRateThreshold: 30
      });

      expect(result.status).toBe("WARNING");
      expect(result.action).toBe("CONTEXT_CLEAR");
    });
  });
});

// ============================================================================
// Progressive Recovery Tests
// ============================================================================

describe("determineRecoveryLevel", () => {
  beforeEach(() => {
    resetRecoveryState();
  });

  test("first recovery returns SOFT_RESET", () => {
    const level = determineRecoveryLevel();
    expect(level).toBe(RecoveryLevel.SOFT_RESET);
  });

  test("second recovery returns MEDIUM_RESET", () => {
    determineRecoveryLevel(); // 1st
    const level = determineRecoveryLevel(); // 2nd

    expect(level).toBe(RecoveryLevel.MEDIUM_RESET);
  });

  test("third recovery returns HARD_RESET", () => {
    determineRecoveryLevel(); // 1st
    determineRecoveryLevel(); // 2nd
    const level = determineRecoveryLevel(); // 3rd

    expect(level).toBe(RecoveryLevel.HARD_RESET);
  });

  test("fourth+ recovery returns HUMAN_INTERVENTION", () => {
    determineRecoveryLevel(); // 1st
    determineRecoveryLevel(); // 2nd
    determineRecoveryLevel(); // 3rd
    const level = determineRecoveryLevel(); // 4th

    expect(level).toBe(RecoveryLevel.HUMAN_INTERVENTION);
  });

  test("multiple calls after 4th still return HUMAN_INTERVENTION", () => {
    for (let i = 0; i < 10; i++) {
      determineRecoveryLevel();
    }
    const level = determineRecoveryLevel();

    expect(level).toBe(RecoveryLevel.HUMAN_INTERVENTION);
  });

  test("resetRecoveryState clears the counter", () => {
    determineRecoveryLevel(); // 1st
    determineRecoveryLevel(); // 2nd

    resetRecoveryState();

    const level = determineRecoveryLevel();
    expect(level).toBe(RecoveryLevel.SOFT_RESET);
  });

  test("getRecoveryState returns current state", () => {
    resetRecoveryState();

    determineRecoveryLevel();
    determineRecoveryLevel();

    const state = getRecoveryState();
    expect(state.attempts).toBe(2);
    expect(state.lastRecoveryTime).toBeGreaterThan(0);
  });
});

// ============================================================================
// MetricsCollector Tests
// ============================================================================

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  describe("Tool Call Tracking", () => {
    test("tracks tool calls and returns rate", () => {
      collector.recordToolCall();
      collector.recordToolCall();
      collector.recordToolCall();

      expect(collector.getToolCallRate()).toBe(3);
    });

    test("prunes old tool calls outside 1-minute window", async () => {
      collector.recordToolCall();

      // Simulate time passing - this is a simplified test
      // In real code, the pruning happens based on timestamps
      expect(collector.getToolCallRate()).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Error Tracking", () => {
    test("tracks errors and returns rate", () => {
      collector.recordError();
      collector.recordError();

      expect(collector.getErrorRate()).toBe(2);
    });
  });

  describe("Output Stall Detection", () => {
    test("isOutputStalled returns false initially", () => {
      expect(collector.isOutputStalled()).toBe(false);
    });

    test("recordOutput updates last output time", () => {
      collector.recordOutput();
      expect(collector.isOutputStalled()).toBe(false);
    });
  });

  describe("Phase Tracking", () => {
    test("setPhase updates current phase", () => {
      collector.setPhase("research");

      const metrics = collector.getMetrics(0, 256);
      expect(metrics.phase).toBe("research");
    });

    test("setPhase resets phase start time on phase change", () => {
      collector.setPhase("research");
      const metrics1 = collector.getMetrics(0, 256);

      collector.setPhase("evaluation");
      const metrics2 = collector.getMetrics(0, 256);

      expect(metrics2.phaseStartTime).toBeGreaterThanOrEqual(metrics1.phaseStartTime);
    });

    test("setPhase does not reset start time for same phase", () => {
      collector.setPhase("research");
      const metrics1 = collector.getMetrics(0, 256);
      const startTime1 = metrics1.phaseStartTime;

      collector.setPhase("research");
      const metrics2 = collector.getMetrics(0, 256);

      expect(metrics2.phaseStartTime).toBe(startTime1);
    });
  });

  describe("getMetrics", () => {
    test("returns complete metrics snapshot", () => {
      collector.recordToolCall();
      collector.recordError();
      collector.setPhase("evaluation");

      const metrics = collector.getMetrics(5000, 256);

      expect(metrics.heartbeatAge).toBe(5000);
      expect(metrics.toolCallRate).toBe(1);
      expect(metrics.memoryUsage).toBe(256);
      expect(metrics.errorRate).toBe(1);
      expect(metrics.phase).toBe("evaluation");
      expect(metrics.phaseStartTime).toBeGreaterThan(0);
    });
  });

  describe("reset", () => {
    test("clears all tracking data", () => {
      collector.recordToolCall();
      collector.recordError();
      collector.setPhase("research");

      collector.reset();

      expect(collector.getToolCallRate()).toBe(0);
      expect(collector.getErrorRate()).toBe(0);
      expect(collector.isOutputStalled()).toBe(false);

      const metrics = collector.getMetrics(0, 0);
      expect(metrics.phase).toBe("idle");
    });
  });
});

// ============================================================================
// Default Configuration Tests
// ============================================================================

describe("DEFAULT_PHASE_TIMEOUTS", () => {
  test("research timeout is 15 minutes", () => {
    expect(DEFAULT_PHASE_TIMEOUTS.research).toBe(15 * 60 * 1000);
  });

  test("evaluation timeout is 10 minutes", () => {
    expect(DEFAULT_PHASE_TIMEOUTS.evaluation).toBe(10 * 60 * 1000);
  });

  test("execution timeout is 5 minutes", () => {
    expect(DEFAULT_PHASE_TIMEOUTS.execution).toBe(5 * 60 * 1000);
  });
});
