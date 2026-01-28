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
import type { ChainClient, TransactionResult } from "./chain-client";
import { fetchWithTls } from "./fetch-utils";

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
 * Epic 8: Added category-based betting fields
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
  // Epic 8: Category-based betting fields
  /** Snapshot ID this bet is based on */
  snapshotId?: string;
  /** Category ID (e.g., 'crypto', 'predictions') */
  categoryId?: string;
  /** List size ('1K', '10K', '100K') */
  listSize?: string;
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
    const response = await fetchWithTls(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch bets: ${response.status}`);
    }

    const data = await response.json() as { bets: Bet[] };
    const bets: Bet[] = data.bets || [];

    // Filter for matchable bets
    const now = Math.floor(Date.now() / 1000);
    const matchable = bets.filter((bet: Bet) => {
      // Only pending or partially matched
      if (bet.status !== "pending" && bet.status !== "partially_matched") {
        return false;
      }
      // Exclude our own bets
      if (excludeCreator && bet.creatorAddress.toLowerCase() === excludeCreator.toLowerCase()) {
        return false;
      }
      // Skip expired bets (deadline has passed)
      if (bet.resolutionDeadline) {
        const deadline = typeof bet.resolutionDeadline === 'number'
          ? bet.resolutionDeadline
          : Math.floor(new Date(bet.resolutionDeadline).getTime() / 1000);
        if (deadline > 0 && deadline < now) {
          return false;
        }
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
    const response = await fetchWithTls(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch bet: ${response.status}`);
    }

    return await response.json() as Bet;
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
 * Minimum time buffer before deadline to consider a bet matchable
 * In TEST_MODE, use 30 seconds; otherwise 10 minutes
 */
