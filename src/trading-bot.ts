/**
 * Trading Bot Runner
 *
 * Main entry point for AI trading bot execution.
 * Coordinates market selection, price negotiation, bet lifecycle, and resolution.
 *
 * Story 7.6: AI Trading Bot Launch Scripts
 * AC: 1, 2, 3, 4, 5, 6
 */

import { getTradableMarkets, getTradableCryptoMarkets, getTradableStockMarkets, randomlySelectMarkets, type MarketScore, type CryptoMarketScore, type StockMarketScore } from "./market-selector";
import {
  evaluateOffer,
  generateCounterRate,
  createRandomPortfolio,
  createMixedPortfolio,
  createCounterPortfolio,
  calculateFairPrice,
  calculateImpliedRate,
  calculateOptimalOdds,
  DEFAULT_NEGOTIATION_CONFIG,
  type Portfolio,
  type PortfolioPosition,
  type NegotiationConfig,
  type OddsRiskProfile,
} from "./trading-strategy";
import {
  fetchPendingBets,
  canMatchBet,
  createInitialBotState,
  getAvailableCapital,
  canPlaceNewBet,
  updateStateAfterPlace,
  updateStateAfterMatch,
  preparePortfolioForChain,
  validatePortfolio,
  formatUSDC,
  calculateRemainingAmount,
  type BotState,
  type Bet,
  type LifecycleConfig,
} from "./bet-lifecycle";
import {
  calculateOddsAwareFillAmount,
  calculateOddsFavorability,
  logOddsSizingDecision,
  type RiskProfile,
} from "./bet-matching";
import { ResolutionTimerManager, formatTimeRemaining, getTimeRemainingSeconds } from "./resolution-timer";
import { ChainClient, createChainClientFromEnv, type TransactionResult } from "./chain-client";
import {
  getCurrentSnapshots,
  getTradeList,
  uploadTradesAsBitmap,
  uploadPositionBitmapWithRetry,
  type BitmapUploadResult,
} from "./snapshot-client";
import { extractPositionsFromTrades, computeBitmapHash } from "./bitmap-utils";
import type { Trade, TradeListSize } from "./types";
// Rate limiting and cancellation imports
import {
  checkRateLimits,
  recordFill,
  pruneFillHistory,
  loadRateLimitsFromEnv,
  formatRateLimitStatus,
  type FillRecord,
  type RateLimits,
} from "./rate-limiter";
import {
  evaluateAllBetsForCancellation,
  getBetsToCancel,
  loadCancellationConfigFromEnv,
  formatCancellationDecision,
  type CancellationConfig,
  type ActiveBetContext,
} from "./cancellation";

/**
 * Trading bot configuration
 */
export interface TradingBotConfig {
  /** Bot name for logging */
  name: string;
  /** Wallet address */
  walletAddress: string;
  /** Private key for signing (from env) */
  privateKey: string;
  /** Total capital in collateral token */
  capital: number;
  /** Risk profile */
  riskProfile: "conservative" | "balanced" | "aggressive";
  /** Number of markets to include in portfolios */
  portfolioSize: number;
  /** Backend API URL */
  backendUrl: string;
  /** Contract address */
  contractAddress: string;
  /** Negotiation config */
  negotiation: Partial<NegotiationConfig>;
  /** Resolution minutes (default: 30) */
  resolutionMinutes: number;
  /** Dry run mode (no actual transactions) */
  dryRun: boolean;
  /** Maximum bets per session */
  maxBetsPerSession: number;
  /** Session duration in minutes */
  sessionDurationMinutes: number;
  /** Rate limits configuration */
  rateLimits: RateLimits;
  /** Cancellation configuration */
  cancellation: CancellationConfig;
  /** Maximum concurrent active bets */
  maxConcurrentBets: number;
  /** Collateral token decimals (6 for USDC, 18 for WIND) */
  collateralDecimals: number;
  /** Epic 8: Categories to bet on (e.g., ['predictions', 'crypto']) */
  tradeCategories: string[];
  /** Epic 8: Trade list size ('1K', '10K', '100K') */
  tradeListSize: TradeListSize;
}

import { join } from "path";
import { RISK_PROFILE_SIZING, CANCELLATION_CHECK_INTERVAL_MS } from "./constants";
import { Logger } from "./logger";

// Initialize logger for this module
const logsDir = process.env.AGENT_LOGS_DIR || join(process.cwd(), "agent");
const fileLogger = new Logger(logsDir);

/**
 * Bot-specific logger that includes bot name in messages
 */
const logger = {
  info: (name: string, msg: string, data?: Record<string, unknown>) => {
    console.log(`[${name}] ${msg}`, data ? JSON.stringify(data) : "");
    fileLogger.info(`[${name}] ${msg}`, data);
  },
  warn: (name: string, msg: string, data?: Record<string, unknown>) => {
    console.log(`[${name}] WARN: ${msg}`, data ? JSON.stringify(data) : "");
    fileLogger.warn(`[${name}] ${msg}`, data);
  },
  error: (name: string, msg: string, data?: Record<string, unknown>) => {
    console.error(`[${name}] ERROR: ${msg}`, data ? JSON.stringify(data) : "");
    fileLogger.error(`[${name}] ${msg}`, data);
  },
  success: (name: string, msg: string, data?: Record<string, unknown>) => {
    console.log(`[${name}] SUCCESS: ${msg}`, data ? JSON.stringify(data) : "");
    fileLogger.info(`[${name}] [SUCCESS] ${msg}`, data);
  },
};

/**
 * Trading bot instance
 */
export class TradingBot {
  private config: TradingBotConfig;
  private state: BotState;
  private markets: MarketScore[] = [];
  private cryptoMarkets: CryptoMarketScore[] = [];
  private stockMarkets: StockMarketScore[] = [];
  private resolutionManager: ResolutionTimerManager;
  private chainClient: ChainClient | null = null;
  private running: boolean = false;
  private sessionBetCount: number = 0;
  private sessionStartTime: number = Date.now();
  // Rate limiting state
  private fillHistory: FillRecord[] = [];
  // Cancellation timing
  private lastCancellationCheck: number = 0;
  // Epic 8: Snapshot-based betting state
  private snapshotId: string | null = null;
  private snapshotTrades: Trade[] = [];
  private snapshotTradesHash: string = '';
  // Multi-category support: stores per-category snapshot data
  private categoryConfigs: Map<string, {
    snapshotId: string;
    trades: Trade[];
    tradesHash: string;
    markets: MarketScore[];
    listSize: TradeListSize;
  }> = new Map();
  private currentCategoryIndex: number = 0;
  private currentCategory: string = '';
  private currentListSize: TradeListSize = '10K';

