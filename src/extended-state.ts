/**
 * Extended State Management for Resilience
 *
 * Provides functions for managing ExtendedAgentState and RecoverableState
 * for crash recovery and resilience tracking.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import type {
  AgentState,
  ExtendedAgentState,
  RecoverableState,
  ResilientAgentState,
  RecoveryState,
  RecoveryLevel
} from "./types";

// ============================================================================
// Default Configuration
// ============================================================================

/** Default path for extended state */
export const DEFAULT_EXTENDED_STATE_PATH = "bot/agent/extended-state.json";

/** Default recovery state */
export const DEFAULT_RECOVERY_STATE: RecoveryState = {
  attempts: 0,
  lastRecoveryTime: 0,
  currentLevel: "context_clear" as RecoveryLevel,
  inProgress: false
};

/** Default circuit breaker states */
export const DEFAULT_CIRCUIT_BREAKER_STATES = {
  polymarketAPI: "CLOSED" as const,
  baseRPC: "CLOSED" as const,
  backend: "CLOSED" as const
};

/** Default recoverable state */
export const DEFAULT_RECOVERABLE_STATE: RecoverableState = {
  lastCheckpoint: null,
  checkpointData: {},
  pendingTaskIds: [],
  snapshotTime: 0
};

// ============================================================================
// Extended State Functions
// ============================================================================

/**
 * Create extended agent state from basic agent state
 */
export function createExtendedState(baseState: AgentState): ExtendedAgentState {
  return {
    ...baseState,
    lastHeartbeat: Date.now(),
    currentTaskId: null,
    phaseStartTime: Date.now(),
    recoveryState: { ...DEFAULT_RECOVERY_STATE },
    circuitBreakerStates: { ...DEFAULT_CIRCUIT_BREAKER_STATES }
  };
}

/**
 * Create full resilient agent state
 */
export function createResilientState(baseState: AgentState): ResilientAgentState {
  return {
    ...createExtendedState(baseState),
    recoverableState: { ...DEFAULT_RECOVERABLE_STATE, snapshotTime: Date.now() }
  };
}

/**
 * Validate extended agent state
 */
function validateExtendedState(state: unknown): state is ExtendedAgentState {
  if (typeof state !== "object" || state === null) return false;

  const s = state as Record<string, unknown>;
  return (
    typeof s.agentAddress === "string" &&
    typeof s.totalCapital === "number" &&
    typeof s.currentBalance === "number" &&
    Array.isArray(s.matchedBets) &&
    typeof s.lastHeartbeat === "number" &&
    (s.currentTaskId === null || typeof s.currentTaskId === "string") &&
    typeof s.phaseStartTime === "number" &&
    typeof s.recoveryState === "object" &&
    typeof s.circuitBreakerStates === "object"
  );
}

/**
 * Load extended state from file
 */
export function loadExtendedState(statePath: string = DEFAULT_EXTENDED_STATE_PATH): ExtendedAgentState | null {
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const content = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(content);

    if (!validateExtendedState(parsed)) {
      console.error("[extended-state] Invalid state file, validation failed");
      return null;
    }

    return parsed;
  } catch (error) {
    console.error("[extended-state] Failed to load state file:", error);
    return null;
  }
}

/**
 * Save extended state atomically
 */
