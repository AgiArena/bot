/**
 * Backup Agent System
 *
 * Implements a hot standby system for zero-downtime failover.
 * The backup agent runs in STANDBY mode, replicating state from the primary.
 * On primary death detection, the backup promotes itself to primary.
 *
 * Features:
 * - STANDBY mode with state file watching
 * - State replication every 30 seconds
 * - Primary death detection via process monitoring
 * - Automatic failover with backup promotion
 * - Spawns new backup after promotion
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, mkdirSync, appendFileSync } from "fs";
import { dirname, join } from "path";

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Backup agent mode
 */
export type BackupMode = "STANDBY" | "PRIMARY" | "DISABLED";

/**
 * Backup agent configuration
 */
export interface BackupAgentConfig {
  /** Interval for state replication in milliseconds */
  replicationIntervalMs: number;
  /** Interval for primary health check in milliseconds */
  healthCheckIntervalMs: number;
  /** Path to primary agent state file */
  primaryStatePath: string;
  /** Path to backup agent state file */
  backupStatePath: string;
  /** Path to resilience log */
  logPath: string;
  /** Path to PID file for primary agent */
  primaryPidPath: string;
  /** Path to PID file for backup agent */
  backupPidPath: string;
  /** Whether backup agent is enabled */
  enabled: boolean;
}

/**
 * Backup agent status
 */
export interface BackupAgentStatus {
  mode: BackupMode;
  primaryPid: number | null;
  backupPid: number | null;
  lastReplicationTime: number | null;
  replicationCount: number;
  failoversPerformed: number;
  isHealthy: boolean;
}

// ============================================================================
// Default Configuration
// ============================================================================

/** Default replication interval (30 seconds) */
export const DEFAULT_REPLICATION_INTERVAL_MS = 30 * 1000;

/** Default health check interval (10 seconds) */
export const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10 * 1000;

// ============================================================================
// Backup Agent Class
// ============================================================================

/**
 * Manages backup agent for hot standby failover
 */
export class BackupAgent {
  private mode: BackupMode = "DISABLED";
  private primaryPid: number | null = null;
  private backupPid: number | null = null;
  private lastReplicationTime: number | null = null;
  private replicationCount = 0;
  private failoversPerformed = 0;

  private replicationInterval: ReturnType<typeof setInterval> | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  private readonly config: BackupAgentConfig;

  // Callbacks for external integration
  private onFailoverCallback: (() => Promise<void>) | null = null;
  private onPromoteCallback: ((newPrimaryPid: number) => void) | null = null;

  constructor(config: Partial<BackupAgentConfig> & { enabled?: boolean }) {
    this.config = {
      replicationIntervalMs: config.replicationIntervalMs ?? DEFAULT_REPLICATION_INTERVAL_MS,
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS,
      primaryStatePath: config.primaryStatePath ?? "bot/agent/agent-state.json",
      backupStatePath: config.backupStatePath ?? "bot/agent/backup-state.json",
      logPath: config.logPath ?? "bot/agent/resilience.log",
      primaryPidPath: config.primaryPidPath ?? "bot/agent/primary.pid",
      backupPidPath: config.backupPidPath ?? "bot/agent/backup.pid",
      enabled: config.enabled ?? false
    };

    // Ensure directories exist
    this.ensureDirectory(this.config.logPath);
    this.ensureDirectory(this.config.primaryStatePath);
  }

