/**
 * Resilience Logging and Metrics System
 *
 * Provides structured logging for resilience events and a /metrics endpoint
 * for health monitoring. All events are logged to resilience.log.
 *
 * Metrics endpoint returns JSON with:
 * - agent: status, uptime, lastHeartbeat, phase, recoveryLevel
 * - tasks: completed, failed, inProgress, successRate
 * - circuitBreakers: polymarketAPI, baseRPC, backend states
 * - watchdog: checksPerformed, intervened, lastIntervention
 */

import { existsSync, appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from "fs";
import { dirname } from "path";

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Resilience log event types
 */
export type ResilienceEventType =
  | "WATCHDOG_CHECK"
  | "RECOVERY_START"
  | "RECOVERY_COMPLETE"
  | "CIRCUIT_BREAKER_OPEN"
  | "CIRCUIT_BREAKER_CLOSE"
  | "CIRCUIT_BREAKER_HALF_OPEN"
  | "TASK_START"
  | "TASK_CHECKPOINT"
  | "TASK_COMPLETE"
  | "TASK_FAILED"
  | "TASK_TIMEOUT"
  | "TASK_RESUME"
  | "FAILOVER_START"
  | "FAILOVER_COMPLETE"
  | "ALERT_SENT"
  | "OUTPUT_STALL"
  | "LOOP_DETECTED"
  | "CONTEXT_CLEAR";

/**
 * Log entry structure
 */
export interface ResilienceLogEntry {
  timestamp: string;
  event: ResilienceEventType;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Agent metrics for /metrics endpoint
 */
export interface AgentMetrics {
  status: "healthy" | "unhealthy" | "degraded" | "recovering";
  uptime: number;
  lastHeartbeat: number | null;
  phase: string;
  recoveryLevel: number;
}

/**
 * Task metrics for /metrics endpoint
 */
export interface TaskMetrics {
  completed: number;
  failed: number;
  inProgress: number;
  successRate: number;
}

/**
 * Circuit breaker metrics for /metrics endpoint
 */
export interface CircuitBreakerMetrics {
  polymarketAPI: "CLOSED" | "OPEN" | "HALF_OPEN";
  baseRPC: "CLOSED" | "OPEN" | "HALF_OPEN";
  backend: "CLOSED" | "OPEN" | "HALF_OPEN";
}

/**
 * Watchdog metrics for /metrics endpoint
 */
export interface WatchdogMetrics {
  checksPerformed: number;
  intervened: number;
  lastIntervention: string | null;
}

/**
 * Complete metrics response from /metrics endpoint
 */
export interface MetricsResponse {
  agent: AgentMetrics;
  tasks: TaskMetrics;
  circuitBreakers: CircuitBreakerMetrics;
  watchdog: WatchdogMetrics;
  timestamp: string;
}

/**
 * Resilience logger configuration
 */
export interface ResilienceLoggerConfig {
  logPath: string;
  metricsPath: string;
  maxLogSizeBytes: number;
  rotateOnSize: boolean;
}

// ============================================================================
// Default Configuration
// ============================================================================

/** Default log path */
export const DEFAULT_LOG_PATH = "bot/agent/resilience.log";

/** Default metrics state path */
export const DEFAULT_METRICS_PATH = "bot/agent/resilience-metrics.json";

/** Default max log size (10 MB) */
export const DEFAULT_MAX_LOG_SIZE = 10 * 1024 * 1024;

// ============================================================================
// Resilience Logger Class
// ============================================================================

/**
 * Centralized logger for all resilience events
 */
export class ResilienceLogger {
  private readonly logPath: string;
  private readonly metricsPath: string;
  private readonly maxLogSize: number;
  private readonly rotateOnSize: boolean;

  // Accumulated metrics
  private watchdogChecks = 0;
  private watchdogInterventions = 0;
  private lastIntervention: string | null = null;
  private tasksCompleted = 0;
  private tasksFailed = 0;
  private tasksInProgress = 0;

  constructor(config?: Partial<ResilienceLoggerConfig>) {
    this.logPath = config?.logPath ?? DEFAULT_LOG_PATH;
    this.metricsPath = config?.metricsPath ?? DEFAULT_METRICS_PATH;
    this.maxLogSize = config?.maxLogSizeBytes ?? DEFAULT_MAX_LOG_SIZE;
    this.rotateOnSize = config?.rotateOnSize ?? true;

    // Ensure directories exist
    this.ensureDirectory(this.logPath);
    this.ensureDirectory(this.metricsPath);

    // Load existing metrics if available
    this.loadMetrics();
  }

  private ensureDirectory(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // --------------------------------------------------------------------------
  // Logging
  // --------------------------------------------------------------------------

  /**
   * Log a resilience event
   */
  log(event: ResilienceEventType, message: string, data?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";
    const line = `${timestamp} | ${event} | ${message}${dataStr}\n`;

    // Check for log rotation
    if (this.rotateOnSize) {
      this.checkRotation();
    }

    try {
      appendFileSync(this.logPath, line);
    } catch (error) {
      console.error(`[ResilienceLogger] Failed to write: ${error}`);
      console.error(`[RESILIENCE] ${line.trim()}`);
    }

    // Update metrics based on event type
    this.updateMetricsFromEvent(event, data);
  }

  /**
   * Update internal metrics based on logged event
   */
  private updateMetricsFromEvent(event: ResilienceEventType, data?: Record<string, unknown>): void {
    switch (event) {
      case "WATCHDOG_CHECK":
        this.watchdogChecks++;
        break;
      case "RECOVERY_START":
      case "CONTEXT_CLEAR":
        this.watchdogInterventions++;
        this.lastIntervention = new Date().toISOString();
        break;
      case "TASK_START":
        this.tasksInProgress++;
        break;
      case "TASK_COMPLETE":
        this.tasksCompleted++;
        this.tasksInProgress = Math.max(0, this.tasksInProgress - 1);
        break;
      case "TASK_FAILED":
      case "TASK_TIMEOUT":
        this.tasksFailed++;
        this.tasksInProgress = Math.max(0, this.tasksInProgress - 1);
        break;
    }

    // Persist metrics periodically
    this.saveMetrics();
  }

  /**
   * Check if log needs rotation
   */
  private checkRotation(): void {
    try {
      if (!existsSync(this.logPath)) return;

      const stats = statSync(this.logPath);
      if (stats.size > this.maxLogSize) {
        this.rotateLog();
      }
    } catch {
      // Ignore rotation check errors
    }
  }

  /**
   * Rotate the log file
   */
  private rotateLog(): void {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rotatedPath = `${this.logPath}.${timestamp}`;

      // Rename current log
      const { renameSync } = require("fs");
      renameSync(this.logPath, rotatedPath);

      this.log("WATCHDOG_CHECK", "Log file rotated", {
        rotatedTo: rotatedPath
      });
    } catch (error) {
      console.error(`[ResilienceLogger] Failed to rotate log: ${error}`);
    }
  }

  // --------------------------------------------------------------------------
  // Convenience Logging Methods
  // --------------------------------------------------------------------------

  /**
   * Log a watchdog check
   */
  logWatchdogCheck(heartbeatAge: number, status: string): void {
    this.log("WATCHDOG_CHECK", `Heartbeat age: ${heartbeatAge}ms, Status: ${status}`, {
      heartbeatAge,
      status
    });
  }

  /**
   * Log recovery start
   */
  logRecoveryStart(level: string, reason: string): void {
    this.log("RECOVERY_START", `Level: ${level}, Reason: ${reason}`, {
      level,
      reason
    });
  }

  /**
   * Log recovery complete
   */
  logRecoveryComplete(level: string, durationMs: number): void {
    this.log("RECOVERY_COMPLETE", `Level: ${level}, Duration: ${durationMs}ms`, {
      level,
      durationMs
    });
  }

  /**
   * Log circuit breaker state change
   */
  logCircuitBreakerChange(name: string, from: string, to: string, reason: string): void {
    const eventType = to === "OPEN"
      ? "CIRCUIT_BREAKER_OPEN"
      : to === "CLOSED"
        ? "CIRCUIT_BREAKER_CLOSE"
        : "CIRCUIT_BREAKER_HALF_OPEN";

    this.log(eventType, `[${name}] ${from} -> ${to}: ${reason}`, {
      name,
      from,
      to,
      reason
    });
  }

  /**
   * Log task start
   */
  logTaskStart(taskId: string, type: string): void {
    this.log("TASK_START", `Task ${taskId} (${type}) started`, {
      taskId,
      type
    });
  }

  /**
   * Log task checkpoint
   */
  logTaskCheckpoint(taskId: string, checkpoint: string): void {
    this.log("TASK_CHECKPOINT", `Task ${taskId} checkpoint: ${checkpoint}`, {
      taskId,
      checkpoint
    });
  }

  /**
   * Log task complete
   */
  logTaskComplete(taskId: string, durationMs: number): void {
    this.log("TASK_COMPLETE", `Task ${taskId} completed in ${durationMs}ms`, {
      taskId,
      durationMs
    });
  }

  /**
   * Log task failed
   */
  logTaskFailed(taskId: string, error: string): void {
    this.log("TASK_FAILED", `Task ${taskId} failed: ${error}`, {
      taskId,
      error
    });
  }

  /**
   * Log task timeout
   */
  logTaskTimeout(taskId: string, timeout: number): void {
    this.log("TASK_TIMEOUT", `Task ${taskId} timed out after ${timeout}ms`, {
      taskId,
      timeout
    });
  }

  /**
   * Log task resume
   */
  logTaskResume(taskId: string, fromCheckpoint: string): void {
    this.log("TASK_RESUME", `Task ${taskId} resuming from ${fromCheckpoint}`, {
      taskId,
      fromCheckpoint
    });
  }

  /**
   * Log failover start
   */
  logFailoverStart(primaryPid: number): void {
    this.log("FAILOVER_START", `Primary (PID ${primaryPid}) failed, starting failover`, {
      primaryPid
    });
  }

  /**
   * Log failover complete
   */
  logFailoverComplete(newPrimaryPid: number): void {
    this.log("FAILOVER_COMPLETE", `Failover complete, new primary PID: ${newPrimaryPid}`, {
      newPrimaryPid
    });
  }

  /**
   * Log alert sent
   */
  logAlertSent(channel: string, message: string): void {
    this.log("ALERT_SENT", `Alert sent via ${channel}: ${message}`, {
      channel,
      message
    });
  }

  // --------------------------------------------------------------------------
  // Metrics Persistence
  // --------------------------------------------------------------------------

  /**
   * Load metrics from file
   */
  private loadMetrics(): void {
    if (!existsSync(this.metricsPath)) return;

    try {
      const content = readFileSync(this.metricsPath, "utf-8");
      const saved = JSON.parse(content);

      this.watchdogChecks = saved.watchdogChecks ?? 0;
      this.watchdogInterventions = saved.watchdogInterventions ?? 0;
      this.lastIntervention = saved.lastIntervention ?? null;
      this.tasksCompleted = saved.tasksCompleted ?? 0;
      this.tasksFailed = saved.tasksFailed ?? 0;
      this.tasksInProgress = saved.tasksInProgress ?? 0;
    } catch {
      // Ignore load errors, start fresh
    }
  }

  /**
   * Save metrics to file
   */
  private saveMetrics(): void {
    const metrics = {
      watchdogChecks: this.watchdogChecks,
      watchdogInterventions: this.watchdogInterventions,
      lastIntervention: this.lastIntervention,
      tasksCompleted: this.tasksCompleted,
      tasksFailed: this.tasksFailed,
      tasksInProgress: this.tasksInProgress
    };

    try {
      const tempPath = `${this.metricsPath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(metrics, null, 2));
      renameSync(tempPath, this.metricsPath);
    } catch {
      // Ignore save errors
    }
  }

  // --------------------------------------------------------------------------
  // Metrics Retrieval
  // --------------------------------------------------------------------------

  /**
   * Get watchdog metrics
   */
  getWatchdogMetrics(): WatchdogMetrics {
    return {
      checksPerformed: this.watchdogChecks,
      intervened: this.watchdogInterventions,
      lastIntervention: this.lastIntervention
    };
  }

  /**
   * Get task metrics
   */
  getTaskMetrics(): TaskMetrics {
    const total = this.tasksCompleted + this.tasksFailed;
    const successRate = total > 0 ? (this.tasksCompleted / total) * 100 : 100;

    return {
      completed: this.tasksCompleted,
      failed: this.tasksFailed,
      inProgress: this.tasksInProgress,
      successRate: Math.round(successRate * 100) / 100
    };
  }

  /**
   * Reset metrics (for testing)
   */
  resetMetrics(): void {
    this.watchdogChecks = 0;
    this.watchdogInterventions = 0;
    this.lastIntervention = null;
    this.tasksCompleted = 0;
    this.tasksFailed = 0;
    this.tasksInProgress = 0;
    this.saveMetrics();
  }
}

// ============================================================================
// Metrics Builder
// ============================================================================

/**
 * Build complete metrics response for /metrics endpoint
 */
export function buildMetricsResponse(params: {
  agentStatus: AgentMetrics["status"];
  uptime: number;
  lastHeartbeat: number | null;
  phase: string;
  recoveryLevel: number;
  taskMetrics: TaskMetrics;
  circuitBreakers: CircuitBreakerMetrics;
  watchdogMetrics: WatchdogMetrics;
}): MetricsResponse {
  return {
    agent: {
      status: params.agentStatus,
      uptime: params.uptime,
      lastHeartbeat: params.lastHeartbeat,
      phase: params.phase,
      recoveryLevel: params.recoveryLevel
    },
    tasks: params.taskMetrics,
    circuitBreakers: params.circuitBreakers,
    watchdog: params.watchdogMetrics,
    timestamp: new Date().toISOString()
  };
}

// ============================================================================
// Singleton Instance
// ============================================================================

let loggerInstance: ResilienceLogger | null = null;

/**
 * Get or create the global resilience logger
 */
export function getResilienceLogger(config?: Partial<ResilienceLoggerConfig>): ResilienceLogger {
  if (!loggerInstance) {
    loggerInstance = new ResilienceLogger(config);
  }
  return loggerInstance;
}

/**
 * Initialize the resilience logger with specific configuration
 */
export function initResilienceLogger(config: Partial<ResilienceLoggerConfig>): ResilienceLogger {
  loggerInstance = new ResilienceLogger(config);
  return loggerInstance;
}
