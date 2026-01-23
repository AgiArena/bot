import { existsSync, appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { CrashLogEntry } from "./types";

/**
 * Log a crash event to the crashes.log file
 */
export function logCrash(entry: CrashLogEntry, crashLogPath: string): void {
  const dir = dirname(crashLogPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const logLine = `[${entry.timestamp}] Exit Code: ${entry.exitCode ?? "N/A"}, Signal: ${entry.signal ?? "N/A"}, Error: ${entry.error ?? "N/A"}\n`;

  appendFileSync(crashLogPath, logLine);
}

/**
 * Tracks crash events in a rolling time window
 * Used to implement "pause after N crashes in M seconds" behavior
 */
export class CrashTracker {
  private crashes: number[] = [];
  private readonly maxCrashes: number;
  private readonly windowMs: number;

  /**
   * @param maxCrashes Maximum number of crashes allowed in the window
   * @param windowMs Time window in milliseconds
   */
  constructor(maxCrashes: number = 5, windowMs: number = 300000) {
    this.maxCrashes = maxCrashes;
    this.windowMs = windowMs;
  }

  /**
   * Record a crash event
   */
  recordCrash(): void {
    const now = Date.now();
    this.crashes.push(now);
    this.pruneOldCrashes();
  }

  /**
   * Check if we should pause due to too many crashes
   */
  shouldPause(): boolean {
    this.pruneOldCrashes();
    return this.crashes.length >= this.maxCrashes;
  }

  /**
   * Get current crash count in the window
   */
  getCrashCount(): number {
    this.pruneOldCrashes();
    return this.crashes.length;
  }

  /**
   * Reset the crash tracker (e.g., after a successful long run)
   */
  reset(): void {
    this.crashes = [];
  }

  /**
   * Remove crashes that are outside the time window
   */
  private pruneOldCrashes(): void {
    const cutoff = Date.now() - this.windowMs;
    this.crashes = this.crashes.filter((timestamp) => timestamp > cutoff);
  }
}

/**
 * Calculate delay before next restart
 * Implements exponential backoff capped at 30 seconds to meet NFR19
 * (Agent must restart within 30 seconds)
 */
export function calculateRestartDelay(restartCount: number): number {
  const baseDelay = 2000; // 2 seconds base delay (faster initial restart)
  const maxDelay = 30000; // 30 seconds max delay (NFR19 requirement)

  // Exponential backoff: 2s, 4s, 8s, 16s, 30s (capped at 30s for NFR19)
  const delay = Math.min(baseDelay * Math.pow(2, restartCount - 1), maxDelay);
  return delay;
}
