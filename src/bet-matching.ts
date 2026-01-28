import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from "fs";
import { dirname, join } from "path";
import { Logger } from "./logger";

// Initialize logger for this module (file-based, respects log levels)
const logsDir = process.env.AGENT_LOGS_DIR || join(process.cwd(), "agent");
const logger = new Logger(logsDir);

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

// ============================================================================
// ODDS-AWARE SIZING (Story 7-15)
// ============================================================================

/**
 * Odds adjustment bounds for bet sizing
 * Cap adjustment factor between 0.5x and 1.5x
 */
export const ODDS_ADJUSTMENT_MIN = 0.5;
export const ODDS_ADJUSTMENT_MAX = 1.5;

/**
 * Result of odds favorability calculation
 */
export interface OddsFavorabilityResult {
  /** Decimal odds (e.g., 2.0 for 2.00x) */
  oddsDecimal: number;
  /** Matcher return multiplier (e.g., 3.0 at 2.0x odds) */
  matcherReturn: number;
  /** Win probability needed to break even */
  impliedProbNeeded: number;
  /** Favorability ratio: >1 = favorable, <1 = unfavorable */
  favorabilityRatio: number;
}

/**
 * Calculate odds favorability for a bet
 *
 * At different odds, matcher gets different returns:
 * - 1.0x odds: matcher risks $100 to win $100, return = 2x (needs 50% to break even)
 * - 2.0x odds: matcher risks $50 to win $150, return = 3x (needs 33% to break even)
 * - 0.5x odds: matcher risks $200 to win $100, return = 1.5x (needs 67% to break even)
 *
 * Favorability = fairProbNeeded / impliedProbNeeded
 * >1 means favorable for matcher, <1 means unfavorable
 *
 * @param oddsBps - Odds in basis points (10000 = 1.0x, 20000 = 2.0x)
 * @returns Odds favorability calculation result
 * @throws Error if oddsBps is <= 0
 */
export function calculateOddsFavorability(oddsBps: number): OddsFavorabilityResult {
  if (oddsBps <= 0) {
    throw new Error(`Invalid oddsBps: ${oddsBps}. Must be greater than 0.`);
  }

  // Convert basis points to decimal (20000 -> 2.0)
  const oddsDecimal = oddsBps / 10000;

  // Calculate matcher return multiplier
  // At 2.0x: matcher risks 0.5 units, wins 1.5 units total = 3x return
  const matcherReturn = oddsDecimal + 1;

  // Implied probability to break even = 1 / matcherReturn
  const impliedProbNeeded = 1 / matcherReturn;

  // Favorability: how much the odds favor the matcher
  // At fair odds (1.00x), this equals 1.0
  // At favorable odds (2.00x), matcher only needs 33% to break even vs 50%
  const fairProbNeeded = 0.5;
  const favorabilityRatio = fairProbNeeded / impliedProbNeeded;

  return {
    oddsDecimal,
    matcherReturn,
    impliedProbNeeded,
    favorabilityRatio
  };
}

/**
 * Calculate fill amount with odds-aware sizing adjustment
 *
 * With favorable odds (high oddsBps), we can bet more aggressively.
 * With unfavorable odds (low oddsBps), we should bet more conservatively.
 *
 * Adjustment is clamped between 0.5x and 1.5x of base sizing.
 *
 * @param capital - Total capital in human-readable units (e.g., 100 tokens)
 * @param riskProfile - Risk profile (conservative, balanced, aggressive)
 * @param betRemaining - Remaining bet amount as decimal string (human-readable)
 * @param oddsBps - Odds in basis points (10000 = 1.0x, 20000 = 2.0x)
 * @param decimals - Number of decimals for the collateral token (6 for USDC, 18 for WIND)
 * @returns Fill amount in base units
 */