  constructor(config: TradingBotConfig) {
    this.config = config;
    this.state = createInitialBotState(config.walletAddress, config.capital);
    this.resolutionManager = new ResolutionTimerManager({
      resolutionMinutes: config.resolutionMinutes,
    });

    // Initialize chain client for live trading
    if (!config.dryRun && config.privateKey) {
      this.chainClient = new ChainClient({
        privateKey: config.privateKey,
        contractAddress: config.contractAddress,
        collateralAddress: process.env.COLLATERAL_ADDRESS,
        resolutionDaoAddress: process.env.RESOLUTION_DAO_ADDRESS,
        rpcUrl: process.env.RPC_URL,
      });
      logger.info(config.name, "Chain client initialized for live trading");
    }

    // Set up resolution callback
    this.resolutionManager.setCallback(async (betId) => {
      return this.handleResolution(betId);
    });
  }

  /**
   * Get bot name
   */
  getName(): string {
    return this.config.name;
  }

  /**
   * Get current state
   */
  getState(): BotState {
    return this.state;
  }

  /**
   * Get resolution summary
   */
  getResolutionSummary() {
    return this.resolutionManager.getSummary();
  }

  /**
   * Initialize the bot - fetch markets and prepare for trading
   */
  async initialize(): Promise<boolean> {
    logger.info(this.config.name, "Initializing trading bot...");
    logger.info(this.config.name, `Capital: $${this.config.capital}`);
    logger.info(this.config.name, `Risk profile: ${this.config.riskProfile}`);
    logger.info(this.config.name, `Portfolio size: ${this.config.portfolioSize} markets`);

    try {
      // Epic 8: Use snapshot-based market selection when TRADE_CATEGORIES is configured
      if (this.config.tradeCategories.length > 0) {
        logger.info(this.config.name, `Using snapshot system: categories=${this.config.tradeCategories.join(',')}, listSize=${this.config.tradeListSize}`);

        const snapshots = await getCurrentSnapshots(this.config.backendUrl);
        let loadedCount = 0;

        for (const category of this.config.tradeCategories) {
          const snapshot = snapshots[category];

          if (!snapshot) {
            logger.warn(this.config.name, `No current snapshot found for category: ${category} - skipping`);
            logger.info(this.config.name, `Available categories: ${Object.keys(snapshots).join(', ')}`);
            continue;
          }

          logger.info(this.config.name, `Found snapshot for ${category}: ${snapshot.id} (created: ${snapshot.createdAt})`);

          // Determine list size: parse from category name (poly-1k→1K, gecko-10k→10K, *-all→ALL)
          let listSize: TradeListSize = this.config.tradeListSize;
          if (category.endsWith('-1k')) listSize = '1K' as TradeListSize;
          else if (category.endsWith('-10k')) listSize = '10K' as TradeListSize;
          else if (category.endsWith('-all')) listSize = 'ALL' as TradeListSize;

          // Fetch the trade list for the category-appropriate size
          try {
            const tradeList = await getTradeList(
              this.config.backendUrl,
              snapshot.id,
              listSize
            );

            const trades = tradeList.trades;
            const tradesHash = tradeList.tradesHash;
            logger.success(this.config.name, `[${category}] Fetched ${trades.length} trades (${this.config.tradeListSize} list, hash: ${tradesHash.slice(0, 10)}...)`);

            // Convert snapshot trades to MarketScores for portfolio creation
            const markets: MarketScore[] = trades.map((trade: Trade, index: number) => ({
              marketId: trade.id || `${trade.source}:${trade.method}:${trade.ticker}`,
              question: trade.ticker,
              priceYes: trade.entryPrice || 0.5,
              priceNo: trade.entryPrice ? (1 - trade.entryPrice) : 0.5,
              score: trades.length - index,
              reasons: [trade.source, trade.method],
              endDate: null,
            }));

            // Store per-category config
            this.categoryConfigs.set(category, {
              snapshotId: snapshot.id,
              trades,
              tradesHash,
              markets,
              listSize,
            });

            loadedCount++;
            logger.success(this.config.name, `[${category}] Loaded ${markets.length} market scores`);
          } catch (e) {
            logger.error(this.config.name, `[${category}] Failed to fetch trade list: ${e}`);
          }
        }

        if (loadedCount === 0) {
          logger.error(this.config.name, `No categories loaded successfully`);
          return false;
        }

        // Set first category as default (backward compat)
        const firstCategory = this.config.tradeCategories.find(c => this.categoryConfigs.has(c));
        if (firstCategory) {
          const cfg = this.categoryConfigs.get(firstCategory)!;
          this.snapshotId = cfg.snapshotId;
          this.snapshotTrades = cfg.trades;
          this.snapshotTradesHash = cfg.tradesHash;
          this.markets = cfg.markets;
        }

        logger.success(this.config.name, `Loaded ${loadedCount}/${this.config.tradeCategories.length} categories`);

        const minMarkets = Math.min(...Array.from(this.categoryConfigs.values()).map(c => c.markets.length));
        if (minMarkets < 100) {
          logger.warn(this.config.name, `Some categories have very few markets (min: ${minMarkets})`);
        }

        return true;
      }

      // Fallback: Legacy Polymarket market fetching
      this.markets = await getTradableMarkets(
        { backendUrl: this.config.backendUrl },
        this.config.portfolioSize + 500
      );

      if (this.markets.length === 0) {
        logger.error(this.config.name, "No tradeable Polymarket markets found!");
        return false;
      }

      logger.success(this.config.name, `Found ${this.markets.length} tradeable Polymarket markets`);

      // Fetch CoinGecko crypto markets for mixed portfolios
      this.cryptoMarkets = await getTradableCryptoMarkets(
        { backendUrl: this.config.backendUrl },
        100
      );

      if (this.cryptoMarkets.length > 0) {
        logger.success(this.config.name, `Found ${this.cryptoMarkets.length} tradeable crypto markets`);
      } else {
        logger.warn(this.config.name, "No crypto markets found - will use Polymarket only");
      }

      // Fetch stock markets for mixed portfolios
      this.stockMarkets = await getTradableStockMarkets(
        { backendUrl: this.config.backendUrl },
        100
      );

      if (this.stockMarkets.length > 0) {
        logger.success(this.config.name, `Found ${this.stockMarkets.length} tradeable stock markets`);
      } else {
        logger.warn(this.config.name, "No stock markets found - will use other sources only");
      }

      return true;
    } catch (error) {
      logger.error(this.config.name, `Initialization failed: ${error}`);
      return false;
    }
  }

