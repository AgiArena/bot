/**
 * Tests for Backup Agent System
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdirSync, rmdirSync } from "fs";
import { join } from "path";
import {
  BackupAgent,
  createBackupAgent,
  shouldEnableBackupAgent,
  getBackupAgentPaths,
  DEFAULT_REPLICATION_INTERVAL_MS,
  DEFAULT_HEALTH_CHECK_INTERVAL_MS,
  type BackupMode
} from "../src/backup-agent";

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_DIR = "/tmp/test-backup-agent";
const TEST_PRIMARY_STATE = join(TEST_DIR, "agent-state.json");
const TEST_BACKUP_STATE = join(TEST_DIR, "backup-state.json");
const TEST_LOG_PATH = join(TEST_DIR, "resilience.log");
const TEST_PRIMARY_PID = join(TEST_DIR, "primary.pid");
const TEST_BACKUP_PID = join(TEST_DIR, "backup.pid");

function cleanupTestFiles(): void {
  const files = [
    TEST_PRIMARY_STATE,
    TEST_BACKUP_STATE,
    TEST_LOG_PATH,
    TEST_PRIMARY_PID,
    TEST_BACKUP_PID,
    `${TEST_BACKUP_STATE}.tmp`
  ];

  for (const file of files) {
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }

  if (existsSync(TEST_DIR)) {
    try {
      rmdirSync(TEST_DIR);
    } catch {}
  }
}

function createTestBackupAgent(options?: {
  enabled?: boolean;
  replicationIntervalMs?: number;
  healthCheckIntervalMs?: number;
}): BackupAgent {
  // Ensure test directory exists
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }

  return new BackupAgent({
    enabled: options?.enabled ?? true,
    replicationIntervalMs: options?.replicationIntervalMs ?? 100, // Fast for tests
    healthCheckIntervalMs: options?.healthCheckIntervalMs ?? 100, // Fast for tests
    primaryStatePath: TEST_PRIMARY_STATE,
    backupStatePath: TEST_BACKUP_STATE,
    logPath: TEST_LOG_PATH,
    primaryPidPath: TEST_PRIMARY_PID,
    backupPidPath: TEST_BACKUP_PID
  });
}

function createTestState(): string {
  return JSON.stringify({
    agentAddress: "0x123",
    totalCapital: 1000,
    currentBalance: 950,
    phase: "idle"
  }, null, 2);
}

// ============================================================================
// BackupAgent Tests
// ============================================================================

describe("BackupAgent", () => {
  let agent: BackupAgent;

  beforeEach(() => {
    cleanupTestFiles();
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (agent) {
      agent.stop();
    }
    cleanupTestFiles();
  });

  describe("Initialization", () => {
    test("starts in DISABLED mode by default", () => {
      agent = createTestBackupAgent({ enabled: false });

      expect(agent.getMode()).toBe("DISABLED");
      expect(agent.isEnabled()).toBe(false);
    });

    test("enabled flag is respected", () => {
      agent = createTestBackupAgent({ enabled: true });

      expect(agent.isEnabled()).toBe(true);
    });
  });

  describe("STANDBY Mode", () => {
    test("startStandby sets mode to STANDBY", () => {
      agent = createTestBackupAgent({ enabled: true });

      agent.startStandby(12345);

      expect(agent.getMode()).toBe("STANDBY");
    });

    test("startStandby writes PID files", () => {
      agent = createTestBackupAgent({ enabled: true });

      agent.startStandby(12345);

      expect(existsSync(TEST_PRIMARY_PID)).toBe(true);
      expect(existsSync(TEST_BACKUP_PID)).toBe(true);

      const primaryPid = readFileSync(TEST_PRIMARY_PID, "utf-8").trim();
      expect(primaryPid).toBe("12345");
    });

    test("startStandby does nothing if disabled", () => {
      agent = createTestBackupAgent({ enabled: false });

      agent.startStandby(12345);

      expect(agent.getMode()).toBe("DISABLED");
      expect(existsSync(TEST_PRIMARY_PID)).toBe(false);
    });

    test("startStandby logs event", () => {
      agent = createTestBackupAgent({ enabled: true });

      agent.startStandby(12345);

      expect(existsSync(TEST_LOG_PATH)).toBe(true);
      const log = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(log).toContain("STANDBY");
    });
  });

  describe("State Replication", () => {
    test("replicateState copies primary to backup", () => {
      agent = createTestBackupAgent({ enabled: true });
      const testState = createTestState();
      writeFileSync(TEST_PRIMARY_STATE, testState);

      const result = agent.replicateState();

      expect(result).toBe(true);
      expect(existsSync(TEST_BACKUP_STATE)).toBe(true);

      const backupState = readFileSync(TEST_BACKUP_STATE, "utf-8");
      expect(backupState).toBe(testState);
    });

    test("replicateState returns false if primary missing", () => {
      agent = createTestBackupAgent({ enabled: true });

      const result = agent.replicateState();

      expect(result).toBe(false);
    });

    test("replicateState updates status", () => {
      agent = createTestBackupAgent({ enabled: true });
      writeFileSync(TEST_PRIMARY_STATE, createTestState());

      agent.replicateState();

      const status = agent.getStatus();
      expect(status.lastReplicationTime).not.toBeNull();
      expect(status.replicationCount).toBe(1);
    });

    test("periodic replication in STANDBY mode", async () => {
      agent = createTestBackupAgent({
        enabled: true,
        replicationIntervalMs: 50
      });
      writeFileSync(TEST_PRIMARY_STATE, createTestState());

      agent.startStandby(process.pid);

      // Wait for a few replication cycles
      await new Promise(resolve => setTimeout(resolve, 150));

      const status = agent.getStatus();
      expect(status.replicationCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Health Monitoring", () => {
    test("isProcessRunning returns true for current process", () => {
      agent = createTestBackupAgent({ enabled: true });

      const result = agent.isProcessRunning(process.pid);

      expect(result).toBe(true);
    });

    test("isProcessRunning returns false for non-existent PID", () => {
      agent = createTestBackupAgent({ enabled: true });

      // Use a very high PID that's unlikely to exist
      const result = agent.isProcessRunning(999999);

      expect(result).toBe(false);
    });

    test("isProcessRunning returns false for invalid PID", () => {
      agent = createTestBackupAgent({ enabled: true });

      expect(agent.isProcessRunning(0)).toBe(false);
      expect(agent.isProcessRunning(-1)).toBe(false);
    });

    test("checkPrimaryHealth returns true when primary is running", async () => {
      agent = createTestBackupAgent({ enabled: true });
      agent.startStandby(process.pid); // Use current process as "primary"

      const result = await agent.checkPrimaryHealth();

      expect(result).toBe(true);
    });
  });

  describe("Promotion", () => {
    test("promoteToPrimary changes mode to PRIMARY", async () => {
      agent = createTestBackupAgent({ enabled: true });
      agent.startStandby(12345);

      await agent.promoteToPrimary();

      expect(agent.getMode()).toBe("PRIMARY");
    });

    test("promoteToPrimary increments failover count", async () => {
      agent = createTestBackupAgent({ enabled: true });
      agent.startStandby(12345);

      await agent.promoteToPrimary();

      const status = agent.getStatus();
      expect(status.failoversPerformed).toBe(1);
    });

    test("promoteToPrimary restores backup state to primary", async () => {
      agent = createTestBackupAgent({ enabled: true });
      const backupState = createTestState();
      writeFileSync(TEST_BACKUP_STATE, backupState);

      agent.startStandby(12345);
      await agent.promoteToPrimary();

      const primaryState = readFileSync(TEST_PRIMARY_STATE, "utf-8");
      expect(primaryState).toBe(backupState);
    });

    test("promoteToPrimary fails if not in STANDBY mode", async () => {
      agent = createTestBackupAgent({ enabled: true });

      const result = await agent.promoteToPrimary();

      expect(result).toBe(false);
      expect(agent.getMode()).toBe("DISABLED");
    });

    test("promoteToPrimary calls onPromote callback", async () => {
      agent = createTestBackupAgent({ enabled: true });
      let promotedPid: number | null = null;

      agent.onPromote((pid) => {
        promotedPid = pid;
      });

      agent.startStandby(12345);
      await agent.promoteToPrimary();

      expect(promotedPid).toBe(process.pid);
    });

    test("promoteToPrimary calls onFailover callback", async () => {
      agent = createTestBackupAgent({ enabled: true });
      let failoverCalled = false;

      agent.onFailover(async () => {
        failoverCalled = true;
      });

      agent.startStandby(12345);
      await agent.promoteToPrimary();

      expect(failoverCalled).toBe(true);
    });
  });

  describe("PID File Management", () => {
    test("readPidFile returns PID from file", () => {
      agent = createTestBackupAgent({ enabled: true });
      writeFileSync(TEST_PRIMARY_PID, "12345");

      const pid = agent.readPidFile(TEST_PRIMARY_PID);

      expect(pid).toBe(12345);
    });

    test("readPidFile returns null for missing file", () => {
      agent = createTestBackupAgent({ enabled: true });

      const pid = agent.readPidFile("/nonexistent/path.pid");

      expect(pid).toBeNull();
    });

    test("readPidFile returns null for invalid content", () => {
      agent = createTestBackupAgent({ enabled: true });
      writeFileSync(TEST_PRIMARY_PID, "not a number");

      const pid = agent.readPidFile(TEST_PRIMARY_PID);

      expect(pid).toBeNull();
    });
  });

  describe("Status", () => {
    test("getStatus returns complete status object", () => {
      agent = createTestBackupAgent({ enabled: true });

      const status = agent.getStatus();

      expect(status).toHaveProperty("mode");
      expect(status).toHaveProperty("primaryPid");
      expect(status).toHaveProperty("backupPid");
      expect(status).toHaveProperty("lastReplicationTime");
      expect(status).toHaveProperty("replicationCount");
      expect(status).toHaveProperty("failoversPerformed");
      expect(status).toHaveProperty("isHealthy");
    });

    test("status reflects current state", () => {
      agent = createTestBackupAgent({ enabled: true });
      writeFileSync(TEST_PRIMARY_STATE, createTestState());

      agent.startStandby(12345);
      agent.replicateState();

      const status = agent.getStatus();
      expect(status.mode).toBe("STANDBY");
      expect(status.primaryPid).toBe(12345);
      expect(status.replicationCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Stop", () => {
    test("stop sets mode to DISABLED", () => {
      agent = createTestBackupAgent({ enabled: true });
      agent.startStandby(12345);

      agent.stop();

      expect(agent.getMode()).toBe("DISABLED");
    });

    test("stop clears intervals", async () => {
      agent = createTestBackupAgent({
        enabled: true,
        replicationIntervalMs: 50
      });
      writeFileSync(TEST_PRIMARY_STATE, createTestState());

      agent.startStandby(12345);
      const countBefore = agent.getStatus().replicationCount;

      agent.stop();

      // Wait and verify no more replications occur
      await new Promise(resolve => setTimeout(resolve, 150));
      const countAfter = agent.getStatus().replicationCount;

      // Count should not have increased significantly after stop
      // (may have incremented once before stop took effect)
      expect(countAfter - countBefore).toBeLessThanOrEqual(1);
    });
  });
});

// ============================================================================
// Factory Function Tests
// ============================================================================

describe("createBackupAgent", () => {
  test("creates disabled agent by default", () => {
    const agent = createBackupAgent();

    expect(agent.isEnabled()).toBe(false);
    agent.stop();
  });

  test("creates enabled agent when specified", () => {
    const agent = createBackupAgent(true);

    expect(agent.isEnabled()).toBe(true);
    agent.stop();
  });
});

// ============================================================================
// Utility Function Tests
// ============================================================================

describe("Utility Functions", () => {
  describe("shouldEnableBackupAgent", () => {
    const originalEnv = process.env.BACKUP_AGENT_ENABLED;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.BACKUP_AGENT_ENABLED;
      } else {
        process.env.BACKUP_AGENT_ENABLED = originalEnv;
      }
    });

    test("returns false when env var not set", () => {
      delete process.env.BACKUP_AGENT_ENABLED;

      expect(shouldEnableBackupAgent()).toBe(false);
    });

    test("returns true when env var is 'true'", () => {
      process.env.BACKUP_AGENT_ENABLED = "true";

      expect(shouldEnableBackupAgent()).toBe(true);
    });

    test("returns false for other values", () => {
      process.env.BACKUP_AGENT_ENABLED = "false";
      expect(shouldEnableBackupAgent()).toBe(false);

      process.env.BACKUP_AGENT_ENABLED = "yes";
      expect(shouldEnableBackupAgent()).toBe(false);
    });
  });

  describe("getBackupAgentPaths", () => {
    test("returns correct paths for agent directory", () => {
      const paths = getBackupAgentPaths("/path/to/agent");

      expect(paths.primaryStatePath).toBe("/path/to/agent/agent-state.json");
      expect(paths.backupStatePath).toBe("/path/to/agent/backup-state.json");
      expect(paths.logPath).toBe("/path/to/agent/resilience.log");
      expect(paths.primaryPidPath).toBe("/path/to/agent/primary.pid");
      expect(paths.backupPidPath).toBe("/path/to/agent/backup.pid");
    });
  });
});

// ============================================================================
// Default Configuration Tests
// ============================================================================

describe("Default Configuration", () => {
  test("DEFAULT_REPLICATION_INTERVAL_MS is 30 seconds", () => {
    expect(DEFAULT_REPLICATION_INTERVAL_MS).toBe(30000);
  });

  test("DEFAULT_HEALTH_CHECK_INTERVAL_MS is 10 seconds", () => {
    expect(DEFAULT_HEALTH_CHECK_INTERVAL_MS).toBe(10000);
  });
});
