import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";

// Test directory for isolated testing
const TEST_DIR = join(import.meta.dir, "..", "test-tmp-lifecycle");
const TEST_AGENT_DIR = join(TEST_DIR, "agent");

describe("LifecycleTracker", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_AGENT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("should initialize with default config", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");
    const tracker = new LifecycleTracker();

    const metrics = tracker.getMetrics();
    expect(metrics.messageCount).toBe(0);
    expect(metrics.betsMatched).toBe(0);
    expect(metrics.totalPnL).toBe(0);
    expect(metrics.contextClearCount).toBe(0);
  });

  it("should track message count", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");
    const tracker = new LifecycleTracker();

    tracker.incrementMessageCount();
    tracker.incrementMessageCount();

    expect(tracker.getMetrics().messageCount).toBe(2);
  });

  it("should track bet matched with PnL", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");
    const tracker = new LifecycleTracker();

    tracker.recordBetMatched(100);
    tracker.recordBetMatched(-50);

    const metrics = tracker.getMetrics();
    expect(metrics.betsMatched).toBe(2);
    expect(metrics.totalPnL).toBe(50);
  });

  it("should calculate uptime in seconds", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");
    const tracker = new LifecycleTracker();

    // Wait a bit to ensure some uptime
    await Bun.sleep(100);

    const uptime = tracker.getUptimeSeconds();
    expect(uptime).toBeGreaterThanOrEqual(0);
    expect(uptime).toBeLessThan(5); // Should be less than 5 seconds
  });

  it("should calculate uptime in hours", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");
    const tracker = new LifecycleTracker();

    const hours = tracker.getUptimeHours();
    expect(hours).toBeGreaterThanOrEqual(0);
    expect(hours).toBeLessThan(1);
  });

  it("should return false for shouldClearContext when below thresholds", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");
    const tracker = new LifecycleTracker({ maxMessages: 50, maxRuntimeHours: 4 });

    // Only a few messages, fresh start
    tracker.incrementMessageCount();
    tracker.incrementMessageCount();

    expect(tracker.shouldClearContext()).toBe(false);
  });

  it("should return true for shouldClearContext at message threshold", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");
    const tracker = new LifecycleTracker({ maxMessages: 5 }); // Low threshold for testing

    for (let i = 0; i < 5; i++) {
      tracker.incrementMessageCount();
    }

    expect(tracker.shouldClearContext()).toBe(true);
  });

  it("should respect cooldown period after reset", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");
    const tracker = new LifecycleTracker({
      maxMessages: 5,
      clearCooldownMs: 60000 // 1 minute cooldown
    });

    // Trigger threshold
    for (let i = 0; i < 10; i++) {
      tracker.incrementMessageCount();
    }
    expect(tracker.shouldClearContext()).toBe(true);

    // Reset simulates context clear
    tracker.reset();

    // Even if we exceed threshold again, cooldown should prevent clear
    for (let i = 0; i < 10; i++) {
      tracker.incrementMessageCount();
    }
    expect(tracker.shouldClearContext()).toBe(false);
  });

  it("should format metrics as human-readable string", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");
    const tracker = new LifecycleTracker();

    tracker.incrementMessageCount();
    tracker.incrementMessageCount();

    const formatted = tracker.getFormatted();
    expect(formatted).toContain("2 messages");
    expect(formatted).toContain("hours");
  });

  it("should reset all metrics on reset()", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");
    const tracker = new LifecycleTracker();

    tracker.incrementMessageCount();
    tracker.incrementMessageCount();
    tracker.recordBetMatched(100);

    tracker.reset();

    const metrics = tracker.getMetrics();
    expect(metrics.messageCount).toBe(0);
    // betsMatched and totalPnL persist across resets (cumulative)
    expect(metrics.contextClearCount).toBe(1);
  });

  it("should increment context clear count on reset", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");
    const tracker = new LifecycleTracker();

    expect(tracker.getMetrics().contextClearCount).toBe(0);

    tracker.reset();
    expect(tracker.getMetrics().contextClearCount).toBe(1);

    tracker.reset();
    expect(tracker.getMetrics().contextClearCount).toBe(2);
  });

  it("should accept custom config values", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");
    const tracker = new LifecycleTracker({
      maxMessages: 100,
      maxRuntimeHours: 8,
      checkIntervalMs: 60000,
      clearCooldownMs: 120000
    });

    // With maxMessages=100, 50 messages should not trigger
    for (let i = 0; i < 50; i++) {
      tracker.incrementMessageCount();
    }
    expect(tracker.shouldClearContext()).toBe(false);

    // But 100 should
    for (let i = 0; i < 50; i++) {
      tracker.incrementMessageCount();
    }
    expect(tracker.shouldClearContext()).toBe(true);
  });
});