  /**
   * Start the trading loop
   */
  async start(): Promise<void> {
    this.running = true;
    this.sessionStartTime = Date.now();
    this.sessionBetCount = 0;

    logger.info(this.config.name, "Starting trading session");
    logger.info(this.config.name, `Max bets: ${this.config.maxBetsPerSession}`);
    logger.info(this.config.name, `Session duration: ${this.config.sessionDurationMinutes} minutes`);

    // Start resolution timer
    this.resolutionManager.start();

    // Main trading loop
    while (this.running && !this.shouldEndSession()) {
      try {
        await this.tradingCycle();
      } catch (error) {
        logger.error(this.config.name, `Trading cycle error: ${error}`);
      }

      // Wait before next cycle
      await this.sleep(this.config.negotiation.pollIntervalMs || 5000);
    }

    logger.info(this.config.name, "Trading session ended");
    this.printSessionSummary();
  }

  /**
   * Stop the trading loop
   */
  stop(): void {
    this.running = false;
    this.resolutionManager.stop();
    logger.info(this.config.name, "Stopping trading bot");
  }

  /**
   * Check if session should end
   */
  private shouldEndSession(): boolean {
    // Check max bets
    if (this.sessionBetCount >= this.config.maxBetsPerSession) {
      logger.info(this.config.name, "Max bets reached for session");
      return true;
    }

    // Check session duration
    const elapsedMinutes = (Date.now() - this.sessionStartTime) / (60 * 1000);
    if (elapsedMinutes >= this.config.sessionDurationMinutes) {
      logger.info(this.config.name, "Session duration reached");
      return true;
    }

    return false;
  }

  /**
   * Single trading cycle
   */
  private async tradingCycle(): Promise<void> {
    // Prune old fill history (older than 31 days)
    this.fillHistory = pruneFillHistory(this.fillHistory);

    // Check for cancellations periodically
    const now = Date.now();
    if (now - this.lastCancellationCheck >= CANCELLATION_CHECK_INTERVAL_MS) {
      this.lastCancellationCheck = now;
      await this.checkForCancellations();
    }

    // Check for pending bets to match
    logger.info(this.config.name, `Fetching pending bets from ${this.config.backendUrl}...`);
    const pendingBets = await fetchPendingBets(
      { backendUrl: this.config.backendUrl },
      this.config.walletAddress
    );

    logger.info(this.config.name, `Fetched ${pendingBets.length} matchable bets from API`);

    if (pendingBets.length > 0) {
      logger.info(this.config.name, `Found ${pendingBets.length} pending bets to evaluate`);

      for (const bet of pendingBets) {
        logger.info(this.config.name, `Evaluating bet ${bet.betId} from ${bet.creatorAddress.slice(0, 10)}...`);
        await this.evaluateAndMatch(bet);
      }
    } else {
      logger.info(this.config.name, `No matchable bets from other creators`);
    }

    // Consider placing a new bet if we have capacity
    if (canPlaceNewBet(this.state, { maxPendingBets: 3, minBetAmount: 1 })) {
      await this.considerPlacingBet();
    }
  }

  /**
   * Check for bets that should be cancelled
   */
  private async checkForCancellations(): Promise<void> {
    // Build context for active bets
    // For now, we only have bet IDs, not full bet objects with prices
    // In a real implementation, we'd fetch bet details from backend
    if (this.state.activeBetIds.length === 0) {
      return;
    }

    logger.info(this.config.name, `Checking ${this.state.activeBetIds.length} active bets for cancellation`);

    // Fetch active bet details and evaluate
    const activeBetContexts: ActiveBetContext[] = [];
    for (const betId of this.state.activeBetIds) {
      // In real implementation, fetch bet details from backend
      // For now, create a minimal context
      const mockBet: Bet = {
        betId,
        creatorAddress: this.config.walletAddress,
        betHash: "",
        portfolioSize: 0,
        amount: "0",
        creatorStake: "0",
        requiredMatch: "0",
        matchedAmount: "0",
        oddsBps: 0,
        status: "pending",
        createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // Mock: 5 min old
        updatedAt: new Date().toISOString(),
      };
      activeBetContexts.push({ bet: mockBet });
    }

    const decisions = evaluateAllBetsForCancellation(
      activeBetContexts,
      this.config.cancellation
    );

    const toCancel = getBetsToCancel(decisions);

    for (const { betId, decision } of toCancel) {
      logger.info(this.config.name, formatCancellationDecision(betId, decision));

      if (!this.config.dryRun && this.chainClient) {
        // Execute actual cancellation
        const result = await this.chainClient.cancelBet(betId);
        if (result.success) {
          logger.success(this.config.name, `Cancelled bet ${betId}! TX: ${result.txHash}`);
          // Remove from active bets after successful cancellation
          this.state.activeBetIds = this.state.activeBetIds.filter(id => id !== betId);
        } else {
          // Check if bet was already cancelled (BetNotOpen error)
          const alreadyCancelled = result.error?.includes("BetNotOpen") ||
            result.error?.includes("0x13254c6a") ||
            result.error?.includes("not open");
          if (alreadyCancelled) {
            logger.info(this.config.name, `Bet ${betId} already cancelled, removing from active list`);
            this.state.activeBetIds = this.state.activeBetIds.filter(id => id !== betId);
          } else {
            logger.warn(this.config.name, `Failed to cancel bet ${betId}: ${result.error}`);
          }
        }
      } else {
        logger.info(this.config.name, `[DRY RUN] Would cancel bet ${betId}`);
      }
    }
  }

