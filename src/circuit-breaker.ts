/**
 * Circuit Breaker Pattern Implementation
 *
 * Prevents cascade failures by stopping calls to failing services.
 * Implements the circuit breaker pattern with three states:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is failing, requests are rejected immediately
 * - HALF_OPEN: Testing if service has recovered
 *
 * State transitions are logged to resilience.log
 */

import { existsSync, appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Circuit breaker states
 */
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening circuit */
  failureThreshold: number;
  /** Cooldown period in milliseconds before attempting HALF_OPEN */
  cooldownMs: number;
  /** Number of successful calls in HALF_OPEN to close circuit */
  successThreshold: number;
  /** Path to resilience log file */
  logPath: string;
}

/**
 * Circuit breaker statistics
 */
export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  lastStateChange: number;
  totalCalls: number;
  totalFailures: number;
  totalSuccesses: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

/** Default number of failures before opening */
export const DEFAULT_FAILURE_THRESHOLD = 3;

/** Default cooldown period (60 seconds) */
export const DEFAULT_COOLDOWN_MS = 60 * 1000;

/** Default successes needed to close from HALF_OPEN */
export const DEFAULT_SUCCESS_THRESHOLD = 1;

/** Default resilience log path */
export const DEFAULT_LOG_PATH = "bot/agent/resilience.log";

// ============================================================================
// Circuit Breaker Class
// ============================================================================

/**
 * Circuit breaker for protecting calls to external services
 */
export class CircuitBreaker {
  private failures = 0;
  private successes = 0;
  private lastFailureTime: number | null = null;
  private lastStateChange: number = Date.now();
  private state: CircuitState = "CLOSED";

  // Statistics
  private totalCalls = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;

  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly successThreshold: number;
  private readonly logPath: string;

  /**
   * Create a new circuit breaker
   * @param name Identifier for this circuit breaker
   * @param config Optional configuration
   */
  constructor(name: string, config?: Partial<CircuitBreakerConfig>) {
    this.name = name;
    this.failureThreshold = config?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.successThreshold = config?.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD;
    this.logPath = config?.logPath ?? DEFAULT_LOG_PATH;

    // Ensure log directory exists
    const dir = dirname(this.logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // --------------------------------------------------------------------------
  // State Management
  // --------------------------------------------------------------------------

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get circuit breaker statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      lastStateChange: this.lastStateChange,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses
    };
  }

  /**
   * Check if circuit allows requests
   */
  isOpen(): boolean {
    return this.state === "OPEN";
  }

  /**
   * Check if circuit is closed (normal operation)
   */
  isClosed(): boolean {
    return this.state === "CLOSED";
  }

  // --------------------------------------------------------------------------
  // State Transitions
  // --------------------------------------------------------------------------

  /**
   * Transition to a new state with logging
   */
  private transitionTo(newState: CircuitState, reason: string): void {
    const oldState = this.state;
    if (oldState === newState) return;

    this.state = newState;
    this.lastStateChange = Date.now();

    // Reset counters on state change
    if (newState === "CLOSED") {
      this.failures = 0;
      this.successes = 0;
    } else if (newState === "HALF_OPEN") {
      this.successes = 0;
    }

    this.log(`${oldState} -> ${newState}: ${reason}`);
  }

  /**
   * Check if we should transition from OPEN to HALF_OPEN
   */
  private checkCooldown(): boolean {
    if (this.state !== "OPEN" || this.lastFailureTime === null) {
      return false;
    }

    const elapsed = Date.now() - this.lastFailureTime;
    if (elapsed >= this.cooldownMs) {
      this.transitionTo("HALF_OPEN", `Cooldown elapsed (${Math.floor(elapsed / 1000)}s)`);
      return true;
    }

    return false;
  }

  // --------------------------------------------------------------------------
  // Execution
  // --------------------------------------------------------------------------

