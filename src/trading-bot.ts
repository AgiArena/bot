/**
 * Trading Bot Runner
 *
 * Main entry point for AI trading bot execution.
 * Coordinates market selection, price negotiation, bet lifecycle, and resolution.
 *
 * Story 7.6: AI Trading Bot Launch Scripts
 * AC: 1, 2, 3, 4, 5, 6
 */

import { getTradableMarkets, randomlySelectMarkets, type MarketScore } from "./market-selector";
import {
  evaluateOffer,
  generateCounterRate,
  createRandomPortfolio,
  createCounterPortfolio,
  calculateFairPrice,
  calculateImpliedRate,
  DEFAULT_NEGOTIATION_CONFIG,
  type Portfolio,
  type NegotiationConfig,
} from "./trading-strategy";
import {
  fetchPendingBets,
  canMatchBet,
  calculateFillAmount,
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
  /** Total capital in USDC */
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
}

/**
 * Risk profile to bet sizing percentage
 */
const RISK_PROFILE_SIZING = {
  conservative: 0.02, // 2% of capital per bet
  balanced: 0.05,     // 5% of capital per bet
  aggressive: 0.10,   // 10% of capital per bet
};

import { join } from "path";
import { Logger } from "./logger";

// Initialize logger for this module
const logsDir = process.env.AGENT_LOGS_DIR || join(process.cwd(), "agent");
const fileLogger = new Logger(logsDir);

/**
 * Bot-specific logger that includes bot name in messages
 */
