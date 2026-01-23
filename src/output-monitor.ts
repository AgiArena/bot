/**
 * Output Monitoring and Stuck Detection
 *
 * Monitors agent stdout/stderr for output and detects subtle agent issues:
 * - No output for >5 minutes (stalled)
 * - Infinite loop patterns (last 10 lines identical)
 * - Tool use patterns that indicate problems
 *
 * Triggers context clear on loop detection to recover the agent.
 */

import { existsSync, appendFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Output monitoring configuration
 */
export interface OutputMonitorConfig {
  /** Seconds without output before considering stalled */
  stallThresholdSec: number;
  /** Number of recent lines to check for loop patterns */
  loopDetectionLines: number;
  /** Minimum identical lines to trigger loop detection */
  loopThreshold: number;
  /** Path to resilience log */
  logPath: string;
  /** Path to write clear context signal */
  clearContextPath: string;
}

/**
 * Output analysis result
 */
export interface OutputAnalysis {
  /** True if output has stalled */
  isStalled: boolean;
  /** True if loop pattern detected */
  hasLoopPattern: boolean;
  /** Seconds since last output */
  secondsSinceOutput: number;
  /** Number of identical consecutive lines detected */
  identicalLineCount: number;
  /** Detected loop pattern (if any) */
  loopPattern?: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

/** Default stall threshold (5 minutes) */
export const DEFAULT_STALL_THRESHOLD_SEC = 300;

/** Default number of lines to check for loops */
export const DEFAULT_LOOP_DETECTION_LINES = 10;

/** Default identical line threshold for loop detection */
export const DEFAULT_LOOP_THRESHOLD = 5;

/** Default log path */
export const DEFAULT_OUTPUT_LOG_PATH = "bot/agent/resilience.log";

/** Default clear context signal path */
export const DEFAULT_CLEAR_CONTEXT_PATH = "bot/agent/CLEAR_CONTEXT";

// ============================================================================
// Output Monitor Class
// ============================================================================

/**
 * Monitors agent output for stall and loop detection
 */
export class OutputMonitor {
  private lastOutputTime: number = Date.now();
  private recentLines: string[] = [];
  private readonly stallThresholdMs: number;
  private readonly loopDetectionLines: number;
  private readonly loopThreshold: number;
  private readonly logPath: string;
  private readonly clearContextPath: string;

  // Statistics
  private totalLinesProcessed = 0;
  private stallsDetected = 0;
  private loopsDetected = 0;
  private contextClearsTriggered = 0;

  constructor(config?: Partial<OutputMonitorConfig>) {
    this.stallThresholdMs = (config?.stallThresholdSec ?? DEFAULT_STALL_THRESHOLD_SEC) * 1000;
    this.loopDetectionLines = config?.loopDetectionLines ?? DEFAULT_LOOP_DETECTION_LINES;
    this.loopThreshold = config?.loopThreshold ?? DEFAULT_LOOP_THRESHOLD;
    this.logPath = config?.logPath ?? DEFAULT_OUTPUT_LOG_PATH;
    this.clearContextPath = config?.clearContextPath ?? DEFAULT_CLEAR_CONTEXT_PATH;

    // Ensure directories exist
    this.ensureDirectory(this.logPath);
    this.ensureDirectory(this.clearContextPath);
  }

  private ensureDirectory(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // --------------------------------------------------------------------------
  // Output Recording
  // --------------------------------------------------------------------------

  /**
   * Record output from the agent
   * @param output Raw output string from stdout/stderr
   */
  recordOutput(output: string): void {
    if (!output || output.trim().length === 0) {
      return;
    }

    this.lastOutputTime = Date.now();

    // Split into lines and add to recent buffer
    const lines = output.split("\n").filter(line => line.trim().length > 0);

    for (const line of lines) {
      this.recentLines.push(line.trim());
      this.totalLinesProcessed++;

      // Keep only the last N lines
      if (this.recentLines.length > this.loopDetectionLines * 2) {
        this.recentLines = this.recentLines.slice(-this.loopDetectionLines);
      }
    }
  }

  /**
   * Get time since last output in milliseconds
   */
  getTimeSinceLastOutput(): number {
    return Date.now() - this.lastOutputTime;
  }

  // --------------------------------------------------------------------------
  // Stall Detection
  // --------------------------------------------------------------------------

  /**
   * Check if output has stalled (no output for threshold period)
   */
  isStalled(): boolean {
    const stalled = this.getTimeSinceLastOutput() > this.stallThresholdMs;

    if (stalled) {
      this.stallsDetected++;
    }

    return stalled;
  }

  // --------------------------------------------------------------------------
  // Loop Detection
  // --------------------------------------------------------------------------

  /**
   * Detect infinite loop pattern in recent output
   * Returns the detected pattern or null if no loop found
   */
  detectLoopPattern(): string | null {
    if (this.recentLines.length < this.loopThreshold) {
      return null;
    }

    // Get last N lines for analysis
    const linesToCheck = this.recentLines.slice(-this.loopDetectionLines);

    // Check for identical consecutive lines
    const identicalPattern = this.findIdenticalLines(linesToCheck);
    if (identicalPattern) {
      this.loopsDetected++;
      return identicalPattern;
    }

    // Check for repeating sequence patterns
    const sequencePattern = this.findRepeatingSequence(linesToCheck);
    if (sequencePattern) {
      this.loopsDetected++;
      return sequencePattern;
    }

    return null;
  }

  /**
   * Find identical consecutive lines
   */
  private findIdenticalLines(lines: string[]): string | null {
    if (lines.length < this.loopThreshold) {
      return null;
    }

    let currentLine = lines[lines.length - 1];
    let count = 1;

    // Count backwards from the end
    for (let i = lines.length - 2; i >= 0; i--) {
      if (lines[i] === currentLine) {
        count++;
      } else {
        break;
      }
    }

    if (count >= this.loopThreshold) {
      return `Identical line repeated ${count}x: "${currentLine.slice(0, 50)}..."`;
    }

    return null;
  }

  /**
   * Find repeating sequence patterns (e.g., A-B-A-B-A-B)
   */
  private findRepeatingSequence(lines: string[]): string | null {
    if (lines.length < 4) {
      return null;
    }

    // Check for 2-line, 3-line, and 4-line repeating patterns
    for (const patternLen of [2, 3, 4]) {
      if (lines.length < patternLen * 2) {
        continue;
      }

      const pattern = lines.slice(-patternLen);
      const previousPattern = lines.slice(-patternLen * 2, -patternLen);

      const patternMatch = pattern.every((line, i) => line === previousPattern[i]);

      if (patternMatch) {
        // Check if this pattern repeats more times
        let repeatCount = 2;
        for (let offset = patternLen * 2; offset + patternLen <= lines.length; offset += patternLen) {
          const checkPattern = lines.slice(-(offset + patternLen), -offset);
          const matches = pattern.every((line, i) => line === checkPattern[i]);
          if (matches) {
            repeatCount++;
          } else {
            break;
          }
        }

        if (repeatCount >= 2) {
          return `${patternLen}-line sequence repeated ${repeatCount}x`;
        }
      }
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // Analysis
  // --------------------------------------------------------------------------

  /**
   * Analyze current output state
   */
  analyze(): OutputAnalysis {
    const timeSinceOutput = this.getTimeSinceLastOutput();
    const loopPattern = this.detectLoopPattern();

    // Count identical consecutive lines at end
    let identicalCount = 1;
    if (this.recentLines.length >= 2) {
      const lastLine = this.recentLines[this.recentLines.length - 1];
      for (let i = this.recentLines.length - 2; i >= 0; i--) {
        if (this.recentLines[i] === lastLine) {
          identicalCount++;
        } else {
          break;
        }
      }
    }

    return {
      isStalled: timeSinceOutput > this.stallThresholdMs,
      hasLoopPattern: loopPattern !== null,
      secondsSinceOutput: Math.floor(timeSinceOutput / 1000),
      identicalLineCount: identicalCount,
      loopPattern: loopPattern ?? undefined
    };
  }

  // --------------------------------------------------------------------------
  // Recovery Actions
  // --------------------------------------------------------------------------

  /**
   * Trigger context clear by creating signal file
   * @param reason Reason for triggering clear
   */
  triggerContextClear(reason: string): void {
    this.contextClearsTriggered++;

    // Log the trigger
    this.log(`CONTEXT_CLEAR triggered: ${reason}`);

    // Create the signal file
    try {
      writeFileSync(this.clearContextPath, `${new Date().toISOString()}\n${reason}\n`);
    } catch (error) {
      console.error(`[OutputMonitor] Failed to create clear context file: ${error}`);
    }
  }

  /**
   * Check and trigger recovery if needed
   * @returns True if recovery was triggered
   */
  checkAndRecover(): boolean {
    const analysis = this.analyze();

    // Check for loop pattern first (more specific issue)
    if (analysis.hasLoopPattern) {
      this.triggerContextClear(`Loop pattern detected: ${analysis.loopPattern}`);
      return true;
    }

    // Note: Stall detection is handled by the main watchdog
    // This monitor just provides the data

    return false;
  }

  // --------------------------------------------------------------------------
  // Statistics and Management
  // --------------------------------------------------------------------------

  /**
   * Get monitoring statistics
   */
  getStats(): {
    totalLinesProcessed: number;
    stallsDetected: number;
    loopsDetected: number;
    contextClearsTriggered: number;
    recentLineCount: number;
    secondsSinceLastOutput: number;
  } {
    return {
      totalLinesProcessed: this.totalLinesProcessed,
      stallsDetected: this.stallsDetected,
      loopsDetected: this.loopsDetected,
      contextClearsTriggered: this.contextClearsTriggered,
      recentLineCount: this.recentLines.length,
      secondsSinceLastOutput: Math.floor(this.getTimeSinceLastOutput() / 1000)
    };
  }

  /**
   * Reset the monitor state
   */
  reset(): void {
    this.lastOutputTime = Date.now();
    this.recentLines = [];
  }

  /**
   * Get recent lines for debugging
   */
  getRecentLines(): string[] {
    return [...this.recentLines];
  }

  // --------------------------------------------------------------------------
  // Logging
  // --------------------------------------------------------------------------

  /**
   * Log an output monitoring event
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const entry = `${timestamp} | OUTPUT_MONITOR | ${message}\n`;

    try {
      appendFileSync(this.logPath, entry);
    } catch (error) {
      console.error(`[OutputMonitor] ${message}`);
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let outputMonitorInstance: OutputMonitor | null = null;

/**
 * Get or create the global output monitor instance
 */
export function getOutputMonitor(config?: Partial<OutputMonitorConfig>): OutputMonitor {
  if (!outputMonitorInstance) {
    outputMonitorInstance = new OutputMonitor(config);
  }
  return outputMonitorInstance;
}

/**
 * Initialize the output monitor with specific configuration
 */
export function initOutputMonitor(config: Partial<OutputMonitorConfig>): OutputMonitor {
  outputMonitorInstance = new OutputMonitor(config);
  return outputMonitorInstance;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create output recording function for use with process streams
 * @param monitor Output monitor instance
 * @returns Function that can be used as stream data handler
 */
export function createOutputRecorder(
  monitor: OutputMonitor
): (chunk: Buffer | string) => void {
  return (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    monitor.recordOutput(text);
  };
}