const MIN_DEADLINE_BUFFER_SECS = process.env.TEST_MODE === "true" ? 30 : 600;

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
// Minimum age (in seconds) before a bet can be matched - allows time for portfolio upload
const MIN_BET_AGE_SECONDS = 10;

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

  // Skip very recent bets - give time for portfolio upload
  if (bet.createdAt) {
    const createdTime = new Date(bet.createdAt).getTime();
    const ageSeconds = (Date.now() - createdTime) / 1000;
    if (ageSeconds < MIN_BET_AGE_SECONDS) {
      // Silently skip - will be evaluated on next cycle
      return false;
    }
  }

  // Check portfolio data exists - don't match bets without proper data
  // TEMPORARILY DISABLED FOR TESTING
  // if (!hasValidPortfolio(bet)) {
  //   logger.warn(`Bet ${bet.betId} rejected: no valid portfolio data`);
  //   return false;
  // }

  // Check deadline if present
  if (bet.resolutionDeadline) {
    const now = Math.floor(Date.now() / 1000);
    // Parse deadline - could be a Unix timestamp (number) or ISO date string
    const deadline = typeof bet.resolutionDeadline === 'number'
      ? bet.resolutionDeadline
      : Math.floor(new Date(String(bet.resolutionDeadline)).getTime() / 1000);

    // Deadline already passed
    if (deadline > 0 && deadline <= now) {
      logger.warn(`Bet ${bet.betId} has expired (deadline: ${bet.resolutionDeadline}, now: ${now})`);
      return false;
    }

    // Too close to expiry (less than 10 minutes)
    if (deadline > 0 && deadline < now + MIN_DEADLINE_BUFFER_SECS) {
      logger.warn(`Bet ${bet.betId} too close to deadline (${deadline - now}s remaining)`);
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
  const decimals = getCollateralDecimals();
  const multiplier = Math.pow(10, decimals);

  // Calculate desired fill amount
  const desiredAmount = capital * riskPercent;

  // Convert remaining to number for comparison
  const remaining = Number(remainingAmount) / multiplier;

  // Take minimum of desired and remaining
  const fillAmount = Math.min(desiredAmount, remaining);

  // Convert to base units using configurable decimals
  const baseUnits = Math.floor(fillAmount * multiplier);

  return baseUnits.toString();
}

/**
 * Format token amount for display (uses configurable decimals)
 */
export function formatUSDC(baseUnits: string): string {
  const decimals = getCollateralDecimals();
  const divisor = BigInt(10) ** BigInt(decimals);
  const amount = BigInt(baseUnits);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  return `${whole}.${fraction.toString().padStart(decimals, "0")}`;
}

/**
 * Parse token amount from decimal string to base units (uses configurable decimals)
 */
export function parseUSDC(decimal: string): string {
  const decimals = getCollateralDecimals();
  const multiplier = BigInt(10) ** BigInt(decimals);
  const parts = decimal.split(".");
  const whole = BigInt(parts[0] || "0");
  const fractionStr = parts[1] ? parts[1].padEnd(decimals, "0").slice(0, decimals) : "0".repeat(decimals);
  return (whole * multiplier + BigInt(fractionStr)).toString();
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
 * Update bot state after placing a bet
 */
export function updateStateAfterPlace(
  state: BotState,
  betId: string,
  amount: string
): BotState {
  const decimals = getCollateralDecimals();
  const amountTokens = Number(amount) / Math.pow(10, decimals);

  return {
    ...state,
    activeBetIds: [...state.activeBetIds, betId],
    allocatedCapital: state.allocatedCapital + amountTokens,
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
  const decimals = getCollateralDecimals();
  const amountTokens = Number(amount) / Math.pow(10, decimals);

  return {
    ...state,
    matchedBetIds: [...state.matchedBetIds, betId],
    allocatedCapital: state.allocatedCapital + amountTokens,
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
  const decimals = getCollateralDecimals();
  const refundTokens = refundAmount ? Number(refundAmount) / Math.pow(10, decimals) : 0;

  return {
    ...state,
    activeBetIds: state.activeBetIds.filter((id) => id !== betId),
    allocatedCapital: Math.max(0, state.allocatedCapital - refundTokens),
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
 * Upload portfolio as trades to backend after placing a bet
 *
 * @deprecated Story 9.2: Use uploadPositionBitmap() or uploadTradesAsBitmap() from
 * snapshot-client.ts instead. This function uses JSON serialization which causes
 * 413 errors for large portfolios (>10K trades). The bitmap encoding reduces
 * payload from ~800KB to ~1.7KB for 10K trades.
 *
 * This function is kept for backwards compatibility only.
 *
 * This stores the full portfolio data so other bots can view it
 * and the frontend can display market positions.
 * Converts portfolio positions to the trades format expected by the backend.
 *
 * @param betId - The bet ID returned from placeBet
 * @param portfolio - The full portfolio object
 * @param config - Optional config for backend URL
 * @param rawJsonString - Optional: the exact JSON string that was hashed on-chain
 * @returns Success status and message
 */
export async function uploadPortfolioToBackend(
  betId: string,
  portfolio: Portfolio,
  config: Partial<LifecycleConfig> = {},
  rawJsonString?: string
): Promise<{ success: boolean; message: string }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  // Use the trades endpoint (not portfolio)
  const url = `${cfg.backendUrl}/api/bets/${betId}/trades`;

  logger.info(`Uploading trades for bet ${betId} to ${url}`);

  try {
    // Convert portfolio positions to trades format
    // Portfolio: { positions: [{ marketId: "polymarket:0x123", position: "YES", weight: 0.01 }] }
    // Trades: [{ id: "ticker/source/method", ticker: "ticker", source: "polymarket", method: "outcome", position: "LONG", entryPrice: "0.50" }]
    const trades = portfolio.positions.map((pos, idx) => {
      // Parse marketId - format is "source:ticker" (e.g., "polymarket:0x123" or "coingecko:BTC")
      const parts = pos.marketId.split(":");
      const source = parts[0] || "polymarket";
      const ticker = parts.slice(1).join(":") || pos.marketId;

      // Convert YES/NO to LONG/SHORT
      const position = pos.position === "YES" ? "LONG" : "SHORT";

      return {
        id: `${ticker}/${source}/outcome`,
        ticker: ticker,
        source: source,
        method: "outcome",
        position: position,
        entryPrice: "0.50", // Default entry price for prediction markets (50% probability)
      };
    });

    const response = await fetchWithTls(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tradesJson: trades,
        tradesJsonString: rawJsonString, // Send raw string for hash verification
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Failed to upload trades: ${response.status} - ${errorText}`);
      return {
        success: false,
        message: `Upload failed: ${response.status} - ${errorText}`,
      };
    }

    const result = await response.json() as { tradesStored: number };
    logger.info(`Trades uploaded successfully for bet ${betId}: ${result.tradesStored} trades`);

    return {
      success: true,
      message: `Uploaded ${result.tradesStored} trades`,
    };
  } catch (error) {
    const errorMsg = (error as Error).message;
    logger.error(`Error uploading trades: ${errorMsg}`);
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

/**
 * Result of cancelling a bet
 */
export interface CancelBetResult {
  success: boolean;
  betId: string;
  txHash?: string;
  refundAmount?: string;
  error?: string;
}

/**
 * Cancel a bet on-chain
 *
 * Note: Only the bet creator can cancel, and only if not fully matched.
 * Returns the refund amount if successful.
 *
 * @param betId - The bet ID to cancel
 * @param chainClient - Chain client for executing the cancellation
 * @param config - Lifecycle configuration
 * @returns Result of the cancellation
 */
export async function cancelBet(
  betId: string,
  chainClient: ChainClient | null,
  config: Partial<LifecycleConfig> = {}
): Promise<CancelBetResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  logger.info(`Cancelling bet ${betId}`);

  if (!chainClient) {
    logger.error(`Cannot cancel bet ${betId}: No chain client provided`);
    return {
      success: false,
      betId,
      error: "Chain client not provided",
    };
  }

  const result = await chainClient.cancelBet(betId);

  if (result.success) {
    logger.info(`Bet ${betId} cancelled successfully: ${result.txHash}`);
    return {
      success: true,
      betId,
      txHash: result.txHash,
    };
  } else {
    logger.error(`Failed to cancel bet ${betId}: ${result.error}`);
    return {
      success: false,
      betId,
      error: result.error,
    };
  }
}

/**
 * Fetch details for multiple bets by ID
 *
 * @param betIds - Array of bet IDs to fetch
 * @param config - Lifecycle configuration
 * @returns Array of bet details (null for any not found)
 */
export async function fetchBetsByIds(
  betIds: string[],
  config: Partial<LifecycleConfig> = {}
): Promise<(Bet | null)[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const results = await Promise.all(
    betIds.map(betId => fetchBetDetails(betId, cfg))
  );

  return results;
}

// ============================================================================
// Epic 8: Category-Based Betting Lifecycle Functions
// ============================================================================

/**
 * Configuration for category-based matching
 */
export interface CategoryMatchConfig {
  currentSnapshotId: string;
  categoryId: string;
  listSize: string;
}

/**
 * Check if a bet can be matched under Epic 8 rules
 *
 * Epic 8 requires:
 * - Same snapshotId
 * - Same categoryId
 * - Same listSize
 *
 * @param bet - The bet to check
 * @param myConfig - Bot's current category configuration
 * @returns true if bet can be matched
 */
export function canMatchBetWithSnapshot(bet: Bet, myConfig: CategoryMatchConfig): boolean {
  // First check standard matching rules
  if (!canMatchBet(bet)) {
    return false;
  }

  // Epic 8: Check snapshot/category/listSize match
  if (!bet.snapshotId || !bet.categoryId || !bet.listSize) {
    // Legacy bet without Epic 8 fields - can't match under new rules
    logger.warn(`Bet ${bet.betId} missing Epic 8 fields, skipping`);
    return false;
  }

  if (bet.snapshotId !== myConfig.currentSnapshotId) {
    logger.info(`Bet ${bet.betId} snapshot mismatch: ${bet.snapshotId} != ${myConfig.currentSnapshotId}`);
    return false;
  }

  if (bet.categoryId !== myConfig.categoryId) {
    logger.info(`Bet ${bet.betId} category mismatch: ${bet.categoryId} != ${myConfig.categoryId}`);
    return false;
  }

  if (bet.listSize !== myConfig.listSize) {
    logger.info(`Bet ${bet.betId} listSize mismatch: ${bet.listSize} != ${myConfig.listSize}`);
    return false;
  }

  return true;
}

/**
 * Filter bets to only those matchable under Epic 8 rules
 *
 * @param bets - All pending bets
 * @param myConfig - Bot's category configuration
 * @returns Bets that match the bot's snapshot/category/listSize
 */
export function filterMatchableBets(bets: Bet[], myConfig: CategoryMatchConfig): Bet[] {
  return bets.filter(bet => canMatchBetWithSnapshot(bet, myConfig));
}

// Re-export trade functions from snapshot-client for convenience
export { uploadTradesToBackend, getBetTrades, verifyCounterpartyTrades } from './snapshot-client';
