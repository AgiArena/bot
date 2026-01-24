import type { AggregatedPortfolio } from "./score-aggregation";

/**
 * Bet position from backend API
 */
export interface BetPosition {
  marketId: string;
  position: "YES" | "NO";
  startingPrice: string;
  endingPrice: string | null;
}

/**
 * Result of odds-adjusted EV calculation
 *
 * With asymmetric odds, matcher needs different edge to profit.
 * Example: At 2.00x odds (oddsBps = 20000, matcher risks $50 to win $150):
 * - Matcher only needs >33% win probability to be +EV
 * - Standard 1.00x requires >50%
 */
export interface OddsAdjustedEV {
  /** Base EV without odds consideration */
  rawEV: number;
  /** Decimal odds (2.0 = 2.00x) */
  oddsDecimal: number;
  /** How odds affect EV (>1 = favorable for matcher) */
  oddsMultiplier: number;
  /** Final EV considering odds adjustment */
  adjustedEV: number;
  /** Minimum edge needed given odds (negative = favorable) */
  requiredEdge: number;
  /** Recommendation based on adjusted EV and dynamic thresholds */
  recommendation: Recommendation;
}

/**
 * Result of matcher return calculation
 */
export interface MatcherReturnResult {
  /** Total return multiplier for matcher (e.g., 3.0 at 2.0x odds) */
  matcherReturn: number;
  /** Win probability needed to break even (e.g., 0.333 at 2.0x odds) */
  impliedProbNeeded: number;
}

// ============================================================================
// ODDS CONVERSION FUNCTIONS
// ============================================================================

/**
 * Convert basis points to decimal odds
 *
 * @param bps - Odds in basis points (10000 = 1.0, 20000 = 2.0)
 * @returns Decimal odds
 * @throws Error if bps is <= 0
 *
 * @example
 * bpsToDecimal(10000) // => 1.0
 * bpsToDecimal(20000) // => 2.0
 * bpsToDecimal(5000)  // => 0.5
 */
export function bpsToDecimal(bps: number): number {
  if (bps <= 0) {
    throw new Error(`Invalid oddsBps: ${bps}. Must be greater than 0.`);
  }
  return bps / 10000;
}

/**
 * Convert decimal odds to basis points
 *
 * @param decimal - Decimal odds (1.0 = fair, 2.0 = 2x)
 * @returns Odds in basis points
 * @throws Error if decimal is <= 0
 *
 * @example
 * decimalToBps(1.0) // => 10000
 * decimalToBps(2.0) // => 20000
 * decimalToBps(0.5) // => 5000
 */
export function decimalToBps(decimal: number): number {
  if (decimal <= 0) {
    throw new Error(`Invalid decimal odds: ${decimal}. Must be greater than 0.`);
  }
  return Math.round(decimal * 10000);
}

/**
 * Calculate matcher return multiplier and implied probability
 *
 * At different odds, matcher gets different returns:
 * - 1.0x odds: matcher risks $100 to win $100, return = 2x (needs 50% to break even)
 * - 2.0x odds: matcher risks $50 to win $150, return = 3x (needs 33% to break even)
 * - 0.5x odds: matcher risks $200 to win $100, return = 1.5x (needs 67% to break even)
 *
 * @param oddsDecimal - Decimal odds
 * @returns Matcher return and implied probability needed
 */
export function calculateMatcherReturn(oddsDecimal: number): MatcherReturnResult {
  // matcherReturn = oddsDecimal + 1
  // At 2.0x: matcher risks 0.5 units, wins 1.5 units total = 3x return
  const matcherReturn = oddsDecimal + 1;

  // Implied probability to break even = 1 / matcherReturn
  const impliedProbNeeded = 1 / matcherReturn;

  return {
    matcherReturn,
    impliedProbNeeded
  };
}

/**
 * Get odds-adjusted recommendation with dynamic thresholds
 *
 * With favorable odds (>1 multiplier), lower thresholds are needed.
 * With unfavorable odds (<1 multiplier), higher thresholds are needed.
 *
 * Standard thresholds at 1.0x odds:
 * - STRONG_MATCH: > 15
 * - MATCH: >= 10
 * - CONSIDER: >= 5
 * - LEAN_SKIP: > 0
 * - SKIP: <= 0
 *
 * @param adjustedEV - The odds-adjusted EV
 * @param oddsMultiplier - How favorable the odds are (>1 = favorable)
 * @returns Recommendation level
 */
export function getOddsAdjustedRecommendation(
  adjustedEV: number,
  oddsMultiplier: number
): Recommendation {
  // Adjust thresholds based on odds favorability
  // Favorable odds (high multiplier) → lower thresholds
  // Unfavorable odds (low multiplier) → higher thresholds
  const threshold = {
    strongMatch: 15 / oddsMultiplier,
    match: 10 / oddsMultiplier,
    consider: 5 / oddsMultiplier,
  };

  if (adjustedEV > threshold.strongMatch) return "STRONG_MATCH";
  if (adjustedEV >= threshold.match) return "MATCH";
  if (adjustedEV >= threshold.consider) return "CONSIDER";
  if (adjustedEV > 0) return "LEAN_SKIP";
  return "SKIP";
}