describe("LifecycleConfig defaults", () => {
  it("should have sensible defaults", async () => {
    const { DEFAULT_LIFECYCLE_CONFIG } = await import("../src/lifecycle");

    expect(DEFAULT_LIFECYCLE_CONFIG.maxMessages).toBe(50);
    expect(DEFAULT_LIFECYCLE_CONFIG.maxRuntimeHours).toBe(4);
    expect(DEFAULT_LIFECYCLE_CONFIG.checkIntervalMs).toBe(30000);
    expect(DEFAULT_LIFECYCLE_CONFIG.clearCooldownMs).toBe(60000);
  });
});

describe("Context Clear File Watcher", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_AGENT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("should detect CLEAR_CONTEXT file exists", async () => {
    const { checkClearContextFile } = await import("../src/lifecycle");

    const clearContextPath = join(TEST_AGENT_DIR, "CLEAR_CONTEXT");

    // Should return false when file doesn't exist
    expect(checkClearContextFile(clearContextPath)).toBe(false);

    // Create the file
    writeFileSync(clearContextPath, "reason: test\ntimestamp: 2026-01-23T12:00:00Z");

    // Should return true when file exists
    expect(checkClearContextFile(clearContextPath)).toBe(true);
  });

  it("should detect IN_PROGRESS_TX file exists", async () => {
    const { checkInProgressTransaction } = await import("../src/lifecycle");

    const inProgressPath = join(TEST_AGENT_DIR, "IN_PROGRESS_TX");

    // Should return false when file doesn't exist
    expect(checkInProgressTransaction(inProgressPath)).toBe(false);

    // Create the file
    writeFileSync(inProgressPath, "betId: 123\ntxHash: 0xabc");

    // Should return true when file exists
    expect(checkInProgressTransaction(inProgressPath)).toBe(true);
  });

  it("should remove CLEAR_CONTEXT file after processing", async () => {
    const { removeClearContextFile } = await import("../src/lifecycle");

    const clearContextPath = join(TEST_AGENT_DIR, "CLEAR_CONTEXT");
    writeFileSync(clearContextPath, "reason: test");

    expect(existsSync(clearContextPath)).toBe(true);

    removeClearContextFile(clearContextPath);

    expect(existsSync(clearContextPath)).toBe(false);
  });
});

describe("Research Terminal Cleanup", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_AGENT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("should clean up research terminal directories", async () => {
    const { cleanResearchTerminalDirectories } = await import("../src/lifecycle");

    // Create mock research directories
    const researchDir = join(TEST_AGENT_DIR, "research");
    mkdirSync(researchDir, { recursive: true });
    mkdirSync(join(researchDir, "terminal-1"), { recursive: true });
    mkdirSync(join(researchDir, "terminal-2"), { recursive: true });
    mkdirSync(join(researchDir, "terminal-3"), { recursive: true });
    writeFileSync(join(researchDir, "terminal-1", "output.txt"), "test");
    writeFileSync(join(researchDir, "terminal-2", "output.txt"), "test");

    // Verify directories exist
    expect(existsSync(join(researchDir, "terminal-1"))).toBe(true);
    expect(existsSync(join(researchDir, "terminal-2"))).toBe(true);

    // Clean up
    cleanResearchTerminalDirectories(researchDir);

    // Verify directories are removed
    expect(existsSync(join(researchDir, "terminal-1"))).toBe(false);
    expect(existsSync(join(researchDir, "terminal-2"))).toBe(false);
    expect(existsSync(join(researchDir, "terminal-3"))).toBe(false);
  });

  it("should handle non-existent research directory gracefully", async () => {
    const { cleanResearchTerminalDirectories } = await import("../src/lifecycle");

    const nonExistentDir = join(TEST_AGENT_DIR, "nonexistent", "research");

    // Should not throw
    expect(() => cleanResearchTerminalDirectories(nonExistentDir)).not.toThrow();
  });
});