  /**
   * Evaluate a pending bet and potentially match it
   */
  private async evaluateAndMatch(bet: Bet): Promise<void> {
    if (!canMatchBet(bet)) {
      return;
    }

    // Build market prices map from current market data
    const marketPrices = this.buildMarketPricesMap();

    // Calculate fair price from portfolio positions
    const portfolio = bet.portfolio || { positions: [], createdAt: new Date().toISOString() };
    const impliedRate = portfolio.positions.length > 0
      ? calculateImpliedRate(portfolio, marketPrices)
      : 0.5; // Default to 50% if no portfolio positions

    // For matching, fair price is the complement if we're betting against the creator
    // If implied rate is high (creator expects YES), matcher should price lower
    const fairPrice = impliedRate;

    // Create a pending bet structure for evaluation
    // Use requiredMatch for asymmetric odds, fall back to amount
    const remaining = calculateRemainingAmount(bet);
    const pendingBet = {
      betId: bet.betId,
      creator: bet.creatorAddress,
      portfolio: portfolio,
      amount: bet.creatorStake || bet.amount,
      remainingAmount: remaining.toString(),
      impliedRate: impliedRate,
      createdAt: bet.createdAt,
      oddsBps: bet.oddsBps, // Include odds for evaluation
    };

    // Evaluate the offer
    const evaluation = evaluateOffer(
      pendingBet,
      fairPrice,
      { ...DEFAULT_NEGOTIATION_CONFIG, ...this.config.negotiation },
      this.state.activeBetIds.length > 0
    );

    logger.info(this.config.name, `Evaluated bet ${bet.betId}: ${evaluation.action}`, {
      priceDiff: evaluation.priceDiffBps,
      reason: evaluation.reason,
    });

    // Take action based on evaluation
    if (evaluation.action === "ACCEPT") {
      await this.matchBet(bet);
    } else if (evaluation.action === "COUNTER") {
      // For now, just log the counter-offer
      logger.info(this.config.name, `Would counter bet ${bet.betId} at rate ${evaluation.fairPrice}`);
    }
  }

  /**
   * Match a bet with odds-aware sizing
   * Updated for Story 7-14/7-15: Uses asymmetric odds for EV-adjusted sizing
   * Now includes rate limit checking
   */
  private async matchBet(bet: Bet): Promise<void> {
    const available = getAvailableCapital(this.state);
    // calculateRemainingAmount returns base units (bigint), convert to human-readable for sizing
    const remainingBaseUnits = calculateRemainingAmount(bet);
    const decimalsMultiplier = 10 ** this.config.collateralDecimals;
    const remainingTokens = (Number(remainingBaseUnits) / decimalsMultiplier).toString();

    // Pre-calculate expected fill amount for rate limit check
    const riskPercent = RISK_PROFILE_SIZING[this.config.riskProfile];
    const estimatedFillTokens = Math.min(available * riskPercent, parseFloat(remainingTokens));

    // Check rate limits before proceeding
    const rateLimitResult = checkRateLimits(
      this.fillHistory,
      this.config.rateLimits,
      estimatedFillTokens
    );

    if (!rateLimitResult.allowed) {
      logger.warn(this.config.name, `Rate limit: ${rateLimitResult.reason}`, {
        waitTimeSeconds: rateLimitResult.waitTimeSeconds,
        status: formatRateLimitStatus(rateLimitResult),
      });
      return;
    }

    let fillAmount: string;

    // Use odds-aware sizing if bet has odds data (Story 7-15)
    if (bet.oddsBps && bet.oddsBps > 0) {
      // Map config risk profile to RiskProfile type
      const riskProfile: RiskProfile = this.config.riskProfile === "conservative"
        ? "conservative"
        : this.config.riskProfile === "aggressive"
        ? "aggressive"
        : "balanced";

      // calculateOddsAwareFillAmount now accepts decimals parameter
      fillAmount = calculateOddsAwareFillAmount(
        available,
        riskProfile,
        remainingTokens,
        bet.oddsBps,
        this.config.collateralDecimals
      );

      // Log the odds-aware sizing decision
      const favorability = calculateOddsFavorability(bet.oddsBps);
      logger.info(this.config.name, `Odds-aware sizing: ${favorability.favorabilityRatio.toFixed(2)}x favorability`, {
        oddsBps: bet.oddsBps,
        oddsDecimal: favorability.oddsDecimal,
        matcherReturn: favorability.matcherReturn,
      });
    } else {
      // Fall back to basic sizing for legacy bets without odds
      // Use odds-aware fill with default 1.0x odds (10000 bps)
      const riskProfile: RiskProfile = this.config.riskProfile === "conservative"
        ? "conservative"
        : this.config.riskProfile === "aggressive"
        ? "aggressive"
        : "balanced";
      fillAmount = calculateOddsAwareFillAmount(
        available,
        riskProfile,
        remainingTokens,
        10000, // Default 1.0x odds
        this.config.collateralDecimals
      );
    }

    // Fix precision: clamp fill to never exceed remaining, and snap up if within 100 wei
    // This prevents both rounding-up overflows (off-by-1 revert) and dust amounts
    const fillBigInt = BigInt(fillAmount);
    if (fillBigInt > 0n && remainingBaseUnits > 0n) {
      // Always clamp to remaining (prevents float→bigint rounding-up overflow)
      if (fillBigInt > remainingBaseUnits) {
        fillAmount = remainingBaseUnits.toString();
      }
      // Snap up: if within 100 wei of remaining, fill exact remaining
      const clampedFill = BigInt(fillAmount);
      const diff = remainingBaseUnits - clampedFill;
      if (diff >= 0n && diff <= 100n) {
        fillAmount = remainingBaseUnits.toString();
      }
    }

    if (fillAmount === "0") {
      logger.warn(this.config.name, `Fill amount too small for bet ${bet.betId}`);
      return;
    }

    // Calculate fill in human-readable tokens for logging
    const fillTokens = Number(fillAmount) / decimalsMultiplier;
    logger.info(this.config.name, `Matching bet ${bet.betId} with ${fillTokens.toFixed(4)} tokens`);

    if (this.config.dryRun) {
      logger.info(this.config.name, "[DRY RUN] Would match bet");
      // Update state as if we matched
      this.state = updateStateAfterMatch(this.state, bet.betId, fillAmount);
      this.sessionBetCount++;

      // Record fill for rate limiting (use fillTokens which is in human-readable units)
      this.fillHistory = recordFill(this.fillHistory, bet.betId, fillTokens);
      logger.info(this.config.name, formatRateLimitStatus(
        checkRateLimits(this.fillHistory, this.config.rateLimits, 0)
      ));

      // Add to resolution tracking
      this.resolutionManager.addBet(bet.betId);
    } else {
      // Execute on-chain match
      if (!this.chainClient) {
        logger.error(this.config.name, "Chain client not initialized for live trading");
        return;
      }

      const fillAmountBigInt = BigInt(fillAmount);
      const result = await this.chainClient.matchBet(bet.betId, fillAmountBigInt);

      if (result.success) {
        logger.success(this.config.name, `Matched bet ${bet.betId}! TX: ${result.txHash}`);
        this.state = updateStateAfterMatch(this.state, bet.betId, fillAmount);
        this.sessionBetCount++;

        // Record fill for rate limiting (use fillTokens which is in human-readable units)
        this.fillHistory = recordFill(this.fillHistory, bet.betId, fillTokens);
        logger.info(this.config.name, formatRateLimitStatus(
          checkRateLimits(this.fillHistory, this.config.rateLimits, 0)
        ));

        this.resolutionManager.addBet(bet.betId);
      } else {
        logger.error(this.config.name, `Failed to match bet ${bet.betId}: ${result.error}`);
      }
    }
  }

