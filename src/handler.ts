import { join, dirname } from "path";
import { existsSync, unlinkSync } from "fs";
import { loadConfig, createDefaultConfig, getSafeConfig } from "./config";
import { loadState, saveState, updateState } from "./state";
import { logCrash, CrashTracker, calculateRestartDelay } from "./crash-recovery";
import {
  createHealthResponse,
  createRestartingResponse,
  createMetricsResponse,
  createDefaultCircuitBreakerMetrics,
  createDefaultWatchdogMetrics,
  createDefaultTaskMetrics,
  createDefaultDiagnosticMetrics,
  calculateSuccessRate
} from "./health";
import { generatePrompt, writePromptFile } from "./prompt";
import { Logger } from "./logger";
import { recoverAgent, needsRecovery } from "./recovery";
import { loadAgentState, saveAgentState, getDefaultAgentState } from "./agent-state";
import {
  LifecycleTracker,
  checkClearContextFile,
  checkInProgressTransaction,
  removeClearContextFile,
  cleanResearchTerminalDirectories,
  killResearchTerminalProcesses,
  checkMatchedBetFile,
  removeMatchedBetFile
} from "./lifecycle";

// Import diagnostic modules (AC#1-#12)
import { SelfDiagnostics, getDefaultSelfDiagnosticsConfig } from "./self-diagnostics";
import { ServiceManager, getDefaultServiceManagerConfig } from "./service-manager";
import { FailureLearning, getDefaultFailureLearningConfig } from "./failure-learning";
import { IdempotencyManager, getDefaultIdempotencyManagerConfig } from "./idempotency";
import { DeadLetterQueue, getDefaultDeadLetterQueueConfig } from "./dead-letter-queue";
import { SyntheticMonitoring, getDefaultSyntheticMonitoringConfig } from "./synthetic-monitoring";
import { CorrelationTracker, getDefaultCorrelationTrackerConfig, withCorrelation } from "./correlation";
import { PromptEvolution, getDefaultPromptEvolutionConfig } from "./prompt-evolution";

import type { Config, HandlerState, HealthResponse, AgentState, MetricsResponse } from "./types";
import { RecoveryLevel } from "./types";

/**
 * Check if a path exists using Bun
 */
async function pathExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

/**
 * Ensure directory exists using Bun
 */
function ensureDir(dir: string): void {
  Bun.spawnSync(["mkdir", "-p", dir]);
}

// Paths configuration
const BOT_DIR = dirname(import.meta.dir);
const CONFIG_PATH = join(BOT_DIR, "config.json");
const AGENT_DIR = join(BOT_DIR, "agent");
const STATE_PATH = join(AGENT_DIR, "handler-state.json"); // Handler state (pid, restarts)
const AGENT_STATE_PATH = join(AGENT_DIR, "agent-state.json"); // Agent trading state (balance, bets, phase)
const LOGS_DIR = join(BOT_DIR, "logs");
const CRASHES_LOG_PATH = join(LOGS_DIR, "crashes.log");
const HEALTH_PORT = 3333;

// Lifecycle paths for context clearing and bet tracking
const CLEAR_CONTEXT_PATH = join(AGENT_DIR, "CLEAR_CONTEXT");
const IN_PROGRESS_TX_PATH = join(AGENT_DIR, "IN_PROGRESS_TX");
const MATCHED_BET_PATH = join(AGENT_DIR, "MATCHED_BET"); // Agent writes when bet matched
const RESEARCH_DIR = join(AGENT_DIR, "research");

// Global state
let config: Config;
let state: HandlerState;
let agentState: AgentState | null = null;
let agentProcess: ReturnType<typeof Bun.spawn> | null = null;
let isShuttingDown = false;
let isRestarting = false;
let isContextClearing = false; // Flag to distinguish context clear from crash
const crashTracker = new CrashTracker(5, 300000); // 5 crashes in 5 minutes
const lifecycleTracker = new LifecycleTracker(); // Lifecycle tracking for context clearing
let contextClearInterval: ReturnType<typeof setInterval> | null = null;
const logger = new Logger(LOGS_DIR);

