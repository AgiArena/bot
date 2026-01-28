/**
 * Unified State Management
 *
 * Single state system replacing:
 * - HandlerState (state.ts) - handler-level concerns
 * - AgentState (agent-state.ts) - trading state
 * - ExtendedAgentState (extended-state.ts) - resilience tracking
 *
 * Simplifies to essential fields needed for trading operations.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type { FillRecord } from "./rate-limiter";
import type { CircuitState } from "./circuit-breaker";

/**
 * Active bet record
 */
export interface ActiveBet {
  /** Bet ID */
  betId: string;
  /** Amount placed in USDC */
  amount: number;
  /** When bet was placed */
  placedAt: string;
  /** Current status */
  status: "pending" | "partially_matched";
  /** Odds in basis points (if applicable) */
  oddsBps?: number;
}

/**
 * Matched bet record
 */
export interface MatchedBet {
  /** Bet ID */
  betId: string;
  /** Amount matched in USDC */
  amount: number;
  /** When bet was matched */
  matchedAt: string;
  /** Transaction hash */
  txHash: string;
  /** EV score at time of match */
  evScore?: number;
  /** Outcome (if resolved) */
  outcome?: "won" | "lost" | "pending";
}

/**
 * Unified bot state
 */
export interface BotState {
  // Identity
  /** Wallet address */
  walletAddress: string;
  /** Bot name/identifier */
  botName: string;

  // Capital management
  /** Total capital in USDC */
  totalCapital: number;
  /** Currently allocated capital in USDC */
  allocatedCapital: number;

  // Bets
  /** Active bets (placed, pending fill) */
  activeBets: ActiveBet[];
  /** Filled/matched bets */
  matchedBets: MatchedBet[];

  // Rate limiting
  /** History of filled bets for rate limiting */
  fillHistory: FillRecord[];

  // Session tracking
  /** Session start timestamp */
  sessionStart: string;
  /** Last activity timestamp */
  lastActivity: string;

  // Circuit breakers (simple status tracking)
  circuitBreakers: Record<string, CircuitState>;

  // Version for migrations
  version: number;
}

/** Current state version */
const STATE_VERSION = 1;

/** Default state file path */
export const DEFAULT_STATE_PATH = "bot/agent/state.json";

/**
 * Create initial bot state
 */
export function createInitialState(
  walletAddress: string,
  botName: string,
  totalCapital: number
): BotState {
  const now = new Date().toISOString();
  return {
    walletAddress,
    botName,
    totalCapital,
    allocatedCapital: 0,
    activeBets: [],
    matchedBets: [],
    fillHistory: [],
    sessionStart: now,
    lastActivity: now,
    circuitBreakers: {
      polymarketAPI: "CLOSED",
      baseRPC: "CLOSED",
      backend: "CLOSED",
    },
    version: STATE_VERSION,
  };
}

/**
 * Validate state structure
 */
function validateState(state: unknown): state is BotState {
  if (typeof state !== "object" || state === null) return false;

  const s = state as Record<string, unknown>;
  return (
    typeof s.walletAddress === "string" &&
    typeof s.botName === "string" &&
    typeof s.totalCapital === "number" &&
    typeof s.allocatedCapital === "number" &&
    Array.isArray(s.activeBets) &&
    Array.isArray(s.matchedBets) &&
    Array.isArray(s.fillHistory) &&
    typeof s.sessionStart === "string" &&
    typeof s.lastActivity === "string" &&
    typeof s.circuitBreakers === "object" &&
    typeof s.version === "number"
  );
}

/**
 * Load state from file
 *
 * @param statePath - Path to state file
 * @returns State or null if not found/invalid
 */
export function loadState(statePath: string = DEFAULT_STATE_PATH): BotState | null {
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const content = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(content);

    if (!validateState(parsed)) {
      console.error("[state] Invalid state file, validation failed");
      return null;
    }

    return parsed;
  } catch (error) {
    console.error("[state] Failed to load state file:", error);
    return null;
  }
}

/**
 * Save state atomically using write-to-temp-then-rename pattern
 *
 * @param state - State to save
 * @param statePath - Path to state file
 */
