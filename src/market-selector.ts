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
import { fetchWithTls } from "./fetch-utils";

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
 * Crypto market data from backend API (CoinGecko prices)
 */
export interface CryptoMarket {
  coinId: string;
  symbol: string;
  name: string;
  priceUsd: number;
  marketCap: number;
  volume24h: number;
  priceChange24h: number;
  lastUpdated: string;
}

/**
 * Crypto market evaluation score for selection
 */
export interface CryptoMarketScore {
  coinId: string;
  symbol: string;
  name: string;
  priceUsd: number;
  priceChange24h: number; // Signed 24h price change (for direction)
  volatility: number; // Absolute price change as proxy for volatility
  score: number;
  reasons: string[];
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

// ============================================================================
// Epic 8: Snapshot-based Market Selection (New APIs)
// ============================================================================

/**
 * Trade list item from a snapshot
 */
export interface TradeListItem {
  ticker: string;
  source: string;          // 'coingecko' | 'polymarket' | 'gamma'
  priceAtSnapshot: number; // Entry price from snapshot
  rank: number;
}

/**
 * Snapshot data from GET /api/snapshots/latest/{categoryId}
 */
export interface Snapshot {
  snapshotId: string;
  categoryId: string;
  listSize: number;
  takenAt: string;  // ISO timestamp
  trades: TradeListItem[];
}

/**
 * Fetch the latest snapshot for a category
 *
 * Epic 8: Uses new GET /api/snapshots/latest/{categoryId} endpoint
 * This is the primary way bots get market data for category-based betting.
 */
export async function fetchLatestSnapshot(
  categoryId: string,
  config: Partial<MarketSelectorConfig> = {}
): Promise<Snapshot | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  logger.info(`Fetching latest snapshot for category: ${categoryId}`);

  try {
    const url = `${cfg.backendUrl}/api/snapshots/latest/${categoryId}`;

    const response = await fetchWithTls(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      if (response.status === 404) {
        logger.warn(`No snapshot found for category: ${categoryId}`);
        return null;
      }
      const errorText = await response.text();
      throw new Error(`Failed to fetch snapshot: ${response.status} - ${errorText}`);
    }

    const snapshot = await response.json() as Snapshot;
    logger.info(`Fetched snapshot ${snapshot.snapshotId}: ${snapshot.trades.length} trades from ${snapshot.takenAt}`);
    return snapshot;
  } catch (error) {
    logger.error(`Snapshot fetch error: ${error}`);
    return null;
  }
}

/**
 * Convert snapshot trades to MarketScore format for compatibility
 *
 * This allows using snapshot data with existing portfolio creation functions.
 */
export function snapshotTradesToMarketScores(trades: TradeListItem[]): MarketScore[] {
  return trades.map((trade) => ({
    marketId: `${trade.source}:deterministic:${trade.ticker}`,
    question: trade.ticker,
    priceYes: trade.priceAtSnapshot,
    priceNo: 1 - trade.priceAtSnapshot,
    score: 100 - trade.rank, // Higher rank = lower score
    reasons: [`rank: ${trade.rank}`, trade.source],
    endDate: null, // Snapshots don't have end dates - they resolve at snapshot time
  }));
}

/**
 * Fetch markets from backend API with filters (with pagination)
 */
