/**
 * Bet Lifecycle Management
 *
 * Manages the complete lifecycle of bets:
 * - Placing new bets with portfolios
 * - Monitoring pending bets
 * - Matching bets from other bots
 * - Cancelling/updating bets
 * - Tracking state through resolution
 *
 * Story 7.6: AI Trading Bot Launch Scripts
 * AC: 3, 4 - Bet Lifecycle Management
 */

import type { Portfolio } from "./trading-strategy";
import { calculatePortfolioHash, serializePortfolio } from "./trading-strategy";

/**
 * Bet status from contract
 */
export type BetStatus =
  | "pending"
  | "partially_matched"
  | "fully_matched"
  | "cancelled"
  | "settling"
  | "settled";

/**
 * Bet data structure with asymmetric odds support
 * Updated for Story 7.7-7.16: Asymmetric Odds Epic
 */
export interface Bet {
  betId: string;
  /** @deprecated Use creatorAddress instead */
  creator?: string;
  creatorAddress: string;
  betHash: string;
  portfolioSize: number;
  /** @deprecated Use creatorStake instead. Kept for backwards compatibility. */
  amount: string; // USDC amount as string (6 decimals)
  /** Creator's stake amount in USDC (6 decimals as string) */
  creatorStake: string;
  /** Required match amount based on odds (6 decimals as string) */
  requiredMatch: string;
  matchedAmount: string;
  /** Odds in basis points: 10000 = 1.00x, 20000 = 2.00x */
  oddsBps: number;
  status: BetStatus;
  createdAt: string;
  updatedAt: string;
  portfolio?: Portfolio;
  /** Unix timestamp when bet can be resolved (seconds since epoch) */
  resolutionDeadline?: number;
}

/**
 * Fill record for a match
 */
export interface BetFill {
  filler: string;
  amount: string;
  filledAt: string;
}

/**
 * Result of placing a bet
 */
export interface PlaceBetResult {
  success: boolean;
  betId?: string;
  txHash?: string;
  error?: string;
}

/**
 * Result of matching a bet
 */
export interface MatchBetResult {
  success: boolean;
  betId: string;
  fillAmount?: string;
  txHash?: string;
  error?: string;
}

/**
 * Lifecycle manager configuration
 */
export interface LifecycleConfig {
  backendUrl: string;
  contractAddress: string;
  maxPendingBets: number;
  minBetAmount: number; // In USDC (e.g., 1 = $1)
}

/**
 * Default lifecycle configuration
 */
const DEFAULT_CONFIG: LifecycleConfig = {
  backendUrl: process.env.BACKEND_URL || "http://localhost:3001",
  contractAddress: process.env.CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000",
  maxPendingBets: 3,
  minBetAmount: 1, // $1 minimum
};

import { join } from "path";
import { Logger } from "./logger";

// Initialize logger for this module
const logsDir = process.env.AGENT_LOGS_DIR || join(process.cwd(), "agent");
const logger = new Logger(logsDir);

/**
 * Fetch pending bets from backend
 *
 * Gets bets that are available for matching
 */
