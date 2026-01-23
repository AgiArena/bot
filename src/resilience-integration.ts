/**
 * Resilience Integration Module
 *
 * Integrates all resilience components for the agent handler:
 * - Advanced watchdog with multi-dimensional monitoring
 * - Task queue with checkpoints for crash recovery
 * - Circuit breakers for external service calls
 * - Output monitoring for stuck/loop detection
 * - Backup agent system for hot standby
 * - Resilience logging and metrics
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";

// Import resilience modules
import {
  checkAgentHealth,
  determineRecoveryLevel,
  getMetricsCollector,
  MetricsCollector,
  RecoveryLevel,
  type WatchdogMetrics,
  type HealthCheckResult
} from "./watchdog-advanced";
import { TaskQueue, type Task, type CheckpointName } from "./task-queue";
import {
  CircuitBreaker,
  polymarketBreaker,
  baseRpcBreaker,
  backendBreaker,
  withCircuitBreaker
} from "./circuit-breaker";
import { OutputMonitor, createOutputRecorder, type OutputAnalysis } from "./output-monitor";
import { BackupAgent, createBackupAgent, shouldEnableBackupAgent } from "./backup-agent";
import {
  ResilienceLogger,
  buildMetricsResponse,
  initResilienceLogger,
  getResilienceLogger,
  type MetricsResponse
} from "./resilience-logger";
import {
  createExtendedState,
  createResilientState,
  loadExtendedState,
  saveExtendedState,
  updateHeartbeat,
  startPhase,
  recordRecoveryAttempt,
  completeRecovery,
  resetRecoveryCounter,
  shouldResetRecoveryCounter,
  setCurrentTask,
  updateCircuitBreakerStates,
  saveCheckpoint,
  getRecoverableState
} from "./extended-state";
import type { AgentState, ExtendedAgentState, ResilientAgentState } from "./types";

// ============================================================================
// Configuration
// ============================================================================

export interface ResilienceConfig {
  /** Directory for resilience files */
  agentDir: string;
  /** Whether backup agent is enabled */
  backupEnabled: boolean;
  /** Watchdog check interval in ms */
  watchdogIntervalMs: number;
  /** Output monitor stall threshold in seconds */
  stallThresholdSec: number;
}

export const DEFAULT_RESILIENCE_CONFIG: ResilienceConfig = {
  agentDir: "bot/agent",
  backupEnabled: false,
  watchdogIntervalMs: 60000, // 1 minute
  stallThresholdSec: 300 // 5 minutes
};

// ============================================================================
// Resilience Manager Class
// ============================================================================

/**
 * Central manager for all resilience components
 */
export class ResilienceManager {
  private readonly config: ResilienceConfig;
  private readonly logger: ResilienceLogger;
  private readonly taskQueue: TaskQueue;
  private readonly outputMonitor: OutputMonitor;
  private readonly backupAgent: BackupAgent;
  private readonly metricsCollector: MetricsCollector;

  private watchdogInterval: ReturnType<typeof setInterval> | null = null;
  private startTime: number;
  private lastHealthCheck: HealthCheckResult | null = null;

  // Paths
  private readonly extendedStatePath: string;
  private readonly resilienceLogPath: string;
  private readonly taskQueuePath: string;
  private readonly clearContextPath: string;

  constructor(config?: Partial<ResilienceConfig>) {
    this.config = { ...DEFAULT_RESILIENCE_CONFIG, ...config };
    this.startTime = Date.now();

    // Set up paths
    const agentDir = this.config.agentDir;
    this.extendedStatePath = join(agentDir, "extended-state.json");
    this.resilienceLogPath = join(agentDir, "resilience.log");
    this.taskQueuePath = join(agentDir, "task-queue.json");
    this.clearContextPath = join(agentDir, "CLEAR_CONTEXT");

    // Ensure directories exist
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
    }

    // Initialize components
    this.logger = initResilienceLogger({
      logPath: this.resilienceLogPath,
      metricsPath: join(agentDir, "resilience-metrics.json")
    });

    this.taskQueue = new TaskQueue(this.taskQueuePath);

    this.outputMonitor = new OutputMonitor({
      stallThresholdSec: this.config.stallThresholdSec,
      logPath: this.resilienceLogPath,
      clearContextPath: this.clearContextPath
    });

    this.backupAgent = createBackupAgent(
      this.config.backupEnabled || shouldEnableBackupAgent()
    );

