#!/usr/bin/env bun
/**
 * CLI entry point for bet matching state management
 * This CLI handles the TypeScript portions of bet matching:
 * - Loading/saving trade state
 * - Calculating fill amounts
 * - Logging transactions
 * - Uploading counter-scores
 *
 * Usage modes:
 *   bun run src/cli/match-bet-cli.ts calculate-fill <capital> <risk_profile> <bet_remaining>
 *   bun run src/cli/match-bet-cli.ts record-match <state_path> <match_json>
 *   bun run src/cli/match-bet-cli.ts log-transaction <log_path> <bet_id> <amount> <tx_hash> <gas_used> <gas_cost_usd> <status> [error]
 *   bun run src/cli/match-bet-cli.ts upload-scores <api_url> <bet_id> <agent_address> <portfolio_path> <ev_score>
 */

import {
  calculateFillAmount,
  formatUSDCAmount,
  addMatchedBet,
  logTransaction,
  type MatchedBet,
  type RiskProfile,
  type CounterScoresPayload
} from "../bet-matching";
import type { AggregatedPortfolio } from "../score-aggregation";

// Retry configuration
const MAX_RETRIES = parseInt(process.env.API_MAX_RETRIES || "3", 10);
const BASE_BACKOFF_MS = parseInt(process.env.API_BASE_BACKOFF_MS || "1000", 10);

/**
 * Calculate fill amount based on risk profile
 */
function handleCalculateFill(args: string[]): void {
  if (args.length < 3) {
    console.error("Usage: calculate-fill <capital> <risk_profile> <bet_remaining>");
    process.exit(1);
  }

  const capital = parseFloat(args[0]);
  const riskProfile = args[1] as RiskProfile;
  const betRemaining = args[2];

  if (!["conservative", "balanced", "aggressive"].includes(riskProfile)) {
    console.error(`Invalid risk profile: ${riskProfile}. Must be conservative, balanced, or aggressive.`);
    process.exit(1);
  }

  const fillAmountBaseUnits = calculateFillAmount(capital, riskProfile, betRemaining);
  const fillAmountFormatted = formatUSDCAmount(fillAmountBaseUnits);

  console.log(JSON.stringify({
    fillAmountBaseUnits,
    fillAmountFormatted,
    capital,
    riskProfile,
    betRemaining
  }));
}

/**
 * Record a completed match to state
 */
function handleRecordMatch(args: string[]): void {
  if (args.length < 2) {
    console.error("Usage: record-match <state_path> <match_json>");
    process.exit(1);
  }

  const statePath = args[0];
  const matchJson = args[1];

  try {
    const matchedBet: MatchedBet = JSON.parse(matchJson);
    const updatedState = addMatchedBet(statePath, matchedBet);

    console.log(JSON.stringify({
      success: true,
      totalMatchedBets: updatedState.matchedBets.length,
      totalMatchedAmount: updatedState.totalMatchedAmount,
      lastMatchedAt: updatedState.lastMatchedAt
    }));
  } catch (error) {
    console.error(JSON.stringify({
      success: false,
      error: `Failed to record match: ${(error as Error).message}`
    }));
    process.exit(1);
  }
}

/**
 * Log a transaction to the transaction log
 */
function handleLogTransaction(args: string[]): void {
  if (args.length < 7) {
    console.error("Usage: log-transaction <log_path> <bet_id> <amount> <tx_hash> <gas_used> <gas_cost_usd> <status> [error]");
    process.exit(1);
  }

  const logPath = args[0];
  const betId = args[1];
  const amount = args[2];
  const txHash = args[3] === "null" || args[3] === "none" ? null : args[3];
  const gasUsed = args[4];
  const gasCostUSD = args[5];
  const status = args[6] as "SUCCESS" | "FAILED";
  const error = args[7];

  try {
    logTransaction(logPath, betId, amount, txHash, gasUsed, gasCostUSD, status, error);
    console.log(JSON.stringify({ success: true, logged: true }));
  } catch (err) {
    console.error(JSON.stringify({
      success: false,
      error: `Failed to log transaction: ${(err as Error).message}`
    }));
    process.exit(1);
  }
}

/**
 * Upload counter-scores to backend API
 */
async function handleUploadScores(args: string[]): Promise<void> {
  if (args.length < 5) {
    console.error("Usage: upload-scores <api_url> <bet_id> <agent_address> <portfolio_path> <ev_score>");
    process.exit(1);
  }

  const apiUrl = args[0];
  const betId = args[1];
  const agentAddress = args[2];
  const portfolioPath = args[3];
  const evScore = parseFloat(args[4]);

  try {
    // Load portfolio scores
    const portfolioFile = Bun.file(portfolioPath);
    if (!(await portfolioFile.exists())) {
      console.log(JSON.stringify({
        success: false,
        warning: "Portfolio scores file not found - skipping counter-scores upload"
      }));
      return;
    }

    const portfolio: AggregatedPortfolio = await portfolioFile.json();

    // Transform portfolio to counter-scores format
    const counterScores: Record<string, { score: number; position: number }> = {};
    for (const [marketId, data] of Object.entries(portfolio)) {
      counterScores[marketId] = {
        score: data.score,
        position: data.position
      };
    }

    // Build payload
    const payload: CounterScoresPayload = {
      betId,
      counterParty: agentAddress,
      counterScores,
      evScore,
      matchedAt: new Date().toISOString()
    };

    // Upload with retries
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(`${apiUrl}/api/bets/${betId}/counter-scores`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        console.log(JSON.stringify({
          success: true,
          message: "Counter-scores uploaded successfully",
          marketCount: Object.keys(counterScores).length
        }));
        return;

      } catch (error) {
        lastError = error as Error;
        if (attempt < MAX_RETRIES) {
          const delay = Math.pow(2, attempt - 1) * BASE_BACKOFF_MS;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // Failed after all retries - log warning but don't fail
    console.log(JSON.stringify({
      success: false,
      warning: `Counter-scores upload failed after ${MAX_RETRIES} attempts: ${lastError?.message}`,
      message: "Bet matching succeeded but counter-scores upload failed"
    }));

  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      warning: `Counter-scores upload error: ${(error as Error).message}`,
      message: "Bet matching succeeded but counter-scores upload failed"
    }));
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error("Usage: match-bet-cli.ts <command> [args...]");
    console.error("Commands: calculate-fill, record-match, log-transaction, upload-scores");
    process.exit(1);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  switch (command) {
    case "calculate-fill":
      handleCalculateFill(commandArgs);
      break;

    case "record-match":
      handleRecordMatch(commandArgs);
      break;

    case "log-transaction":
      handleLogTransaction(commandArgs);
      break;

    case "upload-scores":
      await handleUploadScores(commandArgs);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Commands: calculate-fill, record-match, log-transaction, upload-scores");
      process.exit(1);
  }
}

main();
