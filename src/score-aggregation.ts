import { join } from "path";
import { readdirSync, existsSync } from "fs";

/**
 * Market score data from a research terminal
 */
export interface TerminalScore {
  marketId: string;
  score: number;       // 0-100
  position: number;    // 0=NO, 1=YES
  confidence: number;  // 0.0-1.0
}

/**
 * Aggregated portfolio with scores keyed by marketId
 */
export interface AggregatedPortfolio {
  [marketId: string]: {
    score: number;
    position: number;
    confidence: number;
  };
}

/**
 * Metrics calculated from the aggregated portfolio
 */
export interface PortfolioMetrics {
  totalMarkets: number;
  averageScore: number;
  confidenceWeightedScore: number;
  positionDistribution: {
    yes: number;  // percentage
    no: number;   // percentage
  };
  averageConfidence: number;
  aggregatedAt: string;  // ISO timestamp
}

/**
 * Result from the aggregation process
 */
export interface AggregationResult {
  portfolio: AggregatedPortfolio;
  metrics: PortfolioMetrics;
  warnings?: string[];
  error?: string;
}

/**
 * Parse JSON Lines format content into TerminalScore array
 * Each line is a separate JSON object
 */
export function parseJsonLines(content: string): TerminalScore[] {
  const scores: TerminalScore[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue; // Skip empty lines

    try {
      const score = JSON.parse(trimmed) as TerminalScore;
      // Validate required fields
      if (score.marketId && typeof score.score === "number" && typeof score.position === "number") {
        scores.push(score);
      }
    } catch (error) {
      // Skip malformed JSON lines - log in debug mode
      if (process.env.DEBUG) {
        console.warn(`[score-aggregation] Skipping malformed JSON line: ${trimmed.substring(0, 50)}...`);
      }
      continue;
    }
  }

  return scores;
}

/**
 * Discover all completed terminal score files in the research directory
 * Only returns files from terminals with status.txt containing "COMPLETE"
 */
export async function discoverTerminalFiles(researchDir: string): Promise<string[]> {
  const scoreFiles: string[] = [];

  if (!existsSync(researchDir)) {
    return [];
  }

  try {
    const entries = readdirSync(researchDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("terminal-")) {
        const terminalDir = join(researchDir, entry.name);
        const statusPath = join(terminalDir, "status.txt");
        const scoresPath = join(terminalDir, "scores.json");

        // Check if terminal is complete
        if (existsSync(statusPath) && existsSync(scoresPath)) {
          const statusContent = await Bun.file(statusPath).text();
          if (statusContent.trim() === "COMPLETE") {
            scoreFiles.push(scoresPath);
          }
        }
      }
    }
  } catch (error) {
    if (process.env.DEBUG) {
      console.warn(`[score-aggregation] Failed to read research directory: ${(error as Error).message}`);
    }
    return [];
  }

  return scoreFiles;
}

/**
 * Merge scores from multiple terminals into a single portfolio
 * First occurrence wins for duplicate marketIds (shouldn't happen with proper segmentation)
 */
export function mergeScores(allScores: TerminalScore[][]): AggregatedPortfolio {
  const portfolio: AggregatedPortfolio = {};

  for (const terminalScores of allScores) {
    for (const score of terminalScores) {
      // Keep first occurrence only
      if (!(score.marketId in portfolio)) {
        portfolio[score.marketId] = {
          score: score.score,
          position: score.position,
          confidence: score.confidence
        };
      }
    }
  }

  return portfolio;
}

/**
 * Calculate portfolio metrics from aggregated scores
 */
