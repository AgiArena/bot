import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";

/**
 * Record of a matched bet for state tracking
 */
export interface MatchedBet {
  betId: string;
  fillAmount: string;         // USDC amount with 6 decimals
  txHash: string;
  blockNumber: number;
  timestamp: string;          // ISO timestamp
  gasUsed: string;
  gasCostUSD: string;
  evScore: number;            // EV at time of match
  ourPortfolioRef: string;    // Path to portfolio-scores.json at match time
}

/**
 * Agent trading state for bet matching
 */
export interface AgentTradeState {
  matchedBets: MatchedBet[];
  totalMatchedAmount: string;
  lastMatchedAt: string | null;
}

/**
 * Result of a bet match execution
 */
export interface MatchResult {
  success: boolean;
  betId: string;
  fillAmount?: string;
  txHash?: string;
  gasUsed?: string;
  gasCostUSD?: string;
  message: string;
  error?: string;
  details?: Record<string, string>;
}

/**
 * Bet details from backend API
 */
export interface BetDetails {
  betId: string;
  creatorAddress: string;
  portfolioSize: number;
  amount: string;
  matchedAmount: string;
  status: "pending" | "partially_matched" | "fully_matched" | "resolved" | "cancelled";
  createdAt: string;
}

/**
 * Counter-scores payload for backend API
 */
export interface CounterScoresPayload {
  betId: string;
  counterParty: string;
  counterScores: Record<string, { score: number; position: number }>;
  evScore: number;
  matchedAt: string;
}

/**
 * Risk profile bet sizing configuration
 * Values represent percentage of capital (min-max)
 */
export const RISK_PROFILE_SIZING = {
  conservative: { min: 0.01, max: 0.03 },  // 1-3%
  balanced: { min: 0.03, max: 0.05 },      // 3-5%
  aggressive: { min: 0.05, max: 0.10 },    // 5-10%
} as const;

export type RiskProfile = keyof typeof RISK_PROFILE_SIZING;

/**
 * Error codes for bet matching
 */