export function saveState(state: BotState, statePath: string = DEFAULT_STATE_PATH): void {
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
 * Load or create state
 *
 * @param walletAddress - Wallet address
 * @param botName - Bot name
 * @param totalCapital - Initial capital
 * @param statePath - State file path
 * @returns Loaded or new state
 */
export function loadOrCreateState(
  walletAddress: string,
  botName: string,
  totalCapital: number,
  statePath: string = DEFAULT_STATE_PATH
): BotState {
  const existing = loadState(statePath);
  if (existing) {
    // Update session start and last activity for new session
    return {
      ...existing,
      sessionStart: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    };
  }

  const newState = createInitialState(walletAddress, botName, totalCapital);
  saveState(newState, statePath);
  return newState;
}

/**
 * Update state and save
 */
export function updateState(
  statePath: string,
  updates: Partial<BotState>
): BotState | null {
  const current = loadState(statePath);
  if (!current) {
    console.error("[state] Cannot update: no existing state found");
    return null;
  }

  const newState: BotState = {
    ...current,
    ...updates,
    lastActivity: new Date().toISOString(),
  };

  saveState(newState, statePath);
  return newState;
}

// ============================================================================
// Capital Management
// ============================================================================

/**
 * Get available capital (total - allocated)
 */
export function getAvailableCapital(state: BotState): number {
  return state.totalCapital - state.allocatedCapital;
}

/**
 * Allocate capital for a new bet
 */
export function allocateCapital(
  state: BotState,
  amount: number
): BotState {
  return {
    ...state,
    allocatedCapital: state.allocatedCapital + amount,
    lastActivity: new Date().toISOString(),
  };
}

/**
 * Release allocated capital (bet cancelled or settled)
 */
export function releaseCapital(
  state: BotState,
  amount: number
): BotState {
  return {
    ...state,
    allocatedCapital: Math.max(0, state.allocatedCapital - amount),
    lastActivity: new Date().toISOString(),
  };
}

// ============================================================================
// Bet Management
// ============================================================================

/**
 * Add an active bet
 */
export function addActiveBet(
  state: BotState,
  betId: string,
  amount: number,
  oddsBps?: number
): BotState {
  const newBet: ActiveBet = {
    betId,
    amount,
    placedAt: new Date().toISOString(),
    status: "pending",
    oddsBps,
  };

  return {
    ...state,
    activeBets: [...state.activeBets, newBet],
    allocatedCapital: state.allocatedCapital + amount,
    lastActivity: new Date().toISOString(),
  };
}

/**
 * Remove an active bet (matched, cancelled, or expired)
 */
export function removeActiveBet(
  state: BotState,
  betId: string
): BotState {
  const bet = state.activeBets.find(b => b.betId === betId);
  if (!bet) return state;

  return {
    ...state,
    activeBets: state.activeBets.filter(b => b.betId !== betId),
    lastActivity: new Date().toISOString(),
  };
}

/**
 * Update active bet status
 */
export function updateActiveBetStatus(
  state: BotState,
  betId: string,
  status: ActiveBet["status"]
): BotState {
  return {
    ...state,
    activeBets: state.activeBets.map(b =>
      b.betId === betId ? { ...b, status } : b
    ),
    lastActivity: new Date().toISOString(),
  };
}

/**
 * Add a matched bet
 */
export function addMatchedBet(
  state: BotState,
  betId: string,
  amount: number,
  txHash: string,
  evScore?: number
): BotState {
  const newMatch: MatchedBet = {
    betId,
    amount,
    matchedAt: new Date().toISOString(),
    txHash,
    evScore,
    outcome: "pending",
  };

  return {
    ...state,
    matchedBets: [...state.matchedBets, newMatch],
    allocatedCapital: state.allocatedCapital + amount,
    lastActivity: new Date().toISOString(),
  };
}

/**
 * Update matched bet outcome
 */
export function updateMatchedBetOutcome(
  state: BotState,
  betId: string,
  outcome: MatchedBet["outcome"]
): BotState {
  return {
    ...state,
    matchedBets: state.matchedBets.map(b =>
      b.betId === betId ? { ...b, outcome } : b
    ),
    lastActivity: new Date().toISOString(),
  };
}

// ============================================================================
// Fill History (for rate limiting)
// ============================================================================

/**
 * Record a fill in history
 */
export function recordFill(
  state: BotState,
  betId: string,
  amount: number
): BotState {
  const fill: FillRecord = {
    timestamp: Date.now(),
    amount,
    betId,
  };

  return {
    ...state,
    fillHistory: [...state.fillHistory, fill],
    lastActivity: new Date().toISOString(),
  };
}

/**
 * Prune old fill history (keep last 31 days)
 */
export function pruneFillHistory(
  state: BotState,
  maxAgeDays: number = 31
): BotState {
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);

  return {
    ...state,
    fillHistory: state.fillHistory.filter(f => f.timestamp >= cutoff),
  };
}

// ============================================================================
// Circuit Breaker State
// ============================================================================

/**
 * Update circuit breaker state
 */
export function updateCircuitBreakerState(
  state: BotState,
  name: string,
  circuitState: CircuitState
): BotState {
  return {
    ...state,
    circuitBreakers: {
      ...state.circuitBreakers,
      [name]: circuitState,
    },
    lastActivity: new Date().toISOString(),
  };
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Get state statistics
 */
export function getStateStats(state: BotState): {
  totalCapital: number;
  available: number;
  allocated: number;
  activeBetCount: number;
  matchedBetCount: number;
  totalVolume: number;
  winRate: number;
} {
  const available = getAvailableCapital(state);

  // Calculate total volume from matched bets
  const totalVolume = state.matchedBets.reduce((sum, b) => sum + b.amount, 0);

  // Calculate win rate
  const resolved = state.matchedBets.filter(b => b.outcome !== "pending");
  const wins = resolved.filter(b => b.outcome === "won").length;
  const winRate = resolved.length > 0 ? wins / resolved.length : 0;

  return {
    totalCapital: state.totalCapital,
    available,
    allocated: state.allocatedCapital,
    activeBetCount: state.activeBets.length,
    matchedBetCount: state.matchedBets.length,
    totalVolume,
    winRate,
  };
}

/**
 * Format state for logging
 */
export function formatStateForLog(state: BotState): string {
  const stats = getStateStats(state);
  return [
    `Bot: ${state.botName}`,
    `Wallet: ${state.walletAddress.slice(0, 6)}...${state.walletAddress.slice(-4)}`,
    `Capital: $${stats.totalCapital} (avail: $${stats.available.toFixed(2)})`,
    `Bets: ${stats.activeBetCount} active, ${stats.matchedBetCount} matched`,
    `Volume: $${stats.totalVolume.toFixed(2)}`,
    `Win rate: ${(stats.winRate * 100).toFixed(1)}%`,
  ].join(" | ");
}