  /**
   * Switch to the next category in the rotation (multi-category support)
   */
  private switchToNextCategory(): string | null {
    if (this.categoryConfigs.size === 0) return null;

    const categories = Array.from(this.categoryConfigs.keys());
    this.currentCategoryIndex = (this.currentCategoryIndex + 1) % categories.length;
    const category = categories[this.currentCategoryIndex];
    const cfg = this.categoryConfigs.get(category)!;

    // Update active state
    this.snapshotId = cfg.snapshotId;
    this.snapshotTrades = cfg.trades;
    this.snapshotTradesHash = cfg.tradesHash;
    this.markets = cfg.markets;
    this.currentCategory = category;
    this.currentListSize = cfg.listSize;

    return category;
  }

  /**
   * Consider placing a new bet
   */
  private async considerPlacingBet(): Promise<void> {
    // Check if we should place a bet (random chance to add variety)
    if (Math.random() > 0.3) {
      return; // 70% chance to skip, adds variety to timing
    }

    // Multi-category: rotate to next category before placing
    if (this.categoryConfigs.size > 1) {
      const category = this.switchToNextCategory();
      if (category) {
        logger.info(this.config.name, `Switched to category: ${category} (snapshot: ${this.snapshotId})`);
      }
    }

    const available = getAvailableCapital(this.state);
    if (available < 1) {
      return;
    }

    // Check rate limits before calculating bet size
    const riskPercent = RISK_PROFILE_SIZING[this.config.riskProfile];
    const estimatedBetUSDC = available * riskPercent;

    const rateLimitResult = checkRateLimits(
      this.fillHistory,
      this.config.rateLimits,
      estimatedBetUSDC
    );

    if (!rateLimitResult.allowed) {
      logger.warn(this.config.name, `Rate limit (place): ${rateLimitResult.reason}`, {
        waitTimeSeconds: rateLimitResult.waitTimeSeconds,
      });
      return;
    }

    // Check max concurrent bets limit
    if (this.state.activeBetIds.length >= this.config.maxConcurrentBets) {
      logger.info(this.config.name, `Max concurrent bets reached (${this.state.activeBetIds.length}/${this.config.maxConcurrentBets})`);
      return;
    }

    // Select random markets for portfolio
    const selectedMarkets = randomlySelectMarkets(this.markets, this.config.portfolioSize);

    if (selectedMarkets.length === 0) {
      logger.warn(this.config.name, "No markets selected for portfolio");
      return;
    }

    // Create portfolio based on mode: snapshot or legacy
    let portfolio: Portfolio;
    let selectedTrades: Trade[] = []; // Track selected trades for snapshot mode

    if (this.snapshotId && this.snapshotTrades.length > 0) {
      // Epic 8: Create portfolio from snapshot trades
      // Select random subset of trades matching portfolioSize
      const shuffled = [...this.snapshotTrades].sort(() => Math.random() - 0.5);
      const selected = shuffled.slice(0, Math.min(this.config.portfolioSize, shuffled.length));
      // Build lookup from trade ID -> market priceYes for entry prices
      const priceMap = new Map<string, number>();
      for (const m of this.markets) {
        priceMap.set(m.marketId, m.priceYes);
      }
      // Ensure entryPrice is set on all trades
      // Extract conditionId from trade.id (format: "{conditionId}/polymarket/binary")
      // since priceMap may be keyed by conditionId
      selectedTrades = selected.map((trade: Trade) => {
        const conditionId = trade.id?.split('/')[0] || trade.id;
        return {
          ...trade,
          entryPrice: trade.entryPrice || priceMap.get(conditionId) || priceMap.get(trade.id) || 0.5,
        };
      });
      const weight = 1 / selectedTrades.length;

      const positions: PortfolioPosition[] = selectedTrades.map((trade: Trade) => ({
        marketId: trade.id || `${trade.source}:${trade.method}:${trade.ticker}`,
        position: trade.position
          ? ((trade.position === "LONG" || trade.position === "YES") ? "YES" as const : "NO" as const)
          : (Math.random() > 0.5 ? "YES" as const : "NO" as const),
        weight,
      }));

      portfolio = { positions, createdAt: new Date().toISOString() };
      logger.info(this.config.name, `Snapshot portfolio: ${positions.length} positions from snapshot ${this.snapshotId}`);
    } else {
      // Legacy: Mixed with crypto if available, otherwise Polymarket only
      const cryptoRatio = this.cryptoMarkets.length > 0 ? 0.2 : 0;
      portfolio = this.cryptoMarkets.length > 0
        ? createMixedPortfolio(selectedMarkets, this.cryptoMarkets, this.config.portfolioSize, cryptoRatio)
        : createRandomPortfolio(selectedMarkets, this.config.portfolioSize);

      if (cryptoRatio > 0) {
        const cryptoCount = portfolio.positions.filter(p => p.marketId.startsWith("coingecko:")).length;
        const polyCount = portfolio.positions.length - cryptoCount;
        logger.info(this.config.name, `Mixed portfolio: ${polyCount} Polymarket + ${cryptoCount} CoinGecko positions`);
      }
    }

    // Validate portfolio
    const validation = validatePortfolio(portfolio);
    if (!validation.valid) {
      logger.error(this.config.name, `Invalid portfolio: ${validation.errors.join(", ")}`);
      return;
    }

    // Minimum 1000 markets per bet to ensure meaningful portfolios
    const MIN_PORTFOLIO_SIZE = 1000;
    if (portfolio.positions.length < MIN_PORTFOLIO_SIZE) {
      logger.error(this.config.name, `Portfolio too small: ${portfolio.positions.length} positions (min ${MIN_PORTFOLIO_SIZE})`);
      return;
    }

    // Calculate bet amount (reusing riskPercent from above)
    // Use configurable decimals for collateral token (6 for USDC, 18 for WIND)
    const decimalsMultiplier = BigInt(10) ** BigInt(this.config.collateralDecimals);

    // In TEST_MODE, always bet exactly 0.01 tokens (1 cent worth)
    const isTestMode = process.env.TEST_MODE === "true";
    // For 18 decimals: 0.01 tokens = 10^16 base units
    // For 6 decimals: 0.01 tokens = 10^4 base units
    const testBetAmount = (decimalsMultiplier * BigInt(3)) / BigInt(100); // 0.03 tokens (ensures requiredMatch >= minBet at 2x odds)
    const normalBetAmount = BigInt(Math.floor(available * riskPercent * Number(decimalsMultiplier)));
    const betAmount = isTestMode ? testBetAmount : normalBetAmount;

    // Minimum 0.01 tokens
    const minBetAmount = decimalsMultiplier / BigInt(100);
    if (betAmount < minBetAmount) {
      return;
    }

    if (isTestMode) {
      logger.info(this.config.name, `[TEST MODE] Betting 0.01 tokens only`);
    }

    // Calculate dynamic odds based on portfolio's average market price
    const avgPrice = portfolio.positions.reduce((sum, p) => {
      const market = this.markets.find(m => m.marketId === p.marketId);
      return sum + (market?.priceYes || 0.5);
    }, 0) / portfolio.positions.length;

    // Determine primary position (most common direction in portfolio)
    const yesCount = portfolio.positions.filter(p => p.position === "YES").length;
    const primaryPosition: "YES" | "NO" = yesCount >= portfolio.positions.length / 2 ? "YES" : "NO";

    const oddsBps = calculateOptimalOdds(
      avgPrice,
      primaryPosition,
      this.config.riskProfile as OddsRiskProfile
    );

    // Calculate resolution deadline based on earliest market end date in portfolio
    const marketEndDates = portfolio.positions
      .map(p => {
        const market = this.markets.find(m => m.marketId === p.marketId);
        return market?.endDate;
      })
      .filter((d): d is string => d !== null && d !== undefined)
      .map(d => new Date(d).getTime() / 1000);

    // Use earliest market end, or 24 hours from now if no end dates available
    const defaultDeadline = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

    // In TEST_MODE, use short resolution deadline (RESOLUTION_MINUTES from config)
    const testDeadline = Math.floor(Date.now() / 1000) + this.config.resolutionMinutes * 60;

    const resolutionDeadline = isTestMode
      ? testDeadline
      : (marketEndDates.length > 0 ? Math.min(...marketEndDates) : defaultDeadline);

    // Format bet amount for display (convert from base units to human readable)
    const displayAmount = Number(betAmount) / Number(decimalsMultiplier);

    // Determine trade horizon from category config or use default
    const categoryHorizon = this.currentCategory
      ? this.getCategoryHorizon(this.currentCategory)
      : 'short';

    logger.info(this.config.name, `Placing bet with ${displayAmount.toFixed(4)} tokens`);
    logger.info(this.config.name, `Portfolio: ${portfolio.positions.length} positions`);
    logger.info(this.config.name, `Category: ${this.currentCategory || 'default'}, Horizon: ${categoryHorizon}`);
    logger.info(this.config.name, `Odds: ${(oddsBps / 10000).toFixed(2)}x, Deadline: ${new Date(resolutionDeadline * 1000).toISOString()}`);

    if (this.config.dryRun) {
      logger.info(this.config.name, "[DRY RUN] Would place bet");
      // Simulate bet placement
      const fakeBetId = `dry-run-${Date.now()}`;
      this.state = updateStateAfterPlace(this.state, fakeBetId, betAmount.toString());
      this.sessionBetCount++;

      // Record fill for rate limiting (use displayAmount which is in human-readable units)
      this.fillHistory = recordFill(this.fillHistory, fakeBetId, displayAmount);
      logger.info(this.config.name, formatRateLimitStatus(
        checkRateLimits(this.fillHistory, this.config.rateLimits, 0)
      ));
    } else {
      // Execute on-chain bet placement
      if (!this.chainClient) {
        logger.error(this.config.name, "Chain client not initialized for live trading");
        return;
      }

      // Serialize selected trades for on-chain hash commitment (used by backend for verification)
      const tradesJsonForHash = selectedTrades.length > 0 ? JSON.stringify(selectedTrades) : undefined;

      const result = await this.chainClient.placeBet(
        portfolio,
        BigInt(betAmount),
        oddsBps,
        resolutionDeadline,
        undefined, // jsonStorageRef
        this.snapshotId || undefined, // Pass real snapshotId for Epic 8
        this.snapshotTradesHash || undefined, // Pass backend's trades hash for on-chain commitment
        tradesJsonForHash // Trades JSON for betHash computation (backend verification)
      );

      if (result.success) {
        const betId = result.betId || `placed-${Date.now()}`;
        logger.success(this.config.name, `Placed bet ${betId}! TX: ${result.txHash}`);
        this.state = updateStateAfterPlace(this.state, betId, betAmount.toString());
        this.sessionBetCount++;

        // Record fill for rate limiting (use displayAmount which is in human-readable units)
        this.fillHistory = recordFill(this.fillHistory, betId, displayAmount);
        logger.info(this.config.name, formatRateLimitStatus(
          checkRateLimits(this.fillHistory, this.config.rateLimits, 0)
        ));

        // Story 9.2: Upload positions using bitmap encoding
        // Wait a moment for the indexer to process the BetPlaced event
        await new Promise(resolve => setTimeout(resolve, 3000));

        const backendUrl = process.env.BACKEND_URL || "http://localhost:3001";

        // Use bitmap upload for Epic 8+ trades (efficient 1-bit-per-position encoding)
        // This replaces the old JSON upload and reduces 800KB → 1.7KB for 10K trades
        if (selectedTrades.length > 0 && this.snapshotId) {
          // Extract positions and upload as bitmap
          const positions = extractPositionsFromTrades(selectedTrades);

          logger.info(
            this.config.name,
            `Uploading ${positions.length} positions as bitmap for bet ${betId} (snapshot: ${this.snapshotId})`
          );

          const bitmapResult = await uploadPositionBitmapWithRetry(
            backendUrl,
            parseInt(betId),
            this.snapshotId,
            positions,
            this.currentListSize || '10K',
            5,  // maxRetries
            5000 // initialDelayMs
          );

          if (bitmapResult.success) {
            logger.info(
              this.config.name,
              `Bitmap uploaded for bet ${betId}: ${bitmapResult.tradesCount} trades, ` +
              `${bitmapResult.bitmapSizeBytes} bytes, hash verified: ${bitmapResult.hashVerified}`
            );
          } else {
            logger.warn(
              this.config.name,
              `Bitmap upload failed for bet ${betId}: ${bitmapResult.error} (code: ${bitmapResult.code})`
            );
            // Bet is still placed on-chain, just without backend position data
          }
        } else if (selectedTrades.length > 0) {
          // Fallback: Legacy upload for bets without snapshotId (shouldn't happen in Epic 8+)
          logger.warn(
            this.config.name,
            `No snapshotId for bet ${betId}, cannot use bitmap upload. ` +
            `This may cause 413 errors for large portfolios.`
          );
        }
      } else {
        logger.error(this.config.name, `Failed to place bet: ${result.error}`);
      }
    }
  }