export const ERROR_CODES = {
  BET_NOT_FOUND: "BET_NOT_FOUND",
  BET_ALREADY_MATCHED: "BET_ALREADY_MATCHED",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  APPROVAL_FAILED: "APPROVAL_FAILED",
  MATCH_REVERTED: "MATCH_REVERTED",
  TIMEOUT: "TIMEOUT",
  CAPITAL_LIMIT: "CAPITAL_LIMIT",
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

/**
 * Get default agent trade state
 */
function getDefaultTradeState(): AgentTradeState {
  return {
    matchedBets: [],
    totalMatchedAmount: "0",
    lastMatchedAt: null
  };
}

/**
 * Load agent trade state from file
 */
export function loadTradeState(statePath: string): AgentTradeState {
  if (!existsSync(statePath)) {
    return getDefaultTradeState();
  }

  try {
    const content = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(content);

    // Handle legacy state format (check if it has trade state fields)
    if (parsed.matchedBets !== undefined) {
      return {
        matchedBets: parsed.matchedBets ?? [],
        totalMatchedAmount: parsed.totalMatchedAmount ?? "0",
        lastMatchedAt: parsed.lastMatchedAt ?? null
      };
    }

    // State file exists but doesn't have trade state - return default
    return getDefaultTradeState();
  } catch {
    return getDefaultTradeState();
  }
}

/**
 * Save trade state atomically using write-to-temp-then-rename pattern
 */
export function saveTradeState(state: AgentTradeState, statePath: string): void {
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
 * Add a matched bet to trade state
 */
export function addMatchedBet(
  statePath: string,
  matchedBet: MatchedBet
): AgentTradeState {
  const currentState = loadTradeState(statePath);

  // Add to matched bets array
  currentState.matchedBets.push(matchedBet);

  // Update total matched amount (add as bigint then convert back)
  // Use parseUSDCAmount for correct decimal-to-base-units conversion
  const currentTotal = BigInt(currentState.totalMatchedAmount);
  const newAmount = BigInt(parseUSDCAmount(matchedBet.fillAmount));
  currentState.totalMatchedAmount = (currentTotal + newAmount).toString();

  // Update last matched timestamp
  currentState.lastMatchedAt = matchedBet.timestamp;

  saveTradeState(currentState, statePath);
  return currentState;
}

/**
 * Log transaction to transactions.log file
 * Format: ISO_TIMESTAMP | TYPE | betId=X | amount=X | tx=X | gas=X | gasUSD=X | status=X [| error=X]
 */
export function logTransaction(
  logPath: string,
  betId: string,
  amount: string,
  txHash: string | null,
  gasUsed: string,
  gasCostUSD: string,
  status: "SUCCESS" | "FAILED",
  error?: string
): void {
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const timestamp = new Date().toISOString();
  let logLine = `${timestamp} | MATCH | betId=${betId} | amount=${amount} | tx=${txHash ?? "none"} | gas=${gasUsed} | gasUSD=${gasCostUSD} | status=${status}`;

  if (error) {
    logLine += ` | error=${error}`;
  }

  logLine += "\n";

  appendFileSync(logPath, logLine);
}

/**
 * Calculate fill amount based on risk profile and capital
 * Returns amount in USDC base units (6 decimals)
 */
export function calculateFillAmount(
  capital: number,
  riskProfile: RiskProfile,
  betRemaining: string
): string {
  const sizing = RISK_PROFILE_SIZING[riskProfile];

  // Calculate min and max bet size in USDC
  const minBet = capital * sizing.min;
  const maxBet = capital * sizing.max;

  // Use middle of range as default
  const targetBet = (minBet + maxBet) / 2;

  // Parse remaining amount (comes as decimal string like "100.000000")
  const remaining = parseFloat(betRemaining);

  // Take minimum of target bet and remaining
  const fillAmount = Math.min(targetBet, remaining);

  // Convert to base units (6 decimals) and ensure whole number
  const fillAmountBaseUnits = Math.floor(fillAmount * 1_000_000);

  return fillAmountBaseUnits.toString();
}

/**
 * Format USDC amount from base units to decimal string
 * e.g., "1000000" -> "1.000000"
 */
export function formatUSDCAmount(baseUnits: string): string {
  const amount = BigInt(baseUnits);
  const whole = amount / BigInt(1_000_000);
  const fraction = amount % BigInt(1_000_000);
  return `${whole}.${fraction.toString().padStart(6, "0")}`;
}

/**
 * Parse USDC amount from decimal string to base units
 * e.g., "1.5" -> "1500000"
 */
export function parseUSDCAmount(decimal: string): string {
  const parts = decimal.split(".");
  const whole = BigInt(parts[0]);
  const fraction = parts[1] ? parts[1].padEnd(6, "0").slice(0, 6) : "000000";
  return (whole * BigInt(1_000_000) + BigInt(fraction)).toString();
}

/**
 * Validate bet can be matched
 */
export function validateBetStatus(status: BetDetails["status"]): { valid: boolean; error?: string } {
  if (status === "pending" || status === "partially_matched") {
    return { valid: true };
  }

  if (status === "fully_matched") {
    return { valid: false, error: "Bet already fully matched" };
  }

  if (status === "resolved") {
    return { valid: false, error: "Bet already resolved" };
  }

  if (status === "cancelled") {
    return { valid: false, error: "Bet was cancelled" };
  }

  return { valid: false, error: `Unknown bet status: ${status}` };
}

/**
 * Create a success match result
 */
export function createSuccessResult(
  betId: string,
  fillAmount: string,
  txHash: string,
  gasUsed: string,
  gasCostUSD: string
): MatchResult {
  return {
    success: true,
    betId,
    fillAmount,
    txHash,
    gasUsed,
    gasCostUSD,
    message: "Bet matched successfully"
  };
}

/**
 * Create an error match result
 */
export function createErrorResult(
  betId: string,
  errorCode: ErrorCode,
  message: string,
  details?: Record<string, string>
): MatchResult {
  return {
    success: false,
    betId,
    error: errorCode,
    message,
    details
  };
}