// Diagnostic modules (AC#1-#12)
let selfDiagnostics: SelfDiagnostics | null = null;
let serviceManager: ServiceManager | null = null;
let failureLearning: FailureLearning | null = null;
let idempotencyManager: IdempotencyManager | null = null;
let deadLetterQueue: DeadLetterQueue | null = null;
let syntheticMonitoring: SyntheticMonitoring | null = null;
let correlationTracker: CorrelationTracker | null = null;
let promptEvolution: PromptEvolution | null = null;

// Watchdog metrics tracking
let watchdogChecksPerformed = 0;
let watchdogInterventions = 0;
let watchdogLastIntervention: number | null = null;
let watchdogLastInterventionType: string | null = null;

// Task metrics tracking
let tasksCompleted = 0;
let tasksFailed = 0;
let tasksInProgress = 0;

/**
 * Ensure all required directories exist
 */
function ensureDirectories(): void {
  const dirs = [AGENT_DIR, LOGS_DIR];
  for (const dir of dirs) {
    ensureDir(dir);
  }
}

/**
 * Load configuration, creating default if not found
 */
async function initConfig(): Promise<Config> {
  if (!(await pathExists(CONFIG_PATH))) {
    logger.warn("Config file not found, creating default config", { path: CONFIG_PATH });
    createDefaultConfig(CONFIG_PATH);
    logger.error("Please edit config.json with your agent credentials and set AGENT_PRIVATE_KEY env var, then restart");
    process.exit(1);
  }

  try {
    return loadConfig(CONFIG_PATH);
  } catch (error) {
    logger.error("Failed to load config", { error: String(error) });
    process.exit(1);
  }
}

/**
 * Spawn the Claude Code agent process
 */
async function spawnAgent(): Promise<ReturnType<typeof Bun.spawn>> {
  logger.info("Spawning Claude Code agent", {
    workingDir: AGENT_DIR,
    mode: "dontAsk"
  });

  // Ensure agent directory exists
  ensureDir(AGENT_DIR);

  // Generate and write prompt file BEFORE spawning
  const promptPath = join(AGENT_DIR, "prompt.md");
  const promptContent = generatePrompt(config.agent);
  const promptWriteSuccess = await writePromptFile(promptPath, promptContent);

  // Build spawn arguments - use prompt file if write succeeded, otherwise rely on env vars
  const spawnArgs = promptWriteSuccess
    ? ["claude-code", "--mode", "dontAsk", "--prompt-file", "prompt.md"]
    : ["claude-code", "--mode", "dontAsk"];

  if (promptWriteSuccess) {
    logger.info("Generated agent prompt file", { path: promptPath });
  } else {
    logger.warn("Failed to write prompt file, falling back to environment variables", { path: promptPath });
  }

  const proc = Bun.spawn(spawnArgs, {
    cwd: AGENT_DIR,
    env: {
      ...process.env,
      CLAUDE_CODE_MODE: "dontAsk",
      // Pass agent config as environment variables for the agent to use
      AGENT_WALLET_ADDRESS: config.agent.walletAddress,
      AGENT_CAPITAL: String(config.agent.capital),
      AGENT_RISK_PROFILE: config.agent.riskProfile,
      AGENT_RESEARCH_TERMINALS: String(config.agent.researchTerminals),
      AGENT_RESEARCH_INTERVAL: String(config.agent.researchInterval),
      AGENT_CLAUDE_SUBSCRIPTION: config.agent.claudeSubscription
    },
    // Run in background without inheriting stdio
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });

  // Pipe stdout and stderr to log file using efficient append
  // Also count message patterns for lifecycle tracking (CRITICAL-1 fix)
  const agentLogPath = join(LOGS_DIR, "agent.log");

  if (proc.stdout) {
    const reader = proc.stdout.getReader();
    (async () => {
      const { appendFileSync } = await import("fs");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = new TextDecoder().decode(value);
        appendFileSync(agentLogPath, text);

        // Count message patterns for lifecycle tracking
        // Tool calls and responses indicate message exchanges
        const messagePatterns = /tool_use|tool_result|assistant|human|\[TOOL/gi;
        const matches = text.match(messagePatterns);
        if (matches) {
          for (let i = 0; i < matches.length; i++) {
            lifecycleTracker.incrementMessageCount();
          }
        }
      }
    })();
  }

  if (proc.stderr) {
    const reader = proc.stderr.getReader();
    (async () => {
      const { appendFileSync } = await import("fs");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = new TextDecoder().decode(value);
        appendFileSync(agentLogPath, `[STDERR] ${text}`);
      }
    })();
  }

  return proc;
}