  /**
   * Execute an operation through the circuit breaker
   * @param operation Async operation to execute
   * @returns Result of the operation
   * @throws Error if circuit is OPEN or operation fails
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.totalCalls++;

    // Check if circuit is OPEN
    if (this.state === "OPEN") {
      // Check if cooldown has elapsed
      if (!this.checkCooldown()) {
        const error = new Error(`Circuit breaker OPEN for ${this.name}`);
        (error as Error & { code: string }).code = "CIRCUIT_OPEN";
        throw error;
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Record a successful operation
   */
  private onSuccess(): void {
    this.totalSuccesses++;
    this.successes++;

    if (this.state === "HALF_OPEN") {
      if (this.successes >= this.successThreshold) {
        this.transitionTo("CLOSED", `${this.successes} successful calls`);
      }
    } else if (this.state === "CLOSED") {
      // Reset failure count on success
      this.failures = 0;
    }
  }

  /**
   * Record a failed operation
   */
  private onFailure(): void {
    this.totalFailures++;
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === "HALF_OPEN") {
      // Any failure in HALF_OPEN reopens the circuit
      this.transitionTo("OPEN", "Failure during recovery test");
    } else if (this.state === "CLOSED") {
      if (this.failures >= this.failureThreshold) {
        this.transitionTo("OPEN", `${this.failures} consecutive failures`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Manual Controls
  // --------------------------------------------------------------------------

  /**
   * Manually open the circuit
   */
  forceOpen(reason: string = "Manual intervention"): void {
    this.lastFailureTime = Date.now();
    this.transitionTo("OPEN", reason);
  }

  /**
   * Manually close the circuit
   */
  forceClose(reason: string = "Manual intervention"): void {
    this.transitionTo("CLOSED", reason);
  }

  /**
   * Reset the circuit breaker to initial state
   */
  reset(): void {
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
    this.state = "CLOSED";
    this.lastStateChange = Date.now();
    this.log("Reset to initial state");
  }

  // --------------------------------------------------------------------------
  // Logging
  // --------------------------------------------------------------------------

  /**
   * Log a circuit breaker event to resilience.log
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const entry = `${timestamp} | CIRCUIT_BREAKER | [${this.name}] ${message}\n`;

    try {
      appendFileSync(this.logPath, entry);
    } catch (error) {
      // Fall back to stderr
      console.error(`[CIRCUIT_BREAKER ${this.name}] ${message}`);
    }
  }
}

// ============================================================================
// Pre-configured Circuit Breaker Instances
// ============================================================================

/** Circuit breaker for Polymarket API calls */
export const polymarketBreaker = new CircuitBreaker("Polymarket API");

/** Circuit breaker for Base RPC calls */
export const baseRpcBreaker = new CircuitBreaker("Base RPC");

/** Circuit breaker for Backend API calls */
export const backendBreaker = new CircuitBreaker("Backend API");

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new circuit breaker with custom configuration
 */
export function createCircuitBreaker(
  name: string,
  config?: Partial<CircuitBreakerConfig>
): CircuitBreaker {
  return new CircuitBreaker(name, config);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get status of all default circuit breakers
 */
export function getAllCircuitBreakerStatus(): Record<string, CircuitState> {
  return {
    polymarketAPI: polymarketBreaker.getState(),
    baseRPC: baseRpcBreaker.getState(),
    backend: backendBreaker.getState()
  };
}

/**
 * Reset all default circuit breakers
 */
export function resetAllCircuitBreakers(): void {
  polymarketBreaker.reset();
  baseRpcBreaker.reset();
  backendBreaker.reset();
}

/**
 * Wrapper to execute with circuit breaker protection
 * @param breaker Circuit breaker to use
 * @param operation Operation to execute
 * @param fallback Optional fallback value if circuit is open
 */
export async function withCircuitBreaker<T>(
  breaker: CircuitBreaker,
  operation: () => Promise<T>,
  fallback?: T
): Promise<T> {
  try {
    return await breaker.execute(operation);
  } catch (error) {
    if ((error as Error & { code?: string }).code === "CIRCUIT_OPEN" && fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}
