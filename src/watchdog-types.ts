/**
 * Watchdog monitoring system types
 * Provides type definitions for the watchdog process that monitors agent health
 */

/**
 * Reason for agent restart
 */
export type RestartReason = "heartbeat_stale" | "process_dead" | "unknown";

/**
 * Record of a crash/restart event
 */
export interface CrashRecord {
  timestamp: string;
  reason: RestartReason;
  previousPid: number | null;
  newPid: number | null;
}

/**
 * Watchdog state persisted to watchdog-state.json
 */
export interface WatchdogState {
  agentPid: number | null;
  watchdogStartTime: number;
  lastCheckTime: number;
  crashHistory: CrashRecord[];
}

/**
 * Watchdog configuration
 */
export interface WatchdogConfig {
  /** Check interval in milliseconds (default: 60000 = 60 seconds) */
  checkIntervalMs: number;
  /** Heartbeat staleness threshold in milliseconds (default: 600000 = 10 minutes) */
  heartbeatStaleMs: number;
  /** Path to heartbeat file */
  heartbeatPath: string;
  /** Path to watchdog log file */
  logPath: string;
  /** Path to watchdog state file */
  statePath: string;
  /** Path to agent directory */
  agentDir: string;
}

/**
 * Log event types for watchdog logging
 */
export type WatchdogLogEvent =
  | "START"
  | "AGENT_START"
  | "CHECK"
  | "STALE"
  | "CRASH"
  | "ALERT"
  | "SHUTDOWN"
  | "ERROR";

/**
 * Heartbeat file content
 */
export interface HeartbeatContent {
  status: "ALIVE";
  timestamp: number;
}

/**
 * Default watchdog configuration
 */
export function getDefaultWatchdogConfig(botDir: string): WatchdogConfig {
  return {
    checkIntervalMs: 60000,      // 60 seconds
    heartbeatStaleMs: 600000,    // 10 minutes
    heartbeatPath: `${botDir}/agent/heartbeat.txt`,
    logPath: `${botDir}/logs/watchdog.log`,
    statePath: `${botDir}/watchdog-state.json`,
    agentDir: `${botDir}/agent`
  };
}