/**
 * Handle agent process exit
 */
async function handleAgentExit(exitCode: number | null, signal: string | null): Promise<void> {
  if (isShuttingDown) {
    logger.info("Agent stopped due to shutdown request");
    return;
  }

  // Context clear: agent exits cleanly with code 0 after SIGTERM
  // Don't count as crash, don't apply backoff
  if (isContextClearing) {
    logger.info("Agent exited for context clear (not a crash)", { exitCode });
    isContextClearing = false;
    return;
  }

  const timestamp = new Date().toISOString();

  // Log the crash
  logCrash({
    timestamp,
    exitCode,
    signal,
    error: `Agent process exited unexpectedly`
  }, CRASHES_LOG_PATH);

  crashTracker.recordCrash();

  logger.error("Agent process crashed", {
    exitCode,
    signal,
    crashCount: crashTracker.getCrashCount()
  });

  // Check if we should pause
  if (crashTracker.shouldPause()) {
    logger.warn("Too many crashes in a short period, pausing for 1 minute");
    isRestarting = true;
    await Bun.sleep(60000); // 1 minute pause
    crashTracker.reset();
    isRestarting = false;
  }

  // Calculate restart delay with exponential backoff
  const delay = calculateRestartDelay(state.restartCount + 1);
  logger.info(`Waiting ${delay}ms before restart`);
  await Bun.sleep(delay);

  // Update state and restart
  state = updateState(STATE_PATH, {
    restartCount: state.restartCount + 1,
    lastRestartAt: new Date().toISOString()
  });

  await startAgent();
}

/**
 * Start the agent and set up exit handling
 */
async function startAgent(): Promise<void> {
  if (isShuttingDown) return;

  agentProcess = await spawnAgent();

  // Update state with new PID
  state = updateState(STATE_PATH, {
    agentPid: agentProcess.pid,
    startTime: Date.now()
  });

  logger.info("Agent started", { pid: agentProcess.pid });

  // Monitor for exit
  agentProcess.exited.then((exitCode) => {
    const signal = null; // Bun.spawn doesn't expose signal directly
    handleAgentExit(exitCode, signal);
  });
}

/**
 * Calculate agent uptime in seconds
 */
function getUptime(): number {
  if (!state.startTime) return 0;
  return Math.floor((Date.now() - state.startTime) / 1000);
}

/**
 * Initialize all diagnostic modules (AC#1-#12)
 */
