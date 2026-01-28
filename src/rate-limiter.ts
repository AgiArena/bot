/**
 * Rate Limiter for Bot Trading
 *
 * Tracks filled bets only (not canceled/pending) to enforce:
 * - Per hour/day/week/month bet count limits
 * - Daily USDC volume limits
 *
 * This prevents over-trading and helps manage risk.
 */

/**
 * Rate limit configuration
 */
export interface RateLimits {
  /** Maximum bets per hour */
  maxBetsPerHour: number;
  /** Maximum bets per day */
  maxBetsPerDay: number;
  /** Maximum bets per week */
  maxBetsPerWeek: number;
  /** Maximum bets per month */
  maxBetsPerMonth: number;
  /** Maximum USDC volume per day */
  maxUsdcPerDay: number;
}

/**
 * Record of a filled bet for rate limiting
 */
export interface FillRecord {
  /** Unix timestamp when fill occurred (ms) */
  timestamp: number;
  /** Fill amount in USDC (decimal, e.g., 10.50) */
  amount: number;
  /** Bet ID for reference */
  betId: string;
}

/**
 * Result of rate limit check
 */
export interface RateLimitResult {
  /** Whether the proposed action is allowed */
  allowed: boolean;
  /** Reason for rejection (if not allowed) */
  reason?: string;
  /** Seconds to wait before trying again (if not allowed) */
  waitTimeSeconds?: number;
  /** Current counts for debugging */
  currentCounts?: {
    hour: number;
    day: number;
    week: number;
    month: number;
    usdcToday: number;
  };
}

// Time constants in milliseconds
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;
const ONE_MONTH_MS = 30 * ONE_DAY_MS;

/**
 * Default rate limits (conservative defaults)
 */
export const DEFAULT_RATE_LIMITS: RateLimits = {
  maxBetsPerHour: 5,
  maxBetsPerDay: 20,
  maxBetsPerWeek: 100,
  maxBetsPerMonth: 300,
  maxUsdcPerDay: 500,
};

/**
 * Load rate limits from environment variables with defaults
 */
export function loadRateLimitsFromEnv(): RateLimits {
  return {
    maxBetsPerHour: parseInt(process.env.MAX_BETS_PER_HOUR || "", 10) || DEFAULT_RATE_LIMITS.maxBetsPerHour,
    maxBetsPerDay: parseInt(process.env.MAX_BETS_PER_DAY || "", 10) || DEFAULT_RATE_LIMITS.maxBetsPerDay,
    maxBetsPerWeek: parseInt(process.env.MAX_BETS_PER_WEEK || "", 10) || DEFAULT_RATE_LIMITS.maxBetsPerWeek,
    maxBetsPerMonth: parseInt(process.env.MAX_BETS_PER_MONTH || "", 10) || DEFAULT_RATE_LIMITS.maxBetsPerMonth,
    maxUsdcPerDay: parseInt(process.env.MAX_USDC_PER_DAY || "", 10) || DEFAULT_RATE_LIMITS.maxUsdcPerDay,
  };
}

/**
 * Count fills within a time window
 */
function countFillsInWindow(history: FillRecord[], windowMs: number, now: number): number {
  const cutoff = now - windowMs;
  return history.filter(record => record.timestamp >= cutoff).length;
}

/**
 * Sum USDC volume within a time window
 */
function sumVolumeInWindow(history: FillRecord[], windowMs: number, now: number): number {
  const cutoff = now - windowMs;
  return history
    .filter(record => record.timestamp >= cutoff)
    .reduce((sum, record) => sum + record.amount, 0);
}

/**
 * Check if a new bet can be placed given rate limits
 *
 * @param fillHistory - History of filled bets
 * @param limits - Rate limit configuration
 * @param proposedAmount - USDC amount of proposed bet
 * @param now - Current timestamp (for testing, defaults to Date.now())
 * @returns Result indicating if bet is allowed
 */
