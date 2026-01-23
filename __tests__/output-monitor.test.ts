/**
 * Tests for Output Monitoring and Stuck Detection
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, readFileSync } from "fs";
import {
  OutputMonitor,
  createOutputRecorder,
  DEFAULT_STALL_THRESHOLD_SEC,
  DEFAULT_LOOP_DETECTION_LINES,
  DEFAULT_LOOP_THRESHOLD,
  type OutputAnalysis
} from "../src/output-monitor";

// ============================================================================
// Test Fixtures
// ============================================================================

const TEST_LOG_PATH = "/tmp/test-output-monitor.log";
const TEST_CLEAR_PATH = "/tmp/test-clear-context";

function cleanupTestFiles(): void {
  for (const path of [TEST_LOG_PATH, TEST_CLEAR_PATH]) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}

function createTestMonitor(config?: {
  stallThresholdSec?: number;
  loopDetectionLines?: number;
  loopThreshold?: number;
}): OutputMonitor {
  return new OutputMonitor({
    stallThresholdSec: config?.stallThresholdSec ?? 1, // 1 second for tests
    loopDetectionLines: config?.loopDetectionLines ?? 10,
    loopThreshold: config?.loopThreshold ?? 5,
    logPath: TEST_LOG_PATH,
    clearContextPath: TEST_CLEAR_PATH
  });
}

// ============================================================================
// OutputMonitor Tests
// ============================================================================

describe("OutputMonitor", () => {
  let monitor: OutputMonitor;

  beforeEach(() => {
    cleanupTestFiles();
    monitor = createTestMonitor();
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  describe("Output Recording", () => {
    test("records output and updates last output time", async () => {
      // Wait a bit so there's measurable time difference
      await new Promise(resolve => setTimeout(resolve, 10));

      const before = monitor.getTimeSinceLastOutput();

      monitor.recordOutput("test output");

      const after = monitor.getTimeSinceLastOutput();
      expect(after).toBeLessThan(before);
    });

    test("ignores empty output", () => {
      const linesBefore = monitor.getRecentLines().length;

      monitor.recordOutput("");
      monitor.recordOutput("   ");
      monitor.recordOutput("\n\n");

      expect(monitor.getRecentLines().length).toBe(linesBefore);
    });

    test("splits multi-line output", () => {
      monitor.recordOutput("line1\nline2\nline3");

      const lines = monitor.getRecentLines();
      expect(lines).toContain("line1");
      expect(lines).toContain("line2");
      expect(lines).toContain("line3");
    });

    test("trims whitespace from lines", () => {
      monitor.recordOutput("  line with spaces  ");

      const lines = monitor.getRecentLines();
      expect(lines).toContain("line with spaces");
    });

    test("maintains rolling buffer of recent lines", () => {
      // Record more lines than the buffer size
      for (let i = 0; i < 25; i++) {
        monitor.recordOutput(`line ${i}`);
      }

      const lines = monitor.getRecentLines();
      expect(lines.length).toBeLessThanOrEqual(20); // 2x loopDetectionLines
    });
  });

  describe("Stall Detection", () => {
    test("isStalled returns false when output is recent", () => {
      monitor.recordOutput("recent output");

      expect(monitor.isStalled()).toBe(false);
    });

    test("isStalled returns true after threshold", async () => {
      // Use a very short threshold for testing
      const shortMonitor = createTestMonitor({ stallThresholdSec: 0.05 });
      shortMonitor.recordOutput("initial");

      // Wait longer than threshold
      await new Promise(resolve => setTimeout(resolve, 60));

      expect(shortMonitor.isStalled()).toBe(true);
    });

    test("getTimeSinceLastOutput returns elapsed time", async () => {
      monitor.recordOutput("test");

      await new Promise(resolve => setTimeout(resolve, 50));

      const elapsed = monitor.getTimeSinceLastOutput();
      expect(elapsed).toBeGreaterThanOrEqual(50);
    });
  });

  describe("Loop Detection - Identical Lines", () => {
    test("detects identical consecutive lines", () => {
      // Record the same line 5 times
      for (let i = 0; i < 5; i++) {
        monitor.recordOutput("same line");
      }

      const pattern = monitor.detectLoopPattern();

      expect(pattern).not.toBeNull();
      expect(pattern).toContain("Identical line repeated");
    });

    test("does not detect when lines are different", () => {
      for (let i = 0; i < 10; i++) {
        monitor.recordOutput(`line ${i}`);
      }

      const pattern = monitor.detectLoopPattern();

      expect(pattern).toBeNull();
    });

    test("respects loop threshold", () => {
      // Record 4 identical lines (below threshold of 5)
      for (let i = 0; i < 4; i++) {
        monitor.recordOutput("same line");
      }

      const pattern = monitor.detectLoopPattern();

      expect(pattern).toBeNull();
    });
  });

  describe("Loop Detection - Repeating Sequences", () => {
    test("detects 2-line repeating pattern", () => {
      // Pattern: A-B-A-B-A-B
      for (let i = 0; i < 3; i++) {
        monitor.recordOutput("line A");
        monitor.recordOutput("line B");
      }

      const pattern = monitor.detectLoopPattern();

      expect(pattern).not.toBeNull();
      expect(pattern).toContain("2-line sequence repeated");
    });

    test("detects 3-line repeating pattern", () => {
      // Pattern: A-B-C-A-B-C
      for (let i = 0; i < 2; i++) {
        monitor.recordOutput("alpha");
        monitor.recordOutput("beta");
        monitor.recordOutput("gamma");
      }

      const pattern = monitor.detectLoopPattern();

      expect(pattern).not.toBeNull();
      expect(pattern).toContain("3-line sequence repeated");
    });

    test("does not detect non-repeating sequence", () => {
      monitor.recordOutput("a");
      monitor.recordOutput("b");
      monitor.recordOutput("c");
      monitor.recordOutput("d");
      monitor.recordOutput("e");

      const pattern = monitor.detectLoopPattern();

      expect(pattern).toBeNull();
    });
  });

  describe("Analysis", () => {
    test("analyze returns complete analysis object", () => {
      monitor.recordOutput("test output");

      const analysis = monitor.analyze();

      expect(analysis).toHaveProperty("isStalled");
      expect(analysis).toHaveProperty("hasLoopPattern");
      expect(analysis).toHaveProperty("secondsSinceOutput");
      expect(analysis).toHaveProperty("identicalLineCount");
    });

    test("analyze detects stall condition", async () => {
      const shortMonitor = createTestMonitor({ stallThresholdSec: 0.05 });
      shortMonitor.recordOutput("initial");

      await new Promise(resolve => setTimeout(resolve, 60));

      const analysis = shortMonitor.analyze();
      expect(analysis.isStalled).toBe(true);
    });

    test("analyze detects loop pattern", () => {
      for (let i = 0; i < 5; i++) {
        monitor.recordOutput("repeating line");
      }

      const analysis = monitor.analyze();

      expect(analysis.hasLoopPattern).toBe(true);
      expect(analysis.loopPattern).toBeDefined();
    });

    test("analyze counts identical consecutive lines", () => {
      monitor.recordOutput("different");
      for (let i = 0; i < 3; i++) {
        monitor.recordOutput("same");
      }

      const analysis = monitor.analyze();

      expect(analysis.identicalLineCount).toBe(3);
    });
  });

  describe("Recovery Actions", () => {
    test("triggerContextClear creates signal file", () => {
      monitor.triggerContextClear("test reason");

      expect(existsSync(TEST_CLEAR_PATH)).toBe(true);

      const content = readFileSync(TEST_CLEAR_PATH, "utf-8");
      expect(content).toContain("test reason");
    });

    test("triggerContextClear logs event", () => {
      monitor.triggerContextClear("loop detected");

      const log = readFileSync(TEST_LOG_PATH, "utf-8");
      expect(log).toContain("CONTEXT_CLEAR triggered");
      expect(log).toContain("loop detected");
    });

    test("checkAndRecover triggers on loop pattern", () => {
      for (let i = 0; i < 5; i++) {
        monitor.recordOutput("infinite loop line");
      }

      const recovered = monitor.checkAndRecover();

      expect(recovered).toBe(true);
      expect(existsSync(TEST_CLEAR_PATH)).toBe(true);
    });

    test("checkAndRecover returns false when healthy", () => {
      monitor.recordOutput("healthy output");

      const recovered = monitor.checkAndRecover();

      expect(recovered).toBe(false);
      expect(existsSync(TEST_CLEAR_PATH)).toBe(false);
    });
  });

  describe("Statistics", () => {
    test("getStats returns monitoring statistics", () => {
      monitor.recordOutput("line1");
      monitor.recordOutput("line2");

      const stats = monitor.getStats();

      expect(stats.totalLinesProcessed).toBe(2);
      expect(stats.recentLineCount).toBe(2);
      expect(typeof stats.secondsSinceLastOutput).toBe("number");
    });

    test("stats track loop detections", () => {
      for (let i = 0; i < 5; i++) {
        monitor.recordOutput("loop");
      }
      monitor.detectLoopPattern();

      const stats = monitor.getStats();
      expect(stats.loopsDetected).toBe(1);
    });

    test("stats track context clears triggered", () => {
      monitor.triggerContextClear("test");
      monitor.triggerContextClear("test2");

      const stats = monitor.getStats();
      expect(stats.contextClearsTriggered).toBe(2);
    });
  });

  describe("Reset", () => {
    test("reset clears recent lines", () => {
      monitor.recordOutput("line1");
      monitor.recordOutput("line2");

      monitor.reset();

      expect(monitor.getRecentLines().length).toBe(0);
    });

    test("reset updates last output time", async () => {
      await new Promise(resolve => setTimeout(resolve, 50));

      const before = monitor.getTimeSinceLastOutput();
      monitor.reset();
      const after = monitor.getTimeSinceLastOutput();

      expect(after).toBeLessThan(before);
    });
  });
});

// ============================================================================
// Utility Function Tests
// ============================================================================

describe("createOutputRecorder", () => {
  beforeEach(() => {
    cleanupTestFiles();
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  test("creates function that records string output", () => {
    const monitor = createTestMonitor();
    const recorder = createOutputRecorder(monitor);

    recorder("test output");

    expect(monitor.getRecentLines()).toContain("test output");
  });

  test("creates function that records Buffer output", () => {
    const monitor = createTestMonitor();
    const recorder = createOutputRecorder(monitor);

    const buffer = Buffer.from("buffer output");
    recorder(buffer);

    expect(monitor.getRecentLines()).toContain("buffer output");
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("Integration", () => {
  beforeEach(() => {
    cleanupTestFiles();
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  test("detects complex loop pattern in simulated agent output", () => {
    const monitor = createTestMonitor({ loopThreshold: 3 });

    // Simulate agent stuck in a tool call loop
    for (let i = 0; i < 3; i++) {
      monitor.recordOutput("[TOOL] Running grep");
      monitor.recordOutput("[RESULT] No matches found");
      monitor.recordOutput("[TOOL] Running grep");
    }

    const analysis = monitor.analyze();

    // Should detect the repeating tool call pattern
    expect(analysis.hasLoopPattern || analysis.identicalLineCount >= 2).toBe(true);
  });

  test("full monitoring workflow", async () => {
    const monitor = createTestMonitor({
      stallThresholdSec: 0.1,
      loopThreshold: 3
    });

    // Normal operation
    monitor.recordOutput("Starting agent");
    monitor.recordOutput("Processing request");

    let analysis = monitor.analyze();
    expect(analysis.isStalled).toBe(false);
    expect(analysis.hasLoopPattern).toBe(false);

    // Enter loop pattern
    for (let i = 0; i < 3; i++) {
      monitor.recordOutput("stuck in loop");
    }

    analysis = monitor.analyze();
    expect(analysis.hasLoopPattern).toBe(true);

    // Trigger recovery
    const recovered = monitor.checkAndRecover();
    expect(recovered).toBe(true);

    // Reset for fresh start
    monitor.reset();

    analysis = monitor.analyze();
    expect(analysis.hasLoopPattern).toBe(false);
  });
});