function initializeDiagnosticModules(): void {
  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const secondaryRpcUrl = process.env.SECONDARY_RPC_URL || null;
  const backendUrl = process.env.BACKEND_URL || "http://localhost:3001";

  // AC#1-3: Self-diagnostics
  selfDiagnostics = new SelfDiagnostics({
    agentDir: AGENT_DIR,
    logsDir: LOGS_DIR,
    agentStatePath: AGENT_STATE_PATH,
    memoryGrowthThreshold: 1.5,
    toolCallSuccessThreshold: 0.5,
    winRateThreshold: 0.4,
    diskSpaceThreshold: 1000
  });

  // AC#4: Service manager with circuit breakers and fallbacks
  serviceManager = new ServiceManager({
    cacheDir: join(AGENT_DIR, "cache"),
    primaryRpcUrl: rpcUrl,
    secondaryRpcUrl,
    backendUrl
  });

  // AC#5: Failure learning
  failureLearning = new FailureLearning(getDefaultFailureLearningConfig(BOT_DIR));

  // AC#6: Idempotency manager
  idempotencyManager = new IdempotencyManager(getDefaultIdempotencyManagerConfig(BOT_DIR));

  // AC#7: Dead letter queue with alert callback and weekly review
  deadLetterQueue = new DeadLetterQueue(getDefaultDeadLetterQueueConfig(BOT_DIR));
  deadLetterQueue.setOnAlert((letter) => {
    logger.error("Dead letter alert", {
      taskId: letter.taskId,
      taskType: letter.taskType,
      attempts: letter.attempts,
      lastError: letter.errors[letter.errors.length - 1]
    });
  });
  deadLetterQueue.setOnWeeklyReview((analysis) => {
    logger.info("Dead letter weekly review", {
      totalLetters: analysis.totalLetters,
      criticalCount: analysis.criticalCount,
      byTaskType: analysis.byTaskType,
      byErrorType: analysis.byErrorType
    });
  });
  deadLetterQueue.startWeeklyReviewScheduler();

  // AC#8: Synthetic monitoring
  syntheticMonitoring = new SyntheticMonitoring({
    agentDir: AGENT_DIR,
    rpcUrl,
    intervalMs: 10 * 60 * 1000 // 10 minutes
  });
  syntheticMonitoring.setServiceManager(serviceManager);

  // AC#9: Correlation tracking
  correlationTracker = new CorrelationTracker(getDefaultCorrelationTrackerConfig(BOT_DIR));

  // AC#10: Prompt evolution
  const basePrompt = generatePrompt(config.agent);
  promptEvolution = new PromptEvolution({
    statePath: join(AGENT_DIR, "prompt-evolution.json"),
    basePrompt
  });
  promptEvolution.setOnPromptChanged((newPrompt, reason) => {
    logger.info("Prompt evolved", { reason, version: promptEvolution!.getCurrentVersion() });
  });

  // Start synthetic monitoring
  syntheticMonitoring.start();

  // Schedule hourly self-diagnostics
  selfDiagnostics.start();

  logger.info("Diagnostic modules initialized", {
    modules: [
      "self-diagnostics",
      "service-manager",
      "failure-learning",
      "idempotency",
      "dead-letter-queue",
      "synthetic-monitoring",
      "correlation-tracker",
      "prompt-evolution"
    ]
  });
}

/**
 * Stop all diagnostic modules
 */
function stopDiagnosticModules(): void {
  if (syntheticMonitoring) {
    syntheticMonitoring.stop();
  }
  if (selfDiagnostics) {
    selfDiagnostics.stop();
  }
  if (deadLetterQueue) {
    deadLetterQueue.stopWeeklyReviewScheduler();
  }
  logger.info("Diagnostic modules stopped");
}

/**
 * Format metrics as Prometheus exposition format (Task 9.6)
 */
