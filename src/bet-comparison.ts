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