  /**
   * Handle bet resolution
   *
   * Flow:
   * 1. Check if keeper has resolved the bet via ResolutionDAO
   * 2. If resolved and can settle, call settleBetViaDao()
   * 3. Check if we won
   * 4. If we won, claim winnings
   */
  private async handleResolution(betId: string): Promise<boolean> {
    logger.info(this.config.name, `Checking resolution for bet ${betId}`);

    if (this.config.dryRun) {
      logger.info(this.config.name, "[DRY RUN] Would check and settle bet");
      return true;
    }

    if (!this.chainClient) {
      logger.error(this.config.name, "Chain client not initialized for resolution");
      return false;
    }

    // Step 1: Check if bet has been resolved by keepers
    const resolution = await this.chainClient.getResolution(betId);
    if (!resolution) {
      logger.warn(this.config.name, `Bet ${betId} not yet resolved by keepers - will retry later`);
      return false;
    }

    logger.info(this.config.name, `Bet ${betId} resolved: creatorWins=${resolution.creatorWins}, isTie=${resolution.isTie}, isCancelled=${resolution.isCancelled}`);

    // Step 2: Check if bet is already settled
    const isSettled = await this.chainClient.isBetSettled(betId);
    if (!isSettled) {
      // Try to settle the bet
      const canSettle = await this.chainClient.canSettleBet(betId);
      if (canSettle) {
        logger.info(this.config.name, `Settling bet ${betId}...`);
        const settleResult = await this.chainClient.settleBetViaDao(betId);
        if (!settleResult.success) {
          logger.error(this.config.name, `Failed to settle bet ${betId}: ${settleResult.error}`);
          return false;
        }
        logger.success(this.config.name, `Bet ${betId} settled successfully`, { txHash: settleResult.txHash });
      } else {
        logger.warn(this.config.name, `Bet ${betId} cannot be settled yet (may have pending dispute)`);
        return false;
      }
    }

    // Step 3: Check if we won
    const winner = await this.chainClient.getBetWinner(betId);
    const walletAddress = this.config.walletAddress.toLowerCase();
    const isWinner = winner?.toLowerCase() === walletAddress;

    if (!isWinner) {
      logger.info(this.config.name, `Bet ${betId}: We did not win (winner: ${winner})`);
      return true; // Resolution complete, just didn't win
    }

    // Step 4: Claim winnings if not already claimed
    const alreadyClaimed = await this.chainClient.areWinningsClaimed(betId);
    if (alreadyClaimed) {
      logger.info(this.config.name, `Bet ${betId}: Winnings already claimed`);
      return true;
    }

    const payout = await this.chainClient.getWinnerPayout(betId);
    logger.info(this.config.name, `Claiming winnings for bet ${betId}: ${payout?.toString() || '0'} base units`);

    const claimResult = await this.chainClient.claimWinnings(betId);
    if (!claimResult.success) {
      logger.error(this.config.name, `Failed to claim winnings for bet ${betId}: ${claimResult.error}`);
      return false;
    }

    logger.success(this.config.name, `Winnings claimed for bet ${betId}`, { txHash: claimResult.txHash, payout: payout?.toString() });
    return true;
  }

