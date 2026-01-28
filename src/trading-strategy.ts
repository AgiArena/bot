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

import type { MarketScore, CryptoMarketScore } from "./market-selector";
import { fetchWithTls } from "./fetch-utils";
import { keccak256, toUtf8Bytes, concat } from "ethers";
import { encodePositionBitmap, computeBitmapHash } from "./bitmap-utils";

/**
 * Data source for market prices
 * Expanded to include economic data sources (BLS, FRED, ECB) and DeFi
 */
export type DataSource =
  | "polymarket"
  | "coingecko"
  | "stocks"
  | "openmeteo"
  | "bls"    // Bureau of Labor Statistics - employment/inflation
  | "fred"   // Federal Reserve Economic Data - rates/treasury
  | "ecb"    // European Central Bank - euro macro
  | "defi";  // DeFi protocols - TVL/volumes

/**
 * Resolution method for bets
 */
export type ResolutionMethod = "keeper" | "deterministic";

/**
 * Encode a market ID with source and resolution method prefix
 *
 * Format: {source}:{resolution}:{raw_id}
 *
 * Examples:
 * - encodeMarketId("polymarket", "keeper", "0x123") -> "polymarket:keeper:0x123"
 * - encodeMarketId("coingecko", "deterministic", "bitcoin") -> "coingecko:deterministic:bitcoin"
 */
export function encodeMarketId(
  source: DataSource,
  method: ResolutionMethod,
  rawId: string
): string {
  return `${source}:${method}:${rawId}`;
}

/**
 * Valid data sources for parsing
 */
const VALID_SOURCES: readonly DataSource[] = [
  "polymarket",
  "coingecko",
  "stocks",
  "openmeteo",
  "bls",
  "fred",
  "ecb",
  "defi",
] as const;

/**
 * Parse a market ID into its components
 *
 * Supports:
 * - New format: {source}:{resolution}:{raw_id}
 * - Legacy format: treated as polymarket:keeper:{raw_id}
 */
export function parseMarketId(marketId: string): {
  dataSource: DataSource;
  resolutionMethod: ResolutionMethod;
  rawId: string;
} {
  const parts = marketId.split(":");

  if (parts.length >= 3) {
    // Check if the first part is a valid source
    const sourceStr = parts[0].toLowerCase();
    const dataSource: DataSource = VALID_SOURCES.includes(sourceStr as DataSource)
      ? (sourceStr as DataSource)
      : "polymarket";
    const resolutionMethod = parts[1] === "deterministic" ? "deterministic" : "keeper";
    const rawId = parts.slice(2).join(":");

    return { dataSource, resolutionMethod, rawId };
  }

  // Legacy format
  return {
    dataSource: "polymarket",
    resolutionMethod: "keeper",
    rawId: marketId,
  };
}

/**
 * Check if a data source is economic (macro) data
 */
export function isEconomicSource(source: DataSource): boolean {
  return source === "bls" || source === "fred" || source === "ecb";
}

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
 * Used for initial bet placement by bots.
 * Now encodes market IDs with source and resolution method.
 */