function formatMetricsAsPrometheus(metrics: MetricsResponse): string {
  const lines: string[] = [];

  // Agent metrics
  lines.push("# HELP agent_uptime_ms Agent uptime in milliseconds");
  lines.push("# TYPE agent_uptime_ms gauge");
  lines.push(`agent_uptime_ms ${metrics.agent.uptime}`);

  lines.push("# HELP agent_last_heartbeat_ms Last heartbeat timestamp");
  lines.push("# TYPE agent_last_heartbeat_ms gauge");
  lines.push(`agent_last_heartbeat_ms ${metrics.agent.lastHeartbeat}`);

  lines.push("# HELP agent_recovery_level Current recovery level");
  lines.push("# TYPE agent_recovery_level gauge");
  lines.push(`agent_recovery_level ${metrics.agent.recoveryLevel}`);

  // Task metrics
  lines.push("# HELP tasks_completed_total Total completed tasks");
  lines.push("# TYPE tasks_completed_total counter");
  lines.push(`tasks_completed_total ${metrics.tasks.completed}`);

  lines.push("# HELP tasks_failed_total Total failed tasks");
  lines.push("# TYPE tasks_failed_total counter");
  lines.push(`tasks_failed_total ${metrics.tasks.failed}`);

  lines.push("# HELP tasks_in_progress Current tasks in progress");
  lines.push("# TYPE tasks_in_progress gauge");
  lines.push(`tasks_in_progress ${metrics.tasks.inProgress}`);

  lines.push("# HELP tasks_success_rate Task success rate");
  lines.push("# TYPE tasks_success_rate gauge");
  lines.push(`tasks_success_rate ${metrics.tasks.successRate}`);

  // Circuit breaker metrics
  const cbStateToNum = (state: string): number => {
    if (state === "CLOSED") return 0;
    if (state === "HALF_OPEN") return 1;
    return 2; // OPEN
  };

  lines.push("# HELP circuit_breaker_state Circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)");
  lines.push("# TYPE circuit_breaker_state gauge");
  lines.push(`circuit_breaker_state{service="polymarket"} ${cbStateToNum(metrics.circuitBreakers.polymarketAPI.state)}`);
  lines.push(`circuit_breaker_state{service="base_rpc"} ${cbStateToNum(metrics.circuitBreakers.baseRPC.state)}`);
  lines.push(`circuit_breaker_state{service="backend"} ${cbStateToNum(metrics.circuitBreakers.backend.state)}`);

  lines.push("# HELP circuit_breaker_failures Circuit breaker failure count");
  lines.push("# TYPE circuit_breaker_failures gauge");
  lines.push(`circuit_breaker_failures{service="polymarket"} ${metrics.circuitBreakers.polymarketAPI.failures}`);
  lines.push(`circuit_breaker_failures{service="base_rpc"} ${metrics.circuitBreakers.baseRPC.failures}`);
  lines.push(`circuit_breaker_failures{service="backend"} ${metrics.circuitBreakers.backend.failures}`);

  // Watchdog metrics
  lines.push("# HELP watchdog_checks_total Total watchdog checks performed");
  lines.push("# TYPE watchdog_checks_total counter");
  lines.push(`watchdog_checks_total ${metrics.watchdog.checksPerformed}`);

  lines.push("# HELP watchdog_interventions_total Total watchdog interventions");
  lines.push("# TYPE watchdog_interventions_total counter");
  lines.push(`watchdog_interventions_total ${metrics.watchdog.intervened}`);

  // Diagnostics metrics
  lines.push("# HELP diagnostics_checks_pass Diagnostic checks that passed");
  lines.push("# TYPE diagnostics_checks_pass gauge");
  lines.push(`diagnostics_checks_pass ${metrics.diagnostics.checksPass}`);

  lines.push("# HELP diagnostics_checks_fail Diagnostic checks that failed");
  lines.push("# TYPE diagnostics_checks_fail gauge");
  lines.push(`diagnostics_checks_fail ${metrics.diagnostics.checksFail}`);

  lines.push("# HELP diagnostics_checks_warn Diagnostic checks with warnings");
  lines.push("# TYPE diagnostics_checks_warn gauge");
  lines.push(`diagnostics_checks_warn ${metrics.diagnostics.checksWarn}`);

  return lines.join("\n") + "\n";
}

/**
 * Build metrics response from all diagnostic modules (AC#11)
 */