  private ensureDirectory(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // --------------------------------------------------------------------------
  // Lifecycle Management
  // --------------------------------------------------------------------------

  /**
   * Start the backup agent in STANDBY mode
   * @param primaryPid PID of the primary agent to monitor
   */
  startStandby(primaryPid: number): void {
    if (!this.config.enabled) {
      this.log("Backup agent is disabled, skipping start");
      return;
    }

    this.mode = "STANDBY";
    this.primaryPid = primaryPid;
    this.backupPid = process.pid;

    // Write PID files
    this.writePidFile(this.config.primaryPidPath, primaryPid);
    this.writePidFile(this.config.backupPidPath, process.pid);

    this.log(`Starting STANDBY mode, monitoring primary PID ${primaryPid}`);

    // Start replication
    this.startReplication();

    // Start health monitoring
    this.startHealthMonitoring();
  }

  /**
   * Stop the backup agent
   */
  stop(): void {
    this.log("Stopping backup agent");

    if (this.replicationInterval) {
      clearInterval(this.replicationInterval);
      this.replicationInterval = null;
    }

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    this.mode = "DISABLED";
  }

  /**
   * Promote backup to primary
   * Called when primary death is detected
   */
  async promoteToPrimary(): Promise<boolean> {
    if (this.mode !== "STANDBY") {
      this.log("Cannot promote: not in STANDBY mode");
      return false;
    }

    this.log("Promoting backup to PRIMARY");
    this.mode = "PRIMARY";
    this.failoversPerformed++;

    // Stop monitoring the old primary
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Copy backup state to primary state
    try {
      if (existsSync(this.config.backupStatePath)) {
        copyFileSync(this.config.backupStatePath, this.config.primaryStatePath);
        this.log("Restored state from backup");
      }
    } catch (error) {
      this.log(`Failed to restore state: ${error}`);
    }

    // Update PID files
    this.writePidFile(this.config.primaryPidPath, process.pid);
    this.primaryPid = process.pid;

    // Notify callback
    if (this.onPromoteCallback) {
      this.onPromoteCallback(process.pid);
    }

    // Trigger failover callback
    if (this.onFailoverCallback) {
      try {
        await this.onFailoverCallback();
        this.log("Failover callback completed");
      } catch (error) {
        this.log(`Failover callback failed: ${error}`);
      }
    }

    return true;
  }

  // --------------------------------------------------------------------------
  // State Replication
  // --------------------------------------------------------------------------

  /**
   * Start periodic state replication
   */
  private startReplication(): void {
    // Perform initial replication
    this.replicateState();

    // Set up periodic replication
    this.replicationInterval = setInterval(() => {
      this.replicateState();
    }, this.config.replicationIntervalMs);
  }

  /**
   * Replicate state from primary to backup
   */
  replicateState(): boolean {
    if (!existsSync(this.config.primaryStatePath)) {
      return false;
    }

    try {
      // Read primary state
      const primaryState = readFileSync(this.config.primaryStatePath, "utf-8");

      // Write to backup state atomically
      const tempPath = `${this.config.backupStatePath}.tmp`;
      writeFileSync(tempPath, primaryState);
      renameSync(tempPath, this.config.backupStatePath);

      this.lastReplicationTime = Date.now();
      this.replicationCount++;

      return true;
    } catch (error) {
      this.log(`Replication failed: ${error}`);
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Health Monitoring
  // --------------------------------------------------------------------------

  /**
   * Start monitoring primary agent health
   */
  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(async () => {
      await this.checkPrimaryHealth();
    }, this.config.healthCheckIntervalMs);
  }

  /**
   * Check if primary agent is still running
   */
  async checkPrimaryHealth(): Promise<boolean> {
    if (this.primaryPid === null) {
      return false;
    }

    const isRunning = this.isProcessRunning(this.primaryPid);

    if (!isRunning) {
      this.log(`Primary agent (PID ${this.primaryPid}) is dead, initiating failover`);
      await this.promoteToPrimary();
      return false;
    }

    return true;
  }

  /**
   * Check if a process is running by PID
   */
  isProcessRunning(pid: number): boolean {
    if (pid <= 0) return false;

    try {
      // Signal 0 doesn't kill, just checks if process exists
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // PID File Management
  // --------------------------------------------------------------------------

  /**
   * Write PID to file
   */
  private writePidFile(path: string, pid: number): void {
    try {
      this.ensureDirectory(path);
      writeFileSync(path, pid.toString());
    } catch (error) {
      this.log(`Failed to write PID file: ${error}`);
    }
  }

  /**
   * Read PID from file
   */
  readPidFile(path: string): number | null {
    if (!existsSync(path)) {
      return null;
    }

    try {
      const content = readFileSync(path, "utf-8").trim();
      const pid = parseInt(content, 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Status and Callbacks
  // --------------------------------------------------------------------------

  /**
   * Get current backup agent status
   */
  getStatus(): BackupAgentStatus {
    return {
      mode: this.mode,
      primaryPid: this.primaryPid,
      backupPid: this.backupPid,
      lastReplicationTime: this.lastReplicationTime,
      replicationCount: this.replicationCount,
      failoversPerformed: this.failoversPerformed,
      isHealthy: this.mode !== "DISABLED" &&
        (this.mode === "PRIMARY" || this.primaryPid !== null)
    };
  }

  /**
   * Set callback for failover event
   */
  onFailover(callback: () => Promise<void>): void {
    this.onFailoverCallback = callback;
  }

  /**
   * Set callback for promotion event
   */
  onPromote(callback: (newPrimaryPid: number) => void): void {
    this.onPromoteCallback = callback;
  }

  /**
   * Check if backup agent is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get current mode
   */
  getMode(): BackupMode {
    return this.mode;
  }

  // --------------------------------------------------------------------------
  // Logging
  // --------------------------------------------------------------------------

  /**
   * Log a backup agent event
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const entry = `${timestamp} | BACKUP_AGENT | ${message}\n`;

    try {
      appendFileSync(this.config.logPath, entry);
    } catch (error) {
      console.error(`[BackupAgent] ${message}`);
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a backup agent with default configuration
 * @param enabled Whether to enable the backup agent
 */
export function createBackupAgent(
  enabled: boolean = false,
  config?: Partial<BackupAgentConfig>
): BackupAgent {
  return new BackupAgent({
    ...config,
    enabled
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if backup agent should be enabled based on environment
 */
export function shouldEnableBackupAgent(): boolean {
  return process.env.BACKUP_AGENT_ENABLED === "true";
}

/**
 * Get backup agent paths based on agent directory
 */
export function getBackupAgentPaths(agentDir: string): Pick<
  BackupAgentConfig,
  "primaryStatePath" | "backupStatePath" | "logPath" | "primaryPidPath" | "backupPidPath"
> {
  return {
    primaryStatePath: join(agentDir, "agent-state.json"),
    backupStatePath: join(agentDir, "backup-state.json"),
    logPath: join(agentDir, "resilience.log"),
    primaryPidPath: join(agentDir, "primary.pid"),
    backupPidPath: join(agentDir, "backup.pid")
  };
}