export function calculateOddsAwareFillAmount(
  capital: number,
  riskProfile: RiskProfile,
  betRemaining: string,
  oddsBps: number,
  decimals: number = 6
): string {
  const baseSizing = RISK_PROFILE_SIZING[riskProfile];

  // Calculate odds favorability
  const { favorabilityRatio } = calculateOddsFavorability(oddsBps);

  // Clamp adjustment factor between 0.5x and 1.5x
  const oddsAdjustment = Math.min(
    ODDS_ADJUSTMENT_MAX,
    Math.max(ODDS_ADJUSTMENT_MIN, favorabilityRatio)
  );

  // Apply adjustment to base sizing percentages
  const adjustedMin = baseSizing.min * oddsAdjustment;
  const adjustedMax = baseSizing.max * oddsAdjustment;

  // Calculate target bet as middle of adjusted range
  const targetBet = capital * ((adjustedMin + adjustedMax) / 2);

  // Parse remaining amount
  const remaining = parseFloat(betRemaining);

  // Take minimum of target bet and remaining
  const fillAmount = Math.min(targetBet, remaining);

  logger.debug("Bet sizing calculation", { capital, targetBet, remaining, fillAmount });

  // Convert to base units using the specified decimals
  const multiplier = BigInt(10) ** BigInt(decimals);
  const fillAmountBaseUnits = BigInt(Math.floor(fillAmount * Number(multiplier)));

  logger.debug("Base units conversion", { decimals, multiplier: multiplier.toString(), fillAmountBaseUnits: fillAmountBaseUnits.toString() });

  // Minimum bet in base units (0.01 tokens)
  const minBetBaseUnits = multiplier / BigInt(100);

  // Calculate remaining in base units
  const remainingBaseUnits = BigInt(Math.floor(remaining * Number(multiplier)));
  const isFillingEntireRemaining = fillAmountBaseUnits >= remainingBaseUnits && remainingBaseUnits > BigInt(0);

  logger.debug("Fill size check", {
    minBetBaseUnits: minBetBaseUnits.toString(),
    fillAmountBaseUnits: fillAmountBaseUnits.toString(),
    tooSmall: fillAmountBaseUnits < minBetBaseUnits,
  });

  if (fillAmountBaseUnits < minBetBaseUnits && !isFillingEntireRemaining) {
    logger.debug("Returning 0 because fill too small");
    return "0";
  }

  // For small fills, ensure we fill at least what's remaining
  return isFillingEntireRemaining ? remainingBaseUnits.toString() : fillAmountBaseUnits.toString();
}

/**
 * Get Kelly fraction from environment variable
 * Defaults to 0.25 (25% Kelly) for safety
 */
export function getKellyFractionFromEnv(): number {
  const envValue = process.env.KELLY_FRACTION;
  if (envValue) {
    const parsed = parseFloat(envValue);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 1) {
      return parsed;
    }
  }
  return 0.25; // Default: 25% Kelly for safety
}

/**
 * Calculate Kelly fraction for optimal bet sizing
 *
 * Kelly formula: f* = (p(b+1) - 1) / b
 * Where:
 *   p = win probability
 *   b = net odds (what we win for $1 bet)
 *
 * For matcher at odds:
 * - At 2.00x odds: we risk $50 to win $100 net, so b = 2
 *
 * @param winProbability - Our estimated probability of winning (0-1)
 * @param oddsDecimal - Decimal odds (e.g., 2.0 for 2.00x)
 * @param fraction - Fractional Kelly to use (default from env or 0.25)
 * @returns Fraction of bankroll to bet (0 if negative EV)
 */
export function calculateKellyFraction(
  winProbability: number,
  oddsDecimal: number,
  fraction: number = getKellyFractionFromEnv()
): number {
  // Calculate net odds for matcher
  // At 2.00x odds as matcher: we risk $50 to win $100 net, so b = oddsDecimal
  const netOdds = oddsDecimal;

  // Kelly formula: f* = (p(b+1) - 1) / b
  const fullKelly = (winProbability * (netOdds + 1) - 1) / netOdds;

  // Apply fractional Kelly for safety, clamp to 0 if negative
  const fractionalKelly = Math.max(0, fullKelly * fraction);

  return Math.round(fractionalKelly * 10000) / 10000;
}

/**
 * Log odds sizing decision for debugging
 *
 * Format: ISO_TIMESTAMP | ODDS_SIZING | betId=X | oddsBps=X | adjustment=X | baseSize=X | adjustedSize=X [| capped=true]
 *
 * @param logPath - Path to log file
 * @param betId - Bet ID
 * @param oddsBps - Odds in basis points
 * @param adjustmentFactor - Applied adjustment factor
 * @param baseSize - Base size before adjustment (in base units)
 * @param adjustedSize - Adjusted size after odds (in base units)
 * @param wasCapped - Whether adjustment was capped at min/max
 */