function buildMetricsResponse(): MetricsResponse {
  const uptime = getUptime() * 1000; // Convert to ms
  const phase = agentState?.phase || "idle";
  // AgentState doesn't have lastHeartbeat, use current time
  const lastHeartbeat = Date.now();

  // Get circuit breaker states from service manager
  let circuitBreakers = {
    polymarketAPI: createDefaultCircuitBreakerMetrics(),
    baseRPC: createDefaultCircuitBreakerMetrics(),
    backend: createDefaultCircuitBreakerMetrics()
  };

  if (serviceManager) {
    const cbStates = serviceManager.getCircuitBreakerStates();
    const health = serviceManager.getServiceHealth();

    circuitBreakers = {
      polymarketAPI: {
        state: cbStates.polymarket,
        failures: health.polymarket.consecutiveFailures,
        lastFailure: health.polymarket.lastCheck,
        usingFallback: health.polymarket.fallback !== "NONE"
      },
      baseRPC: {
        state: cbStates.baseRPC,
        failures: health.baseRPC.consecutiveFailures,
        lastFailure: health.baseRPC.lastCheck,
        usingFallback: health.baseRPC.fallback !== "NONE"
      },
      backend: {
        state: cbStates.backend,
        failures: health.backend.consecutiveFailures,
        lastFailure: health.backend.lastCheck,
        usingFallback: health.backend.fallback !== "NONE"
      }
    };
  }

  // Get diagnostic metrics from self-diagnostics
  let diagnosticMetrics = createDefaultDiagnosticMetrics();
  if (selfDiagnostics) {
    const lastReport = selfDiagnostics.getLastReport();
    if (lastReport) {
      let checksPass = 0, checksFail = 0, checksWarn = 0;
      for (const check of lastReport.checks) {
        if (check.status === "PASS") checksPass++;
        else if (check.status === "FAIL") checksFail++;
        else if (check.status === "WARN") checksWarn++;
      }
      diagnosticMetrics = {
        lastRun: lastReport.timestamp,
        checksPass,
        checksFail,
        checksWarn
      };
    }
  }

  // Determine agent status based on diagnostics
  let agentStatus: "HEALTHY" | "WARNING" | "STUCK" | "CRITICAL" | "DEGRADED" = "HEALTHY";
  if (diagnosticMetrics.checksFail > 0) {
    agentStatus = diagnosticMetrics.checksFail > 2 ? "CRITICAL" : "WARNING";
  }

  // Get recovery level - AgentState doesn't have recoveryState, use default
  const recoveryLevel = RecoveryLevel.SOFT_RESET;

  return createMetricsResponse({
    agentStatus,
    uptime,
    lastHeartbeat,
    phase,
    recoveryLevel,
    tasks: {
      completed: tasksCompleted,
      failed: tasksFailed,
      inProgress: tasksInProgress,
      successRate: calculateSuccessRate(tasksCompleted, tasksFailed)
    },
    circuitBreakers,
    watchdog: {
      checksPerformed: watchdogChecksPerformed,
      intervened: watchdogInterventions,
      lastIntervention: watchdogLastIntervention,
      lastInterventionType: watchdogLastInterventionType
    },
    diagnostics: diagnosticMetrics
  });
}

/**
 * Create the health check HTTP server
 */