  /**
   * Build a map of market prices from current market data
   * Used for calculating fair prices for portfolio evaluation
   */
  private buildMarketPricesMap(): Map<string, { priceYes: number; priceNo: number }> {
    const priceMap = new Map<string, { priceYes: number; priceNo: number }>();

    // Add Polymarket/prediction markets
    for (const market of this.markets) {
      priceMap.set(market.marketId, {
        priceYes: market.priceYes,
        priceNo: 1 - market.priceYes,
      });
    }

    // Add crypto markets (CoinGecko format)
    // Price change normalizer: divide by 200 to map ±100% change to ±0.5 price shift
    const PRICE_CHANGE_NORMALIZER = 200;
    for (const crypto of this.cryptoMarkets) {
      // Crypto markets use a normalized price between 0-1 based on 24h change
      // Positive change = YES (bullish), negative = NO (bearish)
      const change24h = crypto.priceChange24h ?? 0; // Handle null/undefined
      const priceYes = 0.5 + (change24h / PRICE_CHANGE_NORMALIZER);
      const normalizedPrice = Math.max(0.1, Math.min(0.9, priceYes));
      priceMap.set(`coingecko:deterministic:${crypto.symbol}`, {
        priceYes: normalizedPrice,
        priceNo: 1 - normalizedPrice,
      });
    }

    // Add stock markets if available
    for (const stock of this.stockMarkets) {
      const changePct = stock.priceChangePct ?? 0; // Handle null/undefined
      const priceYes = 0.5 + (changePct / PRICE_CHANGE_NORMALIZER);
      const normalizedPrice = Math.max(0.1, Math.min(0.9, priceYes));
      priceMap.set(`stocks:deterministic:${stock.symbol}`, {
        priceYes: normalizedPrice,
        priceNo: 1 - normalizedPrice,
      });
    }

    // Add snapshot trades if available (Epic 8)
    for (const trade of this.snapshotTrades) {
      const marketId = trade.id || `${trade.source}:${trade.method}:${trade.ticker}`;
      if (!priceMap.has(marketId)) {
        const entryPrice = trade.entryPrice || 0.5;
        priceMap.set(marketId, {
          priceYes: entryPrice,
          priceNo: 1 - entryPrice,
        });
      }
    }

    return priceMap;
  }

