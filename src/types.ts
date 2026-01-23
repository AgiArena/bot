/**
 * Claude Code subscription tier type
 */
export type ClaudeSubscriptionTier = "free" | "pro" | "team";

/**
 * Request limit configuration per subscription tier
 */
export interface RequestLimit {
  maxRequestsPer5Min: number;
  recommendedAgents: number;
  researchTerminals: number;
  researchInterval: number;
}

/**
 * Tier configuration with request limits and optional warning
 */
export interface TierConfig {
  requestLimit: RequestLimit;
  warningMessage: string | null;
}

/**
 * Agent configuration from config.json
 */
export interface AgentConfig {
  walletAddress: string;
  privateKey: string;
  capital: number;
  riskProfile: "conservative" | "balanced" | "aggressive";
  researchTerminals: number;
  researchInterval: number;
  claudeSubscription: ClaudeSubscriptionTier;
}

/**
 * Init configuration from CLI setup wizard
 * Maps to backend API registration format
 */
export interface InitConfig {
  walletAddress: string;
  privateKey: string;
  capital: number;
  betSizeMin: number;
  betSizeMax: number;
  riskProfile: "risk_averse" | "balanced" | "risk_seeking";
  claudeSubscription: ClaudeSubscriptionTier;
}

/**
 * Root configuration structure
 */
export interface Config {
  agent: AgentConfig;
}

/**
 * Handler state persisted to state.json
 */
export interface HandlerState {
  agentPid: number | null;
  startTime: number | null;
  restartCount: number;
  lastRestartAt: string | null;
}

/**
 * Crash log entry
 */
export interface CrashLogEntry {
  timestamp: string;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
}

/**
 * Health check response
 */
export interface HealthResponse {
  status: "healthy" | "unhealthy" | "restarting";
  agent: {
    pid: number | null;
    uptime: number;
    restartCount: number;
    lastRestartAt: string | null;
  };
  config: {
    walletAddress: string;
    capital: number;
    riskProfile: string;
    researchTerminals: number;
    researchInterval: number;
    claudeSubscription: ClaudeSubscriptionTier;
  };
}

/**
 * Parameters for creating health response
 */
export interface HealthParams {
  agentPid: number | null;
  uptime: number;
  restartCount: number;
  lastRestartAt: string | null;
  config: {
    walletAddress: string;
    capital: number;
    riskProfile: string;
    researchTerminals: number;
    researchInterval: number;
    claudeSubscription: ClaudeSubscriptionTier;
  };
}

/**
 * Agent workflow phase
 */
export type AgentPhase = "research" | "evaluation" | "execution" | "idle";

/**
 * Matched bet record for tracking trading activity
 */
export interface MatchedBet {
  betId: string;
  amount: string; // USDC amount as string for precision
  evScore: number; // Expected value score when matched
  matchedAt: number; // Unix timestamp
  status: "matched" | "won" | "lost" | "pending";
  txHash: string; // Transaction hash on Base
}

/**
 * Agent trading state persisted to agent/state.json
 * Separate from HandlerState which tracks handler-level concerns
 */
export interface AgentState {
  agentAddress: string;
  totalCapital: number;
  currentBalance: number;
  matchedBets: MatchedBet[];
  lastResearchAt: number | null;
  researchJobId: string | null;
  phase: AgentPhase;
}

// ============================================================================
// Resilience and Recovery Types
// ============================================================================

/**
 * Recovery levels for progressive recovery strategy
 * Escalates through levels on repeated failures
 */
export enum RecoveryLevel {
  /** Level 1: Clear context, preserve state */
  SOFT_RESET = "context_clear",
  /** Level 2: Kill process, restart from state */
  MEDIUM_RESET = "process_restart",
  /** Level 3: Reset to initial state */
  HARD_RESET = "state_reset",
  /** Level 4: Alert operator via Telegram/log */
  HUMAN_INTERVENTION = "alert_operator"
}

/**
 * Health status from watchdog multi-dimensional monitoring
 */
export type HealthStatus = "HEALTHY" | "WARNING" | "STUCK" | "CRITICAL" | "DEGRADED";