    this.metricsCollector = getMetricsCollector();
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * Initialize resilience manager with agent state
   */
  initialize(baseState: AgentState): ResilientAgentState {
    const resilientState = createResilientState(baseState);
    saveExtendedState(resilientState, this.extendedStatePath);

    this.logger.log("WATCHDOG_CHECK", "Resilience manager initialized", {
      agentAddress: baseState.agentAddress,
      backupEnabled: this.backupAgent.isEnabled()
    });

    return resilientState;
  }

  /**
   * Start all resilience monitoring
   */
  start(primaryPid?: number): void {
    // Start watchdog monitoring
    this.startWatchdog();

    // Start backup agent if enabled
    if (this.backupAgent.isEnabled() && primaryPid) {
      this.backupAgent.startStandby(primaryPid);
      this.logger.log("FAILOVER_START", `Backup agent started in standby mode`, {
        primaryPid
      });
    }

    this.logger.log("WATCHDOG_CHECK", "Resilience monitoring started", {
      watchdogIntervalMs: this.config.watchdogIntervalMs,
      backupEnabled: this.backupAgent.isEnabled()
    });
  }

  /**
   * Stop all resilience monitoring
   */
  stop(): void {
    this.stopWatchdog();
    this.backupAgent.stop();

    this.logger.log("WATCHDOG_CHECK", "Resilience monitoring stopped");
  }

  // --------------------------------------------------------------------------
  // Watchdog Monitoring
  // --------------------------------------------------------------------------

  /**
   * Start periodic watchdog checks
   */
  private startWatchdog(): void {
    this.watchdogInterval = setInterval(() => {
      this.runWatchdogCheck();
    }, this.config.watchdogIntervalMs);

    // Run immediate check
    this.runWatchdogCheck();
  }