export function saveExtendedState(
  state: ExtendedAgentState,
  statePath: string = DEFAULT_EXTENDED_STATE_PATH
): void {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${statePath}.tmp`;
  const content = JSON.stringify(state, null, 2);

  writeFileSync(tempPath, content);
  renameSync(tempPath, statePath);
}

/**
 * Update extended state fields and save atomically
 */
export function updateExtendedState(
  statePath: string,
  updates: Partial<ExtendedAgentState>
): ExtendedAgentState | null {
  const currentState = loadExtendedState(statePath);
  if (!currentState) {
    console.error("[extended-state] Cannot update: no existing state found");
    return null;
  }

  const newState: ExtendedAgentState = { ...currentState, ...updates };
  saveExtendedState(newState, statePath);
  return newState;
}

// ============================================================================
// Heartbeat Management
// ============================================================================

/**
 * Update heartbeat timestamp
 */
export function updateHeartbeat(statePath: string = DEFAULT_EXTENDED_STATE_PATH): ExtendedAgentState | null {
  return updateExtendedState(statePath, { lastHeartbeat: Date.now() });
}

/**
 * Get heartbeat age in milliseconds
 */
export function getHeartbeatAge(state: ExtendedAgentState): number {
  return Date.now() - state.lastHeartbeat;
}

// ============================================================================
// Phase Management
// ============================================================================

/**
 * Start a new phase with timestamp
 */
export function startPhase(
  statePath: string,
  phase: ExtendedAgentState["phase"]
): ExtendedAgentState | null {
  return updateExtendedState(statePath, {
    phase,
    phaseStartTime: Date.now()
  });
}

/**
 * Get phase duration in milliseconds
 */
export function getPhaseDuration(state: ExtendedAgentState): number {
  return Date.now() - state.phaseStartTime;
}

// ============================================================================
// Recovery State Management
// ============================================================================

/**
 * Record a recovery attempt
 */
export function recordRecoveryAttempt(
  statePath: string,
  level: RecoveryLevel
): ExtendedAgentState | null {
  const currentState = loadExtendedState(statePath);
  if (!currentState) return null;

  const newRecoveryState: RecoveryState = {
    ...currentState.recoveryState,
    attempts: currentState.recoveryState.attempts + 1,
    lastRecoveryTime: Date.now(),
    currentLevel: level,
    inProgress: true
  };

  return updateExtendedState(statePath, { recoveryState: newRecoveryState });
}

/**
 * Complete a recovery attempt
 */
export function completeRecovery(statePath: string): ExtendedAgentState | null {
  const currentState = loadExtendedState(statePath);
  if (!currentState) return null;

  const newRecoveryState: RecoveryState = {
    ...currentState.recoveryState,
    inProgress: false
  };

  return updateExtendedState(statePath, { recoveryState: newRecoveryState });
}

/**
 * Reset recovery counter (after 1 hour of stability)
 */
export function resetRecoveryCounter(statePath: string): ExtendedAgentState | null {
  return updateExtendedState(statePath, {
    recoveryState: { ...DEFAULT_RECOVERY_STATE }
  });
}

/**
 * Check if recovery counter should be reset
 * Returns true if >1 hour since last recovery
 */
export function shouldResetRecoveryCounter(state: ExtendedAgentState): boolean {
  const RECOVERY_RESET_WINDOW = 60 * 60 * 1000; // 1 hour
  return Date.now() - state.recoveryState.lastRecoveryTime > RECOVERY_RESET_WINDOW;
}

// ============================================================================
// Task Management
// ============================================================================

/**
 * Set current task
 */
export function setCurrentTask(
  statePath: string,
  taskId: string | null
): ExtendedAgentState | null {
  return updateExtendedState(statePath, { currentTaskId: taskId });
}

// ============================================================================
// Circuit Breaker State Sync
// ============================================================================

/**
 * Update circuit breaker states snapshot
 */
export function updateCircuitBreakerStates(
  statePath: string,
  states: ExtendedAgentState["circuitBreakerStates"]
): ExtendedAgentState | null {
  return updateExtendedState(statePath, { circuitBreakerStates: states });
}

// ============================================================================
// Recoverable State Management
// ============================================================================

/**
 * Save checkpoint for crash recovery
 */
export function saveCheckpoint(
  statePath: string,
  checkpointName: string,
  data: Record<string, unknown>
): ResilientAgentState | null {
  const currentState = loadExtendedState(statePath) as ResilientAgentState | null;
  if (!currentState) return null;

  const recoverableState: RecoverableState = {
    ...currentState.recoverableState,
    lastCheckpoint: checkpointName,
    checkpointData: data,
    snapshotTime: Date.now()
  };

  const newState: ResilientAgentState = {
    ...currentState,
    recoverableState
  };

  saveExtendedState(newState, statePath);
  return newState;
}

/**
 * Get recoverable state for crash recovery
 */
export function getRecoverableState(statePath: string): RecoverableState | null {
  const state = loadExtendedState(statePath) as ResilientAgentState | null;
  if (!state || !state.recoverableState) return null;
  return state.recoverableState;
}

/**
 * Clear recoverable state after successful recovery
 */
export function clearRecoverableState(statePath: string): ResilientAgentState | null {
  const currentState = loadExtendedState(statePath) as ResilientAgentState | null;
  if (!currentState) return null;

  const newState: ResilientAgentState = {
    ...currentState,
    recoverableState: { ...DEFAULT_RECOVERABLE_STATE, snapshotTime: Date.now() }
  };

  saveExtendedState(newState, statePath);
  return newState;
}

/**
 * Add pending task ID for recovery tracking
 */
export function addPendingTask(statePath: string, taskId: string): ResilientAgentState | null {
  const currentState = loadExtendedState(statePath) as ResilientAgentState | null;
  if (!currentState) return null;

  const pendingTaskIds = currentState.recoverableState?.pendingTaskIds || [];
  if (!pendingTaskIds.includes(taskId)) {
    pendingTaskIds.push(taskId);
  }

  const recoverableState: RecoverableState = {
    ...currentState.recoverableState,
    pendingTaskIds,
    snapshotTime: Date.now()
  };

  const newState: ResilientAgentState = {
    ...currentState,
    recoverableState
  };

  saveExtendedState(newState, statePath);
  return newState;
}

/**
 * Remove pending task ID after completion
 */
export function removePendingTask(statePath: string, taskId: string): ResilientAgentState | null {
  const currentState = loadExtendedState(statePath) as ResilientAgentState | null;
  if (!currentState) return null;

  const pendingTaskIds = (currentState.recoverableState?.pendingTaskIds || [])
    .filter(id => id !== taskId);

  const recoverableState: RecoverableState = {
    ...currentState.recoverableState,
    pendingTaskIds,
    snapshotTime: Date.now()
  };

  const newState: ResilientAgentState = {
    ...currentState,
    recoverableState
  };

  saveExtendedState(newState, statePath);
  return newState;
}
