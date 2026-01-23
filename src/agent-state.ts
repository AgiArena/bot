import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { AgentState, AgentPhase, MatchedBet } from "./types";

/**
 * Default state for a fresh agent
 */
export function getDefaultAgentState(agentAddress: string, totalCapital: number): AgentState {
  return {
    agentAddress,
    totalCapital,
    currentBalance: totalCapital,
    matchedBets: [],
    lastResearchAt: null,
    researchJobId: null,
    phase: "idle"
  };
}

/**
 * Validate that required fields exist in state
 */
function validateAgentState(state: unknown): state is AgentState {
  if (typeof state !== "object" || state === null) return false;

  const s = state as Record<string, unknown>;
  return (
    typeof s.agentAddress === "string" &&
    typeof s.totalCapital === "number" &&
    typeof s.currentBalance === "number" &&
    Array.isArray(s.matchedBets) &&
    (s.lastResearchAt === null || typeof s.lastResearchAt === "number") &&
    (s.researchJobId === null || typeof s.researchJobId === "string") &&
    ["research", "evaluation", "execution", "idle"].includes(s.phase as string)
  );
}

/**
 * Load agent state from state.json file
 * Returns null if file doesn't exist or is invalid
 */
export function loadAgentState(statePath: string): AgentState | null {
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const content = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(content);

    if (!validateAgentState(parsed)) {
      console.error("[agent-state] Invalid state file, validation failed");
      return null;
    }

    return parsed;
  } catch (error) {
    console.error("[agent-state] Failed to load state file:", error);
    return null;
  }
}

/**
 * Save agent state atomically using write-to-temp-then-rename pattern
 * This ensures state file is never corrupted even if process crashes mid-write
 */
export function saveAgentState(state: AgentState, statePath: string): void {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${statePath}.tmp`;
  const content = JSON.stringify(state, null, 2);

  // Step 1: Write to temp file
  writeFileSync(tempPath, content);

  // Step 2: Atomic rename (POSIX guarantee)
  renameSync(tempPath, statePath);
}

/**
 * Update specific fields in agent state and save atomically
 */
export function updateAgentState(
  statePath: string,
  updates: Partial<AgentState>
): AgentState | null {
  const currentState = loadAgentState(statePath);
  if (!currentState) {
    console.error("[agent-state] Cannot update: no existing state found");
    return null;
  }

  const newState: AgentState = { ...currentState, ...updates };
  saveAgentState(newState, statePath);
  return newState;
}

/**
 * Update phase and save atomically (convenience function for phase transitions)
 */
export function setAgentPhase(statePath: string, phase: AgentPhase): AgentState | null {
  return updateAgentState(statePath, { phase });
}

/**
 * Record a research job start
 */
export function startResearchJob(statePath: string, jobId: string): AgentState | null {
  return updateAgentState(statePath, {
    researchJobId: jobId,
    phase: "research",
    lastResearchAt: Date.now()
  });
}

/**
 * Complete a research job
 */
export function completeResearchJob(statePath: string): AgentState | null {
  return updateAgentState(statePath, {
    researchJobId: null,
    phase: "idle"
  });
}

/**
 * Add a matched bet to the state
 */
export function addMatchedBet(statePath: string, bet: MatchedBet): AgentState | null {
  const currentState = loadAgentState(statePath);
  if (!currentState) {
    console.error("[agent-state] Cannot add bet: no existing state found");
    return null;
  }

  const newState: AgentState = {
    ...currentState,
    matchedBets: [...currentState.matchedBets, bet]
  };
  saveAgentState(newState, statePath);
  return newState;
}

/**
 * Update balance after a transaction
 */
export function updateBalance(statePath: string, newBalance: number): AgentState | null {
  return updateAgentState(statePath, { currentBalance: newBalance });
}