export async function fetchPendingBets(
  config: Partial<LifecycleConfig> = {},
  excludeCreator?: string
): Promise<Bet[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const url = new URL("/api/bets", cfg.backendUrl);
  url.searchParams.set("limit", "100");

  logger.info(`Fetching pending bets from ${url.toString()}`);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      // @ts-ignore - Bun-specific option to disable TLS verification
      tls: {
        rejectUnauthorized: false,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch bets: ${response.status}`);
    }

    const data = await response.json();
    const bets: Bet[] = data.bets || [];

    // Filter for matchable bets
    const matchable = bets.filter((bet: Bet) => {
      // Only pending or partially matched
      if (bet.status !== "pending" && bet.status !== "partially_matched") {
        return false;
      }
      // Exclude our own bets
      if (excludeCreator && bet.creatorAddress.toLowerCase() === excludeCreator.toLowerCase()) {
        return false;
      }
      return true;
    });

    logger.info(`Found ${matchable.length} matchable bets`);
    return matchable;
  } catch (error) {
    logger.error(`Error fetching pending bets: ${error}`);
    return [];
  }
}

/**
 * Fetch bet details including portfolio
 */
export async function fetchBetDetails(
  betId: string,
  config: Partial<LifecycleConfig> = {}
): Promise<Bet | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const url = `${cfg.backendUrl}/api/bets/${betId}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      // @ts-ignore - Bun-specific option to disable TLS verification
      tls: {
        rejectUnauthorized: false,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch bet: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    logger.error(`Error fetching bet details: ${error}`);
    return null;
  }
}

/**
 * Calculate remaining amount that can be matched
 * Uses requiredMatch for asymmetric odds, falls back to amount for legacy bets
 * Returns amount in USDC base units (6 decimals)
 */
export function calculateRemainingAmount(bet: Bet): bigint {
  // Use requiredMatch for asymmetric odds, fall back to amount for backwards compatibility
  // API returns decimal strings like "2.500000", convert to base units
  const totalDecimal = bet.requiredMatch || bet.amount;
  const matchedDecimal = bet.matchedAmount;

  // Parse decimal strings to base units
  const total = BigInt(parseUSDC(totalDecimal));
  const matched = BigInt(parseUSDC(matchedDecimal));
  return total - matched;
}

/**
 * Minimum time buffer before deadline to consider a bet matchable (10 minutes)
 */
const MIN_DEADLINE_BUFFER_SECS = 600;

/**
 * Check if a bet can be matched
 *
 * Validates:
 * - Status is pending or partially_matched
 * - Has remaining amount to fill
 * - Resolution deadline hasn't passed
 * - At least 10 minutes remain before deadline
 * - Has valid portfolio data (portfolioSize > 0)
 */
export function canMatchBet(bet: Bet): boolean {
  // Check status
  if (bet.status !== "pending" && bet.status !== "partially_matched") {
    return false;
  }

  // Check remaining amount
  const remaining = calculateRemainingAmount(bet);
  if (remaining <= BigInt(0)) {
    return false;
  }

  // Check portfolio data exists - don't match bets without proper data
  if (!hasValidPortfolio(bet)) {
    logger.warn(`Bet ${bet.betId} rejected: no valid portfolio data`);
    return false;
  }

  // Check deadline if present
  if (bet.resolutionDeadline) {
    const now = Math.floor(Date.now() / 1000);

    // Deadline already passed
    if (bet.resolutionDeadline <= now) {
      logger.warn(`Bet ${bet.betId} has expired (deadline: ${bet.resolutionDeadline}, now: ${now})`);
      return false;
    }

    // Too close to expiry (less than 10 minutes)
    if (bet.resolutionDeadline < now + MIN_DEADLINE_BUFFER_SECS) {
      logger.warn(`Bet ${bet.betId} too close to deadline (${bet.resolutionDeadline - now}s remaining)`);
      return false;
    }
  }

  return true;
}

/**
 * Calculate fill amount based on capital and risk
 *
 * @param capital Available capital in USDC
 * @param riskPercent Percentage of capital to risk (0-1)
 * @param remainingAmount Maximum amount that can be filled
 */
export function calculateFillAmount(
  capital: number,
  riskPercent: number,
  remainingAmount: string
): string {
  // Calculate desired fill amount
  const desiredAmount = capital * riskPercent;

  // Convert remaining to number for comparison
  const remaining = Number(remainingAmount) / 1_000_000;

  // Take minimum of desired and remaining
  const fillAmount = Math.min(desiredAmount, remaining);

  // Convert to USDC base units (6 decimals)
  const baseUnits = Math.floor(fillAmount * 1_000_000);

  return baseUnits.toString();
}

/**
 * Format USDC amount for display
 */
export function formatUSDC(baseUnits: string): string {
  const amount = BigInt(baseUnits);
  const whole = amount / BigInt(1_000_000);
  const fraction = amount % BigInt(1_000_000);
  return `${whole}.${fraction.toString().padStart(6, "0")}`;
}

/**
 * Parse USDC amount from decimal string to base units
 */
export function parseUSDC(decimal: string): string {
  const parts = decimal.split(".");
  const whole = BigInt(parts[0] || "0");
  const fraction = parts[1] ? parts[1].padEnd(6, "0").slice(0, 6) : "000000";
  return (whole * BigInt(1_000_000) + BigInt(fraction)).toString();
}

/**
 * Bot trading state
 */
export interface BotState {
  /** Bot's wallet address */
  address: string;
  /** Active bet IDs placed by this bot */
  activeBetIds: string[];
  /** Bets that have been matched by this bot */
  matchedBetIds: string[];
  /** Total capital in USDC */
  capital: number;
  /** Currently allocated capital */
  allocatedCapital: number;
  /** Last activity timestamp */
  lastActivity: string;
  /** Session start time */
  sessionStart: string;
}

/**
 * Create initial bot state
 */
export function createInitialBotState(address: string, capital: number): BotState {
  return {
    address,
    activeBetIds: [],
    matchedBetIds: [],
    capital,
    allocatedCapital: 0,
    lastActivity: new Date().toISOString(),
    sessionStart: new Date().toISOString(),
  };
}

/**
 * Calculate available capital for new bets
 */
export function getAvailableCapital(state: BotState): number {
  return state.capital - state.allocatedCapital;
}

/**
 * Check if bot can place a new bet
 */
export function canPlaceNewBet(
  state: BotState,
  config: Partial<LifecycleConfig> = {}
): boolean {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Check max pending bets
  if (state.activeBetIds.length >= cfg.maxPendingBets) {
    logger.warn(`Max pending bets reached (${cfg.maxPendingBets})`);
    return false;
  }

  // Check available capital
  const available = getAvailableCapital(state);
  if (available < cfg.minBetAmount) {
    logger.warn(`Insufficient capital: ${available} < ${cfg.minBetAmount}`);
    return false;
  }

  return true;
}

/**
 * Update bot state after placing a bet
 */
export function updateStateAfterPlace(
  state: BotState,
  betId: string,
  amount: string
): BotState {
  const amountUSDC = Number(amount) / 1_000_000;

  return {
    ...state,
    activeBetIds: [...state.activeBetIds, betId],
    allocatedCapital: state.allocatedCapital + amountUSDC,
    lastActivity: new Date().toISOString(),
  };
}

/**
 * Update bot state after matching a bet
 */
export function updateStateAfterMatch(
  state: BotState,
  betId: string,
  amount: string
): BotState {
  const amountUSDC = Number(amount) / 1_000_000;

  return {
    ...state,
    matchedBetIds: [...state.matchedBetIds, betId],
    allocatedCapital: state.allocatedCapital + amountUSDC,
    lastActivity: new Date().toISOString(),
  };
}

/**
 * Update bot state after bet is fully matched or cancelled
 */
export function updateStateAfterComplete(
  state: BotState,
  betId: string,
  refundAmount?: string
): BotState {
  const refundUSDC = refundAmount ? Number(refundAmount) / 1_000_000 : 0;

  return {
    ...state,
    activeBetIds: state.activeBetIds.filter((id) => id !== betId),
    allocatedCapital: Math.max(0, state.allocatedCapital - refundUSDC),
    lastActivity: new Date().toISOString(),
  };
}

/**
 * Prepare portfolio for on-chain submission
 *
 * Returns the hash and JSON string needed for placeBet
 */
export function preparePortfolioForChain(portfolio: Portfolio): {
  betHash: string;
  portfolioJson: string;
} {
  const portfolioJson = serializePortfolio(portfolio);
  const betHash = calculatePortfolioHash(portfolio);

  return { betHash, portfolioJson };
}

/**
 * Validate portfolio before submission
 */
export function validatePortfolio(portfolio: Portfolio): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!portfolio.positions || portfolio.positions.length === 0) {
    errors.push("Portfolio must have at least one position");
  }

  if (portfolio.positions) {
    // Check weights sum to 1
    const totalWeight = portfolio.positions.reduce((sum, p) => sum + p.weight, 0);
    if (Math.abs(totalWeight - 1) > 0.001) {
      errors.push(`Portfolio weights must sum to 1, got ${totalWeight}`);
    }

    // Check each position
    for (const position of portfolio.positions) {
      if (!position.marketId) {
        errors.push("Position missing marketId");
      }
      if (position.position !== "YES" && position.position !== "NO") {
        errors.push(`Invalid position: ${position.position}`);
      }
      if (position.weight <= 0 || position.weight > 1) {
        errors.push(`Invalid weight: ${position.weight}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Generate a unique bet reference for off-chain storage
 */
export function generateBetReference(botAddress: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `bot-${botAddress.slice(2, 8)}-${timestamp}-${random}`;
}

/**
 * Upload portfolio JSON to backend after placing a bet
 *
 * This stores the full portfolio data so other bots can view it
 * and the frontend can display market positions.
 *
 * @param betId - The bet ID returned from placeBet
 * @param portfolio - The full portfolio object
 * @param config - Optional config for backend URL
 * @returns Success status and message
 */
export async function uploadPortfolioToBackend(
  betId: string,
  portfolio: Portfolio,
  config: Partial<LifecycleConfig> = {}
): Promise<{ success: boolean; message: string }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const url = `${cfg.backendUrl}/api/bets/${betId}/portfolio`;

  logger.info(`Uploading portfolio for bet ${betId} to ${url}`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        portfolioJson: portfolio,
      }),
      // @ts-ignore - Bun-specific option to disable TLS verification
      tls: {
        rejectUnauthorized: false,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Failed to upload portfolio: ${response.status} - ${errorText}`);
      return {
        success: false,
        message: `Upload failed: ${response.status} - ${errorText}`,
      };
    }

    const result = await response.json() as { positionsExtracted: number };
    logger.info(`Portfolio uploaded successfully for bet ${betId}: ${result.positionsExtracted} positions`);

    return {
      success: true,
      message: `Uploaded ${result.positionsExtracted} positions`,
    };
  } catch (error) {
    const errorMsg = (error as Error).message;
    logger.error(`Error uploading portfolio: ${errorMsg}`);
    return {
      success: false,
      message: `Upload error: ${errorMsg}`,
    };
  }
}

/**
 * Check if a bet has valid portfolio data for matching
 *
 * Bots should NOT match bets without portfolio data because:
 * 1. Can't verify what markets the bet is for
 * 2. Frontend/keeper can't process the bet properly
 * 3. Indicates the bet creator didn't properly upload data
 *
 * @param bet - The bet to validate
 * @returns true if portfolio data exists and is valid
 */
export function hasValidPortfolio(bet: Bet): boolean {
  // Check if portfolioSize is greater than 0
  if (!bet.portfolioSize || bet.portfolioSize === 0) {
    logger.warn(`Bet ${bet.betId} has no portfolio positions (portfolioSize: ${bet.portfolioSize})`);
    return false;
  }

  // If portfolio object is attached, validate it has positions
  if (bet.portfolio) {
    if (!bet.portfolio.positions || bet.portfolio.positions.length === 0) {
      logger.warn(`Bet ${bet.betId} has empty portfolio.positions array`);
      return false;
    }
  }

  return true;
}
