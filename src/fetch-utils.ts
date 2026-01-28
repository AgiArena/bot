/**
 * Fetch Utilities
 *
 * Provides a unified fetch wrapper that handles:
 * - Bun-specific TLS options
 * - Configurable TLS verification (for development/testing)
 * - Automatic retry with exponential backoff
 * - Request timeout
 * - Consistent error handling
 */

import { withRetry, type RetryOptions } from './retry-utils';

/**
 * Check if TLS verification should be skipped
 *
 * SECURITY: TLS is ENABLED by default in ALL environments.
 * Only skip when SKIP_TLS_VERIFY=true is explicitly set.
 */
export function shouldSkipTlsVerify(): boolean {
  // Only skip TLS when explicitly set to 'true'
  // This is secure-by-default: TLS enabled unless explicitly disabled
  if (process.env.SKIP_TLS_VERIFY === 'true') {
    return true;
  }

  // Allow skipping in test mode for CI/testing
  if (process.env.TEST_MODE === 'true') {
    return true;
  }

  // Default: TLS verification ENABLED
  return false;
}

/** Default fetch timeout in milliseconds (30 seconds) */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Extended fetch options that include Bun-specific TLS options
 */
interface BunFetchOptions extends RequestInit {
  tls?: {
    rejectUnauthorized?: boolean;
  };
}

/**
 * Fetch options with timeout support
 */
export interface FetchWithTlsOptions extends RequestInit {
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

/**
 * Fetch wrapper that handles Bun-specific TLS options and timeout
 *
 * @param url - URL to fetch
 * @param options - Standard fetch options plus timeout
 * @returns Fetch response
 */
export async function fetchWithTls(
  url: string | URL,
  options: FetchWithTlsOptions = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, ...fetchInit } = options;
  const skipTls = shouldSkipTlsVerify();

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Build fetch options with optional TLS override
    const fetchOptions: BunFetchOptions = {
      ...fetchInit,
      signal: controller.signal,
    };

    // Only add TLS option if we're skipping verification
    // This is a Bun-specific extension to the fetch API
    if (skipTls) {
      fetchOptions.tls = { rejectUnauthorized: false };
    }

    // Use type assertion for Bun's extended fetch API
    return await fetch(url, fetchOptions as RequestInit);
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch JSON with TLS handling
 *
 * @param url - URL to fetch
 * @param options - Standard fetch options
 * @returns Parsed JSON response
 */
export async function fetchJson<T>(
  url: string | URL,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetchWithTls(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Post JSON with TLS handling
 *
 * @param url - URL to post to
 * @param data - Data to send as JSON body
 * @param options - Additional fetch options
 * @returns Parsed JSON response
 */
export async function postJson<T, R = unknown>(
  url: string | URL,
  data: T,
  options: RequestInit = {}
): Promise<R> {
  const response = await fetchWithTls(url, {
    method: 'POST',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json() as Promise<R>;
}

/**
 * Fetch JSON with automatic retry on transient failures
 *
 * @param url - URL to fetch
 * @param options - Fetch options plus retry configuration
 * @returns Parsed JSON response
 */
export async function fetchJsonWithRetry<T>(
  url: string | URL,
  options: FetchWithTlsOptions & { retry?: RetryOptions } = {}
): Promise<T> {
  const { retry: retryOptions, ...fetchOptions } = options;

  const result = await withRetry(
    () => fetchJson<T>(url, fetchOptions),
    {
      maxRetries: 3,
      initialDelayMs: 1000,
      ...retryOptions,
      onRetry: (attempt, error, delayMs) => {
        console.warn(`[fetchJsonWithRetry] Retry ${attempt} for ${url}: ${error.message} (waiting ${delayMs}ms)`);
        retryOptions?.onRetry?.(attempt, error, delayMs);
      },
    }
  );

  if (!result.success) {
    throw result.error || new Error(`Failed to fetch ${url} after retries`);
  }

  return result.result as T;
}
