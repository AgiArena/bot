#!/bin/bash
# review-bets.sh - Review top EV opportunities from open bets
#
# Usage: bash scripts/review-bets.sh [top_n]
#
# This script:
# 1. Ensures portfolio scores exist (runs aggregate-scores.sh if needed)
# 2. Fetches open bets from backend
# 3. Compares each bet against agent's portfolio
# 4. Sorts by EV score and presents top N opportunities
# 5. Outputs structured JSON for agent decision making
#
# Parameters:
#   top_n - Number of top opportunities to show (default: 3)
#
# Output: JSON array of top comparison results sorted by EV score
#
# Environment variables:
#   API_BASE_URL - Backend API URL (default: http://localhost:3001)
#   API_MAX_RETRIES - Max retry attempts (default: 3)
#   API_BASE_BACKOFF_MS - Base backoff in ms (default: 1000)

set -e

# Parameters
TOP_N="${1:-3}"

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BOT_DIR="$(cd "${AGENT_DIR}/.." && pwd)"

# Files
PORTFOLIO_SCORES="${AGENT_DIR}/portfolio-scores.json"
OPEN_BETS="${AGENT_DIR}/open-bets.json"
COMPARISON_RESULTS="${AGENT_DIR}/comparison-results.json"
TOP_OPPORTUNITIES="${AGENT_DIR}/top-opportunities.json"

# API Configuration
export API_BASE_URL="${API_BASE_URL:-http://localhost:3001}"
export API_MAX_RETRIES="${API_MAX_RETRIES:-3}"
export API_BASE_BACKOFF_MS="${API_BASE_BACKOFF_MS:-1000}"

echo "=== AgiArena Bet Review ==="
echo "Reviewing top ${TOP_N} EV opportunities"
echo ""

# Step 1: Ensure portfolio scores exist
if [ ! -f "${PORTFOLIO_SCORES}" ]; then
  echo "Portfolio scores not found. Running aggregation first..."
  bash "${SCRIPT_DIR}/aggregate-scores.sh"
  echo ""
fi

if [ ! -f "${PORTFOLIO_SCORES}" ]; then
  echo "ERROR: Failed to generate portfolio scores"
  exit 1
fi

# Step 2: Fetch open bets
echo "Fetching open bets..."
cd "${BOT_DIR}"
bun run src/cli/fetch-open-bets-cli.ts "${OPEN_BETS}" "${API_BASE_URL}"
echo ""

# Step 3: Compare each bet and collect results
echo "Comparing bets against portfolio..."

# Read open bets and run comparisons
bun run -e "
import type { AggregatedPortfolio } from './src/score-aggregation';
import { compareBet } from './src/bet-comparison';
import type { BetPosition, ComparisonResult } from './src/bet-comparison';

const openBetsPath = '${OPEN_BETS}';
const portfolioPath = '${PORTFOLIO_SCORES}';
const resultsPath = '${COMPARISON_RESULTS}';
const topPath = '${TOP_OPPORTUNITIES}';
const topN = ${TOP_N};
const apiBaseUrl = '${API_BASE_URL}';
const maxRetries = parseInt('${API_MAX_RETRIES}', 10);
const baseBackoffMs = parseInt('${API_BASE_BACKOFF_MS}', 10);

interface Bet {
  betId: string;
  creatorAddress: string;
  portfolioSize: number;
  amount: string;
  status: string;
}

interface OpenBetsFile {
  bets: Bet[];
  metadata: {
    totalBets: number;
    fetchedAt: string;
  };
}

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

async function fetchBetPositions(betId: string): Promise<BetPosition[]> {
  const allPositions: BetPosition[] = [];
  let page = 1;
  let hasMore = true;
  const limit = 1000;

  while (hasMore) {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const url = \`\${apiBaseUrl}/api/bets/\${betId}/portfolio?page=\${page}&limit=\${limit}\`;
        const response = await fetch(url, {
          headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
          if (response.status === 404) {
            return []; // Bet not found, skip
          }
          throw new Error(\`API error: \${response.status}\`);
        }

        const data: APIPositionResponse = await response.json();
        allPositions.push(...data.positions);
        hasMore = data.pagination.hasMore;
        page++;
        break;

      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt - 1) * baseBackoffMs;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (lastError) {
      console.error(\`Failed to fetch positions for bet \${betId}: \${lastError.message}\`);
      return [];
    }
  }

  return allPositions;
}

async function main() {
  // Load data
  const openBetsFile: OpenBetsFile = await Bun.file(openBetsPath).json();
  const portfolio: AggregatedPortfolio = await Bun.file(portfolioPath).json();

  const results: ComparisonResult[] = [];
  const totalBets = openBetsFile.bets.length;

  console.log(\`Found \${totalBets} open bets to compare\`);

  for (let i = 0; i < totalBets; i++) {
    const bet = openBetsFile.bets[i];
    console.log(\`  Comparing bet \${i + 1}/\${totalBets}: \${bet.betId.substring(0, 10)}...\`);

    const positions = await fetchBetPositions(bet.betId);

    if (positions.length === 0) {
      console.log(\`    Skipped - no positions\`);
      continue;
    }

    const result = compareBet(bet.betId, portfolio, positions);
    results.push(result);

    console.log(\`    EV: \${result.evScore.toFixed(2)}, Recommendation: \${result.recommendedAction}\`);
  }

  // Sort by EV score descending
  results.sort((a, b) => b.evScore - a.evScore);

  // Save all results
  await Bun.write(resultsPath, JSON.stringify(results, null, 2));

  // Extract top N
  const topOpportunities = results.slice(0, topN);

  // Format output for agent consumption
  const output = {
    timestamp: new Date().toISOString(),
    totalBetsAnalyzed: totalBets,
    totalComparisons: results.length,
    topN: topN,
    opportunities: topOpportunities.map((r, idx) => ({
      rank: idx + 1,
      betId: r.betId,
      evScore: r.evScore,
      recommendedAction: r.recommendedAction,
      confidence: r.confidence,
      reasoning: r.reasoning,
      matchingMarkets: r.details.matchingMarkets,
      totalMarkets: r.details.totalMarkets
    }))
  };

  await Bun.write(topPath, JSON.stringify(output, null, 2));

  // Print summary
  console.log('');
  console.log('=== Top ' + topN + ' EV Opportunities ===');
  console.log('');

  if (topOpportunities.length === 0) {
    console.log('No opportunities found.');
  } else {
    for (const opp of output.opportunities) {
      console.log(\`#\${opp.rank}: Bet \${opp.betId.substring(0, 16)}...\`);
      console.log(\`    EV Score: \${opp.evScore.toFixed(2)}\`);
      console.log(\`    Recommendation: \${opp.recommendedAction}\`);
      console.log(\`    Confidence: \${(opp.confidence * 100).toFixed(0)}%\`);
      console.log(\`    Markets: \${opp.matchingMarkets}/\${opp.totalMarkets} overlap\`);
      console.log('');
    }
  }

  console.log('Full results saved to:', resultsPath);
  console.log('Top opportunities saved to:', topPath);
}

main();
"

echo ""
echo "=== Review Complete ==="
echo "Agent should review: ${TOP_OPPORTUNITIES}"
echo ""
