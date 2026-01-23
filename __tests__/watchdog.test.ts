import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, mkdirSync, rmSync, statSync } from "fs";
import { join, dirname } from "path";

// Test directory setup
const TEST_DIR = join(dirname(import.meta.dir), "test-watchdog");
const TEST_HEARTBEAT_PATH = join(TEST_DIR, "heartbeat.txt");
const TEST_LOG_PATH = join(TEST_DIR, "watchdog.log");
const TEST_STATE_PATH = join(TEST_DIR, "watchdog-state.json");

beforeEach(() => {
  // Create test directory
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
});

afterEach(() => {
  // Cleanup test files
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ============================================================================
// Unit Tests: Process Running Check
// ============================================================================
describe("isProcessRunning", () => {
  // Import the function (will be implemented)
  const { isProcessRunning } = require("../src/watchdog");

  test("returns true for current process (known running process)", () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  test("returns false for non-existent PID", () => {
    // Use a very high PID that's unlikely to exist
    expect(isProcessRunning(999999999)).toBe(false);
  });

  test("returns false for negative PID", () => {
    expect(isProcessRunning(-1)).toBe(false);
  });

  test("returns false for zero PID", () => {
    expect(isProcessRunning(0)).toBe(false);
  });
});

// ============================================================================
// Unit Tests: Heartbeat Age Check
// ============================================================================
describe("getHeartbeatAge", () => {
  const { getHeartbeatAge } = require("../src/watchdog");

  test("returns file age for existing file", async () => {
    writeFileSync(TEST_HEARTBEAT_PATH, "ALIVE 1234567890");
    // Small delay to ensure file is written
    await Bun.sleep(10);

    const age = getHeartbeatAge(TEST_HEARTBEAT_PATH);

    // Should be less than 1 second old
    expect(age).toBeLessThan(1000);
    expect(age).toBeGreaterThanOrEqual(0);
  });

  test("returns Infinity for missing file", () => {
    const age = getHeartbeatAge("/nonexistent/path/heartbeat.txt");
    expect(age).toBe(Infinity);
  });

  test("returns Infinity for empty path", () => {
    const age = getHeartbeatAge("");
    expect(age).toBe(Infinity);
  });

  test("handles file that was modified a while ago", async () => {
    writeFileSync(TEST_HEARTBEAT_PATH, "ALIVE 1234567890");

    // Wait a bit
    await Bun.sleep(100);

    const age = getHeartbeatAge(TEST_HEARTBEAT_PATH);

    // Should be at least 100ms old
    expect(age).toBeGreaterThanOrEqual(90); // Allow some margin
  });
});

// ============================================================================
// Unit Tests: Restart Delay Calculation (Exponential Backoff)
// ============================================================================
describe("getRestartDelay", () => {
  const { getRestartDelay } = require("../src/watchdog");

  test("returns 0 for first crash (immediate restart)", () => {
    expect(getRestartDelay(1)).toBe(0);
  });

  test("returns 30s for second crash within window", () => {
    expect(getRestartDelay(2)).toBe(30000);
  });

  test("returns 60s for third crash within window", () => {
    expect(getRestartDelay(3)).toBe(60000);
  });

  test("returns 5min for fourth+ crash within window", () => {
    expect(getRestartDelay(4)).toBe(300000);
    expect(getRestartDelay(5)).toBe(300000);
    expect(getRestartDelay(10)).toBe(300000);
  });

  test("returns 0 for zero crashes", () => {
    expect(getRestartDelay(0)).toBe(0);
  });
});

// ============================================================================
// Unit Tests: Watchdog Crash Tracker
// ============================================================================
describe("WatchdogCrashTracker", () => {
  const { WatchdogCrashTracker } = require("../src/watchdog");

  test("tracks crashes within time window", () => {
    const tracker = new WatchdogCrashTracker(300000); // 5 min window

    expect(tracker.getCrashCount()).toBe(0);

    tracker.recordCrash("heartbeat_stale", 1234);
    expect(tracker.getCrashCount()).toBe(1);

    tracker.recordCrash("process_dead", 1235);
    expect(tracker.getCrashCount()).toBe(2);
  });

  test("resets crash counter", () => {
    const tracker = new WatchdogCrashTracker(300000);

    tracker.recordCrash("heartbeat_stale", 1234);
    tracker.recordCrash("process_dead", 1235);
    expect(tracker.getCrashCount()).toBe(2);

    tracker.reset();
    expect(tracker.getCrashCount()).toBe(0);
  });

  test("records crash reason and PID", () => {
    const tracker = new WatchdogCrashTracker(300000);

    tracker.recordCrash("heartbeat_stale", 1234);

    const history = tracker.getCrashHistory();
    expect(history.length).toBe(1);
    expect(history[0].reason).toBe("heartbeat_stale");
    expect(history[0].previousPid).toBe(1234);
  });
});

// ============================================================================
// Unit Tests: Watchdog Logger
// ============================================================================
describe("WatchdogLogger", () => {
  const { WatchdogLogger } = require("../src/watchdog");

  test("creates log file if it does not exist", async () => {
    const logger = new WatchdogLogger(TEST_LOG_PATH);

    logger.log("START", "Watchdog started");
    await logger.flush(); // Wait for async write

    expect(existsSync(TEST_LOG_PATH)).toBe(true);
  });

  test("logs with correct timestamp format", async () => {
    const logger = new WatchdogLogger(TEST_LOG_PATH);

    logger.log("CHECK", "Agent healthy");
    await logger.flush(); // Wait for async write

    const content = await Bun.file(TEST_LOG_PATH).text();
    // Should match format: YYYY-MM-DD HH:MM:SS | EVENT | message
    expect(content).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| CHECK \| Agent healthy/);
  });

  test("appends multiple log entries", async () => {
    const logger = new WatchdogLogger(TEST_LOG_PATH);

    logger.log("START", "First entry");
    logger.log("CHECK", "Second entry");
    await logger.flush();

    const content = await Bun.file(TEST_LOG_PATH).text();
    expect(content).toContain("First entry");
    expect(content).toContain("Second entry");
  });
});

// ============================================================================
// Unit Tests: Watchdog State Management
// ============================================================================
describe("WatchdogState", () => {
  const { loadWatchdogState, saveWatchdogState, getDefaultWatchdogState } = require("../src/watchdog");

  test("returns default state when file does not exist", () => {
    const state = loadWatchdogState("/nonexistent/watchdog-state.json");

    expect(state.agentPid).toBeNull();
    expect(state.watchdogStartTime).toBeGreaterThan(0);
    expect(state.crashHistory).toEqual([]);
  });

  test("saves state atomically", () => {
    const state = getDefaultWatchdogState();
    state.agentPid = 12345;

    saveWatchdogState(state, TEST_STATE_PATH);

    expect(existsSync(TEST_STATE_PATH)).toBe(true);

    const loaded = loadWatchdogState(TEST_STATE_PATH);
    expect(loaded.agentPid).toBe(12345);
  });

  test("handles corrupted state file", () => {
    writeFileSync(TEST_STATE_PATH, "not valid json {{{");

    const state = loadWatchdogState(TEST_STATE_PATH);

    // Should return default state
    expect(state.agentPid).toBeNull();
  });
});

// ============================================================================
// Integration Tests: Heartbeat Detection
// ============================================================================
describe("Watchdog Integration: Heartbeat Detection", () => {
  const { checkAgentHealth, WatchdogConfig } = require("../src/watchdog");

  test("detects stale heartbeat", async () => {
    const config: WatchdogConfig = {
      checkIntervalMs: 60000,
      heartbeatStaleMs: 50, // Very short for testing
      heartbeatPath: TEST_HEARTBEAT_PATH,
      logPath: TEST_LOG_PATH,
      statePath: TEST_STATE_PATH
    };

    // Create old heartbeat file
    writeFileSync(TEST_HEARTBEAT_PATH, "ALIVE 1234567890");

    // Wait for it to become stale (3x threshold for reliability on slow CI)
    await Bun.sleep(200);

    const health = checkAgentHealth(config, null);

    expect(health.isHealthy).toBe(false);
    expect(health.reason).toBe("heartbeat_stale");
  });

  test("detects healthy agent with fresh heartbeat", () => {
    const config = {
      checkIntervalMs: 60000,
      heartbeatStaleMs: 600000, // 10 minutes
      heartbeatPath: TEST_HEARTBEAT_PATH,
      logPath: TEST_LOG_PATH,
      statePath: TEST_STATE_PATH
    };

    // Create fresh heartbeat
    writeFileSync(TEST_HEARTBEAT_PATH, `ALIVE ${Math.floor(Date.now() / 1000)}`);

    // Use current process PID as "agent" for testing
    const health = checkAgentHealth(config, process.pid);

    expect(health.isHealthy).toBe(true);
  });

  test("detects crashed agent (process not running)", () => {
    const config = {
      checkIntervalMs: 60000,
      heartbeatStaleMs: 600000,
      heartbeatPath: TEST_HEARTBEAT_PATH,
      logPath: TEST_LOG_PATH,
      statePath: TEST_STATE_PATH
    };

    // Create fresh heartbeat but use non-existent PID
    writeFileSync(TEST_HEARTBEAT_PATH, `ALIVE ${Math.floor(Date.now() / 1000)}`);

    const health = checkAgentHealth(config, 999999999);

    expect(health.isHealthy).toBe(false);
    expect(health.reason).toBe("process_dead");
  });
});

// ============================================================================
// Heartbeat Update Script Tests
// ============================================================================
describe("update-heartbeat.sh script", () => {
  test("script file exists", () => {
    const scriptPath = join(dirname(import.meta.dir), "agent/scripts/update-heartbeat.sh");
    expect(existsSync(scriptPath)).toBe(true);
  });

  test("script updates heartbeat file correctly", async () => {
    const scriptPath = join(dirname(import.meta.dir), "agent/scripts/update-heartbeat.sh");

    const proc = Bun.spawn(["bash", scriptPath, TEST_HEARTBEAT_PATH], {
      cwd: TEST_DIR
    });

    await proc.exited;

    expect(existsSync(TEST_HEARTBEAT_PATH)).toBe(true);

    const content = await Bun.file(TEST_HEARTBEAT_PATH).text();
    expect(content).toMatch(/^ALIVE \d+/);
  });
});

// ============================================================================
// Unit Tests: Input Validation
// ============================================================================
describe("Input Validation", () => {
  const { getRestartDelay } = require("../src/watchdog");

  test("getRestartDelay handles NaN input", () => {
    expect(getRestartDelay(NaN)).toBe(0);
  });

  test("getRestartDelay handles negative input", () => {
    expect(getRestartDelay(-5)).toBe(0);
  });

  test("getRestartDelay handles Infinity", () => {
    expect(getRestartDelay(Infinity)).toBe(0);
  });

  test("getRestartDelay handles floating point (rounds down)", () => {
    expect(getRestartDelay(2.9)).toBe(30000); // Rounds to 2
    expect(getRestartDelay(3.1)).toBe(60000); // Rounds to 3
  });
});

// ============================================================================
// Integration Tests: Full Restart Cycle
// ============================================================================
describe("Watchdog Integration: Full Restart Cycle", () => {
  const {
    checkAgentHealth,
    WatchdogCrashTracker,
    WatchdogLogger,
    loadWatchdogState,
    saveWatchdogState,
    getDefaultWatchdogState,
    killAgent,
    getRestartDelay
  } = require("../src/watchdog");

  test("simulates complete crash detection and restart preparation cycle", async () => {
    // Setup
    const config = {
      checkIntervalMs: 60000,
      heartbeatStaleMs: 50,
      heartbeatPath: TEST_HEARTBEAT_PATH,
      logPath: TEST_LOG_PATH,
      statePath: TEST_STATE_PATH,
      agentDir: TEST_DIR
    };

    const logger = new WatchdogLogger(config.logPath);
    const crashTracker = new WatchdogCrashTracker(300000);
    let state = getDefaultWatchdogState();

    // Simulate agent running with PID (use current process for testing)
    state.agentPid = process.pid;
    saveWatchdogState(state, config.statePath);

    // Create heartbeat that will become stale
    writeFileSync(TEST_HEARTBEAT_PATH, "ALIVE 1234567890");
    await Bun.sleep(100); // Wait for staleness

    // Run health check (mimics main loop iteration)
    const health = checkAgentHealth(config, state.agentPid);

    // Should detect stale heartbeat
    expect(health.isHealthy).toBe(false);
    expect(health.reason).toBe("heartbeat_stale");

    // Log the issue (mimics main loop)
    logger.log("STALE", `Agent heartbeat stale (last: ${Math.floor(health.heartbeatAge / 1000)}s ago), restarting...`);

    // Record crash and get delay
    crashTracker.recordCrash(health.reason, state.agentPid);
    const delay = crashTracker.getRestartDelay();

    // First crash should have no delay (immediate restart)
    expect(delay).toBe(0);
    expect(crashTracker.getCrashCount()).toBe(1);

    // Simulate second crash - delay is based on crashes already recorded
    crashTracker.recordCrash("heartbeat_stale", state.agentPid);
    expect(crashTracker.getCrashCount()).toBe(2);
    expect(crashTracker.getRestartDelay()).toBe(30000); // 2nd crash = 30s delay

    // Verify log file was written
    const logContent = await Bun.file(TEST_LOG_PATH).text();
    expect(logContent).toContain("STALE");
    expect(logContent).toContain("heartbeat stale");
  });

  test("crash tracker correctly handles rapid failure sequence", () => {
    const crashTracker = new WatchdogCrashTracker(300000); // 5 min window

    // Simulate rapid failures - delays are based on crashes already recorded
    crashTracker.recordCrash("heartbeat_stale", 1001);
    expect(crashTracker.shouldAlertOperator()).toBe(false);
    expect(crashTracker.getRestartDelay()).toBe(0); // 1st crash = immediate

    crashTracker.recordCrash("process_dead", 1002);
    expect(crashTracker.shouldAlertOperator()).toBe(false);
    expect(crashTracker.getRestartDelay()).toBe(30000); // 2nd crash = 30s

    crashTracker.recordCrash("heartbeat_stale", 1003);
    expect(crashTracker.shouldAlertOperator()).toBe(false);
    expect(crashTracker.getRestartDelay()).toBe(60000); // 3rd crash = 60s

    crashTracker.recordCrash("process_dead", 1004);
    // 4 crashes = should alert operator
    expect(crashTracker.shouldAlertOperator()).toBe(true);
    expect(crashTracker.getRestartDelay()).toBe(300000); // 4th+ crash = 5 min delay

    // Crash history should be complete
    const history = crashTracker.getCrashHistory();
    expect(history.length).toBe(4);
    expect(history[0].reason).toBe("heartbeat_stale");
    expect(history[3].reason).toBe("process_dead");
  });

  test("state persists across simulated restarts", () => {
    let state = getDefaultWatchdogState();
    state.agentPid = 12345;
    state.crashHistory.push({
      timestamp: new Date().toISOString(),
      reason: "heartbeat_stale",
      previousPid: 12340,
      newPid: 12345
    });

    // Save state
    saveWatchdogState(state, TEST_STATE_PATH);

    // Load state (simulating watchdog restart)
    const loadedState = loadWatchdogState(TEST_STATE_PATH);

    expect(loadedState.agentPid).toBe(12345);
    expect(loadedState.crashHistory.length).toBe(1);
    expect(loadedState.crashHistory[0].reason).toBe("heartbeat_stale");
  });
});