export async function fetchMarkets(
  config: Partial<MarketSelectorConfig> = {}
): Promise<Market[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const allMarkets: Market[] = [];
  let page = 1;
  const pageSize = 500;
  let hasMore = true;

  logger.info(`Fetching all open markets with volume >= ${cfg.minVolume}...`);

  while (hasMore) {
    const url = new URL("/api/markets", cfg.backendUrl);
    url.searchParams.set("active", "true");
    url.searchParams.set("open", "true"); // Only non-closed markets
    url.searchParams.set("minVolume", cfg.minVolume.toString());
    url.searchParams.set("limit", pageSize.toString());
    url.searchParams.set("page", page.toString());

    try {
      const response = await fetchWithTls(url.toString(), {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to fetch markets: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      // Parse string values to numbers
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

      allMarkets.push(...markets);
      hasMore = data.pagination.hasMore;

      if (page === 1) {
        logger.info(`Total markets available: ${data.pagination.total}`);
      }

      page++;

      // Safety limit to prevent infinite loops
      if (page > 50) {
        logger.warn(`Stopping at page 50 (${allMarkets.length} markets fetched)`);
        break;
      }
    } catch (error) {
      logger.error(`Market fetch error on page ${page}: ${error}`);
      throw error;
    }
  }

  logger.info(`Fetched ${allMarkets.length} markets total`);
  return allMarkets;
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

    // Note: We no longer filter by price here since is_closed filter on server
    // handles resolved markets. Price-based filtering was unreliable.

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
 * Uses Fisher-Yates shuffle for efficiency when selecting many markets
 */
export function randomlySelectMarkets(
  markets: MarketScore[],
  count: number = 3
): MarketScore[] {
  if (markets.length <= count) {
    return markets;
  }

  // For large selections (>100), use simple shuffle for efficiency
  // Fisher-Yates shuffle is O(n) vs O(n²) for weighted selection
  const shuffled = [...markets];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled.slice(0, count);
}

// ============================================================================
// Crypto Market Functions (CoinGecko)
// ============================================================================

/**
 * Fetch crypto markets from backend API
 */
export async function fetchCryptoMarkets(
  config: Partial<MarketSelectorConfig> = {}
): Promise<CryptoMarket[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  logger.info("Fetching crypto markets from backend...");

  try {
    const url = new URL("/api/crypto/prices", cfg.backendUrl);

    const response = await fetchWithTls(url.toString(), {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch crypto markets: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    // Parse the response - expected format: { prices: CryptoMarket[] }
    const prices = data.prices || data;
    const markets: CryptoMarket[] = (Array.isArray(prices) ? prices : []).map((p: Record<string, unknown>) => ({
      coinId: String(p.coinId || p.coin_id || ""),
      symbol: String(p.symbol || "").toUpperCase(),
      name: String(p.name || p.coinId || ""),
      priceUsd: parseFloat(String(p.priceUsd || p.price_usd || "0")),
      marketCap: parseFloat(String(p.marketCap || p.market_cap || "0")),
      volume24h: parseFloat(String(p.volume24h || p.volume_24h || "0")),
      priceChange24h: parseFloat(String(p.priceChange24h || p.price_change_24h || "0")),
      lastUpdated: String(p.lastUpdated || p.last_updated || new Date().toISOString()),
    }));

    logger.info(`Fetched ${markets.length} crypto markets`);
    return markets;
  } catch (error) {
    logger.error(`Crypto market fetch error: ${error}`);
    return [];
  }
}

/**
 * Score crypto markets for trading
 *
 * Scoring factors:
 * - Volatility (price change 24h) - higher is better for trading
 * - Volume - higher is better for liquidity
 * - Market cap - prefer major coins for reliability
 */
export function scoreCryptoMarkets(markets: CryptoMarket[]): CryptoMarketScore[] {
  return markets.map((market) => {
    const reasons: string[] = [];
    let score = 50; // Base score

    // Volatility bonus (absolute price change)
    const volatility = Math.abs(market.priceChange24h);
    if (volatility > 5) {
      score += 20;
      reasons.push("high-volatility");
    } else if (volatility > 2) {
      score += 10;
      reasons.push("med-volatility");
    }

    // Volume bonus (normalized)
    if (market.volume24h > 1_000_000_000) {
      score += 15;
      reasons.push("high-volume");
    } else if (market.volume24h > 100_000_000) {
      score += 10;
      reasons.push("med-volume");
    }

    // Market cap bonus (prefer major coins)
    if (market.marketCap > 10_000_000_000) {
      score += 15;
      reasons.push("large-cap");
    } else if (market.marketCap > 1_000_000_000) {
      score += 10;
      reasons.push("mid-cap");
    }

    return {
      coinId: market.coinId,
      symbol: market.symbol,
      name: market.name,
      priceUsd: market.priceUsd,
      priceChange24h: market.priceChange24h,
      volatility,
      score,
      reasons,
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Get tradeable crypto markets
 *
 * Fetches, scores, and returns best crypto markets for trading
 */
export async function getTradableCryptoMarkets(
  config: Partial<MarketSelectorConfig> = {},
  count: number = 3
): Promise<CryptoMarketScore[]> {
  const markets = await fetchCryptoMarkets(config);

  if (markets.length === 0) {
    logger.warn("No crypto markets found!");
    return [];
  }

  const scored = scoreCryptoMarkets(markets);
  const selected = scored.slice(0, count);

  logger.info(`Selected ${selected.length} crypto markets for trading:`);
  for (const market of selected) {
    logger.info(`  - ${market.symbol}: score=${market.score} (${market.reasons.join(", ")})`);
  }

  return selected;
}

// ============================================================================
// Stock Market Functions (Finnhub via /api/market-prices?source=stocks)
// ============================================================================

/**
 * Stock market data from backend unified market_prices API
 */
export interface StockMarket {
  assetId: string;
  symbol: string;
  name: string;
  category: string | null;
  priceUsd: number;
  prevClose: number | null;
  priceChangePct: number | null;
  volume24h: number | null;
  marketCap: number | null;
  fetchedAt: string;
}

/**
 * Stock market evaluation score for selection
 */
export interface StockMarketScore {
  symbol: string;
  name: string;
  priceUsd: number;
  priceChangePct: number;
  score: number;
  reasons: string[];
}

/**
 * Fetch stock markets from backend unified market-prices API
 */
export async function fetchStockMarkets(
  config: Partial<MarketSelectorConfig> = {},
  limit: number = 500
): Promise<StockMarket[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  logger.info("Fetching stock markets from backend...");

  try {
    const url = new URL("/api/market-prices", cfg.backendUrl);
    url.searchParams.set("source", "stocks");
    url.searchParams.set("limit", limit.toString());

    const response = await fetchWithTls(url.toString(), {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch stock markets: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const prices = data.prices || [];

    const markets: StockMarket[] = prices.map((p: Record<string, unknown>) => ({
      assetId: String(p.assetId || p.asset_id || ""),
      symbol: String(p.symbol || ""),
      name: String(p.name || p.symbol || ""),
      category: p.category ? String(p.category) : null,
      priceUsd: parseFloat(String(p.priceUsd || p.price_usd || "0")),
      prevClose: p.prevClose ? parseFloat(String(p.prevClose)) : null,
      priceChangePct: p.priceChangePct ? parseFloat(String(p.priceChangePct)) : null,
      volume24h: p.volume24h ? parseFloat(String(p.volume24h)) : null,
      marketCap: p.marketCap ? parseFloat(String(p.marketCap)) : null,
      fetchedAt: String(p.fetchedAt || new Date().toISOString()),
    }));

    logger.info(`Fetched ${markets.length} stock markets`);
    return markets;
  } catch (error) {
    logger.error(`Stock market fetch error: ${error}`);
    return [];
  }
}

/**
 * Score stock markets for trading
 *
 * Scoring by price change (volatility) — more volatile stocks = more interesting
 */
export function scoreStockMarkets(markets: StockMarket[]): StockMarketScore[] {
  return markets.map((market) => {
    const reasons: string[] = [];
    let score = 50;

    const pctChange = Math.abs(market.priceChangePct || 0);
    if (pctChange > 3) {
      score += 20;
      reasons.push("high-volatility");
    } else if (pctChange > 1) {
      score += 10;
      reasons.push("med-volatility");
    }

    if (market.category) {
      reasons.push(market.category);
    }

    return {
      symbol: market.symbol,
      name: market.name,
      priceUsd: market.priceUsd,
      priceChangePct: market.priceChangePct || 0,
      score,
      reasons,
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Get tradeable stock markets
 */
export async function getTradableStockMarkets(
  config: Partial<MarketSelectorConfig> = {},
  count: number = 100
): Promise<StockMarketScore[]> {
  const markets = await fetchStockMarkets(config);

  if (markets.length === 0) {
    logger.warn("No stock markets found!");
    return [];
  }

  const scored = scoreStockMarkets(markets);
  const selected = scored.slice(0, count);

  logger.info(`Selected ${selected.length} stock markets for trading:`);
  for (const market of selected.slice(0, 5)) {
    logger.info(`  - ${market.symbol}: score=${market.score} (${market.reasons.join(", ")})`);
  }

  return selected;
}

// ============================================================================
// Weather Market Functions (Open-Meteo via /api/weather)
// ============================================================================

/**
 * Weather city data from backend API
 */
export interface WeatherCity {
  cityId: string;
  name: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  population: number;
  rank: number;
}

/**
 * Weather reading data from backend API
 */
export interface WeatherReading {
  cityId: string;
  cityName: string;
  countryCode: string;
  metric: string;
  value: number;
  unit: string;
  recordedAt: string;
}

/**
 * Weather market evaluation score for selection
 */
export interface WeatherMarketScore {
  marketId: string;        // Format: "cityId-metric" (e.g., "paris-fr-temperature_2m")
  cityId: string;
  cityName: string;
  metric: string;
  value: number;
  unit: string;
  score: number;
  reasons: string[];
}

/**
 * Fetch weather readings from backend API
 */
export async function fetchWeatherMarkets(
  config: Partial<MarketSelectorConfig> = {},
  metric?: string,
  maxRank?: number
): Promise<WeatherReading[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  logger.info(`Fetching weather markets from backend (metric: ${metric || "all"}, maxRank: ${maxRank || "all"})...`);

  try {
    const url = new URL("/api/weather/readings", cfg.backendUrl);
    url.searchParams.set("limit", "500");
    if (metric) {
      url.searchParams.set("metric", metric);
    }
    if (maxRank) {
      url.searchParams.set("maxRank", maxRank.toString());
    }

    const response = await fetchWithTls(url.toString(), {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch weather markets: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const readings = data.readings || [];

    const markets: WeatherReading[] = readings.map((r: Record<string, unknown>) => ({
      cityId: String(r.cityId || r.city_id || ""),
      cityName: String(r.cityName || r.city_name || ""),
      countryCode: String(r.countryCode || r.country_code || ""),
      metric: String(r.metric || ""),
      value: parseFloat(String(r.value || "0")),
      unit: String(r.unit || ""),
      recordedAt: String(r.recordedAt || r.recorded_at || new Date().toISOString()),
    }));

    logger.info(`Fetched ${markets.length} weather readings`);
    return markets;
  } catch (error) {
    logger.error(`Weather market fetch error: ${error}`);
    return [];
  }
}

/**
 * Score weather markets for trading
 *
 * Scoring factors:
 * - City population rank (lower rank = larger city = higher priority)
 * - Metric type (temperature often most interesting)
 */
export function scoreWeatherMarkets(readings: WeatherReading[]): WeatherMarketScore[] {
  return readings.map((reading) => {
    const reasons: string[] = [];
    let score = 50; // Base score

    // City/metric combination
    const marketId = `${reading.cityId}-${reading.metric}`;

    // Metric type bonus
    if (reading.metric === "temperature_2m") {
      score += 10;
      reasons.push("temperature");
    } else if (reading.metric === "rain") {
      score += 8;
      reasons.push("rain");
    } else if (reading.metric === "wind_speed_10m") {
      score += 6;
      reasons.push("wind");
    } else if (reading.metric === "pm2_5" || reading.metric === "ozone") {
      score += 4;
      reasons.push("air-quality");
    }

    // Country diversity bonus (encourage international coverage)
    reasons.push(reading.countryCode);

    return {
      marketId,
      cityId: reading.cityId,
      cityName: reading.cityName,
      metric: reading.metric,
      value: reading.value,
      unit: reading.unit,
      score,
      reasons,
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Get tradeable weather markets
 *
 * @param config - Market selector configuration
 * @param count - Number of markets to return
 * @param metric - Optional filter for specific metric (temperature_2m, rain, etc.)
 * @param maxRank - Optional filter for top N cities by population
 */
export async function getTradableWeatherMarkets(
  config: Partial<MarketSelectorConfig> = {},
  count: number = 100,
  metric?: string,
  maxRank?: number
): Promise<WeatherMarketScore[]> {
  const readings = await fetchWeatherMarkets(config, metric, maxRank);

  if (readings.length === 0) {
    logger.warn("No weather markets found!");
    return [];
  }

  const scored = scoreWeatherMarkets(readings);
  const selected = scored.slice(0, count);

  logger.info(`Selected ${selected.length} weather markets for trading:`);
  for (const market of selected.slice(0, 5)) {
    logger.info(`  - ${market.marketId}: ${market.value}${market.unit} score=${market.score} (${market.reasons.join(", ")})`);
  }

  return selected;
}

// ============================================================================
// Generic Market Price Functions (Unified API)
// ============================================================================

import { SOURCE_CONFIG, type DataSource } from "./constants";

/**
 * Generic market price data from unified /api/market-prices endpoint
 */
export interface GenericMarketPrice {
  assetId: string;
  symbol: string;
  name: string;
  source: DataSource;
  category: string | null;
  priceUsd: number;
  prevValue: number | null;
  changePct: number | null;
  fetchedAt: string;
}

/**
 * Generic market score for any source
 */
export interface GenericMarketScore {
  assetId: string;
  symbol: string;
  name: string;
  source: DataSource;
  priceUsd: number;
  changePct: number;
  score: number;
  reasons: string[];
}

/**
 * Fetch market prices from the unified /api/market-prices endpoint
 *
 * @param backendUrl - Backend API URL
 * @param source - Data source to fetch (bls, fred, ecb, defi, stocks)
 * @param category - Optional category filter
 * @param limit - Maximum number of results
 */
export async function fetchMarketPrices(
  backendUrl: string,
  source: DataSource,
  category?: string,
  limit: number = 500
): Promise<GenericMarketPrice[]> {
  const config = SOURCE_CONFIG[source];
  if (!config) {
    logger.warn(`Unknown source: ${source}`);
    return [];
  }

  logger.info(`Fetching ${source} market prices from backend...`);

  try {
    const url = new URL("/api/market-prices", backendUrl);
    url.searchParams.set("source", source);
    url.searchParams.set("limit", limit.toString());
    if (category) {
      url.searchParams.set("category", category);
    }

    const response = await fetchWithTls(url.toString(), {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch ${source} prices: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as { prices?: Record<string, unknown>[] };
    const prices = data.prices || [];

    const markets: GenericMarketPrice[] = prices.map((p) => ({
      assetId: String(p.assetId || p.asset_id || ""),
      symbol: String(p.symbol || ""),
      name: String(p.name || p.symbol || ""),
      source: source,
      category: p.category ? String(p.category) : null,
      priceUsd: parseFloat(String(p.priceUsd || p.price_usd || p.value || "0")),
      prevValue: p.prevValue ? parseFloat(String(p.prevValue)) : null,
      changePct: p.changePct ? parseFloat(String(p.changePct)) : null,
      fetchedAt: String(p.fetchedAt || p.fetched_at || new Date().toISOString()),
    }));

    logger.info(`Fetched ${markets.length} ${source} market prices`);
    return markets;
  } catch (error) {
    logger.error(`${source} market fetch error: ${error}`);
    return [];
  }
}

/**
 * Score market prices for trading
 *
 * Generic scorer that works for any source - scores by volatility/change
 * Economic sources get bonus for upcoming release dates (if available)
 */
export function scoreMarketPrices(
  markets: GenericMarketPrice[],
  source: DataSource
): GenericMarketScore[] {
  const config = SOURCE_CONFIG[source];
  const isEconomic = config?.isEconomic || false;

  return markets.map((market) => {
    const reasons: string[] = [];
    let score = 50; // Base score

    // Volatility/change bonus
    const changePct = Math.abs(market.changePct || 0);
    if (changePct > 5) {
      score += 25;
      reasons.push("high-change");
    } else if (changePct > 2) {
      score += 15;
      reasons.push("med-change");
    } else if (changePct > 0.5) {
      score += 5;
      reasons.push("low-change");
    }

    // Economic source bonus
    if (isEconomic) {
      score += 10;
      reasons.push("economic");
    }

    // Category bonus
    if (market.category) {
      reasons.push(market.category);
    }

    return {
      assetId: market.assetId,
      symbol: market.symbol,
      name: market.name,
      source: market.source,
      priceUsd: market.priceUsd,
      changePct: market.changePct || 0,
      score,
      reasons,
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Get tradable markets for any source
 *
 * @param backendUrl - Backend API URL
 * @param source - Data source to fetch
 * @param count - Number of markets to return
 * @param category - Optional category filter
 */
export async function getTradableMarketsBySource(
  backendUrl: string,
  source: DataSource,
  count: number = 100,
  category?: string
): Promise<GenericMarketScore[]> {
  const config = { backendUrl };
  const markets = await fetchMarketPrices(backendUrl, source, category);

  if (markets.length === 0) {
    logger.warn(`No ${source} markets found!`);
    return [];
  }

  const scored = scoreMarketPrices(markets, source);
  const selected = scored.slice(0, count);

  logger.info(`Selected ${selected.length} ${source} markets for trading:`);
  for (const market of selected.slice(0, 5)) {
    logger.info(`  - ${market.symbol}: score=${market.score} (${market.reasons.join(", ")})`);
  }

  return selected;
}
