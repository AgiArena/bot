#!/usr/bin/env bun
/**
 * CLI entry point for bet comparison
 * Usage: bun run src/cli/compare-bet-cli.ts <bet_id> <portfolio_path> [api_base_url]
 */

import { compareBet, formatComparisonResult } from "../bet-comparison";
import type { AggregatedPortfolio } from "../score-aggregation";
import type { BetPosition } from "../bet-comparison";

// Retry configuration from environment variables
const MAX_RETRIES = parseInt(process.env.API_MAX_RETRIES || "3", 10);
const BASE_BACKOFF_MS = parseInt(process.env.API_BASE_BACKOFF_MS || "1000", 10);

interface APIPositionResponse {
  betId: string;
  portfolioSize: number;
  positions: BetPosition[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

/**
 * Fetch all positions for a bet with pagination
 */
async function fetchBetPositions(betId: string, apiBaseUrl: string): Promise<BetPosition[]> {
  const allPositions: BetPosition[] = [];
  let page = 1;
  let hasMore = true;
  const limit = 1000; // API returns 1000 positions per page

  while (hasMore) {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const url = `${apiBaseUrl}/api/bets/${betId}/portfolio?page=${page}&limit=${limit}`;
        const response = await fetch(url, {
          headers: {
            "Accept": "application/json"
          }
        });

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error(`Bet ${betId} not found`);
          }
          throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        const data: APIPositionResponse = await response.json();

        allPositions.push(...data.positions);
        hasMore = data.pagination.hasMore;
        page++;
        lastError = null;
        break; // Success, exit retry loop

      } catch (error) {
        lastError = error as Error;
        if (attempt < MAX_RETRIES) {
          // Exponential backoff using configurable base
          const delay = Math.pow(2, attempt - 1) * BASE_BACKOFF_MS;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  return allPositions;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: bun run compare-bet-cli.ts <bet_id> <portfolio_path> [api_base_url]");
    process.exit(1);
  }

  const betId = args[0];
  const portfolioScoresPath = args[1];
  const apiBaseUrl = args[2] || process.env.API_BASE_URL || "http://localhost:3001";

  try {
    // Load our portfolio scores
    const portfolioFile = Bun.file(portfolioScoresPath);
    if (!(await portfolioFile.exists())) {
      console.log(JSON.stringify({
        betId,
        error: "portfolio-scores.json not found. Run aggregate-scores.sh first.",
        evScore: 0,
        recommendedAction: "SKIP",
        confidence: 0,
        reasoning: "Cannot compare - portfolio scores not available"
      }, null, 2));
      process.exit(1);
    }

    const ourPortfolio: AggregatedPortfolio = await portfolioFile.json();

    // Fetch bet positions from API
    let betPositions: BetPosition[];
    try {
      betPositions = await fetchBetPositions(betId, apiBaseUrl);
    } catch (error) {
      console.log(JSON.stringify({
        betId,
        error: `Failed to fetch bet: ${(error as Error).message}`,
        evScore: 0,
        recommendedAction: "SKIP",
        confidence: 0,
        reasoning: "Cannot compare - failed to fetch bet positions from API"
      }, null, 2));
      process.exit(1);
    }

    if (betPositions.length === 0) {
      console.log(JSON.stringify({
        betId,
        evScore: 0,
        recommendedAction: "SKIP",
        confidence: 0,
        reasoning: "Bet has no positions uploaded yet"
      }, null, 2));
      process.exit(0);
    }

    // Run comparison
    const result = compareBet(betId, ourPortfolio, betPositions);

    // Output result as JSON
    console.log(formatComparisonResult(result));

  } catch (error) {
    console.error(JSON.stringify({
      betId,
      error: `Comparison failed: ${(error as Error).message}`,
      evScore: 0,
      recommendedAction: "SKIP",
      confidence: 0,
      reasoning: "Comparison error occurred"
    }, null, 2));
    process.exit(1);
  }
}

main();
