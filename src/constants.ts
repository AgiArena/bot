/**
 * Bot Constants
 *
 * Centralized configuration for magic numbers and tunable parameters.
 * Consolidates hardcoded values from across the codebase for easier maintenance.
 */

// =============================================================================
// Environment Detection
// =============================================================================

/** Whether the bot is running in test mode */
export const IS_TEST_MODE = process.env.TEST_MODE === 'true';

/** Whether the bot is running in development mode */
export const IS_DEV_MODE = process.env.NODE_ENV === 'development';

// =============================================================================
// Betting Limits
// =============================================================================

/** Minimum portfolio size required for betting (in markets) */
export const MIN_PORTFOLIO_SIZE = 100; // Reduced for testing

/** Minimum bet amount in tokens (0.01 tokens) */
export const MIN_BET_TOKENS = 0.01;

/** Minimum bet amount for test mode (0.03 tokens) */
export const TEST_BET_TOKENS = 0.03;

// =============================================================================
// Timing Constants
// =============================================================================

/** Default resolution deadline in hours */
export const DEFAULT_RESOLUTION_HOURS = 24;

/** Default resolution deadline in seconds */
export const DEFAULT_RESOLUTION_SECONDS = DEFAULT_RESOLUTION_HOURS * 60 * 60;

/** Resolution buffer before deadline in seconds (10 minutes) */
export const MIN_DEADLINE_BUFFER_SECONDS = IS_TEST_MODE ? 30 : 600;

/** Default IPFS upload delay in milliseconds */
export const IPFS_UPLOAD_DELAY_MS = 3000;

/** Cancellation check interval in milliseconds */
export const CANCELLATION_CHECK_INTERVAL_MS = 30_000;

/** Resolution timer poll interval in milliseconds */
export const RESOLUTION_POLL_INTERVAL_MS = 10_000;

// =============================================================================
// Retry Configuration
// =============================================================================

/** Default number of retries for failed operations */
export const DEFAULT_MAX_RETRIES = 5;

/** Default delay between retries in milliseconds */
export const DEFAULT_RETRY_DELAY_MS = 5000;

/** Resolution max retries */
export const RESOLUTION_MAX_RETRIES = 3;

// =============================================================================
// Risk & Sizing
// =============================================================================

/** Risk profile sizing percentages - portion of capital per bet */
export const RISK_PROFILE_SIZING = {
  conservative: 0.02, // 2% of capital per bet
  balanced: 0.05,     // 5% of capital per bet
  aggressive: 0.10,   // 10% of capital per bet
} as const;

/** Probability thresholds for market selection */
export const MARKET_PROBABILITY = {
  /** Skip probability for low-quality markets */
  SKIP_THRESHOLD: 0.3, // 70% chance to skip
  /** Default fair price when no data available */
  DEFAULT_FAIR_PRICE: 0.5,
} as const;

// =============================================================================
// Odds Configuration
// =============================================================================

/** Odds in basis points - 10000 = 1.00x (even money) */
export const ODDS_BPS = {
  EVEN: 10000,     // 1.00x
  TWO_TO_ONE: 20000,  // 2.00x
} as const;

// =============================================================================
// API & Network
// =============================================================================

/** Default backend API URL */
export const DEFAULT_BACKEND_URL = 'http://localhost:3001';

/** Default RPC URL for Index L3 */
export const DEFAULT_RPC_URL = 'https://index.rpc.zeeve.net';

/** Pagination page size for API requests */
export const API_PAGE_SIZE = 500;

/** Maximum batch size for batch operations (gas limit protection) */
export const MAX_BATCH_SIZE = 50;

// =============================================================================
// Contract Addresses (Index L3 - Orbit)
// =============================================================================

export const CONTRACT_ADDRESSES = {
  AGIARENA_CORE: '0x873256196B70c5a7fC08A820089293302F492d08',
  RESOLUTION_DAO: '0x1B1157f2C4E8821B4172dDA17730E9807aceEe88',
  WIND_TOKEN: '0x6Ef9653b34C2A0d91219466b029428ff4F49D651',
} as const;

// =============================================================================
// Collateral Configuration
// =============================================================================

/** Default collateral token decimals (18 for WIND, 6 for USDC) */
export const DEFAULT_COLLATERAL_DECIMALS = 18;

/** Collateral symbols by address */
export const COLLATERAL_CONFIG = {
  [CONTRACT_ADDRESSES.WIND_TOKEN]: {
    symbol: 'WIND',
    decimals: 18,
  },
} as const;

// =============================================================================
// Rate Limiting
// =============================================================================