/**
 * Calculate EV adjusted for bet odds
 *
 * With asymmetric odds, matcher needs less edge to profit at favorable odds.
 *
 * @param ourPortfolio - Our aggregated portfolio scores
 * @param betPositions - The bet's positions to compare against
 * @param oddsBps - Odds in basis points (10000 = 1.0x, 20000 = 2.0x)
 * @returns Odds-adjusted EV result
 *
 * @example
 * // At 2.00x odds (favorable for matcher):
 * // - Raw EV: +10%
 * // - Odds multiplier: 1.5 (favorable)
 * // - Adjusted EV: +15%
 * // - Required edge: -16.7% (negative = favorable)
 */
export function calculateOddsAdjustedEV(
  ourPortfolio: AggregatedPortfolio,
  betPositions: BetPosition[],
  oddsBps: number
): OddsAdjustedEV {
  // Base EV calculation (unchanged)
  const baseResult = calculateEV(ourPortfolio, betPositions);
  const rawEV = baseResult.weightedEV;

  // Convert basis points to decimal (20000 -> 2.0)
  const oddsDecimal = bpsToDecimal(oddsBps);

  // Calculate matcher return multiplier
  const { impliedProbNeeded } = calculateMatcherReturn(oddsDecimal);

  // Odds multiplier: how much the odds favor the matcher
  // At fair odds (1.00x), this equals 1.0
  // At favorable odds (2.00x), matcher only needs 33% to break even vs 50%
  const fairProbNeeded = 0.5;
  const oddsMultiplier = fairProbNeeded / impliedProbNeeded;

  // Adjusted EV: our edge * how much odds favor us
  const adjustedEV = rawEV * oddsMultiplier;

  // Required edge at these odds (lower for favorable odds)
  // Negative value means odds are favorable (need less edge)
  const requiredEdge = (impliedProbNeeded - 0.5) * 100;

  // Adjust recommendation thresholds based on odds
  const recommendation = getOddsAdjustedRecommendation(adjustedEV, oddsMultiplier);

  return {
    rawEV,
    oddsDecimal,
    oddsMultiplier: Math.round(oddsMultiplier * 100) / 100,
    adjustedEV: Math.round(adjustedEV * 100) / 100,
    requiredEdge: Math.round(requiredEdge * 100) / 100,
    recommendation
  };
}

/**
 * Result of EV calculation
 */
export interface EVResult {
  rawEV: number;
  weightedEV: number;
  matchingMarkets: number;
  totalBetMarkets: number;
  deltas: number[];
}

/**
 * Recommendation levels based on EV thresholds
 */
export type Recommendation = "STRONG_MATCH" | "MATCH" | "CONSIDER" | "LEAN_SKIP" | "SKIP";

/**
 * Full comparison result for a bet
 */
export interface ComparisonResult {
  betId: string;
  evScore: number;
  recommendedAction: Recommendation;
  confidence: number;
  reasoning: string;
  details: {
    totalMarkets: number;
    matchingMarkets: number;
    averageDelta: number;
  };
}

/**
 * Calculate Expected Value (EV) for comparing our portfolio against a bet's positions
 *
 * EV Formula:
 * - If our score > 50 (we're YES) and bet is NO: delta = our_score - 50
 * - If our score < 50 (we're NO) and bet is YES: delta = 50 - our_score
 * - If positions match: delta = 0 (no edge)
 *
 * @param ourPortfolio - Our aggregated portfolio scores
 * @param betPositions - The bet's positions to compare against
 * @returns EV calculation result
 */
export function calculateEV(
  ourPortfolio: AggregatedPortfolio,
  betPositions: BetPosition[]
): EVResult {
  const deltas: number[] = [];
  let weightedDeltaSum = 0;
  let totalConfidence = 0;
  let matchingMarkets = 0;

  for (const betPosition of betPositions) {
    const ourScore = ourPortfolio[betPosition.marketId];

    // Skip markets we don't have scores for
    if (!ourScore) {
      continue;
    }

    matchingMarkets++;

    // Convert bet position to numeric (YES=1, NO=0)
    const betPositionNum = betPosition.position === "YES" ? 1 : 0;

    // Calculate delta based on whether positions differ
    let delta: number;

    if (ourScore.position === betPositionNum) {
      // Positions match - no edge
      delta = 0;
    } else if (ourScore.position === 1 && betPositionNum === 0) {
      // We're YES (score >= 50), bet is NO - we have edge if we're confident
      delta = ourScore.score - 50;
    } else {
      // We're NO (score < 50), bet is YES - we have edge if we're confident
      delta = 50 - ourScore.score;
    }

    deltas.push(delta);
    weightedDeltaSum += delta * ourScore.confidence;
    totalConfidence += ourScore.confidence;
  }

  // Calculate raw (unweighted) EV
  const rawEV = deltas.length > 0
    ? deltas.reduce((sum, d) => sum + d, 0) / deltas.length
    : 0;

  // Calculate confidence-weighted EV
  const weightedEV = totalConfidence > 0
    ? weightedDeltaSum / totalConfidence
    : 0;

  return {
    rawEV: Math.round(rawEV * 100) / 100,
    weightedEV: Math.round(weightedEV * 100) / 100,
    matchingMarkets,
    totalBetMarkets: betPositions.length,
    deltas
  };
}

