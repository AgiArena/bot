/**
 * AI Trading Strategy and Price Negotiation Engine
 *
 * Implements AI-driven price negotiation between bots:
 * - Fair price calculation
 * - Offer evaluation (accept/counter/switch/ignore)
 * - Counter-offer generation
 * - Ordered fill optimization
 *
 * Story 7.6: AI Trading Bot Launch Scripts
 * AC: 3, 4 - AI Price Negotiation
 */

import type { MarketScore } from "./market-selector";

/**
 * Negotiation thresholds in basis points (100 bps = 1%)
 */
export interface NegotiationConfig {
  /** Match if within this % of fair price (e.g., 50 = 0.5%) */
  acceptThresholdBps: number;
  /** Counter-propose if within this % (e.g., 200 = 2%) */
  counterThresholdBps: number;
  /** Ignore if beyond this % (e.g., 500 = 5%) */
  rejectThresholdBps: number;
  /** Max time to wait for counter-offers in seconds */
  negotiationTimeoutSecs: number;
  /** Max counter-offers before accepting/moving on */
  maxCounterAttempts: number;
  /** How often to check for new offers in ms */
  pollIntervalMs: number;
}

/**
 * Default negotiation configuration
 */
export const DEFAULT_NEGOTIATION_CONFIG: NegotiationConfig = {
  acceptThresholdBps: parseInt(process.env.ACCEPT_THRESHOLD_BPS || "50", 10),
  counterThresholdBps: parseInt(process.env.COUNTER_THRESHOLD_BPS || "200", 10),
  rejectThresholdBps: parseInt(process.env.REJECT_THRESHOLD_BPS || "500", 10),
  negotiationTimeoutSecs: parseInt(process.env.NEGOTIATION_TIMEOUT_SECS || "60", 10),
  maxCounterAttempts: parseInt(process.env.MAX_COUNTER_ATTEMPTS || "3", 10),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
};

/**
 * Portfolio position for a bet
 */
export interface PortfolioPosition {
  marketId: string;
  position: "YES" | "NO";
  weight: number; // 0-1, all weights sum to 1
}

/**
 * A complete portfolio bet
 */
export interface Portfolio {
  positions: PortfolioPosition[];
  createdAt: string;
}

/**
 * Pending bet from another bot
 */
export interface PendingBet {
  betId: string;
  creator: string;
  portfolio: Portfolio;
  amount: string; // USDC with 6 decimals
  remainingAmount: string;
  impliedRate: number; // 0-1, the implied YES probability
  createdAt: string;
}

/**
 * Evaluation action for an offer
 */
export type NegotiationAction = "ACCEPT" | "COUNTER" | "SWITCH" | "IGNORE";

/**
 * Result of evaluating an offer
 */
export interface OfferEvaluation {
  action: NegotiationAction;
  priceDiffBps: number;
  fairPrice: number;
  offeredPrice: number;
  reason: string;
}

/**
 * Fair price calculation result
 */
export interface FairPriceResult {
  fairYesPrice: number;
  confidence: number; // 0-1
  reasoning: string[];
}

/**
 * Calculate fair price for a market based on available data
 *
 * This is a simplified AI price estimation. In production,
 * this would integrate with Claude or other AI models.
 */
export function calculateFairPrice(market: MarketScore): FairPriceResult {
  const reasoning: string[] = [];

  // Start with market's current price as base
  let fairPrice = market.priceYes;
  let confidence = 0.5;

  // Adjust confidence based on market score
  // Higher scored markets = more reliable pricing
  if (market.score >= 70) {
    confidence = 0.8;
    reasoning.push("High-quality market with strong liquidity");
  } else if (market.score >= 50) {
    confidence = 0.6;
    reasoning.push("Good market with adequate liquidity");
  } else {
    confidence = 0.4;
    reasoning.push("Lower quality market, price less certain");
  }

  // Price uncertainty affects confidence
  // Markets near 50% are harder to predict
  const distanceFrom50 = Math.abs(market.priceYes - 0.5);
  if (distanceFrom50 < 0.1) {
    confidence *= 0.8;
    reasoning.push("High uncertainty market (near 50%)");
  } else if (distanceFrom50 > 0.3) {
    confidence *= 1.1;
    reasoning.push("Strong directional consensus");
  }

  // Cap confidence at 0.95
  confidence = Math.min(confidence, 0.95);

  reasoning.push(`Fair price: ${(fairPrice * 100).toFixed(1)}% (confidence: ${(confidence * 100).toFixed(0)}%)`);

  return {
    fairYesPrice: fairPrice,
    confidence,
    reasoning,
  };
}

