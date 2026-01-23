/**
 * Advanced Watchdog Monitoring System
 *
 * Multi-dimensional health monitoring for the agent following BMAD resilience patterns.
 * Extends basic watchdog.ts with advanced metrics including:
 * - Tool call rate monitoring (infinite loop detection)
 * - Output stall detection
 * - Phase timeout detection
 * - Error rate tracking
 * - Memory usage monitoring
 */

import { existsSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import type { WatchdogConfig } from "./watchdog-types";
import { RecoveryLevel } from "./types";

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Multi-dimensional health metrics collected from the agent
 */
export interface WatchdogMetrics {
  /** Time since last heartbeat in milliseconds */
  heartbeatAge: number;
  /** Tool calls per minute (>60 indicates potential infinite loop) */
  toolCallRate: number;
  /** True if no output for >5 minutes */
  outputStalled: boolean;
  /** Memory usage in MB */
  memoryUsage: number;
  /** Errors per hour (>10 indicates degraded state) */
  errorRate: number;
  /** Current workflow phase */
  phase: string;
  /** Unix timestamp when current phase started */
  phaseStartTime: number;
}

/**
 * Agent health status levels
 */
export type HealthStatus = "HEALTHY" | "WARNING" | "STUCK" | "CRITICAL" | "DEGRADED";

/**
 * Recommended recovery actions based on health status
 */
export type HealthAction =
  | "NONE"
  | "CONTEXT_CLEAR"
  | "SEND_SIGNAL"
  | "KILL_TERMINALS_RESTART"
  | "RESTART"
  | "EXPONENTIAL_BACKOFF";

/**
 * Result of a health check containing status and recommended action
 */
export interface HealthCheckResult {
  status: HealthStatus;
  action: HealthAction;
  reason?: string;
}

/**
 * Extended watchdog configuration for advanced monitoring
 */
export interface AdvancedWatchdogConfig extends WatchdogConfig {
  /** Tool calls per minute threshold for infinite loop detection */
  toolCallRateThreshold: number;
  /** Seconds without output before considering stalled */
  outputStallThresholdSec: number;
  /** Errors per hour threshold for degraded state */
  errorRateThreshold: number;
  /** Phase timeout configuration in milliseconds */
  phaseTimeouts: Record<string, number>;
}

// RecoveryLevel is imported from ./types

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Default phase timeouts in milliseconds
 */
export const DEFAULT_PHASE_TIMEOUTS: Record<string, number> = {
  research: 15 * 60 * 1000,    // 15 minutes for research
  evaluation: 10 * 60 * 1000,  // 10 minutes for evaluation
  execution: 5 * 60 * 1000,    // 5 minutes for execution
};

/**
 * Get default advanced watchdog configuration
 */
export function getDefaultAdvancedConfig(botDir: string): AdvancedWatchdogConfig {
  return {
    // Basic watchdog config
    checkIntervalMs: 60000,           // 60 seconds
    heartbeatStaleMs: 600000,         // 10 minutes
    heartbeatPath: `${botDir}/agent/heartbeat.txt`,
    logPath: `${botDir}/logs/watchdog.log`,
    statePath: `${botDir}/watchdog-state.json`,
    agentDir: `${botDir}/agent`,
    // Advanced config
    toolCallRateThreshold: 60,        // >60 calls/min = infinite loop
    outputStallThresholdSec: 300,     // 5 minutes no output
    errorRateThreshold: 10,           // >10 errors/hour = degraded
    phaseTimeouts: DEFAULT_PHASE_TIMEOUTS,
  };
}

// ============================================================================
// Health Check Logic
// ============================================================================

/**
 * Check agent health based on multi-dimensional metrics
 *
 * Priority order:
 * 1. Heartbeat (most critical - agent may be dead)
 * 2. Tool call rate (infinite loop detection)
 * 3. Output stall (agent may be stuck)
 * 4. Phase timeout (stuck in a phase)
 * 5. Error rate (degraded operation)
 *
 * @param metrics - Current agent metrics
 * @param config - Advanced watchdog configuration
 * @returns Health check result with status and recommended action
 */
export function checkAgentHealth(
  metrics: WatchdogMetrics,
  config?: Partial<AdvancedWatchdogConfig>
): HealthCheckResult {
  const cfg = {
    heartbeatStaleMs: config?.heartbeatStaleMs ?? 600000,
    toolCallRateThreshold: config?.toolCallRateThreshold ?? 60,
    outputStallThresholdSec: config?.outputStallThresholdSec ?? 300,
    errorRateThreshold: config?.errorRateThreshold ?? 10,
    phaseTimeouts: config?.phaseTimeouts ?? DEFAULT_PHASE_TIMEOUTS,
  };

  // Priority 1: Heartbeat check (most critical)
  if (metrics.heartbeatAge > cfg.heartbeatStaleMs) {
    return {
      status: "CRITICAL",
      action: "RESTART",
      reason: `Heartbeat stale >10min (${Math.floor(metrics.heartbeatAge / 60000)}min)`
    };
  }

  // Priority 2: Infinite loop detection via tool call rate
  if (metrics.toolCallRate > cfg.toolCallRateThreshold) {
    return {
      status: "WARNING",
      action: "CONTEXT_CLEAR",
      reason: `High tool call rate (${metrics.toolCallRate}/min) - possible infinite loop`
    };
  }

  // Priority 3: Output stall detection
  if (metrics.outputStalled) {
    return {
      status: "STUCK",
      action: "SEND_SIGNAL",
      reason: "No output >5min - agent may be stuck"
    };
  }

  // Priority 4: Phase timeout detection
  if (metrics.phase && metrics.phase in cfg.phaseTimeouts) {
    const timeout = cfg.phaseTimeouts[metrics.phase];
    const phaseElapsed = Date.now() - metrics.phaseStartTime;

    if (phaseElapsed > timeout) {
      return {
        status: "STUCK",
        action: "KILL_TERMINALS_RESTART",
        reason: `${metrics.phase} phase timeout (${Math.floor(phaseElapsed / 60000)}min > ${Math.floor(timeout / 60000)}min)`
      };
    }
  }

  // Priority 5: Error rate check
  if (metrics.errorRate > cfg.errorRateThreshold) {
    return {
      status: "DEGRADED",
      action: "EXPONENTIAL_BACKOFF",
      reason: `High error rate (${metrics.errorRate}/hour)`
    };
  }

  // Agent is healthy
  return {
    status: "HEALTHY",
    action: "NONE"
  };
}

// ============================================================================
// Progressive Recovery
// ============================================================================

/** Track recovery attempts for progressive escalation */
let recoveryAttempts = 0;
let lastRecoveryTime = 0;
const RECOVERY_RESET_WINDOW = 60 * 60 * 1000; // 1 hour

/**
 * Determine recovery level based on escalation pattern
 *
 * Recovery escalates through levels:
 * - Level 1: SOFT_RESET - Clear context, preserve state
 * - Level 2: MEDIUM_RESET - Kill process, restart from state
 * - Level 3: HARD_RESET - Reset to initial state
 * - Level 4: HUMAN_INTERVENTION - Alert operator
 *
 * Counter resets after 1 hour of stable operation.
 *
 * @returns The appropriate recovery level
 */
export function determineRecoveryLevel(): RecoveryLevel {
  const timeSinceLastRecovery = Date.now() - lastRecoveryTime;

  // Reset counter after 1 hour of stability
  if (timeSinceLastRecovery > RECOVERY_RESET_WINDOW) {
    recoveryAttempts = 0;
  }

  recoveryAttempts++;
  lastRecoveryTime = Date.now();

  if (recoveryAttempts === 1) return RecoveryLevel.SOFT_RESET;
  if (recoveryAttempts === 2) return RecoveryLevel.MEDIUM_RESET;
  if (recoveryAttempts === 3) return RecoveryLevel.HARD_RESET;
  return RecoveryLevel.HUMAN_INTERVENTION;
}

/**
 * Get current recovery state for testing/monitoring
 */
export function getRecoveryState(): { attempts: number; lastRecoveryTime: number } {
  return { attempts: recoveryAttempts, lastRecoveryTime };
}

/**
 * Reset recovery state (for testing or manual intervention)
 */
export function resetRecoveryState(): void {
  recoveryAttempts = 0;
  lastRecoveryTime = 0;
}

// ============================================================================
// Metrics Collection Helpers
// ============================================================================

/**
 * Metrics collector that aggregates data over time windows
 */
export class MetricsCollector {
  private toolCalls: number[] = [];
  private errors: number[] = [];
  private lastOutputTime: number = Date.now();
  private currentPhase: string = "idle";
  private phaseStartTime: number = Date.now();

  private readonly toolCallWindow = 60 * 1000;  // 1 minute for tool call rate
  private readonly errorWindow = 60 * 60 * 1000; // 1 hour for error rate

  /**
   * Record a tool call event
   */
  recordToolCall(): void {
    this.toolCalls.push(Date.now());
    this.pruneOldEntries();
  }

  /**
   * Record an error event
   */
  recordError(): void {
    this.errors.push(Date.now());
    this.pruneOldEntries();
  }

  /**
   * Record output received from agent
   */
  recordOutput(): void {
    this.lastOutputTime = Date.now();
  }

  /**
   * Update current phase
   */
  setPhase(phase: string): void {
    if (this.currentPhase !== phase) {
      this.currentPhase = phase;
      this.phaseStartTime = Date.now();
    }
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(heartbeatAge: number, memoryUsage: number): WatchdogMetrics {
    this.pruneOldEntries();

    const now = Date.now();
    const outputAge = now - this.lastOutputTime;

    return {
      heartbeatAge,
      toolCallRate: this.toolCalls.length,
      outputStalled: outputAge > 5 * 60 * 1000, // 5 minutes
      memoryUsage,
      errorRate: this.errors.length,
      phase: this.currentPhase,
      phaseStartTime: this.phaseStartTime
    };
  }

  /**
   * Get tool call rate (calls per minute)
   */
  getToolCallRate(): number {
    this.pruneOldEntries();
    return this.toolCalls.length;
  }

  /**
   * Get error rate (errors per hour)
   */
  getErrorRate(): number {
    this.pruneOldEntries();
    return this.errors.length;
  }

  /**
   * Check if output is stalled (>5 min since last output)
   */
  isOutputStalled(): boolean {
    return Date.now() - this.lastOutputTime > 5 * 60 * 1000;
  }

  /**
   * Reset all metrics (for context clear)
   */
  reset(): void {
    this.toolCalls = [];
    this.errors = [];
    this.lastOutputTime = Date.now();
    this.currentPhase = "idle";
    this.phaseStartTime = Date.now();
  }

  /**
   * Remove entries outside their respective time windows
   */
  private pruneOldEntries(): void {
    const now = Date.now();
    const toolCallCutoff = now - this.toolCallWindow;
    const errorCutoff = now - this.errorWindow;

    this.toolCalls = this.toolCalls.filter(t => t > toolCallCutoff);
    this.errors = this.errors.filter(e => e > errorCutoff);
  }
}

// ============================================================================
// Resilience Logger
// ============================================================================

/**
 * Log event types for resilience logging
 */
export type ResilienceLogEvent =
  | "HEALTH_CHECK"
  | "RECOVERY_TRIGGERED"
  | "RECOVERY_COMPLETE"
  | "CIRCUIT_BREAKER"
  | "TASK_CHECKPOINT"
  | "TASK_TIMEOUT"
  | "FAILOVER"
  | "ALERT";

/**
 * Logger for resilience events to resilience.log
 */
export class ResilienceLogger {
  private readonly logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;

    // Ensure log directory exists
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Format timestamp as ISO string
   */
  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Log a resilience event
   */
  log(event: ResilienceLogEvent, message: string, data?: Record<string, unknown>): void {
    const timestamp = this.formatTimestamp();
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";
    const line = `${timestamp} | ${event} | ${message}${dataStr}\n`;

    try {
      appendFileSync(this.logPath, line);
    } catch (error) {
      // Fall back to stderr
      console.error(`[RESILIENCE LOG ERROR] Failed to write to ${this.logPath}: ${error}`);
      console.error(`[RESILIENCE] ${line.trim()}`);
    }
  }

  /**
   * Log a health check result
   */
  logHealthCheck(result: HealthCheckResult, metrics: Partial<WatchdogMetrics>): void {
    this.log("HEALTH_CHECK", `Status: ${result.status}, Action: ${result.action}${result.reason ? ` - ${result.reason}` : ""}`, {
      status: result.status,
      action: result.action,
      heartbeatAge: metrics.heartbeatAge,
      toolCallRate: metrics.toolCallRate,
      phase: metrics.phase
    });
  }

  /**
   * Log a recovery action
   */
  logRecovery(level: RecoveryLevel, reason: string): void {
    this.log("RECOVERY_TRIGGERED", `Level: ${level} - ${reason}`, {
      level,
      reason,
      attempts: recoveryAttempts
    });
  }
}

// ============================================================================
// Integration with Existing Watchdog
// ============================================================================

/**
 * Get heartbeat age from existing watchdog infrastructure
 */
export function getHeartbeatAge(heartbeatPath: string): number {
  if (!heartbeatPath || !existsSync(heartbeatPath)) {
    return Infinity;
  }

  try {
    const stats = statSync(heartbeatPath);
    return Date.now() - stats.mtimeMs;
  } catch {
    return Infinity;
  }
}

/**
 * Get current memory usage in MB
 */
export function getMemoryUsage(): number {
  if (typeof process.memoryUsage === "function") {
    const usage = process.memoryUsage();
    return Math.round(usage.heapUsed / 1024 / 1024);
  }
  return 0;
}

// ============================================================================
// Singleton Instances
// ============================================================================

/** Global metrics collector instance */
let metricsCollector: MetricsCollector | null = null;

/**
 * Get or create the global metrics collector
 */
export function getMetricsCollector(): MetricsCollector {
  if (!metricsCollector) {
    metricsCollector = new MetricsCollector();
  }
  return metricsCollector;
}

/** Global resilience logger instance */
let resilienceLogger: ResilienceLogger | null = null;

/**
 * Get or create the global resilience logger
 */
export function getResilienceLogger(logPath?: string): ResilienceLogger {
  if (!resilienceLogger && logPath) {
    resilienceLogger = new ResilienceLogger(logPath);
  }
  if (!resilienceLogger) {
    throw new Error("ResilienceLogger not initialized. Call with logPath first.");
  }
  return resilienceLogger;
}

/**
 * Initialize the resilience logger with a path
 */
export function initResilienceLogger(logPath: string): ResilienceLogger {
  resilienceLogger = new ResilienceLogger(logPath);
  return resilienceLogger;
}

// Re-export RecoveryLevel for backwards compatibility
export { RecoveryLevel };
