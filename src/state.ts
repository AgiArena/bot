import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { HandlerState } from "./types";

/**
 * Default state when no state file exists
 */
function getDefaultState(): HandlerState {
  return {
    agentPid: null,
    startTime: null,
    restartCount: 0,
    lastRestartAt: null
  };
}

/**
 * Load state from state.json file
 * Returns default state if file doesn't exist
 */
export function loadState(statePath: string): HandlerState {
  if (!existsSync(statePath)) {
    return getDefaultState();
  }

  try {
    const content = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(content) as HandlerState;

    // Validate and apply defaults for any missing fields
    return {
      agentPid: parsed.agentPid ?? null,
      startTime: parsed.startTime ?? null,
      restartCount: parsed.restartCount ?? 0,
      lastRestartAt: parsed.lastRestartAt ?? null
    };
  } catch {
    // If state file is corrupted, return default state
    return getDefaultState();
  }
}

/**
 * Save state atomically using write-to-temp-then-rename pattern
 * This ensures state file is never corrupted even if process crashes mid-write
 */
export function saveState(state: HandlerState, statePath: string): void {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${statePath}.tmp`;
  const content = JSON.stringify(state, null, 2);

  // Write to temp file first
  writeFileSync(tempPath, content);

  // Atomic rename
  renameSync(tempPath, statePath);
}

/**
 * Update specific fields in state
 */
export function updateState(
  statePath: string,
  updates: Partial<HandlerState>
): HandlerState {
  const currentState = loadState(statePath);
  const newState = { ...currentState, ...updates };
  saveState(newState, statePath);
  return newState;
}