/**
 * Calculate the implied rate from a portfolio
 *
 * The implied rate is the weighted average YES probability
 * across all positions in the portfolio.
 */
export function calculateImpliedRate(
  portfolio: Portfolio,
  marketPrices: Map<string, { priceYes: number; priceNo: number }>
): number {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const position of portfolio.positions) {
    const prices = marketPrices.get(position.marketId);
    if (!prices) continue;

    const positionValue = position.position === "YES" ? prices.priceYes : prices.priceNo;
    weightedSum += positionValue * position.weight;
    totalWeight += position.weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0.5;
}

/**
 * Evaluate an offer and decide action
 *
 * AC3, AC4: AI Price Negotiation
 */
export function evaluateOffer(
  bet: PendingBet,
  fairPrice: number,
  config: NegotiationConfig = DEFAULT_NEGOTIATION_CONFIG,
  hasActiveOffer: boolean = false
): OfferEvaluation {
  // Calculate price difference in basis points
  const priceDiff = Math.abs(bet.impliedRate - fairPrice);
  const priceDiffBps = Math.round(priceDiff * 10000);

  // ACCEPT: Rate is within acceptable threshold
  if (priceDiffBps <= config.acceptThresholdBps) {
    return {
      action: "ACCEPT",
      priceDiffBps,
      fairPrice,
      offeredPrice: bet.impliedRate,
      reason: `Price ${bet.impliedRate.toFixed(4)} is within ${config.acceptThresholdBps}bps of fair value ${fairPrice.toFixed(4)}`,
    };
  }

  // COUNTER: Rate is close but not ideal
  if (priceDiffBps <= config.counterThresholdBps) {
    return {
      action: "COUNTER",
      priceDiffBps,
      fairPrice,
      offeredPrice: bet.impliedRate,
      reason: `Price ${bet.impliedRate.toFixed(4)} is within ${config.counterThresholdBps}bps - will counter at better rate`,
    };
  }

  // SWITCH: Rate is acceptable but worse than ideal, and we have active offer
  // Cancel our offer and take theirs for ordered fill
  if (priceDiffBps <= config.rejectThresholdBps && hasActiveOffer) {
    return {
      action: "SWITCH",
      priceDiffBps,
      fairPrice,
      offeredPrice: bet.impliedRate,
      reason: `Price ${bet.impliedRate.toFixed(4)} is acceptable - switching from own offer for better fill`,
    };
  }

  // IGNORE: Rate is too far off
  return {
    action: "IGNORE",
    priceDiffBps,
    fairPrice,
    offeredPrice: bet.impliedRate,
    reason: `Price ${bet.impliedRate.toFixed(4)} is beyond ${config.rejectThresholdBps}bps threshold`,
  };
}

/**
 * Generate a counter-offer rate
 *
 * Moves from current offer toward fair price by a portion
 */
export function generateCounterRate(
  currentRate: number,
  fairPrice: number,
  attemptNumber: number,
  maxAttempts: number
): number {
  // Each attempt, move closer to the other's offer
  // First attempt: 75% toward fair price
  // Last attempt: 25% toward fair price (more willing to compromise)
  const compromiseFactor = 0.75 - (0.5 * (attemptNumber - 1) / Math.max(maxAttempts - 1, 1));

  const counterRate = currentRate + (fairPrice - currentRate) * compromiseFactor;

  // Ensure rate is valid (0-1)
  return Math.max(0.01, Math.min(0.99, counterRate));
}

/**
 * Create a random portfolio from selected markets
 *
 * Used for initial bet placement by bots
 */
