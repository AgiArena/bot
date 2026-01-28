/**
 * Bet Cancellation Logic
 *
 * Decides when to cancel unfilled or partially filled bets:
 * - Too old (unfilled for too long)
 * - Market moved significantly
 * - Approaching resolution deadline
 * - Better opportunity available
 * - Capital needed for higher-value bets
 *
 * Auto-cancels without manual review for fast operation.
 */

import type { Bet } from "./bet-lifecycle";
import type { ChainClient, TransactionResult } from "./chain-client";

/**
 * Cancellation configuration
 */
export interface CancellationConfig {
  /** Minimum age in minutes before considering cancellation */
  minAgeBeforeCancel: number;
  /** Maximum unfilled age in minutes - cancel after this */
  maxUnfilledAge: number;
  /** Price change threshold in basis points to trigger cancellation */
  priceChangeThreshold: number;
  /** Minutes before deadline to cancel */
  cancelBeforeDeadlineMinutes: number;
  /** EV improvement threshold to cancel for better opportunity (0-1) */
  opportunityCostThreshold: number;
}

/**
 * Default cancellation config (fast defaults)
 */
export const DEFAULT_CANCELLATION_CONFIG: CancellationConfig = {
  minAgeBeforeCancel: 1,              // Wait 1 minute minimum
  maxUnfilledAge: 3,                  // Cancel after 3 minutes unfilled
  priceChangeThreshold: 200,          // 2% price move (200 bps)
  cancelBeforeDeadlineMinutes: 10,    // 10 minute buffer
  opportunityCostThreshold: 0.10,     // 10% better EV
};

/**
 * Load cancellation config from environment
 */
export function loadCancellationConfigFromEnv(): CancellationConfig {
  return {
    minAgeBeforeCancel: parseInt(process.env.MIN_AGE_BEFORE_CANCEL_MINUTES || "", 10) || DEFAULT_CANCELLATION_CONFIG.minAgeBeforeCancel,
    maxUnfilledAge: parseInt(process.env.MAX_UNFILLED_AGE_MINUTES || "", 10) || DEFAULT_CANCELLATION_CONFIG.maxUnfilledAge,
    priceChangeThreshold: parseInt(process.env.PRICE_CHANGE_CANCEL_BPS || "", 10) || DEFAULT_CANCELLATION_CONFIG.priceChangeThreshold,
    cancelBeforeDeadlineMinutes: parseInt(process.env.CANCEL_BEFORE_DEADLINE_MINUTES || "", 10) || DEFAULT_CANCELLATION_CONFIG.cancelBeforeDeadlineMinutes,
    opportunityCostThreshold: parseFloat(process.env.OPPORTUNITY_COST_THRESHOLD || "") || DEFAULT_CANCELLATION_CONFIG.opportunityCostThreshold,
  };
}

/**
 * Reasons for cancellation
 */
export type CancelReason =
  | "too_old"              // Unfilled for too long
  | "market_moved"         // Price changed significantly
  | "approaching_deadline" // Too close to resolution deadline
  | "better_opportunity"   // Higher EV opportunity available
  | "capital_needed";      // Need capital for other bets

/**
 * Cancellation decision
 */
export interface CancellationDecision {
  /** Whether to cancel this bet */
  shouldCancel: boolean;
  /** Reason for cancellation */
  reason?: CancelReason;
  /** Priority (higher = cancel first) */
  priority: number;
  /** Human-readable explanation */
  explanation?: string;
}

/**
 * Active bet with additional context for cancellation evaluation
 */
export interface ActiveBetContext {
  bet: Bet;
  /** Current market price (if available) */
  currentPrice?: number;
  /** Price when bet was placed */
  originalPrice?: number;
  /** Expected value score (for opportunity cost) */
  evScore?: number;
}

/**
 * Evaluate whether a single bet should be canceled
 *
 * @param bet - The bet to evaluate
 * @param config - Cancellation configuration
 * @param currentTime - Current timestamp (ms) for testing
 * @param context - Additional context like current prices
 */