export function checkRateLimits(
  fillHistory: FillRecord[],
  limits: RateLimits,
  proposedAmount: number,
  now: number = Date.now()
): RateLimitResult {
  const hourCount = countFillsInWindow(fillHistory, ONE_HOUR_MS, now);
  const dayCount = countFillsInWindow(fillHistory, ONE_DAY_MS, now);
  const weekCount = countFillsInWindow(fillHistory, ONE_WEEK_MS, now);
  const monthCount = countFillsInWindow(fillHistory, ONE_MONTH_MS, now);
  const usdcToday = sumVolumeInWindow(fillHistory, ONE_DAY_MS, now);

  const currentCounts = {
    hour: hourCount,
    day: dayCount,
    week: weekCount,
    month: monthCount,
    usdcToday,
  };

  // Check hour limit
  if (hourCount >= limits.maxBetsPerHour) {
    const oldestInHour = fillHistory
      .filter(r => r.timestamp >= now - ONE_HOUR_MS)
      .sort((a, b) => a.timestamp - b.timestamp)[0];
    const waitTime = oldestInHour
      ? Math.ceil((oldestInHour.timestamp + ONE_HOUR_MS - now) / 1000)
      : 3600;
    return {
      allowed: false,
      reason: `Hourly limit reached (${hourCount}/${limits.maxBetsPerHour})`,
      waitTimeSeconds: waitTime,
      currentCounts,
    };
  }

  // Check day limit
  if (dayCount >= limits.maxBetsPerDay) {
    const oldestInDay = fillHistory
      .filter(r => r.timestamp >= now - ONE_DAY_MS)
      .sort((a, b) => a.timestamp - b.timestamp)[0];
    const waitTime = oldestInDay
      ? Math.ceil((oldestInDay.timestamp + ONE_DAY_MS - now) / 1000)
      : 86400;
    return {
      allowed: false,
      reason: `Daily limit reached (${dayCount}/${limits.maxBetsPerDay})`,
      waitTimeSeconds: waitTime,
      currentCounts,
    };
  }

  // Check week limit
  if (weekCount >= limits.maxBetsPerWeek) {
    return {
      allowed: false,
      reason: `Weekly limit reached (${weekCount}/${limits.maxBetsPerWeek})`,
      waitTimeSeconds: 3600, // Check again in an hour
      currentCounts,
    };
  }

  // Check month limit
  if (monthCount >= limits.maxBetsPerMonth) {
    return {
      allowed: false,
      reason: `Monthly limit reached (${monthCount}/${limits.maxBetsPerMonth})`,
      waitTimeSeconds: 86400, // Check again in a day
      currentCounts,
    };
  }

  // Check daily USDC volume
  if (usdcToday + proposedAmount > limits.maxUsdcPerDay) {
    const remaining = limits.maxUsdcPerDay - usdcToday;
    return {
      allowed: false,
      reason: `Daily USDC limit would be exceeded ($${usdcToday.toFixed(2)} + $${proposedAmount.toFixed(2)} > $${limits.maxUsdcPerDay})`,
      waitTimeSeconds: 3600,
      currentCounts,
    };
  }

  return {
    allowed: true,
    currentCounts,
  };
}

/**
 * Record a new fill in the history
 *
 * @param fillHistory - Current fill history
 * @param betId - Bet ID that was filled
 * @param amount - Fill amount in USDC
 * @param timestamp - Fill timestamp (defaults to now)
 * @returns Updated fill history
 */
export function recordFill(
  fillHistory: FillRecord[],
  betId: string,
  amount: number,
  timestamp: number = Date.now()
): FillRecord[] {
  return [
    ...fillHistory,
    { timestamp, amount, betId },
  ];
}

/**
 * Prune fill history to remove old records
 *
 * Keeps records up to maxAge (default 31 days) to support monthly limits
 *
 * @param history - Current fill history
 * @param maxAgeMs - Maximum age to keep (default 31 days)
 * @param now - Current timestamp (for testing)
 * @returns Pruned history
 */
export function pruneFillHistory(
  history: FillRecord[],
  maxAgeMs: number = 31 * ONE_DAY_MS,
  now: number = Date.now()
): FillRecord[] {
  const cutoff = now - maxAgeMs;
  return history.filter(record => record.timestamp >= cutoff);
}

/**
 * Format rate limit status for logging
 */
export function formatRateLimitStatus(result: RateLimitResult): string {
  if (!result.currentCounts) {
    return result.allowed ? "Rate limits OK" : `Rate limited: ${result.reason}`;
  }

  const { hour, day, week, month, usdcToday } = result.currentCounts;
  return `Fills: ${hour}/hr ${day}/day ${week}/wk ${month}/mo | USDC today: $${usdcToday.toFixed(2)}`;
}