/** Default rate limit configuration */
export const DEFAULT_RATE_LIMITS = {
  maxFillsPerMinute: 5,
  maxFillsPerHour: 20,
  maxAmountPerHour: 1000, // In tokens
  cooldownAfterFailureMs: 60_000,
} as const;

// =============================================================================
// Kelly Criterion
// =============================================================================

/** Default Kelly fraction (25% Kelly for safety) */
export const DEFAULT_KELLY_FRACTION = 0.25;

/** Minimum Kelly fraction */
export const MIN_KELLY_FRACTION = 0.01;

/** Maximum Kelly fraction */
export const MAX_KELLY_FRACTION = 1.0;

// =============================================================================
// Data Source Configuration
// =============================================================================

import type { TradeHorizon } from './types';

/**
 * Data source for market prices
 * Expanded to include economic data sources (BLS, FRED, ECB) and DeFi
 */
export type DataSource =
  | 'polymarket'
  | 'coingecko'
  | 'stocks'
  | 'openmeteo'
  | 'bls'    // Bureau of Labor Statistics - employment/inflation
  | 'fred'   // Federal Reserve Economic Data - rates/treasury
  | 'ecb'    // European Central Bank - euro macro
  | 'defi';  // DeFi protocols - TVL/volumes

/**
 * Configuration for each data source
 */
export interface SourceConfig {
  displayName: string;
  defaultHorizon: TradeHorizon;
  endpoint: string;
  isEconomic: boolean;
  /** Description of what this source provides */
  description: string;
}

/**
 * Source configuration map
 * Defines endpoint, default horizon, and whether it's economic data
 */
export const SOURCE_CONFIG: Record<DataSource, SourceConfig> = {
  polymarket: {
    displayName: 'Polymarket',
    defaultHorizon: 'short',
    endpoint: '/api/markets',
    isEconomic: false,
    description: 'Prediction markets for events and politics',
  },
  coingecko: {
    displayName: 'Crypto',
    defaultHorizon: 'short',
    endpoint: '/api/crypto/prices',
    isEconomic: false,
    description: 'Cryptocurrency prices from CoinGecko',
  },
  stocks: {
    displayName: 'Stocks',
    defaultHorizon: 'daily',
    endpoint: '/api/market-prices?source=stocks',
    isEconomic: false,
    description: 'Stock market prices',
  },
  openmeteo: {
    displayName: 'Weather',
    defaultHorizon: 'daily',
    endpoint: '/api/weather/readings',
    isEconomic: false,
    description: 'Weather data from Open-Meteo',
  },
  bls: {
    displayName: 'Employment',
    defaultHorizon: 'monthly',
    endpoint: '/api/market-prices?source=bls',
    isEconomic: true,
    description: 'Bureau of Labor Statistics - unemployment, CPI, etc.',
  },
  fred: {
    displayName: 'Rates',
    defaultHorizon: 'monthly',
    endpoint: '/api/market-prices?source=rates', // Backend uses "rates" not "fred"
    isEconomic: true,
    description: 'Federal Reserve Economic Data - interest rates, treasury yields',
  },
  ecb: {
    displayName: 'ECB',
    defaultHorizon: 'monthly',
    endpoint: '/api/market-prices?source=ecb',
    isEconomic: true,
    description: 'European Central Bank - euro macro indicators',
  },
  defi: {
    displayName: 'DeFi',
    defaultHorizon: 'daily',
    endpoint: '/api/market-prices?source=defi',
    isEconomic: false,
    description: 'DeFi protocol metrics - TVL, volumes, yields',
  },
};

/**
 * Get position config based on trade horizon
 * Longer horizons allow larger positions and longer hold periods
 */
export function getPositionConfig(horizon: TradeHorizon): {
  maxPositionSize: number;
  minHoldPeriodMinutes: number;
} {
  switch (horizon) {
    case 'short':
      return { maxPositionSize: 0.1, minHoldPeriodMinutes: 30 };
    case 'daily':
      return { maxPositionSize: 0.15, minHoldPeriodMinutes: 1440 }; // 24 hours
    case 'weekly':
      return { maxPositionSize: 0.2, minHoldPeriodMinutes: 10080 }; // 7 days
    case 'monthly':
      return { maxPositionSize: 0.25, minHoldPeriodMinutes: 43200 }; // 30 days
    case 'quarterly':
      return { maxPositionSize: 0.3, minHoldPeriodMinutes: 129600 }; // 90 days
  }
}

/**
 * Get default horizon for a data source
 */
export function getDefaultHorizon(source: DataSource): TradeHorizon {
  return SOURCE_CONFIG[source]?.defaultHorizon || 'short';
}

/**
 * Check if a source is economic (macro) data
 */
export function isEconomicSource(source: DataSource): boolean {
  return SOURCE_CONFIG[source]?.isEconomic || false;
}