  /**
   * Print session summary
   */
  private printSessionSummary(): void {
    const elapsed = Date.now() - this.sessionStartTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);

    console.log("");
    console.log("═══════════════════════════════════════════");
    console.log(`  Session Summary: ${this.config.name}`);
    console.log("═══════════════════════════════════════════");
    console.log(`  Duration: ${minutes}m ${seconds}s`);
    console.log(`  Bets placed/matched: ${this.sessionBetCount}`);
    console.log(`  Active bets: ${this.state.activeBetIds.length}`);
    console.log(`  Matched bets: ${this.state.matchedBetIds.length}`);
    console.log(`  Capital: $${this.config.capital}`);
    console.log(`  Allocated: $${this.state.allocatedCapital.toFixed(2)}`);
    console.log(`  Available: $${getAvailableCapital(this.state).toFixed(2)}`);

    const resolutions = this.resolutionManager.getSummary();
    console.log(`  Resolutions: ${resolutions.resolved}/${resolutions.total}`);
    console.log("═══════════════════════════════════════════");
    console.log("");
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get the trade horizon for a category
   *
   * Determines horizon based on category name patterns:
   * - Categories with "bls", "fred", "ecb" -> monthly
   * - Categories with "weather", "defi" -> daily
   * - Default -> short
   */
  private getCategoryHorizon(category: string): string {
    const lower = category.toLowerCase();

    // Economic/macro sources have monthly horizons
    if (lower.includes('bls') || lower.includes('fred') || lower.includes('ecb')) {
      return 'monthly';
    }

    // Weather and DeFi have daily horizons
    if (lower.includes('weather') || lower.includes('defi') || lower.includes('stocks')) {
      return 'daily';
    }

    // Crypto and prediction markets are short-term
    return 'short';
  }
}

/**
 * Safely parse an integer from environment variable with validation
 */
function parseEnvInt(value: string | undefined, defaultValue: number, min?: number, max?: number): number {
  if (!value) return defaultValue;

  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    logger.warn("Config", `Invalid integer value "${value}", using default ${defaultValue}`);
    return defaultValue;
  }

  if (min !== undefined && parsed < min) {
    logger.warn("Config", `Value ${parsed} below minimum ${min}, using ${min}`);
    return min;
  }

  if (max !== undefined && parsed > max) {
    logger.warn("Config", `Value ${parsed} above maximum ${max}, using ${max}`);
    return max;
  }

  return parsed;
}

/**
 * Validate risk profile value
 */
function parseRiskProfile(value: string | undefined): TradingBotConfig["riskProfile"] {
  const validProfiles = ["conservative", "balanced", "aggressive"] as const;
  if (value && validProfiles.includes(value as typeof validProfiles[number])) {
    return value as TradingBotConfig["riskProfile"];
  }
  return "balanced";
}

/**
 * Create a trading bot from environment config
 */
export function createBotFromEnv(name: string): TradingBot {
  // Validate wallet address format
  const walletAddress = process.env.AGENT_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000";
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    logger.warn("Config", `Invalid wallet address format: ${walletAddress}`);
  }

  // Load rate limits and cancellation config from env
  const rateLimits = loadRateLimitsFromEnv();
  const cancellation = loadCancellationConfigFromEnv();

  const config: TradingBotConfig = {
    name,
    walletAddress,
    privateKey: process.env.AGENT_PRIVATE_KEY || "",
    capital: parseEnvInt(process.env.AGENT_CAPITAL, 100, 1, 1000000),
    riskProfile: parseRiskProfile(process.env.AGENT_RISK_PROFILE),
    portfolioSize: parseEnvInt(process.env.AGENT_PORTFOLIO_SIZE, 5, 1, 10000),
    backendUrl: process.env.BACKEND_URL || "http://localhost:3001",
    contractAddress: process.env.CONTRACT_ADDRESS || "",
    negotiation: {
      acceptThresholdBps: parseEnvInt(process.env.ACCEPT_THRESHOLD_BPS, 50, 1, 1000),
      counterThresholdBps: parseEnvInt(process.env.COUNTER_THRESHOLD_BPS, 200, 1, 2000),
      rejectThresholdBps: parseEnvInt(process.env.REJECT_THRESHOLD_BPS, 500, 1, 5000),
      pollIntervalMs: parseEnvInt(process.env.POLL_INTERVAL_MS, 5000, 1000, 60000),
    },
    resolutionMinutes: parseEnvInt(process.env.RESOLUTION_MINUTES, 30, 1, 1440),
    dryRun: process.env.DRY_RUN === "true",
    maxBetsPerSession: parseEnvInt(process.env.MAX_BETS_PER_SESSION, 10, 1, 100),
    sessionDurationMinutes: parseEnvInt(process.env.SESSION_DURATION_MINUTES, 60, 1, 1440),
    rateLimits,
    cancellation,
    maxConcurrentBets: parseEnvInt(process.env.MAX_CONCURRENT_BETS, 3, 1, 20),
    collateralDecimals: parseEnvInt(process.env.COLLATERAL_DECIMALS, 18, 0, 18), // Default to WIND's 18
    tradeCategories: process.env.TRADE_CATEGORIES?.split(',').map(c => c.trim()).filter(Boolean) || [],
    tradeListSize: (['1K', '10K', '100K'].includes(process.env.TRADE_LIST_SIZE || '') ? process.env.TRADE_LIST_SIZE : '10K') as TradeListSize,
  };

  // Log configuration (without sensitive data)
  logger.info(name, "Bot configuration loaded", {
    capital: config.capital,
    riskProfile: config.riskProfile,
    portfolioSize: config.portfolioSize,
    dryRun: config.dryRun,
    resolutionMinutes: config.resolutionMinutes,
    collateralDecimals: config.collateralDecimals,
    tradeCategories: config.tradeCategories,
    tradeListSize: config.tradeListSize,
    rateLimits: {
      maxBetsPerHour: rateLimits.maxBetsPerHour,
      maxBetsPerDay: rateLimits.maxBetsPerDay,
      maxUsdcPerDay: rateLimits.maxUsdcPerDay,
    },
    cancellation: {
      maxUnfilledAge: cancellation.maxUnfilledAge,
      priceChangeThreshold: cancellation.priceChangeThreshold,
    },
  });

  return new TradingBot(config);
}
