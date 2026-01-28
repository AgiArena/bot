/**
 * Retry Utilities
 *
 * Provides reusable retry logic with exponential backoff for handling
 * transient failures in network operations, API calls, and blockchain transactions.
 */

import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
} from './constants';

/**
 * Retry configuration options
 */
export interface RetryOptions {
  /** Maximum number of retry attempts */
  maxRetries?: number;
  /** Initial delay between retries in milliseconds */
  initialDelayMs?: number;
  /** Maximum delay between retries in milliseconds */
  maxDelayMs?: number;
  /** Backoff multiplier (e.g., 2 for exponential backoff) */
  backoffMultiplier?: number;
  /** Optional function to determine if error is retryable */
  isRetryable?: (error: Error) => boolean;
  /** Optional callback for each retry attempt */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/**
 * Default retry options
 */
const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, 'onRetry' | 'isRetryable'>> = {
  maxRetries: DEFAULT_MAX_RETRIES,
  initialDelayMs: DEFAULT_RETRY_DELAY_MS,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
};

/**
 * Result of a retry operation
 */
export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number
): number {
  // Exponential backoff
  const exponentialDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  // Add jitter (±10%)
  const jitter = cappedDelay * 0.1 * (Math.random() * 2 - 1);
  return Math.floor(cappedDelay + jitter);
}

/**
 * Default retryable error checker
 * Considers network errors and rate limits as retryable
 */
function defaultIsRetryable(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Network errors
  if (message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('socket hang up')) {
    return true;
  }

  // Rate limits
  if (message.includes('rate limit') ||
      message.includes('too many requests') ||
      message.includes('429')) {
    return true;
  }

  // Server errors (5xx)
  if (message.includes('500') ||
      message.includes('502') ||
      message.includes('503') ||
      message.includes('504')) {
    return true;
  }

  // Blockchain-specific retryable errors
  if (message.includes('nonce too low') ||
      message.includes('replacement underpriced') ||
      message.includes('transaction underpriced')) {
    return true;
  }

  return false;
}

/**
 * Execute a function with automatic retry on failure
 *
 * @param fn - The function to execute (should return a Promise)
 * @param options - Retry configuration options
 * @returns Promise with retry result
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fetchData(url),
 *   { maxRetries: 3, initialDelayMs: 1000 }
 * );
 *
 * if (result.success) {
 *   console.log('Data:', result.result);
 * } else {
 *   console.error('Failed after', result.attempts, 'attempts:', result.error);
 * }
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const opts = {
    ...DEFAULT_RETRY_OPTIONS,
    ...options,
  };

  const isRetryable = opts.isRetryable || defaultIsRetryable;
  let lastError: Error | undefined;
  let attempts = 0;

  for (attempts = 1; attempts <= opts.maxRetries + 1; attempts++) {
    try {
      const result = await fn();
      return {
        success: true,
        result,
        attempts,
      };
    } catch (error) {
      lastError = error as Error;

      // Check if we should retry
      const isLastAttempt = attempts > opts.maxRetries;
      const canRetry = !isLastAttempt && isRetryable(lastError);

      if (!canRetry) {
        break;
      }

      // Calculate delay for next retry
      const delayMs = calculateDelay(
        attempts,
        opts.initialDelayMs,
        opts.maxDelayMs,
        opts.backoffMultiplier
      );

      // Call onRetry callback if provided
      if (opts.onRetry) {
        opts.onRetry(attempts, lastError, delayMs);
      }

      // Wait before retrying
      await sleep(delayMs);
    }
  }

  return {
    success: false,
    error: lastError,
    attempts,
  };
}

/**
 * Execute a function with retry, throwing on failure
 *
 * @param fn - The function to execute
 * @param options - Retry configuration options
 * @returns Promise with the result
 * @throws Error if all retries fail
 *
 * @example
 * ```typescript
 * try {
 *   const data = await retryOrThrow(() => fetchData(url));
 *   console.log('Data:', data);
 * } catch (error) {
 *   console.error('Failed:', error);
 * }
 * ```
 */
export async function retryOrThrow<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const result = await withRetry(fn, options);

  if (!result.success) {
    throw result.error || new Error('Operation failed after retries');
  }

  return result.result as T;
}

/**
 * Create a retryable version of any async function
 *
 * @param fn - The function to wrap
 * @param options - Default retry options for this function
 * @returns A new function that automatically retries
 *
 * @example
 * ```typescript
 * const retryableFetch = makeRetryable(fetchData, { maxRetries: 3 });
 * const data = await retryableFetch(url);
 * ```
 */
export function makeRetryable<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: RetryOptions = {}
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => retryOrThrow(() => fn(...args), options);
}

/**
 * Simple exponential backoff helper
 *
 * Story 9.2: Added for bitmap upload retry logic.
 *
 * @param fn - The async function to execute with retries
 * @param maxRetries - Maximum retry attempts
 * @param initialDelayMs - Initial delay in milliseconds
 * @param onRetry - Optional callback for retry attempts
 * @returns Promise with the result
 */
export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 5,
  initialDelayMs: number = 1000,
  onRetry?: (attempt: number, error: Error) => void
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries) {
        if (onRetry) {
          onRetry(attempt, lastError);
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s...
        const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError || new Error('Operation failed after retries');
}
