#!/usr/bin/env bun
/**
 * CLI entry point for score aggregation
 * Usage: bun run src/cli/aggregate-scores-cli.ts <research_dir> <portfolio_output> <myportfolio_output>
 */

import { aggregateScores, writePortfolioScores, writeMyPortfolio } from "../score-aggregation";

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error("Usage: bun run aggregate-scores-cli.ts <research_dir> <portfolio_output> <myportfolio_output>");
    process.exit(1);
  }

  const [researchDir, portfolioScoresPath, myPortfolioPath] = args;

  console.log("Aggregating scores from research terminals...");
  console.log("Research directory:", researchDir);

  const result = await aggregateScores(researchDir);

  if (result.error) {
    console.error("ERROR:", result.error);
    process.exit(1);
  }

  // Log warnings if any
  if (result.warnings && result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.warn("WARNING:", warning);
    }
  }

  // Write portfolio-scores.json
  const portfolioWritten = await writePortfolioScores(portfolioScoresPath, result.portfolio);
  if (!portfolioWritten) {
    console.error("ERROR: Failed to write portfolio-scores.json");
    process.exit(1);
  }
  console.log("Written:", portfolioScoresPath);

  // Write my-portfolio.json
  const myPortfolioWritten = await writeMyPortfolio(myPortfolioPath, result.portfolio, result.metrics);
  if (!myPortfolioWritten) {
    console.error("ERROR: Failed to write my-portfolio.json");
    process.exit(1);
  }
  console.log("Written:", myPortfolioPath);

  // Print summary
  console.log("");
  console.log("=== Aggregation Summary ===");
  console.log("Total markets:", result.metrics.totalMarkets);
  console.log("Average score:", result.metrics.averageScore);
  console.log("Confidence-weighted score:", result.metrics.confidenceWeightedScore);
  console.log("Position distribution: YES", result.metrics.positionDistribution.yes + "%,", "NO", result.metrics.positionDistribution.no + "%");
  console.log("Average confidence:", result.metrics.averageConfidence);
  console.log("Aggregated at:", result.metrics.aggregatedAt);
  console.log("");
  console.log("SUCCESS: Score aggregation complete");
}

main();