describe("Extended HandlerState for Lifecycle", () => {
  it("should have lifecycle fields in ExtendedHandlerState type", async () => {
    const { createExtendedState, isExtendedState } = await import("../src/lifecycle");

    const baseState = {
      agentPid: 12345,
      startTime: Date.now(),
      restartCount: 0,
      lastRestartAt: null
    };

    const extendedState = createExtendedState(baseState);

    expect(extendedState.messageCount).toBe(0);
    expect(extendedState.lastContextClearAt).toBeNull();
    expect(extendedState.contextClearCount).toBe(0);
    expect(extendedState.totalBetsMatched).toBe(0);
    expect(extendedState.totalPnL).toBe("0");

    expect(isExtendedState(extendedState)).toBe(true);
    expect(isExtendedState(baseState)).toBe(false);
  });
});

describe("Integration Tests - Context Clear Scenarios", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_AGENT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("should trigger context clear at message threshold", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");

    const tracker = new LifecycleTracker({ maxMessages: 50 });

    // Simulate 49 messages - should not trigger
    for (let i = 0; i < 49; i++) {
      tracker.incrementMessageCount();
    }
    expect(tracker.shouldClearContext()).toBe(false);

    // 50th message - should trigger
    tracker.incrementMessageCount();
    expect(tracker.shouldClearContext()).toBe(true);
  });

  it("should trigger context clear at runtime threshold", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");

    // Create tracker with very short runtime threshold for testing
    const tracker = new LifecycleTracker({
      maxMessages: 1000, // High so it won't trigger
      maxRuntimeHours: 0.0001 // ~0.36 seconds
    });

    // Initially below threshold
    expect(tracker.shouldClearContext()).toBe(false);

    // Wait past threshold
    await Bun.sleep(500);

    expect(tracker.shouldClearContext()).toBe(true);
  });

  it("should CLEAR_CONTEXT file trigger context clear check", async () => {
    const { checkClearContextFile, removeClearContextFile } = await import("../src/lifecycle");

    const clearContextPath = join(TEST_AGENT_DIR, "CLEAR_CONTEXT");

    // No file - should not trigger
    expect(checkClearContextFile(clearContextPath)).toBe(false);

    // Create file - should trigger
    writeFileSync(clearContextPath, "reason: approaching_token_limit\ntimestamp: 2026-01-23T12:00:00Z");
    expect(checkClearContextFile(clearContextPath)).toBe(true);

    // Remove file after processing
    removeClearContextFile(clearContextPath);
    expect(existsSync(clearContextPath)).toBe(false);
  });

  it("should IN_PROGRESS_TX block context clear", async () => {
    const { LifecycleTracker, checkInProgressTransaction } = await import("../src/lifecycle");

    const tracker = new LifecycleTracker({ maxMessages: 5 });
    const inProgressPath = join(TEST_AGENT_DIR, "IN_PROGRESS_TX");

    // Trigger threshold
    for (let i = 0; i < 10; i++) {
      tracker.incrementMessageCount();
    }

    // No IN_PROGRESS_TX - context clear allowed
    expect(tracker.shouldClearContext()).toBe(true);
    expect(checkInProgressTransaction(inProgressPath)).toBe(false);

    // Create IN_PROGRESS_TX - context clear should be blocked
    writeFileSync(inProgressPath, "betId: 123\ntxHash: 0xabc\nstartedAt: 2026-01-23T12:00:00Z");
    expect(checkInProgressTransaction(inProgressPath)).toBe(true);

    // Cleanup
    unlinkSync(inProgressPath);
  });

  it("should clean research terminals correctly", async () => {
    const { cleanResearchTerminalDirectories } = await import("../src/lifecycle");

    // Create mock research structure
    const researchDir = join(TEST_AGENT_DIR, "research");
    mkdirSync(researchDir, { recursive: true });

    // Create terminal directories with files
    for (let i = 1; i <= 5; i++) {
      const termDir = join(researchDir, `terminal-${i}`);
      mkdirSync(termDir, { recursive: true });
      writeFileSync(join(termDir, "prompt.md"), `Research prompt ${i}`);
      writeFileSync(join(termDir, "scores.jsonl"), '{"market":"test","score":50}');
      writeFileSync(join(termDir, "status.txt"), "COMPLETE");
    }

    // Also create a non-terminal file that should NOT be deleted
    writeFileSync(join(researchDir, "config.json"), "{}");

    // Verify all created
    expect(existsSync(join(researchDir, "terminal-1"))).toBe(true);
    expect(existsSync(join(researchDir, "terminal-5"))).toBe(true);

    // Clean up terminals
    cleanResearchTerminalDirectories(researchDir);

    // Terminals should be gone
    expect(existsSync(join(researchDir, "terminal-1"))).toBe(false);
    expect(existsSync(join(researchDir, "terminal-5"))).toBe(false);

    // Non-terminal file should remain
    expect(existsSync(join(researchDir, "config.json"))).toBe(true);
  });

  it("should preserve state across context clear", async () => {
    const { LifecycleTracker } = await import("../src/lifecycle");

    const tracker = new LifecycleTracker({ maxMessages: 50 });

    // Simulate activity
    for (let i = 0; i < 30; i++) {
      tracker.incrementMessageCount();
    }
    tracker.recordBetMatched(100);
    tracker.recordBetMatched(-25);

    const beforeReset = tracker.getMetrics();
    expect(beforeReset.messageCount).toBe(30);
    expect(beforeReset.betsMatched).toBe(2);
    expect(beforeReset.totalPnL).toBe(75);
    expect(beforeReset.contextClearCount).toBe(0);

    // Reset (simulates context clear)
    tracker.reset();

    const afterReset = tracker.getMetrics();
    // Session metrics reset
    expect(afterReset.messageCount).toBe(0);
    // Cumulative stats preserved (bets matched and PnL persist)
    expect(afterReset.betsMatched).toBe(2);
    expect(afterReset.totalPnL).toBe(75);
    // Context clear count incremented
    expect(afterReset.contextClearCount).toBe(1);
  });
});