const logger = {
  info: (name: string, msg: string, data?: Record<string, unknown>) => {
    fileLogger.info(`[${name}] ${msg}`, data);
  },
  warn: (name: string, msg: string, data?: Record<string, unknown>) => {
    fileLogger.warn(`[${name}] ${msg}`, data);
  },
  error: (name: string, msg: string, data?: Record<string, unknown>) => {
    fileLogger.error(`[${name}] ${msg}`, data);
  },
  success: (name: string, msg: string, data?: Record<string, unknown>) => {
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
  private resolutionManager: ResolutionTimerManager;
  private running: boolean = false;
  private sessionBetCount: number = 0;
  private sessionStartTime: number = Date.now();

  constructor(config: TradingBotConfig) {
    this.config = config;
    this.state = createInitialBotState(config.walletAddress, config.capital);
    this.resolutionManager = new ResolutionTimerManager({
      resolutionMinutes: config.resolutionMinutes,
    });

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
      // Fetch tradeable markets
      this.markets = await getTradableMarkets(
        { backendUrl: this.config.backendUrl },
        50 // Fetch top 50 markets
      );

      if (this.markets.length === 0) {
        logger.error(this.config.name, "No tradeable markets found!");
        return false;
      }

      logger.success(this.config.name, `Found ${this.markets.length} tradeable markets`);
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
    // Check for pending bets to match
    const pendingBets = await fetchPendingBets(
      { backendUrl: this.config.backendUrl },
      this.config.walletAddress
    );

    if (pendingBets.length > 0) {
      logger.info(this.config.name, `Found ${pendingBets.length} pending bets to evaluate`);

      for (const bet of pendingBets) {
        await this.evaluateAndMatch(bet);
      }
    }

    // Consider placing a new bet if we have capacity
    if (canPlaceNewBet(this.state, { maxPendingBets: 3, minBetAmount: 1 })) {
      await this.considerPlacingBet();
    }
  }

  /**
   * Evaluate a pending bet and potentially match it
   */
  private async evaluateAndMatch(bet: Bet): Promise<void> {
    if (!canMatchBet(bet)) {
      return;
    }

    // Get market prices for the portfolio positions
    // For now, use a simplified fair price calculation
    const fairPrice = 0.5; // Simplified - would calculate from portfolio

    // Create a pending bet structure for evaluation
    // Use requiredMatch for asymmetric odds, fall back to amount
    const remaining = calculateRemainingAmount(bet);
    const pendingBet = {
      betId: bet.betId,
      creator: bet.creator,
      portfolio: bet.portfolio || { positions: [], createdAt: new Date().toISOString() },
      amount: bet.creatorStake || bet.amount,
      remainingAmount: remaining.toString(),
      impliedRate: 0.5, // Would calculate from portfolio
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
   */
  private async matchBet(bet: Bet): Promise<void> {
    const available = getAvailableCapital(this.state);
    const remaining = calculateRemainingAmount(bet).toString();

    let fillAmount: string;

    // Use odds-aware sizing if bet has odds data (Story 7-15)
    if (bet.oddsBps && bet.oddsBps > 0) {
      // Map config risk profile to RiskProfile type
      const riskProfile: RiskProfile = this.config.riskProfile === "conservative"
        ? "conservative"
        : this.config.riskProfile === "aggressive"
        ? "aggressive"
        : "balanced";

      fillAmount = calculateOddsAwareFillAmount(
        available,
        riskProfile,
        remaining,
        bet.oddsBps
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
      const riskPercent = RISK_PROFILE_SIZING[this.config.riskProfile];
      fillAmount = calculateFillAmount(available, riskPercent, remaining);
    }

    if (fillAmount === "0") {
      logger.warn(this.config.name, `Fill amount too small for bet ${bet.betId}`);
      return;
    }

    logger.info(this.config.name, `Matching bet ${bet.betId} with ${formatUSDC(fillAmount)} USDC`);

    if (this.config.dryRun) {
      logger.info(this.config.name, "[DRY RUN] Would match bet");
      // Update state as if we matched
      this.state = updateStateAfterMatch(this.state, bet.betId, fillAmount);
      this.sessionBetCount++;

      // Add to resolution tracking
      this.resolutionManager.addBet(bet.betId);
    } else {
      // TODO: Actually match the bet on-chain
      logger.warn(this.config.name, "On-chain matching not implemented yet");
    }
  }

  /**
   * Consider placing a new bet
   */
  private async considerPlacingBet(): Promise<void> {
    // Check if we should place a bet (random chance to add variety)
    if (Math.random() > 0.3) {
      return; // 70% chance to skip, adds variety to timing
    }

    const available = getAvailableCapital(this.state);
    if (available < 1) {
      return;
    }

    // Select random markets for portfolio
    const selectedMarkets = randomlySelectMarkets(this.markets, this.config.portfolioSize);

    if (selectedMarkets.length === 0) {
      logger.warn(this.config.name, "No markets selected for portfolio");
      return;
    }

    // Create portfolio
    const portfolio = createRandomPortfolio(selectedMarkets, this.config.portfolioSize);

    // Validate portfolio
    const validation = validatePortfolio(portfolio);
    if (!validation.valid) {
      logger.error(this.config.name, `Invalid portfolio: ${validation.errors.join(", ")}`);
      return;
    }

    // Calculate bet amount
    const riskPercent = RISK_PROFILE_SIZING[this.config.riskProfile];
    const betAmount = Math.floor(available * riskPercent * 1_000_000);

    if (betAmount < 1_000_000) { // $1 minimum
      return;
    }

    logger.info(this.config.name, `Placing bet with ${formatUSDC(betAmount.toString())} USDC`);
    logger.info(this.config.name, `Portfolio: ${portfolio.positions.length} positions`);

    if (this.config.dryRun) {
      logger.info(this.config.name, "[DRY RUN] Would place bet");
      // Simulate bet placement
      const fakeBetId = `dry-run-${Date.now()}`;
      this.state = updateStateAfterPlace(this.state, fakeBetId, betAmount.toString());
      this.sessionBetCount++;
    } else {
      // TODO: Actually place the bet on-chain
      logger.warn(this.config.name, "On-chain bet placement not implemented yet");
    }
  }

  /**
   * Handle bet resolution
   */
  private async handleResolution(betId: string): Promise<boolean> {
    logger.info(this.config.name, `Resolving bet ${betId}`);

    if (this.config.dryRun) {
      logger.info(this.config.name, "[DRY RUN] Would resolve bet");
      return true;
    }

    // TODO: Actually resolve on-chain
    logger.warn(this.config.name, "On-chain resolution not implemented yet");
    return true;
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

  const config: TradingBotConfig = {
    name,
    walletAddress,
    privateKey: process.env.AGENT_PRIVATE_KEY || "",
    capital: parseEnvInt(process.env.AGENT_CAPITAL, 100, 1, 1000000),
    riskProfile: parseRiskProfile(process.env.AGENT_RISK_PROFILE),
    portfolioSize: parseEnvInt(process.env.AGENT_PORTFOLIO_SIZE, 5, 1, 20),
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
  };

  // Log configuration (without sensitive data)
  logger.info(name, "Bot configuration loaded", {
    capital: config.capital,
    riskProfile: config.riskProfile,
    portfolioSize: config.portfolioSize,
    dryRun: config.dryRun,
    resolutionMinutes: config.resolutionMinutes,
  });

  return new TradingBot(config);
}