  /**
   * Stop watchdog monitoring
   */
  private stopWatchdog(): void {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  /**
   * Run a single watchdog health check
   */
  runWatchdogCheck(): HealthCheckResult {
    const state = loadExtendedState(this.extendedStatePath);
    const outputAnalysis = this.outputMonitor.analyze();

    // Collect metrics from various sources
    const metrics: WatchdogMetrics = {
      heartbeatAge: state ? Date.now() - state.lastHeartbeat : Infinity,
      toolCallRate: this.metricsCollector.getToolCallRate(),
      outputStalled: outputAnalysis.isStalled,
      memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
      errorRate: this.metricsCollector.getErrorRate(),
      phase: state?.phase || "idle",
      phaseStartTime: state?.phaseStartTime || Date.now()
    };

    // Check health
    const result = checkAgentHealth(metrics);
    this.lastHealthCheck = result;

    // Log the check
    this.logger.logWatchdogCheck(metrics.heartbeatAge, result.status);

    // Record to metrics collector
    this.metricsCollector.recordToolCall();

    // Handle any required action
    if (result.action !== "NONE") {
      this.handleHealthAction(result);
    }

    // Check if recovery counter should reset (1 hour stability)
    if (state && shouldResetRecoveryCounter(state)) {
      resetRecoveryCounter(this.extendedStatePath);
      this.logger.log("RECOVERY_COMPLETE", "Recovery counter reset after 1 hour stability");
    }

    return result;
  }

  /**
   * Handle a health check action
   */
  private handleHealthAction(result: HealthCheckResult): void {
    const level = determineRecoveryLevel();

    this.logger.logRecoveryStart(level, result.reason || "Unknown");

    // Record recovery attempt in state
    recordRecoveryAttempt(this.extendedStatePath, level as unknown as RecoveryLevel);

    // Execute recovery based on level and action
    switch (result.action) {
      case "CONTEXT_CLEAR":
        this.triggerContextClear(result.reason || "Health check triggered");
        break;
      case "SEND_SIGNAL":
        // Signal-based recovery (handled externally)
        this.logger.log("RECOVERY_START", "Signal-based recovery requested", { action: result.action });
        break;
      case "KILL_TERMINALS_RESTART":
        this.logger.log("RECOVERY_START", "Terminal restart requested", { action: result.action });
        break;
      case "RESTART":
        this.logger.log("RECOVERY_START", "Full restart requested", { action: result.action });
        break;
      case "EXPONENTIAL_BACKOFF":
        this.logger.log("RECOVERY_START", "Exponential backoff initiated", { action: result.action });
        break;
    }

    completeRecovery(this.extendedStatePath);
  }

  // --------------------------------------------------------------------------
  // Context Clear
  // --------------------------------------------------------------------------

  /**
   * Trigger context clear
   */
  triggerContextClear(reason: string): void {
    this.outputMonitor.triggerContextClear(reason);
    this.logger.log("CONTEXT_CLEAR", reason);
  }

  // --------------------------------------------------------------------------
  // Heartbeat
  // --------------------------------------------------------------------------

  /**
   * Update heartbeat timestamp
   */
  updateHeartbeat(): void {
    updateHeartbeat(this.extendedStatePath);
  }

  // --------------------------------------------------------------------------
  // Phase Management
  // --------------------------------------------------------------------------

  /**
   * Start a new phase
   */
  startPhase(phase: AgentState["phase"]): void {
    startPhase(this.extendedStatePath, phase);
    this.logger.log("TASK_START", `Phase started: ${phase}`, { phase });
  }

  // --------------------------------------------------------------------------
  // Task Queue
  // --------------------------------------------------------------------------

  /**
   * Get the task queue instance
   */
  getTaskQueue(): TaskQueue {
    return this.taskQueue;
  }

  /**
   * Create a new task
   */
  createTask(type: Task["type"], input?: Record<string, unknown>): Task {
    const task = this.taskQueue.addTask(type, input);
    setCurrentTask(this.extendedStatePath, task.id);
    this.logger.logTaskStart(task.id, type);
    return task;
  }

  /**
   * Complete a task
   */
  completeTask(taskId: string, output?: Record<string, unknown>): void {
    const task = this.taskQueue.completeTask(taskId, output);
    if (task) {
      const duration = task.completedAt! - task.startedAt!;
      this.logger.logTaskComplete(taskId, duration);
      setCurrentTask(this.extendedStatePath, null);
    }
  }

  /**
   * Fail a task
   */
  failTask(taskId: string, error: string): void {
    this.taskQueue.failTask(taskId, error);
    this.logger.logTaskFailed(taskId, error);
    setCurrentTask(this.extendedStatePath, null);
  }

  /**
   * Add checkpoint to current task
   */
  addCheckpoint(taskId: string, name: CheckpointName, data: Record<string, unknown>): void {
    this.taskQueue.addCheckpoint(taskId, name, data);
    saveCheckpoint(this.extendedStatePath, name, data);
    this.logger.logTaskCheckpoint(taskId, name);
  }

  /**
   * Recover tasks after crash
   */
  recoverTasks(): Array<{ task: Task; lastCheckpoint: Task["checkpoints"][0] | null; resumeFrom: CheckpointName | null }> {
    const recovered = this.taskQueue.recoverTasks();

    for (const { task, resumeFrom } of recovered) {
      if (resumeFrom) {
        this.logger.logTaskResume(task.id, resumeFrom);
      }
    }

    return recovered;
  }

  // --------------------------------------------------------------------------
  // Circuit Breakers
  // --------------------------------------------------------------------------

  /**
   * Execute operation with Polymarket API circuit breaker
   */
  async withPolymarketBreaker<T>(operation: () => Promise<T>, fallback?: T): Promise<T> {
    const result = await withCircuitBreaker(polymarketBreaker, operation, fallback);
    this.syncCircuitBreakerStates();
    return result;
  }

  /**
   * Execute operation with Base RPC circuit breaker
   */
  async withBaseRpcBreaker<T>(operation: () => Promise<T>, fallback?: T): Promise<T> {
    const result = await withCircuitBreaker(baseRpcBreaker, operation, fallback);
    this.syncCircuitBreakerStates();
    return result;
  }

  /**
   * Execute operation with Backend API circuit breaker
   */
  async withBackendBreaker<T>(operation: () => Promise<T>, fallback?: T): Promise<T> {
    const result = await withCircuitBreaker(backendBreaker, operation, fallback);
    this.syncCircuitBreakerStates();
    return result;
  }

  /**
   * Sync circuit breaker states to extended state
   */
  private syncCircuitBreakerStates(): void {
    updateCircuitBreakerStates(this.extendedStatePath, {
      polymarketAPI: polymarketBreaker.getState(),
      baseRPC: baseRpcBreaker.getState(),
      backend: backendBreaker.getState()
    });
  }

  /**
   * Get circuit breaker states
   */
  getCircuitBreakerStates(): { polymarketAPI: string; baseRPC: string; backend: string } {
    return {
      polymarketAPI: polymarketBreaker.getState(),
      baseRPC: baseRpcBreaker.getState(),
      backend: backendBreaker.getState()
    };
  }

  // --------------------------------------------------------------------------
  // Output Monitoring
  // --------------------------------------------------------------------------

  /**
   * Get output monitor instance
   */
  getOutputMonitor(): OutputMonitor {
    return this.outputMonitor;
  }

  /**
   * Create an output recorder function for stdout/stderr
   */
  createOutputRecorder(): (output: string | Buffer) => void {
    return createOutputRecorder(this.outputMonitor);
  }

  /**
   * Check for output issues and trigger recovery if needed
   */
  checkOutputHealth(): boolean {
    return this.outputMonitor.checkAndRecover();
  }

  // --------------------------------------------------------------------------
  // Backup Agent
  // --------------------------------------------------------------------------

  /**
   * Get backup agent instance
   */
  getBackupAgent(): BackupAgent {
    return this.backupAgent;
  }

  /**
   * Set failover callback
   */
  onFailover(callback: () => Promise<void>): void {
    this.backupAgent.onFailover(callback);
  }

  /**
   * Set promotion callback
   */
  onPromote(callback: (newPrimaryPid: number) => void): void {
    this.backupAgent.onPromote(callback);
  }

  // --------------------------------------------------------------------------
  // Metrics
  // --------------------------------------------------------------------------

  /**
   * Record a tool call
   */
  recordToolCall(): void {
    this.metricsCollector.recordToolCall();
  }

  /**
   * Record an error
   */
  recordError(): void {
    this.metricsCollector.recordError();
  }

  /**
   * Get metrics response for /metrics endpoint
   */
  getMetricsResponse(): MetricsResponse {
    const state = loadExtendedState(this.extendedStatePath);
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    return buildMetricsResponse({
      agentStatus: this.lastHealthCheck?.status === "HEALTHY" ? "healthy"
        : this.lastHealthCheck?.status === "CRITICAL" ? "unhealthy"
        : this.lastHealthCheck?.status === "DEGRADED" ? "degraded"
        : "recovering",
      uptime,
      lastHeartbeat: state?.lastHeartbeat ?? null,
      phase: state?.phase ?? "idle",
      recoveryLevel: state?.recoveryState?.attempts ?? 0,
      taskMetrics: this.logger.getTaskMetrics(),
      circuitBreakers: {
        polymarketAPI: polymarketBreaker.getState(),
        baseRPC: baseRpcBreaker.getState(),
        backend: backendBreaker.getState()
      },
      watchdogMetrics: this.logger.getWatchdogMetrics()
    });
  }

  /**
   * Get logger instance
   */
  getLogger(): ResilienceLogger {
    return this.logger;
  }

  // --------------------------------------------------------------------------
  // Recovery State
  // --------------------------------------------------------------------------

  /**
   * Get current recovery level
   */
  getCurrentRecoveryLevel(): number {
    const state = loadExtendedState(this.extendedStatePath);
    return state?.recoveryState?.attempts ?? 0;
  }

  /**
   * Get recoverable state for crash recovery
   */
  getRecoverableState(): ReturnType<typeof getRecoverableState> {
    return getRecoverableState(this.extendedStatePath);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let managerInstance: ResilienceManager | null = null;

/**
 * Get or create the global resilience manager
 */
export function getResilienceManager(config?: Partial<ResilienceConfig>): ResilienceManager {
  if (!managerInstance) {
    managerInstance = new ResilienceManager(config);
  }
  return managerInstance;
}

/**
 * Initialize the resilience manager
 */
export function initResilienceManager(config: Partial<ResilienceConfig>): ResilienceManager {
  managerInstance = new ResilienceManager(config);
  return managerInstance;
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export {
  // Watchdog
  checkAgentHealth,
  determineRecoveryLevel,
  RecoveryLevel,
  type WatchdogMetrics,
  type HealthCheckResult,

  // Task Queue
  TaskQueue,
  type Task,
  type CheckpointName,

  // Circuit Breaker
  CircuitBreaker,
  polymarketBreaker,
  baseRpcBreaker,
  backendBreaker,
  withCircuitBreaker,

  // Output Monitor
  OutputMonitor,
  createOutputRecorder,
  type OutputAnalysis,

  // Backup Agent
  BackupAgent,
  createBackupAgent,
  shouldEnableBackupAgent,

  // Resilience Logger
  ResilienceLogger,
  buildMetricsResponse,
  type MetricsResponse
};