/**
 * Actions the watchdog can trigger based on health status
 */
export type HealthAction =
  | "NONE"
  | "CONTEXT_CLEAR"
  | "SEND_SIGNAL"
  | "KILL_TERMINALS_RESTART"
  | "RESTART"
  | "EXPONENTIAL_BACKOFF";

/**
 * Recovery state tracking for progressive recovery
 */
export interface RecoveryState {
  /** Number of recovery attempts in current window */
  attempts: number;
  /** Timestamp of last recovery attempt */
  lastRecoveryTime: number;
  /** Current recovery level */
  currentLevel: RecoveryLevel;
  /** Whether recovery is in progress */
  inProgress: boolean;
}

/**
 * Extended agent state with resilience fields
 * Includes recoverable state for crash recovery
 */
export interface ExtendedAgentState extends AgentState {
  /** Timestamp of last successful heartbeat */
  lastHeartbeat: number;
  /** Current task ID being processed */
  currentTaskId: string | null;
  /** Phase start time for timeout detection */
  phaseStartTime: number;
  /** Recovery state tracking */
  recoveryState: RecoveryState;
  /** Circuit breaker states snapshot */
  circuitBreakerStates: {
    polymarketAPI: "CLOSED" | "OPEN" | "HALF_OPEN";
    baseRPC: "CLOSED" | "OPEN" | "HALF_OPEN";
    backend: "CLOSED" | "OPEN" | "HALF_OPEN";
  };
}

/**
 * Recoverable state fields that can be restored after crash
 */
export interface RecoverableState {
  /** Last checkpoint name for current task */
  lastCheckpoint: string | null;
  /** Data saved at checkpoint */
  checkpointData: Record<string, unknown>;
  /** Tasks that were in progress */
  pendingTaskIds: string[];
  /** Timestamp of state snapshot */
  snapshotTime: number;
}

/**
 * Full resilient agent state combining extended and recoverable state
 */
export interface ResilientAgentState extends ExtendedAgentState {
  /** Recoverable state for crash recovery */
  recoverableState: RecoverableState;
}

// ============================================================================
// Metrics Dashboard Types (AC#11)
// ============================================================================

/**
 * Circuit breaker status for metrics
 */
export interface CircuitBreakerMetrics {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  failures: number;
  lastFailure: number | null;
  usingFallback: boolean;
}

/**
 * Watchdog metrics for dashboard
 */
export interface WatchdogMetrics {
  checksPerformed: number;
  intervened: number;
  lastIntervention: number | null;
  lastInterventionType: string | null;
}

/**
 * Task metrics for dashboard
 */
export interface TaskMetrics {
  completed: number;
  failed: number;
  inProgress: number;
  successRate: number;
}

/**
 * Diagnostic metrics for dashboard
 */
export interface DiagnosticMetrics {
  lastRun: number | null;
  checksPass: number;
  checksFail: number;
  checksWarn: number;
}

/**
 * Full metrics response (AC#11)
 */
export interface MetricsResponse {
  agent: {
    status: HealthStatus;
    uptime: number;
    lastHeartbeat: number;
    phase: AgentPhase;
    recoveryLevel: RecoveryLevel;
  };
  tasks: TaskMetrics;
  circuitBreakers: {
    polymarketAPI: CircuitBreakerMetrics;
    baseRPC: CircuitBreakerMetrics;
    backend: CircuitBreakerMetrics;
  };
  watchdog: WatchdogMetrics;
  diagnostics: DiagnosticMetrics;
}

/**
 * Parameters for creating metrics response
 */
export interface MetricsParams {
  agentStatus: HealthStatus;
  uptime: number;
  lastHeartbeat: number;
  phase: AgentPhase;
  recoveryLevel: RecoveryLevel;
  tasks: TaskMetrics;
  circuitBreakers: {
    polymarketAPI: CircuitBreakerMetrics;
    baseRPC: CircuitBreakerMetrics;
    backend: CircuitBreakerMetrics;
  };
  watchdog: WatchdogMetrics;
  diagnostics: DiagnosticMetrics;
}