export function evaluateCancellation(
  bet: Bet,
  config: CancellationConfig,
  currentTime: number = Date.now(),
  context?: Partial<ActiveBetContext>
): CancellationDecision {
  const betCreatedAt = new Date(bet.createdAt).getTime();
  const betAgeMinutes = (currentTime - betCreatedAt) / (60 * 1000);

  // Don't consider bets that are too new
  if (betAgeMinutes < config.minAgeBeforeCancel) {
    return { shouldCancel: false, priority: 0 };
  }

  // Check if bet is fully matched (no need to cancel)
  if (bet.status === "fully_matched" || bet.status === "settled" || bet.status === "settling") {
    return { shouldCancel: false, priority: 0 };
  }

  // Already cancelled
  if (bet.status === "cancelled") {
    return { shouldCancel: false, priority: 0 };
  }

  // Priority 1: Approaching deadline (highest priority)
  if (bet.resolutionDeadline) {
    const deadlineMs = bet.resolutionDeadline * 1000;
    const timeToDeadlineMinutes = (deadlineMs - currentTime) / (60 * 1000);

    if (timeToDeadlineMinutes <= config.cancelBeforeDeadlineMinutes) {
      return {
        shouldCancel: true,
        reason: "approaching_deadline",
        priority: 100,
        explanation: `Only ${timeToDeadlineMinutes.toFixed(1)} minutes until deadline`,
      };
    }
  }

  // Priority 2: Too old (unfilled for too long)
  if (betAgeMinutes >= config.maxUnfilledAge) {
    // Only apply to completely unfilled bets
    const matchedAmount = parseFloat(bet.matchedAmount) || 0;
    if (matchedAmount === 0) {
      return {
        shouldCancel: true,
        reason: "too_old",
        priority: 80,
        explanation: `Unfilled for ${betAgeMinutes.toFixed(1)} minutes (max: ${config.maxUnfilledAge})`,
      };
    }
  }

  // Priority 3: Market moved significantly
  if (context?.currentPrice !== undefined && context?.originalPrice !== undefined) {
    const priceChange = Math.abs(context.currentPrice - context.originalPrice);
    const priceChangeBps = (priceChange / context.originalPrice) * 10000;

    if (priceChangeBps >= config.priceChangeThreshold) {
      return {
        shouldCancel: true,
        reason: "market_moved",
        priority: 60,
        explanation: `Price moved ${priceChangeBps.toFixed(0)} bps (threshold: ${config.priceChangeThreshold})`,
      };
    }
  }

  // No cancellation needed
  return { shouldCancel: false, priority: 0 };
}

/**
 * Evaluate all active bets for cancellation
 *
 * @param activeBets - List of active bets with context
 * @param config - Cancellation configuration
 * @param currentTime - Current timestamp for testing
 * @returns Map of betId -> cancellation decision
 */
export function evaluateAllBetsForCancellation(
  activeBets: ActiveBetContext[],
  config: CancellationConfig,
  currentTime: number = Date.now()
): Map<string, CancellationDecision> {
  const decisions = new Map<string, CancellationDecision>();

  for (const { bet, ...context } of activeBets) {
    const decision = evaluateCancellation(bet, config, currentTime, context);
    decisions.set(bet.betId, decision);
  }

  return decisions;
}

/**
 * Get bets that should be canceled, sorted by priority
 */
export function getBetsToCancel(
  decisions: Map<string, CancellationDecision>
): Array<{ betId: string; decision: CancellationDecision }> {
  const toCancel: Array<{ betId: string; decision: CancellationDecision }> = [];

  for (const [betId, decision] of decisions) {
    if (decision.shouldCancel) {
      toCancel.push({ betId, decision });
    }
  }

  // Sort by priority (highest first)
  return toCancel.sort((a, b) => b.decision.priority - a.decision.priority);
}

/**
 * Execute a bet cancellation on-chain
 *
 * @param chainClient - Chain client for transactions
 * @param betId - Bet ID to cancel
 * @returns Transaction result
 */
export async function executeCancellation(
  chainClient: ChainClient,
  betId: string
): Promise<TransactionResult> {
  console.log(`[Cancellation] Cancelling bet ${betId} on-chain`);

  const result = await chainClient.cancelBet(betId);

  if (result.success) {
    console.log(`[Cancellation] Bet ${betId} cancelled successfully: ${result.txHash}`);
  } else {
    console.error(`[Cancellation] Failed to cancel bet ${betId}: ${result.error}`);
  }

  return result;
}

/**
 * Format cancellation decision for logging
 */
export function formatCancellationDecision(
  betId: string,
  decision: CancellationDecision
): string {
  if (!decision.shouldCancel) {
    return `Bet ${betId}: Keep (priority: ${decision.priority})`;
  }

  return `Bet ${betId}: CANCEL (${decision.reason}, priority: ${decision.priority}) - ${decision.explanation}`;
}
