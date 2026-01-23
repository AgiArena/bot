/**
 * Tests for Extended State Management
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, rmdirSync } from "fs";
import { join } from "path";
import {
  createExtendedState,
  createResilientState,
  loadExtendedState,
  saveExtendedState,
  updateExtendedState,
  updateHeartbeat,
  getHeartbeatAge,
  startPhase,
  getPhaseDuration,
  recordRecoveryAttempt,
  completeRecovery,
  resetRecoveryCounter,
  shouldResetRecoveryCounter,
  setCurrentTask,
  updateCircuitBreakerStates,
  saveCheckpoint,
  getRecoverableState,
  clearRecoverableState,
  addPendingTask,
  removePendingTask,
  DEFAULT_RECOVERY_STATE,
  DEFAULT_CIRCUIT_BREAKER_STATES,
  DEFAULT_RECOVERABLE_STATE
} from "../src/extended-state";
import type { AgentState, RecoveryLevel, ExtendedAgentState } from "../src/types";

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_DIR = "/tmp/test-extended-state";
const TEST_STATE_PATH = join(TEST_DIR, "extended-state.json");

function cleanupTestFiles(): void {
  if (existsSync(TEST_STATE_PATH)) {
    unlinkSync(TEST_STATE_PATH);
  }
  if (existsSync(`${TEST_STATE_PATH}.tmp`)) {
    unlinkSync(`${TEST_STATE_PATH}.tmp`);
  }
  if (existsSync(TEST_DIR)) {
    try {
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

function setupTestDir(): void {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
}

// ============================================================================
// createExtendedState Tests
// ============================================================================

describe("createExtendedState", () => {
  test("creates extended state from base state", () => {
    const baseState = createTestBaseState();
    const extendedState = createExtendedState(baseState);

    expect(extendedState.agentAddress).toBe(baseState.agentAddress);
    expect(extendedState.totalCapital).toBe(baseState.totalCapital);
    expect(extendedState.currentBalance).toBe(baseState.currentBalance);
    expect(extendedState.phase).toBe(baseState.phase);
  });

  test("adds extended fields", () => {
    const baseState = createTestBaseState();
    const extendedState = createExtendedState(baseState);

    expect(typeof extendedState.lastHeartbeat).toBe("number");
    expect(extendedState.currentTaskId).toBeNull();
    expect(typeof extendedState.phaseStartTime).toBe("number");
    expect(extendedState.recoveryState).toBeDefined();
    expect(extendedState.circuitBreakerStates).toBeDefined();
  });

  test("initializes recovery state with defaults", () => {
    const baseState = createTestBaseState();
    const extendedState = createExtendedState(baseState);

    expect(extendedState.recoveryState.attempts).toBe(0);
    expect(extendedState.recoveryState.inProgress).toBe(false);
  });

  test("initializes circuit breakers as CLOSED", () => {
    const baseState = createTestBaseState();
    const extendedState = createExtendedState(baseState);

    expect(extendedState.circuitBreakerStates.polymarketAPI).toBe("CLOSED");
    expect(extendedState.circuitBreakerStates.baseRPC).toBe("CLOSED");
    expect(extendedState.circuitBreakerStates.backend).toBe("CLOSED");
  });
});

// ============================================================================
// createResilientState Tests
// ============================================================================

describe("createResilientState", () => {
  test("creates resilient state with recoverable state", () => {
    const baseState = createTestBaseState();
    const resilientState = createResilientState(baseState);

    expect(resilientState.recoverableState).toBeDefined();
    expect(resilientState.recoverableState.lastCheckpoint).toBeNull();
    expect(resilientState.recoverableState.checkpointData).toEqual({});
    expect(resilientState.recoverableState.pendingTaskIds).toEqual([]);
  });

  test("sets snapshot time", () => {
    const before = Date.now();
    const baseState = createTestBaseState();
    const resilientState = createResilientState(baseState);
    const after = Date.now();

    expect(resilientState.recoverableState.snapshotTime).toBeGreaterThanOrEqual(before);
    expect(resilientState.recoverableState.snapshotTime).toBeLessThanOrEqual(after);
  });
});

// ============================================================================
// State Persistence Tests
// ============================================================================

describe("State Persistence", () => {
  beforeEach(() => {
    cleanupTestFiles();
    setupTestDir();
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  test("saveExtendedState creates file", () => {
    const state = createExtendedState(createTestBaseState());
    saveExtendedState(state, TEST_STATE_PATH);

    expect(existsSync(TEST_STATE_PATH)).toBe(true);
  });

  test("loadExtendedState reads saved state", () => {
    const state = createExtendedState(createTestBaseState());
    state.currentTaskId = "task_123";
    saveExtendedState(state, TEST_STATE_PATH);

    const loaded = loadExtendedState(TEST_STATE_PATH);

    expect(loaded).not.toBeNull();
    expect(loaded!.currentTaskId).toBe("task_123");
    expect(loaded!.agentAddress).toBe("0x123");
  });

  test("loadExtendedState returns null for missing file", () => {
    const loaded = loadExtendedState("/nonexistent/path.json");
    expect(loaded).toBeNull();
  });

  test("updateExtendedState modifies and saves", () => {
    const state = createExtendedState(createTestBaseState());
    saveExtendedState(state, TEST_STATE_PATH);

    const updated = updateExtendedState(TEST_STATE_PATH, { currentTaskId: "task_456" });

    expect(updated).not.toBeNull();
    expect(updated!.currentTaskId).toBe("task_456");

    const reloaded = loadExtendedState(TEST_STATE_PATH);
    expect(reloaded!.currentTaskId).toBe("task_456");
  });

  test("updateExtendedState returns null if no existing state", () => {
    const result = updateExtendedState(TEST_STATE_PATH, { currentTaskId: "task_123" });
    expect(result).toBeNull();
  });
});

// ============================================================================
// Heartbeat Management Tests
// ============================================================================

describe("Heartbeat Management", () => {
  beforeEach(() => {
    cleanupTestFiles();
    setupTestDir();
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  test("updateHeartbeat updates timestamp", async () => {
    const state = createExtendedState(createTestBaseState());
    state.lastHeartbeat = Date.now() - 10000; // 10 seconds ago
    saveExtendedState(state, TEST_STATE_PATH);

    await new Promise(resolve => setTimeout(resolve, 10));

    const updated = updateHeartbeat(TEST_STATE_PATH);

    expect(updated).not.toBeNull();
    expect(updated!.lastHeartbeat).toBeGreaterThan(state.lastHeartbeat);
  });

  test("getHeartbeatAge returns elapsed time", async () => {
    const state = createExtendedState(createTestBaseState());
    state.lastHeartbeat = Date.now() - 5000; // 5 seconds ago

    const age = getHeartbeatAge(state);

    expect(age).toBeGreaterThanOrEqual(5000);
    expect(age).toBeLessThan(6000);
  });
});

// ============================================================================
// Phase Management Tests
// ============================================================================

describe("Phase Management", () => {
  beforeEach(() => {
    cleanupTestFiles();
    setupTestDir();
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  test("startPhase updates phase and timestamp", () => {
    const state = createExtendedState(createTestBaseState());
    saveExtendedState(state, TEST_STATE_PATH);

    const before = Date.now();
    const updated = startPhase(TEST_STATE_PATH, "research");
    const after = Date.now();

    expect(updated).not.toBeNull();
    expect(updated!.phase).toBe("research");
    expect(updated!.phaseStartTime).toBeGreaterThanOrEqual(before);
    expect(updated!.phaseStartTime).toBeLessThanOrEqual(after);
  });

  test("getPhaseDuration returns elapsed time", () => {
    const state = createExtendedState(createTestBaseState());
    state.phaseStartTime = Date.now() - 3000; // 3 seconds ago

    const duration = getPhaseDuration(state);

    expect(duration).toBeGreaterThanOrEqual(3000);
    expect(duration).toBeLessThan(4000);
  });
});

// ============================================================================
// Recovery State Tests
// ============================================================================

describe("Recovery State Management", () => {
  beforeEach(() => {
    cleanupTestFiles();
    setupTestDir();
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  test("recordRecoveryAttempt increments attempts", () => {
    const state = createExtendedState(createTestBaseState());
    saveExtendedState(state, TEST_STATE_PATH);

    const updated = recordRecoveryAttempt(TEST_STATE_PATH, "context_clear" as RecoveryLevel);

    expect(updated).not.toBeNull();
    expect(updated!.recoveryState.attempts).toBe(1);
    expect(updated!.recoveryState.inProgress).toBe(true);
    expect(updated!.recoveryState.currentLevel).toBe("context_clear");
  });

  test("recordRecoveryAttempt updates timestamp", () => {
    const state = createExtendedState(createTestBaseState());
    state.recoveryState.lastRecoveryTime = Date.now() - 10000;
    saveExtendedState(state, TEST_STATE_PATH);

    const before = Date.now();
    const updated = recordRecoveryAttempt(TEST_STATE_PATH, "process_restart" as RecoveryLevel);

    expect(updated!.recoveryState.lastRecoveryTime).toBeGreaterThanOrEqual(before);
  });

  test("completeRecovery sets inProgress to false", () => {
    const state = createExtendedState(createTestBaseState());
    state.recoveryState.inProgress = true;
    saveExtendedState(state, TEST_STATE_PATH);

    const updated = completeRecovery(TEST_STATE_PATH);

    expect(updated).not.toBeNull();
    expect(updated!.recoveryState.inProgress).toBe(false);
  });

  test("resetRecoveryCounter clears attempts", () => {
    const state = createExtendedState(createTestBaseState());
    state.recoveryState.attempts = 3;
    state.recoveryState.lastRecoveryTime = Date.now() - 7200000; // 2 hours ago
    saveExtendedState(state, TEST_STATE_PATH);

    const updated = resetRecoveryCounter(TEST_STATE_PATH);

    expect(updated).not.toBeNull();
    expect(updated!.recoveryState.attempts).toBe(0);
  });

  test("shouldResetRecoveryCounter returns true after 1 hour", () => {
    const state = createExtendedState(createTestBaseState());
    state.recoveryState.lastRecoveryTime = Date.now() - (61 * 60 * 1000); // 61 minutes ago

    expect(shouldResetRecoveryCounter(state)).toBe(true);
  });

  test("shouldResetRecoveryCounter returns false within 1 hour", () => {
    const state = createExtendedState(createTestBaseState());
    state.recoveryState.lastRecoveryTime = Date.now() - (30 * 60 * 1000); // 30 minutes ago

    expect(shouldResetRecoveryCounter(state)).toBe(false);
  });
});

// ============================================================================
// Task Management Tests
// ============================================================================

describe("Task Management", () => {
  beforeEach(() => {
    cleanupTestFiles();
    setupTestDir();
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  test("setCurrentTask updates task ID", () => {
    const state = createExtendedState(createTestBaseState());
    saveExtendedState(state, TEST_STATE_PATH);

    const updated = setCurrentTask(TEST_STATE_PATH, "task_789");

    expect(updated).not.toBeNull();
    expect(updated!.currentTaskId).toBe("task_789");
  });

  test("setCurrentTask can clear task ID", () => {
    const state = createExtendedState(createTestBaseState());
    state.currentTaskId = "task_123";
    saveExtendedState(state, TEST_STATE_PATH);

    const updated = setCurrentTask(TEST_STATE_PATH, null);

    expect(updated).not.toBeNull();
    expect(updated!.currentTaskId).toBeNull();
  });
});

// ============================================================================
// Circuit Breaker State Tests
// ============================================================================

describe("Circuit Breaker State Sync", () => {
  beforeEach(() => {
    cleanupTestFiles();
    setupTestDir();
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  test("updateCircuitBreakerStates updates all states", () => {
    const state = createExtendedState(createTestBaseState());
    saveExtendedState(state, TEST_STATE_PATH);

    const updated = updateCircuitBreakerStates(TEST_STATE_PATH, {
      polymarketAPI: "OPEN",
      baseRPC: "HALF_OPEN",
      backend: "CLOSED"
    });

    expect(updated).not.toBeNull();
    expect(updated!.circuitBreakerStates.polymarketAPI).toBe("OPEN");
    expect(updated!.circuitBreakerStates.baseRPC).toBe("HALF_OPEN");
    expect(updated!.circuitBreakerStates.backend).toBe("CLOSED");
  });
});

// ============================================================================
// Recoverable State Tests
// ============================================================================

describe("Recoverable State Management", () => {
  beforeEach(() => {
    cleanupTestFiles();
    setupTestDir();
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  test("saveCheckpoint stores checkpoint data", () => {
    const state = createResilientState(createTestBaseState());
    saveExtendedState(state, TEST_STATE_PATH);

    const updated = saveCheckpoint(TEST_STATE_PATH, "MARKETS_FETCHED", {
      marketCount: 10,
      fetchedAt: Date.now()
    });

    expect(updated).not.toBeNull();
    expect(updated!.recoverableState.lastCheckpoint).toBe("MARKETS_FETCHED");
    expect(updated!.recoverableState.checkpointData.marketCount).toBe(10);
  });

  test("getRecoverableState returns saved state", () => {
    const state = createResilientState(createTestBaseState());
    state.recoverableState.lastCheckpoint = "SEGMENTS_CREATED";
    state.recoverableState.checkpointData = { segmentCount: 5 };
    saveExtendedState(state, TEST_STATE_PATH);

    const recoverable = getRecoverableState(TEST_STATE_PATH);

    expect(recoverable).not.toBeNull();
    expect(recoverable!.lastCheckpoint).toBe("SEGMENTS_CREATED");
    expect(recoverable!.checkpointData.segmentCount).toBe(5);
  });

  test("clearRecoverableState resets to defaults", () => {
    const state = createResilientState(createTestBaseState());
    state.recoverableState.lastCheckpoint = "RESEARCH_COMPLETE";
    state.recoverableState.pendingTaskIds = ["task_1", "task_2"];
    saveExtendedState(state, TEST_STATE_PATH);

    const updated = clearRecoverableState(TEST_STATE_PATH);

    expect(updated).not.toBeNull();
    expect(updated!.recoverableState.lastCheckpoint).toBeNull();
    expect(updated!.recoverableState.pendingTaskIds).toEqual([]);
    expect(updated!.recoverableState.checkpointData).toEqual({});
  });

  test("addPendingTask adds task ID", () => {
    const state = createResilientState(createTestBaseState());
    saveExtendedState(state, TEST_STATE_PATH);

    const updated = addPendingTask(TEST_STATE_PATH, "task_abc");

    expect(updated).not.toBeNull();
    expect(updated!.recoverableState.pendingTaskIds).toContain("task_abc");
  });

  test("addPendingTask does not duplicate", () => {
    const state = createResilientState(createTestBaseState());
    state.recoverableState.pendingTaskIds = ["task_abc"];
    saveExtendedState(state, TEST_STATE_PATH);

    const updated = addPendingTask(TEST_STATE_PATH, "task_abc");

    expect(updated).not.toBeNull();
    expect(updated!.recoverableState.pendingTaskIds).toEqual(["task_abc"]);
  });

  test("removePendingTask removes task ID", () => {
    const state = createResilientState(createTestBaseState());
    state.recoverableState.pendingTaskIds = ["task_1", "task_2", "task_3"];
    saveExtendedState(state, TEST_STATE_PATH);

    const updated = removePendingTask(TEST_STATE_PATH, "task_2");

    expect(updated).not.toBeNull();
    expect(updated!.recoverableState.pendingTaskIds).toEqual(["task_1", "task_3"]);
  });
});

// ============================================================================
// Default Values Tests
// ============================================================================

describe("Default Values", () => {
  test("DEFAULT_RECOVERY_STATE has correct values", () => {
    expect(DEFAULT_RECOVERY_STATE.attempts).toBe(0);
    expect(DEFAULT_RECOVERY_STATE.lastRecoveryTime).toBe(0);
    expect(DEFAULT_RECOVERY_STATE.inProgress).toBe(false);
  });

  test("DEFAULT_CIRCUIT_BREAKER_STATES are all CLOSED", () => {
    expect(DEFAULT_CIRCUIT_BREAKER_STATES.polymarketAPI).toBe("CLOSED");
    expect(DEFAULT_CIRCUIT_BREAKER_STATES.baseRPC).toBe("CLOSED");
    expect(DEFAULT_CIRCUIT_BREAKER_STATES.backend).toBe("CLOSED");
  });

  test("DEFAULT_RECOVERABLE_STATE has correct values", () => {
    expect(DEFAULT_RECOVERABLE_STATE.lastCheckpoint).toBeNull();
    expect(DEFAULT_RECOVERABLE_STATE.checkpointData).toEqual({});
    expect(DEFAULT_RECOVERABLE_STATE.pendingTaskIds).toEqual([]);
    expect(DEFAULT_RECOVERABLE_STATE.snapshotTime).toBe(0);
  });
});