export function logOddsSizingDecision(
  logPath: string,
  betId: string,
  oddsBps: number,
  adjustmentFactor: number,
  baseSize: number,
  adjustedSize: number,
  wasCapped: boolean
): void {
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const timestamp = new Date().toISOString();
  let logLine = `${timestamp} | ODDS_SIZING | betId=${betId} | oddsBps=${oddsBps} | adjustment=${adjustmentFactor} | baseSize=${baseSize} | adjustedSize=${adjustedSize}`;

  if (wasCapped) {
    logLine += " | capped=true";
  }

  logLine += "\n";

  appendFileSync(logPath, logLine);
}

/**
 * Get collateral decimals from environment (default: 6 for USDC, 18 for WIND)
 */
function getCollateralDecimals(): number {
  const envValue = process.env.COLLATERAL_DECIMALS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 18) {
      return parsed;
    }
  }
  return 6;
}

/**
 * Get multiplier for collateral token
 */
function getCollateralMultiplier(): bigint {
  return BigInt(10) ** BigInt(getCollateralDecimals());
}

/**
 * Minimum bet amount in base units
 * 0.01 tokens = 10^(decimals-2) base units
 */
export function getMinBetAmount(): bigint {
  const decimals = getCollateralDecimals();
  return BigInt(10) ** BigInt(decimals - 2);
}

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
  BELOW_MINIMUM: "BELOW_MINIMUM",
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
 * Returns amount in base units (uses COLLATERAL_DECIMALS from env)
 * Enforces minimum bet of 0.01 tokens
 */
export function calculateFillAmount(
  capital: number,
  riskProfile: RiskProfile,
  betRemaining: string
): string {
  const sizing = RISK_PROFILE_SIZING[riskProfile];
  const multiplier = Number(getCollateralMultiplier());
  const minBetAmount = Number(getMinBetAmount());

  // Calculate min and max bet size in tokens
  const minBet = capital * sizing.min;
  const maxBet = capital * sizing.max;

  // Use middle of range as default
  const targetBet = (minBet + maxBet) / 2;

  // Parse remaining amount (comes as decimal string like "100.000000")
  const remaining = parseFloat(betRemaining);

  // Take minimum of target bet and remaining
  const fillAmount = Math.min(targetBet, remaining);

  // Convert to base units and ensure whole number
  const fillAmountBaseUnits = Math.floor(fillAmount * multiplier);

  // Enforce minimum bet amount
  // BUT: allow filling if we're filling the entire remaining amount (for small bets)
  const remainingBaseUnits = Math.floor(remaining * multiplier);
  const isFillingEntireRemaining = fillAmountBaseUnits >= remainingBaseUnits && remainingBaseUnits > 0;

  if (fillAmountBaseUnits < minBetAmount && !isFillingEntireRemaining) {
    return "0"; // Return 0 to signal below minimum - caller should skip this bet
  }

  // For small fills, ensure we fill at least what's remaining
  return isFillingEntireRemaining ? remainingBaseUnits.toString() : fillAmountBaseUnits.toString();
}

/**
 * Validate that a bet amount meets the minimum threshold
 * Returns true if amount is at least 0.01 tokens
 * Uses BigInt for safe comparison
 */
export function validateMinimumBet(amountBaseUnits: string | number | bigint): boolean {
  const amount = BigInt(amountBaseUnits);
  return amount >= getMinBetAmount();
}

/**
 * Format collateral amount from base units to decimal string
 * Uses COLLATERAL_DECIMALS from env
 */
export function formatUSDCAmount(baseUnits: string): string {
  const decimals = getCollateralDecimals();
  const multiplier = getCollateralMultiplier();
  const amount = BigInt(baseUnits);
  const whole = amount / multiplier;
  const fraction = amount % multiplier;
  return `${whole}.${fraction.toString().padStart(decimals, "0")}`;
}

/**
 * Parse collateral amount from decimal string to base units
 * Uses COLLATERAL_DECIMALS from env
 */