/**
 * Get recommendation based on EV score
 *
 * Thresholds from acceptance criteria:
 * - > 15: STRONG_MATCH - All profiles proceed
 * - 10-15: MATCH - Aggressive proceeds, others review
 * - 5-10: CONSIDER - Agent makes judgment call
 * - 0-5: LEAN_SKIP - Only aggressive might proceed
 * - <= 0: SKIP - Negative edge, always skip
 */
export function getRecommendation(evScore: number): Recommendation {
  if (evScore > 15) {
    return "STRONG_MATCH";
  } else if (evScore >= 10) {
    return "MATCH";
  } else if (evScore >= 5) {
    return "CONSIDER";
  } else if (evScore > 0) {
    return "LEAN_SKIP";
  } else {
    return "SKIP";
  }
}

/**
 * Generate human-readable reasoning for the comparison result
 */
export function generateReasoning(
  evScore: number,
  totalMarkets: number,
  matchingMarkets: number,
  recommendation: Recommendation
): string {
  if (matchingMarkets === 0) {
    return "No overlapping markets between our portfolio and the bet. Cannot calculate edge.";
  }

  const coverage = Math.round((matchingMarkets / totalMarkets) * 100);

  switch (recommendation) {
    case "STRONG_MATCH":
      return `Strong edge detected on ${matchingMarkets} of ${totalMarkets} markets (${coverage}% coverage). EV ${evScore.toFixed(1)} indicates high profit potential.`;

    case "MATCH":
      return `Good edge detected on ${matchingMarkets} of ${totalMarkets} markets (${coverage}% coverage). EV ${evScore.toFixed(1)} suggests profitable opportunity.`;

    case "CONSIDER":
      return `Moderate edge on ${matchingMarkets} of ${totalMarkets} markets (${coverage}% coverage). EV ${evScore.toFixed(1)} - recommend manual review based on risk tolerance.`;

    case "LEAN_SKIP":
      return `Low edge on ${matchingMarkets} of ${totalMarkets} markets (${coverage}% coverage). EV ${evScore.toFixed(1)} - only aggressive profiles should consider.`;

    case "SKIP":
      return evScore < 0
        ? `Negative edge (EV ${evScore.toFixed(1)}) - positions are unfavorable. Skip recommended.`
        : `Zero or minimal edge on ${matchingMarkets} of ${totalMarkets} markets. No profitable opportunity detected.`;
  }
}

/**
 * Compare a bet against our portfolio and generate full comparison result
 */
export function compareBet(
  betId: string,
  ourPortfolio: AggregatedPortfolio,
  betPositions: BetPosition[]
): ComparisonResult {
  // Calculate EV
  const evResult = calculateEV(ourPortfolio, betPositions);

  // Use weighted EV for final decision (rewards higher confidence scores)
  const evScore = evResult.weightedEV;

  // Get recommendation
  const recommendedAction = getRecommendation(evScore);

  // Calculate average confidence across matching markets
  let totalConfidence = 0;
  let matchingConfidenceCount = 0;

  for (const position of betPositions) {
    const ourScore = ourPortfolio[position.marketId];
    if (ourScore) {
      totalConfidence += ourScore.confidence;
      matchingConfidenceCount++;
    }
  }

  const confidence = matchingConfidenceCount > 0
    ? Math.round((totalConfidence / matchingConfidenceCount) * 100) / 100
    : 0;

  // Generate reasoning
  const reasoning = generateReasoning(
    evScore,
    betPositions.length,
    evResult.matchingMarkets,
    recommendedAction
  );

  // Calculate average delta
  const averageDelta = evResult.deltas.length > 0
    ? Math.round((evResult.deltas.reduce((a, b) => a + b, 0) / evResult.deltas.length) * 100) / 100
    : 0;

  return {
    betId,
    evScore,
    recommendedAction,
    confidence,
    reasoning,
    details: {
      totalMarkets: betPositions.length,
      matchingMarkets: evResult.matchingMarkets,
      averageDelta
    }
  };
}

/**
 * Format comparison result as JSON for shell script output
 */
export function formatComparisonResult(result: ComparisonResult): string {
  return JSON.stringify({
    betId: result.betId,
    evScore: result.evScore,
    recommendedAction: result.recommendedAction,
    confidence: result.confidence,
    reasoning: result.reasoning
  }, null, 2);
}