export function createRandomPortfolio(
  markets: MarketScore[],
  positionCount: number = 5
): Portfolio {
  // Select random subset of markets
  const shuffled = [...markets].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(positionCount, markets.length));

  // Create positions with random YES/NO and equal weights
  const weight = 1 / selected.length;
  const positions: PortfolioPosition[] = selected.map((market) => ({
    marketId: market.marketId,
    position: Math.random() > 0.5 ? "YES" : "NO",
    weight,
  }));

  return {
    positions,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create a counter-portfolio (opposite positions)
 *
 * For counter-trading, take opposite side of each position
 */
export function createCounterPortfolio(portfolio: Portfolio): Portfolio {
  const positions: PortfolioPosition[] = portfolio.positions.map((pos) => ({
    marketId: pos.marketId,
    position: pos.position === "YES" ? "NO" : "YES",
    weight: pos.weight,
  }));

  return {
    positions,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Calculate expected portfolio score
 *
 * Used to determine which side wins at resolution
 */
export function calculatePortfolioScore(
  portfolio: Portfolio,
  startPrices: Map<string, number>,
  endPrices: Map<string, number>
): number {
  let score = 0;

  for (const position of portfolio.positions) {
    const startPrice = startPrices.get(position.marketId) ?? 0.5;
    const endPrice = endPrices.get(position.marketId) ?? 0.5;

    const priceChange = endPrice - startPrice;
    const positionMultiplier = position.position === "YES" ? 1 : -1;

    score += priceChange * positionMultiplier * position.weight;
  }

  return score;
}

/**
 * Calculate portfolio hash for on-chain commitment
 */
export function calculatePortfolioHash(portfolio: Portfolio): string {
  const json = JSON.stringify(portfolio);
  // Use Bun's native crypto for keccak256
  const hash = new Bun.CryptoHasher("sha3-256");
  hash.update(json);
  return "0x" + hash.digest("hex");
}

/**
 * Serialize portfolio to JSON string
 */
export function serializePortfolio(portfolio: Portfolio): string {
  return JSON.stringify(portfolio);
}

/**
 * Parse portfolio from JSON string
 */
export function parsePortfolio(json: string): Portfolio {
  return JSON.parse(json) as Portfolio;
}

/**
 * Risk profile for odds calculation
 */
export type OddsRiskProfile = "conservative" | "balanced" | "aggressive";

/**
 * Calculate optimal odds based on market prices and risk profile
 *
 * The odds represent the multiplier for the creator's stake:
 * - If creator stakes $100 at 2.00x odds, matcher stakes $50
 * - Creator wins: gets $150 (their $100 + matcher's $50)
 * - Matcher wins: gets $150 (their $50 + creator's $100) = 3x return
 *
 * @param marketPrice - Average market price (0.0 to 1.0) representing YES probability
 * @param position - Whether creator is betting YES or NO
 * @param riskProfile - Risk tolerance level
 * @returns oddsBps - Odds in basis points (10000 = 1.00x)
 */
export function calculateOptimalOdds(
  marketPrice: number,
  position: "YES" | "NO",
  riskProfile: OddsRiskProfile = "balanced"
): number {
  // Convert market price to implied probability for the creator's position
  // If betting YES on a 70% YES market, creator's implied prob is 70%
  // If betting NO on a 70% YES market, creator's implied prob is 30%
  const impliedProb = position === "YES" ? marketPrice : 1 - marketPrice;

  // Clamp implied probability to avoid division issues
  const clampedProb = Math.max(0.1, Math.min(0.9, impliedProb));

  // Base odds from implied probability
  // Higher implied prob -> higher odds (creator expects to win more often)
  // impliedProb = 0.7 -> base odds = 1 / (1 - 0.7) = 3.33x
  // impliedProb = 0.5 -> base odds = 1 / (1 - 0.5) = 2.0x
  // impliedProb = 0.3 -> base odds = 1 / (1 - 0.3) = 1.43x
  const baseOddsMultiplier = 1 / (1 - clampedProb);
  let baseOddsBps = Math.round(baseOddsMultiplier * 10000);

  // Apply risk adjustment
  // Conservative: Offer slightly worse odds for creator (lower oddsBps = higher matcher return)
  // Aggressive: Offer slightly better odds for creator (higher oddsBps = lower matcher return)
  const adjustments: Record<OddsRiskProfile, number> = {
    conservative: 0.85, // Offer 15% worse odds (more attractive to matchers)
    balanced: 1.0,      // Fair odds
    aggressive: 1.15,   // Offer 15% better odds (less attractive to matchers)
  };

  baseOddsBps = Math.round(baseOddsBps * adjustments[riskProfile]);

  // Clamp to valid range
  // Min: 5000 (0.5x) - creator risks 2x what they could win
  // Max: 30000 (3.0x) - creator could win 3x their stake
  return Math.max(5000, Math.min(30000, baseOddsBps));
}