function startHealthServer(): void {
  const server = Bun.serve({
    port: HEALTH_PORT,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        const safeConfig = getSafeConfig(config);

        let response: HealthResponse;
        if (isRestarting) {
          response = createRestartingResponse({
            agentPid: agentProcess?.pid ?? null,
            uptime: getUptime(),
            restartCount: state.restartCount,
            lastRestartAt: state.lastRestartAt,
            config: safeConfig
          });
        } else {
          response = createHealthResponse({
            agentPid: agentProcess?.pid ?? null,
            uptime: getUptime(),
            restartCount: state.restartCount,
            lastRestartAt: state.lastRestartAt,
            config: safeConfig
          });
        }

        return new Response(JSON.stringify(response, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      // AC#11: Metrics dashboard endpoint with optional Prometheus format
      if (url.pathname === "/metrics" && req.method === "GET") {
        const metrics = buildMetricsResponse();
        const format = url.searchParams.get("format");

        if (format === "prometheus") {
          // Convert to Prometheus exposition format
          const prometheusOutput = formatMetricsAsPrometheus(metrics);
          return new Response(prometheusOutput, {
            status: 200,
            headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" }
          });
        }

        return new Response(JSON.stringify(metrics, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response("Not Found", { status: 404 });
    },
    error(error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        logger.error(`Port ${HEALTH_PORT} is already in use. Is another handler running?`);
        process.exit(1);
      }
      logger.error("Health server error", { error: String(error) });
      return new Response("Internal Server Error", { status: 500 });
    }
  });

  logger.info("Health check server started", { port: HEALTH_PORT });
}

/**
 * Handle graceful shutdown
 */
function setupShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Received ${signal}, shutting down gracefully`);

    // Stop diagnostic modules
    stopDiagnosticModules();

    // Stop context clear monitor
    stopContextClearMonitor();

    // Kill agent process
    if (agentProcess) {
      agentProcess.kill();
      logger.info("Agent process terminated");
    }

    // Save final handler state
    saveState({
      ...state,
      agentPid: null
    }, STATE_PATH);

    // Save final agent state (set phase to idle for clean restart)
    if (agentState) {
      agentState.phase = "idle";
      agentState.researchJobId = null;
      saveAgentState(agentState, AGENT_STATE_PATH);
      logger.info("Agent state saved", {
        phase: agentState.phase,
        matchedBets: agentState.matchedBets.length,
        balance: agentState.currentBalance
      });
    }

    logger.info("Shutdown complete");

    // Flush pending log writes before exit
    await logger.flush();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/**
 * Check if agent process is still running
 */
function isAgentProcessRunning(): boolean {
  if (!agentProcess || agentProcess.pid === undefined) return false;
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(agentProcess.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle context clear process
 * Gracefully stops agent, cleans up research terminals, and respawns
 */
async function handleContextClear(reason: 'file_signal' | 'threshold'): Promise<void> {
  // Check if transaction in progress - defer clear
  if (checkInProgressTransaction(IN_PROGRESS_TX_PATH)) {
    logger.info("Context clear deferred - transaction in progress");
    return;
  }

  // Capture metrics BEFORE reset for logging (HIGH-2 fix)
  const metrics = lifecycleTracker.getFormatted();
  logger.info(`🔄 Initiating context clear (${metrics})`, { reason });

  // Mark that we're doing a context clear (not a crash)
  isContextClearing = true;

  // Graceful shutdown sequence with SIGKILL fallback (MEDIUM-1 fix)
  if (agentProcess) {
    // First try SIGTERM for graceful shutdown
    agentProcess.kill("SIGTERM");
    await Bun.sleep(5000); // Wait 5 seconds for graceful shutdown

    // Check if process still running, escalate to SIGKILL if needed
    if (isAgentProcessRunning()) {
      logger.warn("Agent did not terminate gracefully, sending SIGKILL");
      try {
        process.kill(agentProcess.pid!, "SIGKILL");
        await Bun.sleep(1000); // Brief wait for SIGKILL to take effect
      } catch {
        // Process may have exited between check and kill
      }
    }
  }

  // Kill research terminal processes
  killResearchTerminalProcesses();

  // Clean up research terminal directories
  cleanResearchTerminalDirectories(RESEARCH_DIR);

  // Remove signal file if present
  if (checkClearContextFile(CLEAR_CONTEXT_PATH)) {
    removeClearContextFile(CLEAR_CONTEXT_PATH);
  }

  // Reset lifecycle metrics for new session
  lifecycleTracker.reset();

  // Respawn agent
  try {
    await startAgent();
    // Log with metrics per AC#5 spec (HIGH-2 fix)
    logger.info(`🔄 Context cleared (${metrics})`);
  } catch (error) {
    logger.error("Failed to respawn agent after context clear", { error: String(error) });
    // Fallback: wait and retry
    await Bun.sleep(5000);
    await startAgent();
  }
}

/**
 * Start context clear monitoring interval
 * Checks for clear triggers and matched bets every 30 seconds
 */
function startContextClearMonitor(): void {
  contextClearInterval = setInterval(async () => {
    if (isShuttingDown || isRestarting || isContextClearing) {
      return;
    }

    // Check for matched bet signal file (CRITICAL-2 fix)
    const matchedBet = checkMatchedBetFile(MATCHED_BET_PATH);
    if (matchedBet) {
      lifecycleTracker.recordBetMatched(matchedBet.pnl);
      logger.info("Recorded matched bet from signal file", {
        betId: matchedBet.betId,
        pnl: matchedBet.pnl
      });
      removeMatchedBetFile(MATCHED_BET_PATH);
    }

    // Check CLEAR_CONTEXT file signal
    if (checkClearContextFile(CLEAR_CONTEXT_PATH)) {
      await handleContextClear('file_signal');
      return;
    }

    // Check lifecycle thresholds
    if (lifecycleTracker.shouldClearContext()) {
      await handleContextClear('threshold');
    }
  }, 30000); // Check every 30 seconds
}

/**
 * Stop context clear monitoring
 */
function stopContextClearMonitor(): void {
  if (contextClearInterval) {
    clearInterval(contextClearInterval);
    contextClearInterval = null;
  }
}

/**
 * Run recovery protocol before starting agent
 */
async function runRecoveryProtocol(): Promise<void> {
  const rpcUrl = process.env.BASE_RPC_URL;

  // Check if there's existing agent state
  agentState = loadAgentState(AGENT_STATE_PATH);

  if (agentState) {
    logger.info("Found existing agent state", {
      phase: agentState.phase,
      matchedBets: agentState.matchedBets.length,
      balance: agentState.currentBalance
    });

    // Run recovery if needed
    if (needsRecovery(AGENT_STATE_PATH)) {
      logger.info("Running crash recovery protocol");

      const recoveryResult = await recoverAgent(AGENT_STATE_PATH, AGENT_DIR, rpcUrl);

      if (recoveryResult.success) {
        logger.info("Recovery completed", {
          message: recoveryResult.message,
          researchRecovered: recoveryResult.details.researchRecovered,
          balanceReconciled: recoveryResult.details.balanceReconciled,
          phaseReset: recoveryResult.details.phaseReset
        });

        if (recoveryResult.details.discrepancies.length > 0) {
          logger.warn("Recovery found discrepancies", {
            discrepancies: recoveryResult.details.discrepancies
          });
        }

        agentState = recoveryResult.state;
      } else {
        logger.warn("Recovery failed, starting fresh", {
          message: recoveryResult.message
        });
      }
    }
  } else {
    // Initialize fresh agent state
    logger.info("No existing agent state, initializing fresh state");

    agentState = getDefaultAgentState(
      config.agent.walletAddress,
      config.agent.capital
    );
    saveAgentState(agentState, AGENT_STATE_PATH);

    logger.info("Initialized new agent state", {
      address: agentState.agentAddress,
      capital: agentState.totalCapital
    });
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Initialize
  ensureDirectories();

  logger.info("AgiArena Agent Handler starting");

  // Load configuration
  config = await initConfig();
  logger.info("Configuration loaded", getSafeConfig(config));

  // Load persisted handler state
  state = loadState(STATE_PATH);
  if (state.restartCount > 0) {
    logger.info("Resuming from previous session", {
      previousRestarts: state.restartCount,
      lastRestartAt: state.lastRestartAt
    });
  }

  // Run recovery protocol BEFORE spawning agent
  await runRecoveryProtocol();

  // Set up shutdown handlers
  setupShutdownHandlers();

  // Start health check server
  try {
    startHealthServer();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      logger.error(`Port ${HEALTH_PORT} is already in use. Check if another handler is running.`);
      process.exit(1);
    }
    throw error;
  }

  // Start the agent
  await startAgent();

  // Start context clear monitor (checks every 30 seconds)
  startContextClearMonitor();
  logger.info("Context clear monitor started", {
    maxMessages: 50,
    maxRuntimeHours: 4,
    checkIntervalMs: 30000
  });

  // Initialize diagnostic modules (AC#1-#12)
  initializeDiagnosticModules();

  logger.info("Handler initialized successfully", {
    healthEndpoint: `http://localhost:${HEALTH_PORT}/health`,
    metricsEndpoint: `http://localhost:${HEALTH_PORT}/metrics`,
    agentDir: AGENT_DIR,
    logsDir: LOGS_DIR
  });
}

// Run main
main().catch((error) => {
  logger.error("Fatal error in main", { error: String(error) });
  process.exit(1);
});