describe("Matched Bet Signal File", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_AGENT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("should return null when MATCHED_BET file does not exist", async () => {
    const { checkMatchedBetFile } = await import("../src/lifecycle");
    const matchedBetPath = join(TEST_AGENT_DIR, "MATCHED_BET");

    expect(checkMatchedBetFile(matchedBetPath)).toBeNull();
  });

  it("should parse MATCHED_BET file correctly", async () => {
    const { checkMatchedBetFile } = await import("../src/lifecycle");
    const matchedBetPath = join(TEST_AGENT_DIR, "MATCHED_BET");

    // Create a signal file
    writeFileSync(matchedBetPath, "betId: bet-123\npnl: 50.5\ntimestamp: 2026-01-23T12:00:00Z");

    const result = checkMatchedBetFile(matchedBetPath);
    expect(result).not.toBeNull();
    expect(result!.betId).toBe("bet-123");
    expect(result!.pnl).toBe(50.5);
    expect(result!.timestamp).toBe("2026-01-23T12:00:00Z");
  });

  it("should remove MATCHED_BET file after processing", async () => {
    const { removeMatchedBetFile } = await import("../src/lifecycle");
    const matchedBetPath = join(TEST_AGENT_DIR, "MATCHED_BET");

    writeFileSync(matchedBetPath, "betId: bet-456\npnl: -25\n");
    expect(existsSync(matchedBetPath)).toBe(true);

    removeMatchedBetFile(matchedBetPath);
    expect(existsSync(matchedBetPath)).toBe(false);
  });

  it("should handle malformed MATCHED_BET file gracefully", async () => {
    const { checkMatchedBetFile } = await import("../src/lifecycle");
    const matchedBetPath = join(TEST_AGENT_DIR, "MATCHED_BET");

    // Create a malformed signal file
    writeFileSync(matchedBetPath, "invalid content");

    const result = checkMatchedBetFile(matchedBetPath);
    expect(result).not.toBeNull();
    expect(result!.betId).toBe("unknown");
    expect(result!.pnl).toBe(0);
  });
});

describe("Crash Recovery Delay - NFR19 Compliance", () => {
  it("should cap restart delay at 30 seconds for NFR19", async () => {
    const { calculateRestartDelay } = await import("../src/crash-recovery");

    // First restart: 2s
    expect(calculateRestartDelay(1)).toBe(2000);

    // Second restart: 4s
    expect(calculateRestartDelay(2)).toBe(4000);

    // Third restart: 8s
    expect(calculateRestartDelay(3)).toBe(8000);

    // Fourth restart: 16s
    expect(calculateRestartDelay(4)).toBe(16000);

    // Fifth restart: capped at 30s (not 32s)
    expect(calculateRestartDelay(5)).toBe(30000);

    // Sixth+ restarts: still capped at 30s
    expect(calculateRestartDelay(6)).toBe(30000);
    expect(calculateRestartDelay(10)).toBe(30000);
  });
});
