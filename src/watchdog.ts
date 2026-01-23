/**
 * Watchdog Monitoring System
 *
 * A standalone process that monitors the agent's health via heartbeat file
 * and process status, automatically restarting the agent on failure.
 *
 * Provides defense-in-depth monitoring separate from handler.ts
 */

import { existsSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from "fs";
import { dirname, join } from "path";
import type {
  WatchdogState,
  WatchdogConfig,
  WatchdogLogEvent,
  CrashRecord,
  RestartReason
} from "./watchdog-types";
import { getDefaultWatchdogConfig } from "./watchdog-types";

// ============================================================================
// Process Running Check
// ============================================================================

/**
 * Check if a process with the given PID is running
 * Uses signal 0 which doesn't kill but checks existence
 */
export function isProcessRunning(pid: number): boolean {
  if (pid <= 0) return false;

  try {
    // Signal 0 doesn't kill, just checks if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Heartbeat Age Check
// ============================================================================

/**
 * Get the age of the heartbeat file in milliseconds
 * Returns Infinity if file doesn't exist
 */
export function getHeartbeatAge(heartbeatPath: string): number {
  if (!heartbeatPath) return Infinity;

  try {
    const stats = statSync(heartbeatPath);
    return Date.now() - stats.mtimeMs;
  } catch {
    // File doesn't exist = infinite age (trigger restart)
    return Infinity;
  }
}

// ============================================================================
// Restart Delay Calculation (Exponential Backoff)
// ============================================================================

/**
 * Calculate delay before restart based on crash count in window
 * Implements exponential backoff:
 * - 1st crash: immediate (0ms)
 * - 2nd crash: 30 seconds
 * - 3rd crash: 60 seconds
 * - 4th+ crash: 5 minutes
 *
 * @param crashCount - Number of crashes in the current window (must be non-negative integer)
 * @returns Delay in milliseconds before next restart attempt
 */
export function getRestartDelay(crashCount: number): number {
  // Validate input - treat invalid values as 0
  if (!Number.isFinite(crashCount) || crashCount < 0) {
    return 0;
  }
  const count = Math.floor(crashCount);

  if (count <= 1) return 0;           // 1st crash: immediate
  if (count === 2) return 30000;      // 2nd crash: 30s
  if (count === 3) return 60000;      // 3rd crash: 60s
  return 300000;                      // 4th+: 5 min
}

// ============================================================================
// Watchdog Crash Tracker
// ============================================================================

/**
 * Internal crash record with Unix timestamp for efficient window checks
 */
interface InternalCrashRecord {
  timestampMs: number;
  record: CrashRecord;
}

/**
 * Tracks crash events within a rolling time window
 * Used to implement exponential backoff and operator alerts
 */
export class WatchdogCrashTracker {
  private crashes: InternalCrashRecord[] = [];
  private readonly windowMs: number;

  /**
   * @param windowMs Time window in milliseconds (default: 5 minutes)
   */
  constructor(windowMs: number = 300000) {
    this.windowMs = windowMs;
  }

  /**
   * Record a crash event
   */
  recordCrash(reason: RestartReason, previousPid: number | null = null, newPid: number | null = null): void {
    const now = Date.now();
    this.crashes.push({
      timestampMs: now,
      record: {
        timestamp: new Date(now).toISOString(),
        reason,
        previousPid,
        newPid
      }
    });
  }

  /**
   * Get total number of recorded crashes (all time)
   */
  getCrashCount(): number {
    return this.crashes.length;
  }

  /**
   * Get number of crashes within the time window
   * Uses pre-stored Unix timestamps for efficiency
   */
  getCrashCountInWindow(): number {
    const cutoff = Date.now() - this.windowMs;
    return this.crashes.filter(c => c.timestampMs > cutoff).length;
  }

  /**
   * Get delay for restart based on crashes already recorded in window
   * Call this AFTER recording the current crash
   */
  getRestartDelay(): number {
    return getRestartDelay(this.getCrashCountInWindow());
  }

  /**
   * Check if operator should be alerted (4+ crashes in window)
   */
  shouldAlertOperator(): boolean {
    return this.getCrashCountInWindow() >= 4;
  }

  /**
   * Get full crash history
   */
  getCrashHistory(): CrashRecord[] {
    return this.crashes.map(c => c.record);
  }

  /**
   * Reset the crash tracker
   */
  reset(): void {
    this.crashes = [];
  }
}

// ============================================================================
// Watchdog Logger
// ============================================================================

/**
 * Logger for watchdog events
 * Writes to a dedicated watchdog.log file (synchronous for simplicity)
 */
export class WatchdogLogger {
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
   * Format timestamp as YYYY-MM-DD HH:MM:SS
   */
  private formatTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  /**
   * Log an event to the watchdog log file (synchronous)
   * Falls back to stderr if file write fails
   */
  log(event: WatchdogLogEvent, message: string, data?: Record<string, unknown>): void {
    const timestamp = this.formatTimestamp(new Date());
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";
    const line = `${timestamp} | ${event} | ${message}${dataStr}\n`;

    try {
      appendFileSync(this.logPath, line);
    } catch (error) {
      // Fall back to stderr so operator can see log failures
      console.error(`[WATCHDOG LOG ERROR] Failed to write to ${this.logPath}: ${error}`);
      console.error(`[WATCHDOG] ${line.trim()}`);
    }
  }

  /**
   * Flush pending writes (no-op for synchronous logger, kept for API compatibility)
   */
  async flush(): Promise<void> {
    // No-op - writes are synchronous
  }
}

// ============================================================================
// Watchdog State Management
// ============================================================================

/**
 * Get default watchdog state
 */
export function getDefaultWatchdogState(): WatchdogState {
  return {
    agentPid: null,
    watchdogStartTime: Date.now(),
    lastCheckTime: Date.now(),
    crashHistory: []
  };
}

/**
 * Load watchdog state from file
 * Returns default state if file doesn't exist or is corrupted
 */
export function loadWatchdogState(statePath: string): WatchdogState {
  if (!existsSync(statePath)) {
    return getDefaultWatchdogState();
  }

  try {
    const content = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(content) as WatchdogState;

    // Validate and apply defaults
    return {
      agentPid: parsed.agentPid ?? null,
      watchdogStartTime: parsed.watchdogStartTime ?? Date.now(),
      lastCheckTime: parsed.lastCheckTime ?? Date.now(),
      crashHistory: parsed.crashHistory ?? []
    };
  } catch {
    // Corrupted file - return default
    return getDefaultWatchdogState();
  }
}

/**
 * Save watchdog state atomically using write-to-temp-then-rename pattern
 */
export function saveWatchdogState(state: WatchdogState, statePath: string): void {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${statePath}.tmp`;
  const content = JSON.stringify(state, null, 2);

  // Write to temp file first
  writeFileSync(tempPath, content);

  // Atomic rename
  renameSync(tempPath, statePath);
}

// ============================================================================
// Agent Health Check
// ============================================================================

/**
 * Health check result
 */
export interface HealthCheckResult {
  isHealthy: boolean;
  reason: RestartReason | null;
  heartbeatAge: number;
  processRunning: boolean;
}

/**
 * Check agent health based on heartbeat file and process status
 */
export function checkAgentHealth(config: WatchdogConfig, agentPid: number | null): HealthCheckResult {
  const heartbeatAge = getHeartbeatAge(config.heartbeatPath);
  const processRunning = agentPid !== null ? isProcessRunning(agentPid) : false;

  // Check heartbeat staleness first
  if (heartbeatAge > config.heartbeatStaleMs) {
    return {
      isHealthy: false,
      reason: "heartbeat_stale",
      heartbeatAge,
      processRunning
    };
  }

  // Then check if process is running
  if (agentPid !== null && !processRunning) {
    return {
      isHealthy: false,
      reason: "process_dead",
      heartbeatAge,
      processRunning
    };
  }

  // Agent is healthy
  return {
    isHealthy: true,
    reason: null,
    heartbeatAge,
    processRunning
  };
}

// ============================================================================
// Agent Management
// ============================================================================

/**
 * Kill agent process gracefully, falling back to SIGKILL if needed
 *
 * @param pid - Process ID to terminate
 * @returns true if process was killed or already dead, false on failure
 */
export function killAgent(pid: number): boolean {
  if (!isProcessRunning(pid)) return true;

  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    try {
      // Force kill if SIGTERM fails
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Spawn agent process (similar to handler.ts pattern)
 *
 * @param agentDir - Path to the agent directory
 * @returns The spawned process or null on failure
 */
export async function spawnAgent(agentDir: string): Promise<ReturnType<typeof Bun.spawn> | null> {
  try {
    // Ensure agent directory exists (using fs for non-blocking in async context)
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true });
    }

    // Spawn the handler (which manages the agent)
    const proc = Bun.spawn(["bun", "run", "src/handler.ts"], {
      cwd: dirname(agentDir), // bot directory
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });

    return proc;
  } catch {
    return null;
  }
}

// ============================================================================
// Main Watchdog Process
// ============================================================================

/**
 * Main watchdog entry point
 * Runs the monitoring loop
 */
export async function runWatchdog(configOverrides?: Partial<WatchdogConfig>): Promise<void> {
  const botDir = dirname(import.meta.dir);
  const config = {
    ...getDefaultWatchdogConfig(botDir),
    ...configOverrides
  };

  const logger = new WatchdogLogger(config.logPath);
  const crashTracker = new WatchdogCrashTracker();
  let state = loadWatchdogState(config.statePath);

  logger.log("START", "Watchdog started", {
    checkInterval: config.checkIntervalMs,
    heartbeatStaleMs: config.heartbeatStaleMs
  });

  // Initial agent start if not running
  if (!state.agentPid || !isProcessRunning(state.agentPid)) {
    logger.log("AGENT_START", "Starting agent (no running agent found)");

    const proc = await spawnAgent(config.agentDir);
    if (proc) {
      state.agentPid = proc.pid;
      state.watchdogStartTime = Date.now();
      saveWatchdogState(state, config.statePath);
      logger.log("AGENT_START", `Agent started (PID: ${proc.pid})`);
    } else {
      logger.log("ERROR", "Failed to start agent");
    }
  } else {
    logger.log("START", `Monitoring existing agent (PID: ${state.agentPid})`);
  }

  // Main monitoring loop
  const interval = setInterval(async () => {
    const health = checkAgentHealth(config, state.agentPid);
    state.lastCheckTime = Date.now();

    if (health.isHealthy) {
      logger.log("CHECK", `Agent healthy (PID: ${state.agentPid}, heartbeat: ${Math.floor(health.heartbeatAge / 1000)}s ago)`);
      saveWatchdogState(state, config.statePath);
      return;
    }

    // Agent needs restart
    const previousPid = state.agentPid;

    if (health.reason === "heartbeat_stale") {
      logger.log("STALE", `Agent heartbeat stale (last: ${Math.floor(health.heartbeatAge / 1000)}s ago), restarting...`);
    } else if (health.reason === "process_dead") {
      logger.log("CRASH", `Agent crashed (PID: ${previousPid}), restarting...`);
    }

    // Kill existing process if still running
    if (previousPid && isProcessRunning(previousPid)) {
      killAgent(previousPid);
      await Bun.sleep(1000); // Wait for cleanup
    }

    // Track crash and get delay
    crashTracker.recordCrash(health.reason || "unknown", previousPid);
    const delay = crashTracker.getRestartDelay();

    // Alert operator if needed
    // Note: console.error is intentional here - stderr alerts go directly to operator
    // even if log file is unavailable or being monitored by external tools
    if (crashTracker.shouldAlertOperator()) {
      const crashCount = crashTracker.getCrashCountInWindow();
      logger.log("ALERT", `Rapid failures detected (${crashCount} in 5 min), backing off ${delay / 1000}s`, {
        crashCount
      });
      console.error(`[WATCHDOG ALERT] Rapid agent failures - ${crashCount} crashes in 5 minutes`);
    }

    // Wait with backoff
    if (delay > 0) {
      await Bun.sleep(delay);
    }

    // Restart agent
    const proc = await spawnAgent(config.agentDir);
    if (proc) {
      state.agentPid = proc.pid;
      state.crashHistory.push({
        timestamp: new Date().toISOString(),
        reason: health.reason || "unknown",
        previousPid,
        newPid: proc.pid
      });
      saveWatchdogState(state, config.statePath);
      logger.log("AGENT_START", `Agent restarted (PID: ${proc.pid})`);
    } else {
      logger.log("ERROR", "Failed to restart agent");
    }
  }, config.checkIntervalMs);

  // Handle shutdown
  const shutdown = async (signal: string) => {
    logger.log("SHUTDOWN", `Received ${signal}, shutting down watchdog`);
    clearInterval(interval);

    // Kill agent on shutdown
    if (state.agentPid && isProcessRunning(state.agentPid)) {
      killAgent(state.agentPid);
      logger.log("SHUTDOWN", `Agent terminated (PID: ${state.agentPid})`);
    }

    state.agentPid = null;
    saveWatchdogState(state, config.statePath);
    await logger.flush();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// ============================================================================
// Entry Point
// ============================================================================

// Run if executed directly: bun run watchdog.ts
if (import.meta.main) {
  runWatchdog().catch((error) => {
    console.error("Fatal watchdog error:", error);
    process.exit(1);
  });
}
