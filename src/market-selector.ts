/**
 * Market Selector for AI Trading Bots
 *
 * Fetches and filters markets from backend API for bot trading.
 * Selects markets with sufficient volume and liquidity.
 *
 * Story 7.6: AI Trading Bot Launch Scripts
 * AC: 1, 2 - Market Selection Logic
 */

import { join } from "path";
import { Logger } from "./logger";

// Initialize logger for this module with console output
const logsDir = process.env.AGENT_LOGS_DIR || join(process.cwd(), "agent");
const fileLogger = new Logger(logsDir);
const logger = {
  info: (msg: string) => { console.log(`[MarketSelector] ${msg}`); fileLogger.info(msg); },
  warn: (msg: string) => { console.log(`[MarketSelector] WARN: ${msg}`); fileLogger.warn(msg); },
  error: (msg: string) => { console.error(`[MarketSelector] ERROR: ${msg}`); fileLogger.error(msg); },
};

/**
 * Market data from backend API
 */
export interface Market {
  marketId: string;
  question: string;
  priceYes: number | null;
  priceNo: number | null;
  volume: number;
  liquidity: number;
  isActive: boolean;
  endDate: string | null;
  category: string | null;
  lastUpdated: string;
}

/**
 * Paginated markets response from backend
 */
export interface MarketsResponse {
  markets: Market[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

/**
 * Market evaluation score for selection
 */
export interface MarketScore {
  marketId: string;
  question: string;
  priceYes: number;
  priceNo: number;
  score: number;
  reasons: string[];
  /** Market end date (ISO string), used for resolution deadline calculation */
  endDate: string | null;
}

/**
 * Market selector configuration
 */
export interface MarketSelectorConfig {
  backendUrl: string;
  minVolume: number;
  maxMarketsToFetch: number;
  preferredCategories?: string[];
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: MarketSelectorConfig = {
  backendUrl: process.env.BACKEND_URL || "http://localhost:3001",
  minVolume: 1000, // AC2: volume > 1000
  maxMarketsToFetch: 500,
};

/**
 * Fetch markets from backend API with filters
 */
export async function fetchMarkets(
  config: Partial<MarketSelectorConfig> = {}
): Promise<Market[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const url = new URL("/api/markets", cfg.backendUrl);
  url.searchParams.set("active", "true");
  url.searchParams.set("minVolume", cfg.minVolume.toString());
  url.searchParams.set("limit", cfg.maxMarketsToFetch.toString());

  logger.info(`Fetching markets from ${url.toString()}`);

  try {
    // Use Bun's fetch with TLS verification disabled for self-signed certs
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      // @ts-ignore - Bun-specific option to disable TLS verification
      tls: {
        rejectUnauthorized: false,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch markets: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    logger.info(`Fetched ${data.markets.length} markets (total: ${data.pagination.total})`);

    // Parse string values to numbers (API returns strings for numeric fields)
    const markets: Market[] = data.markets.map((m: Record<string, unknown>) => ({
      marketId: String(m.marketId || ""),
      question: String(m.question || ""),
      priceYes: m.priceYes != null ? parseFloat(String(m.priceYes)) : null,
      priceNo: m.priceNo != null ? parseFloat(String(m.priceNo)) : null,
      volume: parseFloat(String(m.volume || "0")),
      liquidity: parseFloat(String(m.liquidity || "0")),
      isActive: Boolean(m.isActive),
      endDate: m.endDate ? String(m.endDate) : null,
      category: m.category ? String(m.category) : null,
      lastUpdated: String(m.lastUpdated || new Date().toISOString()),
    }));

    return markets;
  } catch (error) {
    logger.error(`Market fetch error: ${error}`);
    throw error;
  }
}

/**
 * Filter markets based on trading criteria
 *
 * AC2: volume > 1000, active markets, not expired, not closing soon
 */
export function filterMarkets(
  markets: Market[],
  config: Partial<MarketSelectorConfig> = {}
): Market[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = new Date();
  const minEndTime = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes from now

  return markets.filter((market) => {
    // Must be active and not closed
    if (!market.isActive) {
      return false;
    }

    // Volume filter (AC2) - minimum $1000 volume
    if (market.volume < cfg.minVolume) {
      return false;
    }

    // Not expired and not closing within 10 minutes
    if (market.endDate) {
      const endDate = new Date(market.endDate);
      if (endDate <= minEndTime) {
        return false; // Expired or closing too soon
      }
    }

    // Must have valid prices (odds between 0.01 and 0.99)
    const priceYes = market.priceYes ?? 0;
    const priceNo = market.priceNo ?? 0;
    if (priceYes <= 0.01 || priceYes >= 0.99) {
      return false; // Market essentially resolved (>99% or <1%)
    }

    return true;
  });
}

/**
 * Score a market for selection priority
 *
 * Higher scores = better markets for trading
 */
export function scoreMarket(market: Market): MarketScore {
  const reasons: string[] = [];
  let score = 0;

  const priceYes = market.priceYes ?? 0.5;
  const priceNo = market.priceNo ?? 0.5;

  // Volume score (0-30 points)
  // Higher volume = more liquidity for trading
  if (market.volume >= 100000) {
    score += 30;
    reasons.push("Very high volume (100k+)");
  } else if (market.volume >= 50000) {
    score += 25;
    reasons.push("High volume (50k+)");
  } else if (market.volume >= 10000) {
    score += 20;
    reasons.push("Good volume (10k+)");
  } else if (market.volume >= 1000) {
    score += 10;
    reasons.push("Minimum volume met");
  }

  // Price uncertainty score (0-30 points)
  // Markets closer to 50/50 are more interesting for trading
  const priceSpread = Math.abs(priceYes - 0.5);
  if (priceSpread <= 0.1) {
    score += 30;
    reasons.push("High uncertainty (40-60%)");
  } else if (priceSpread <= 0.2) {
    score += 20;
    reasons.push("Moderate uncertainty (30-70%)");
  } else if (priceSpread <= 0.3) {
    score += 10;
    reasons.push("Low uncertainty (20-80%)");
  }

  // Liquidity score (0-20 points)
  if (market.liquidity >= 50000) {
    score += 20;
    reasons.push("Excellent liquidity");
  } else if (market.liquidity >= 10000) {
    score += 15;
    reasons.push("Good liquidity");
  } else if (market.liquidity >= 1000) {
    score += 10;
    reasons.push("Adequate liquidity");
  }

  // Time to expiry score (0-20 points)
  // Prefer markets that won't expire too soon
  if (market.endDate) {
    const hoursUntilExpiry = (new Date(market.endDate).getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursUntilExpiry >= 168) { // 1 week+
      score += 20;
      reasons.push("Long time to expiry");
    } else if (hoursUntilExpiry >= 24) { // 1 day+
      score += 15;
      reasons.push("Adequate time to expiry");
    } else if (hoursUntilExpiry >= 2) { // 2 hours+
      score += 5;
      reasons.push("Limited time to expiry");
    }
  } else {
    score += 15; // No expiry set
    reasons.push("No expiry date");
  }

  return {
    marketId: market.marketId,
    question: market.question,
    priceYes,
    priceNo,
    score,
    reasons,
    endDate: market.endDate,
  };
}

/**
 * Select best markets for trading
 *
 * Returns top N markets sorted by score
 */
export function selectBestMarkets(
  markets: Market[],
  count: number = 5
): MarketScore[] {
  const scoredMarkets = markets.map(scoreMarket);

  // Sort by score descending
  scoredMarkets.sort((a, b) => b.score - a.score);

  // Return top N
  return scoredMarkets.slice(0, count);
}

/**
 * High-level function to get tradeable markets
 *
 * Fetches, filters, scores, and returns best markets
 */
export async function getTradableMarkets(
  config: Partial<MarketSelectorConfig> = {},
  count: number = 5
): Promise<MarketScore[]> {
  // Fetch markets from backend
  const allMarkets = await fetchMarkets(config);

  // Filter for tradeable markets
  const filtered = filterMarkets(allMarkets, config);
  logger.info(`Filtered to ${filtered.length} tradeable markets`);

  if (filtered.length === 0) {
    logger.warn("No tradeable markets found!");
    return [];
  }

  // Select best markets
  const selected = selectBestMarkets(filtered, count);

  logger.info(`Selected ${selected.length} markets for trading:`);
  for (const market of selected) {
    logger.info(`  - ${market.marketId}: score=${market.score} (${market.reasons.join(", ")})`);
  }

  return selected;
}

/**
 * Randomly select markets from the tradeable pool
 *
 * Used by bots to add variety to their portfolios
 */
export function randomlySelectMarkets(
  markets: MarketScore[],
  count: number = 3
): MarketScore[] {
  if (markets.length <= count) {
    return markets;
  }

  // Weighted random selection based on score
  const totalScore = markets.reduce((sum, m) => sum + m.score, 0);
  const selected: MarketScore[] = [];
  const available = [...markets];

  while (selected.length < count && available.length > 0) {
    // Random weighted selection
    let random = Math.random() * totalScore;
    let index = 0;

    for (let i = 0; i < available.length; i++) {
      random -= available[i].score;
      if (random <= 0) {
        index = i;
        break;
      }
    }

    selected.push(available[index]);
    available.splice(index, 1);
  }

  return selected;
}
