import type {
  HealthResponse,
  HealthParams,
  MetricsResponse,
  MetricsParams,
  CircuitBreakerMetrics,
  WatchdogMetrics,
  TaskMetrics,
  DiagnosticMetrics,
  HealthStatus,
  AgentPhase
} from "./types";
import { RecoveryLevel } from "./types";

/**
 * Create a health check response object
 */
export function createHealthResponse(params: HealthParams): HealthResponse {
  const isAgentRunning = params.agentPid !== null;

  return {
    status: isAgentRunning ? "healthy" : "unhealthy",
    agent: {
      pid: params.agentPid,
      uptime: params.uptime,
      restartCount: params.restartCount,
      lastRestartAt: params.lastRestartAt
    },
    config: {
      walletAddress: params.config.walletAddress,
      capital: params.config.capital,
      riskProfile: params.config.riskProfile,
      researchTerminals: params.config.researchTerminals,
      researchInterval: params.config.researchInterval,
      claudeSubscription: params.config.claudeSubscription
    }
  };
}

/**
 * Create health check response for restarting state
 */
export function createRestartingResponse(params: HealthParams): HealthResponse {
  return {
    ...createHealthResponse(params),
    status: "restarting"
  };
}

// ============================================================================
// Metrics Dashboard (AC#11)
// ============================================================================

/**
 * Create default circuit breaker metrics
 */
export function createDefaultCircuitBreakerMetrics(): CircuitBreakerMetrics {
  return {
    state: "CLOSED",
    failures: 0,
    lastFailure: null,
    usingFallback: false
  };
}

/**
 * Create default watchdog metrics
 */
export function createDefaultWatchdogMetrics(): WatchdogMetrics {
  return {
    checksPerformed: 0,
    intervened: 0,
    lastIntervention: null,
    lastInterventionType: null
  };
}

/**
 * Create default task metrics
 */
export function createDefaultTaskMetrics(): TaskMetrics {
  return {
    completed: 0,
    failed: 0,
    inProgress: 0,
    successRate: 1.0
  };
}

/**
 * Create default diagnostic metrics
 */
export function createDefaultDiagnosticMetrics(): DiagnosticMetrics {
  return {
    lastRun: null,
    checksPass: 0,
    checksFail: 0,
    checksWarn: 0
  };
}

/**
 * Create full metrics response (AC#11)
 *
 * Returns comprehensive metrics including:
 * - Agent status, uptime, heartbeat, phase, recovery level
 * - Task completion statistics
 * - Circuit breaker states for all external services
 * - Watchdog intervention history
 * - Diagnostic check results
 */
export function createMetricsResponse(params: MetricsParams): MetricsResponse {
  return {
    agent: {
      status: params.agentStatus,
      uptime: params.uptime,
      lastHeartbeat: params.lastHeartbeat,
      phase: params.phase,
      recoveryLevel: params.recoveryLevel
    },
    tasks: {
      completed: params.tasks.completed,
      failed: params.tasks.failed,
      inProgress: params.tasks.inProgress,
      successRate: params.tasks.successRate
    },
    circuitBreakers: {
      polymarketAPI: { ...params.circuitBreakers.polymarketAPI },
      baseRPC: { ...params.circuitBreakers.baseRPC },
      backend: { ...params.circuitBreakers.backend }
    },
    watchdog: {
      checksPerformed: params.watchdog.checksPerformed,
      intervened: params.watchdog.intervened,
      lastIntervention: params.watchdog.lastIntervention,
      lastInterventionType: params.watchdog.lastInterventionType
    },
    diagnostics: {
      lastRun: params.diagnostics.lastRun,
      checksPass: params.diagnostics.checksPass,
      checksFail: params.diagnostics.checksFail,
      checksWarn: params.diagnostics.checksWarn
    }
  };
}

/**
 * Create default metrics response with initial values
 */
export function createDefaultMetricsResponse(
  uptime: number = 0,
  phase: AgentPhase = "idle"
): MetricsResponse {
  return createMetricsResponse({
    agentStatus: "HEALTHY",
    uptime,
    lastHeartbeat: Date.now(),
    phase,
    recoveryLevel: RecoveryLevel.SOFT_RESET,
    tasks: createDefaultTaskMetrics(),
    circuitBreakers: {
      polymarketAPI: createDefaultCircuitBreakerMetrics(),
      baseRPC: createDefaultCircuitBreakerMetrics(),
      backend: createDefaultCircuitBreakerMetrics()
    },
    watchdog: createDefaultWatchdogMetrics(),
    diagnostics: createDefaultDiagnosticMetrics()
  });
}

/**
 * Calculate task success rate from completed and failed counts
 */
export function calculateSuccessRate(completed: number, failed: number): number {
  const total = completed + failed;
  if (total === 0) return 1.0;
  return completed / total;
}