export function calculateMetrics(portfolio: AggregatedPortfolio): PortfolioMetrics {
  const entries = Object.values(portfolio);
  const totalMarkets = entries.length;

  if (totalMarkets === 0) {
    return {
      totalMarkets: 0,
      averageScore: 0,
      confidenceWeightedScore: 0,
      positionDistribution: { yes: 0, no: 0 },
      averageConfidence: 0,
      aggregatedAt: new Date().toISOString()
    };
  }

  // Calculate sums
  let scoreSum = 0;
  let confidenceSum = 0;
  let weightedScoreSum = 0;
  let yesCount = 0;

  for (const entry of entries) {
    scoreSum += entry.score;
    confidenceSum += entry.confidence;
    weightedScoreSum += entry.score * entry.confidence;
    if (entry.position === 1) {
      yesCount++;
    }
  }

  const averageScore = Math.round(scoreSum / totalMarkets);
  const averageConfidence = confidenceSum / totalMarkets;
  const confidenceWeightedScore = confidenceSum > 0 ? weightedScoreSum / confidenceSum : 0;
  const yesPercentage = Math.round((yesCount / totalMarkets) * 100);
  const noPercentage = 100 - yesPercentage;

  return {
    totalMarkets,
    averageScore,
    confidenceWeightedScore: Math.round(confidenceWeightedScore * 100) / 100,
    positionDistribution: {
      yes: yesPercentage,
      no: noPercentage
    },
    averageConfidence: Math.round(averageConfidence * 100) / 100,
    aggregatedAt: new Date().toISOString()
  };
}

/**
 * Count total terminal directories in research directory
 */
async function countTerminalDirectories(researchDir: string): Promise<number> {
  if (!existsSync(researchDir)) {
    return 0;
  }

  try {
    const entries = readdirSync(researchDir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && e.name.startsWith("terminal-")).length;
  } catch (error) {
    if (process.env.DEBUG) {
      console.warn(`[score-aggregation] Failed to count terminal directories: ${(error as Error).message}`);
    }
    return 0;
  }
}

/**
 * Main aggregation function
 * Discovers terminal files, reads scores, merges, and calculates metrics
 */
export async function aggregateScores(researchDir: string): Promise<AggregationResult> {
  const warnings: string[] = [];

  // Discover completed terminal files
  const scoreFiles = await discoverTerminalFiles(researchDir);

  if (scoreFiles.length === 0) {
    return {
      portfolio: {},
      metrics: calculateMetrics({}),
      error: "No completed research terminals found"
    };
  }

  // Check for partial completion
  const totalTerminals = await countTerminalDirectories(researchDir);
  if (scoreFiles.length < totalTerminals) {
    warnings.push(`Partial terminal completion: ${scoreFiles.length}/${totalTerminals} terminals complete`);
  }

  // Read all score files in parallel
  const allScoresPromises = scoreFiles.map(async (filePath) => {
    try {
      const content = await Bun.file(filePath).text();
      return parseJsonLines(content);
    } catch (error) {
      warnings.push(`Failed to read ${filePath}: ${(error as Error).message}`);
      return [];
    }
  });

  const allScores = await Promise.all(allScoresPromises);

  // Merge all scores into portfolio
  const portfolio = mergeScores(allScores);

  // Calculate metrics
  const metrics = calculateMetrics(portfolio);

  const result: AggregationResult = {
    portfolio,
    metrics
  };

  if (warnings.length > 0) {
    result.warnings = warnings;
  }

  return result;
}

/**
 * Write aggregated portfolio to JSON file
 */
export async function writePortfolioScores(
  outputPath: string,
  portfolio: AggregatedPortfolio
): Promise<boolean> {
  try {
    await Bun.write(outputPath, JSON.stringify(portfolio, null, 2));
    return true;
  } catch (error) {
    if (process.env.DEBUG) {
      console.error(`[score-aggregation] Failed to write portfolio scores: ${(error as Error).message}`);
    }
    return false;
  }
}

/**
 * Write agent's portfolio with metadata to JSON file
 */
export async function writeMyPortfolio(
  outputPath: string,
  portfolio: AggregatedPortfolio,
  metrics: PortfolioMetrics
): Promise<boolean> {
  try {
    const myPortfolio = {
      agentPortfolio: portfolio,
      metadata: {
        ...metrics,
        version: "1.0"
      }
    };
    await Bun.write(outputPath, JSON.stringify(myPortfolio, null, 2));
    return true;
  } catch (error) {
    if (process.env.DEBUG) {
      console.error(`[score-aggregation] Failed to write my-portfolio: ${(error as Error).message}`);
    }
    return false;
  }
}