export function parseUSDCAmount(decimal: string): string {
  const decimals = getCollateralDecimals();
  const multiplier = getCollateralMultiplier();
  const parts = decimal.split(".");
  const whole = BigInt(parts[0]);
  const fraction = parts[1] ? parts[1].padEnd(decimals, "0").slice(0, decimals) : "0".repeat(decimals);
  return (whole * multiplier + BigInt(fraction)).toString();
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

// ============================================================================
// Epic 8: Category-Based Matching Constraints
// ============================================================================

import type { TradeListSize, Trade } from './types';

/**
 * Extended bet details with Epic 8 fields
 */
export interface BetDetailsEpic8 extends BetDetails {
  snapshotId?: string;
  categoryId?: string;
  listSize?: string;
}

/**
 * Bot's current category configuration
 */
export interface BotCategoryConfig {
  currentSnapshotId: string;
  categoryId: string;
  listSize: TradeListSize;
}

/**
 * Check if a bet matches the bot's category configuration
 *
 * Epic 8: Bots can only match bets with same snapshot + category + listSize
 *
 * @param bet - The bet to check
 * @param botConfig - Bot's category configuration
 * @returns true if bet can be matched
 */
export function matchesCategoryConfig(bet: BetDetailsEpic8, botConfig: BotCategoryConfig): boolean {
  if (!bet.snapshotId || !bet.categoryId || !bet.listSize) {
    // Legacy bet without Epic 8 fields - skip under new rules
    return false;
  }

  return (
    bet.snapshotId === botConfig.currentSnapshotId &&
    bet.categoryId === botConfig.categoryId &&
    bet.listSize === botConfig.listSize
  );
}

/**
 * Filter bets to only those matching bot's category config
 *
 * @param bets - All pending bets
 * @param botConfig - Bot's category configuration
 * @returns Bets matching the configuration
 */
export function filterBetsByCategory(
  bets: BetDetailsEpic8[],
  botConfig: BotCategoryConfig
): BetDetailsEpic8[] {
  return bets.filter(bet => matchesCategoryConfig(bet, botConfig));
}

/**
 * Result of counterparty trade verification
 */
export interface TradeVerificationResult {
  valid: boolean;
  trades: Trade[];
  reason?: string;
}

/**
 * Check if counterparty's entry prices are reasonable
 *
 * Epic 8: Before matching, verify the counterparty's entry prices
 * are within tolerance of current market prices.
 *
 * @param trades - Counterparty's trades
 * @param currentPrices - Map of ticker -> current price
 * @param tolerance - Max allowed price deviation (default 5%)
 * @returns Verification result
 */
export function verifyTradeEntryPrices(
  trades: Trade[],
  currentPrices: Map<string, number>,
  tolerance: number = 0.05
): TradeVerificationResult {
  if (trades.length === 0) {
    return { valid: false, trades: [], reason: 'No trades found' };
  }

  for (const trade of trades) {
    const currentPrice = currentPrices.get(trade.ticker);
    if (currentPrice === undefined) {
      // Can't verify this trade - might be acceptable for illiquid markets
      continue;
    }

    const deviation = Math.abs(trade.entryPrice - currentPrice) / currentPrice;
    if (deviation > tolerance) {
      return {
        valid: false,
        trades,
        reason: `Trade ${trade.ticker}: entry price ${trade.entryPrice} deviates ${(deviation * 100).toFixed(1)}% from current ${currentPrice}`,
      };
    }
  }

  return { valid: true, trades };
}

/**
 * Error codes specific to Epic 8 matching
 */
export const EPIC8_ERROR_CODES = {
  SNAPSHOT_MISMATCH: "SNAPSHOT_MISMATCH",
  CATEGORY_MISMATCH: "CATEGORY_MISMATCH",
  LIST_SIZE_MISMATCH: "LIST_SIZE_MISMATCH",
  TRADES_NOT_FOUND: "TRADES_NOT_FOUND",
  PRICE_DEVIATION: "PRICE_DEVIATION",
} as const;

export type Epic8ErrorCode = typeof EPIC8_ERROR_CODES[keyof typeof EPIC8_ERROR_CODES];