export function createRandomPortfolio(
  markets: MarketScore[],
  positionCount: number = 5
): Portfolio {
  // Select random subset of markets
  const shuffled = [...markets].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(positionCount, markets.length));

  // Create positions with random YES/NO and equal weights
  // Use encoded market IDs for Polymarket positions
  const weight = 1 / selected.length;
  const positions: PortfolioPosition[] = selected.map((market) => ({
    marketId: encodeMarketId("polymarket", "keeper", market.marketId),
    position: Math.random() > 0.5 ? "YES" : "NO",
    weight,
  }));

  return {
    positions,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create a mixed portfolio from both Polymarket and CoinGecko markets
 *
 * Allows diversification across prediction markets and crypto prices.
 * CoinGecko positions use deterministic resolution.
 */
export function createMixedPortfolio(
  polymarketMarkets: MarketScore[],
  cryptoMarkets: CryptoMarketScore[],
  positionCount: number = 5,
  cryptoRatio: number = 0.2 // 20% crypto by default
): Portfolio {
  const cryptoCount = Math.floor(positionCount * cryptoRatio);
  const polymarketCount = positionCount - cryptoCount;

  // Select random Polymarket markets
  const shuffledPoly = [...polymarketMarkets].sort(() => Math.random() - 0.5);
  const selectedPoly = shuffledPoly.slice(0, Math.min(polymarketCount, polymarketMarkets.length));

  // Select random crypto markets
  const shuffledCrypto = [...cryptoMarkets].sort(() => Math.random() - 0.5);
  const selectedCrypto = shuffledCrypto.slice(0, Math.min(cryptoCount, cryptoMarkets.length));

  const totalPositions = selectedPoly.length + selectedCrypto.length;
  if (totalPositions === 0) {
    return { positions: [], createdAt: new Date().toISOString() };
  }

  const weight = 1 / totalPositions;

  // Create Polymarket positions (keeper resolution)
  const polyPositions: PortfolioPosition[] = selectedPoly.map((market) => ({
    marketId: encodeMarketId("polymarket", "keeper", market.marketId),
    position: Math.random() > 0.5 ? "YES" : "NO",
    weight,
  }));

  // Create crypto positions (deterministic resolution)
  // YES = LONG (price goes up), NO = SHORT (price goes down)
  const cryptoPositions: PortfolioPosition[] = selectedCrypto.map((market) => ({
    marketId: encodeMarketId("coingecko", "deterministic", market.coinId),
    position: Math.random() > 0.5 ? "YES" : "NO",
    weight,
  }));

  return {
    positions: [...polyPositions, ...cryptoPositions],
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
 * @deprecated Epic 8: This function is deprecated. Resolution now uses
 * majority-wins (trades won > 50%) instead of score calculation.
 * Kept for backward compatibility only.
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
 *
 * Story 9.2: Updated to use keccak256 from ethers.js to match backend.
 * The old sha3-256 (Bun.CryptoHasher) produces different hashes than keccak256.
 */
export function calculatePortfolioHash(portfolio: Portfolio): string {
  const json = JSON.stringify(portfolio);
  return keccak256(toUtf8Bytes(json));
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

// ============================================================================
// Epic 8: Trade-Based Betting (Majority-Wins Resolution)
// ============================================================================

import type { Trade, TradeList, TradeListSize } from './types';

/**
 * Trade position for Epic 8 bets
 */
export type TradePosition = 'LONG' | 'SHORT' | 'YES' | 'NO';

/**
 * Fetch current price for a ticker from backend
 *
 * @param source - Data source ('coingecko', 'polymarket', 'gamma')
 * @param ticker - Ticker symbol or market ID
 * @param backendUrl - Backend API URL
 * @returns Current price
 */
export async function fetchCurrentPrice(
  source: string,
  ticker: string,
  backendUrl: string
): Promise<number> {
  const url = `${backendUrl}/api/prices/${source}/${encodeURIComponent(ticker)}`;

  const response = await fetchWithTls(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch price for ${ticker}: ${response.status}`);
  }

  const data = await response.json();
  return data.price;
}

/**
 * Select random positions for trades
 *
 * @param trades - Trade list from snapshot
 * @returns Trades with positions assigned
 */
export function assignRandomPositions(trades: Trade[]): Trade[] {
  return trades.map(trade => ({
    ...trade,
    position: (trade.source === 'coingecko' || trade.source === 'stocks'
      ? (Math.random() > 0.5 ? 'LONG' : 'SHORT')
      : (Math.random() > 0.5 ? 'YES' : 'NO')) as TradePosition,
  }));
}

/**
 * Create trades with current entry prices
 *
 * Epic 8: Entry prices defined by creator at bet time.
 * Fetches current prices and assigns to trades.
 *
 * @param tradeList - Trade list from snapshot
 * @param backendUrl - Backend API URL
 * @returns Trades with entry prices
 */
export async function createTradesWithEntryPrices(
  tradeList: TradeList,
  backendUrl: string
): Promise<Trade[]> {
  // First assign random positions
  const tradesWithPositions = assignRandomPositions(tradeList.trades);

  // Then fetch current prices for each
  const tradesWithPrices = await Promise.all(
    tradesWithPositions.map(async (trade) => {
      try {
        const entryPrice = await fetchCurrentPrice(trade.source, trade.ticker, backendUrl);
        return {
          ...trade,
          entryPrice,
        };
      } catch (error) {
        // Use snapshot price as fallback
        console.warn(`Failed to fetch price for ${trade.ticker}, using snapshot price`);
        return trade;
      }
    })
  );

  return tradesWithPrices;
}

/**
 * Calculate the trades hash for on-chain commitment
 *
 * Epic 8: betHash = keccak256(trades JSON)
 * Story 9.2: Updated to use keccak256 from ethers.js to match backend.
 *
 * @param trades - Array of trades
 * @returns Hash string (0x prefixed)
 */
export function calculateTradesHash(trades: Trade[]): string {
  const json = JSON.stringify(trades);
  return keccak256(toUtf8Bytes(json));
}

/**
 * Calculate bitmap hash for on-chain commitment
 *
 * Story 9.2: New bitmap-based hash for compact position encoding.
 * Hash = keccak256(snapshot_id_bytes + bitmap_bytes)
 *
 * This MUST match the backend Rust implementation exactly.
 *
 * @param snapshotId - Snapshot ID string
 * @param trades - Array of trades with positions
 * @returns Hash string (0x prefixed)
 */
export function calculateBitmapTradesHash(snapshotId: string, trades: Trade[]): string {
  // Extract positions and encode as bitmap
  const positions = trades.map(t => t.position as 'LONG' | 'SHORT' | 'YES' | 'NO');
  const bitmap = encodePositionBitmap(positions);

  // Compute hash: keccak256(snapshotId_bytes + bitmap_bytes)
  return computeBitmapHash(snapshotId, bitmap);
}

/**
 * Serialize trades to JSON string
 *
 * @param trades - Array of trades
 * @returns JSON string
 */
export function serializeTrades(trades: Trade[]): string {
  return JSON.stringify(trades);
}

/**
 * Create opposite trades for matching (counter-portfolio)
 *
 * Epic 8: Matcher takes opposite positions
 *
 * @param trades - Original trades
 * @returns Trades with opposite positions
 */
export function createCounterTrades(trades: Trade[]): Trade[] {
  return trades.map(trade => ({
    ...trade,
    position: getOppositePosition(trade.position),
  }));
}

/**
 * Get the opposite position
 */
function getOppositePosition(position: TradePosition): TradePosition {
  switch (position) {
    case 'LONG': return 'SHORT';
    case 'SHORT': return 'LONG';
    case 'YES': return 'NO';
    case 'NO': return 'YES';
  }
}

/**
 * Check if a price is reasonable (within tolerance of current market)
 *
 * @param entryPrice - Entry price to check
 * @param currentPrice - Current market price
 * @param tolerance - Max allowed deviation (default 5%)
 * @returns true if price is reasonable
 */
export function isPriceReasonable(
  entryPrice: number,
  currentPrice: number,
  tolerance: number = 0.05
): boolean {
  if (currentPrice === 0) return false;
  const deviation = Math.abs(entryPrice - currentPrice) / currentPrice;
  return deviation <= tolerance;
}
