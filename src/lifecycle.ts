import { existsSync, readdirSync, rmSync, unlinkSync } from "fs";
import { join } from "path";
import type { HandlerState } from "./types";

/**
 * Configuration for lifecycle tracking
 */
export interface LifecycleConfig {
  maxMessages: number;          // Default: 50
  maxRuntimeHours: number;      // Default: 4
  checkIntervalMs: number;      // Default: 30000 (30 seconds)
  clearCooldownMs: number;      // Default: 60000 (1 minute - prevent rapid clears)
}

/**
 * Lifecycle metrics for tracking agent state
 */
export interface LifecycleMetrics {
  messageCount: number;
  startTime: number;            // Unix timestamp
  lastActivityAt: number;
  betsMatched: number;
  totalPnL: number;
  contextClearCount: number;
}

/**
 * Extended handler state with lifecycle fields
 */
export interface ExtendedHandlerState extends HandlerState {
  messageCount: number;
  lastContextClearAt: string | null;
  contextClearCount: number;
  totalBetsMatched: number;
  totalPnL: string;  // USDC with 6 decimals as string
}

/**
 * Default lifecycle configuration
 */
export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  maxMessages: 50,
  maxRuntimeHours: 4,
  checkIntervalMs: 30000,
  clearCooldownMs: 60000
};

/**
 * Lifecycle tracker class for monitoring agent state and determining
 * when context clearing should occur
 */
export class LifecycleTracker {
  private config: LifecycleConfig;
  private metrics: LifecycleMetrics;
  private lastClearAt: number | null = null;

  constructor(config?: Partial<LifecycleConfig>) {
    this.config = { ...DEFAULT_LIFECYCLE_CONFIG, ...config };
    this.metrics = {
      messageCount: 0,
      startTime: Date.now(),
      lastActivityAt: Date.now(),
      betsMatched: 0,
      totalPnL: 0,
      contextClearCount: 0
    };
  }

  /**
   * Increment the message count (tool calls + responses)
   */
  incrementMessageCount(): void {
    this.metrics.messageCount++;
    this.metrics.lastActivityAt = Date.now();
  }

  /**
   * Record a matched bet with PnL
   */
  recordBetMatched(pnl: number): void {
    this.metrics.betsMatched++;
    this.metrics.totalPnL += pnl;
    this.metrics.lastActivityAt = Date.now();
  }

  /**
   * Get uptime in seconds since tracker creation
   */
  getUptimeSeconds(): number {
    return Math.floor((Date.now() - this.metrics.startTime) / 1000);
  }

  /**
   * Get uptime in hours
   */
  getUptimeHours(): number {
    return (Date.now() - this.metrics.startTime) / (1000 * 60 * 60);
  }

  /**
   * Determine if context should be cleared based on thresholds
   */
  shouldClearContext(): boolean {
    // Never clear during cooldown period
    if (this.lastClearAt && Date.now() - this.lastClearAt < this.config.clearCooldownMs) {
      return false;
    }

    // Check message threshold
    const messageThreshold = this.metrics.messageCount >= this.config.maxMessages;

    // Check runtime threshold
    const runtimeThreshold = this.getUptimeHours() >= this.config.maxRuntimeHours;

    return messageThreshold || runtimeThreshold;
  }

  /**
   * Reset metrics after context clear (preserves cumulative stats)
   */
  reset(): void {
    this.lastClearAt = Date.now();
    this.metrics.messageCount = 0;
    this.metrics.startTime = Date.now();
    this.metrics.lastActivityAt = Date.now();
    this.metrics.contextClearCount++;
    // betsMatched and totalPnL persist across resets (cumulative)
  }

  /**
   * Get current metrics
   */
  getMetrics(): LifecycleMetrics {
    return { ...this.metrics };
  }

  /**
   * Get formatted string for logging
   */
  getFormatted(): string {
    const hours = this.getUptimeHours().toFixed(2);
    return `${this.metrics.messageCount} messages, ${hours} hours runtime`;
  }
}

/**
 * Check if CLEAR_CONTEXT signal file exists
 */
export function checkClearContextFile(path: string): boolean {
  return existsSync(path);
}

/**
 * Matched bet signal file content structure
 */
export interface MatchedBetSignal {
  betId: string;
  pnl: number;
  timestamp: string;
}

/**
 * Check for and read MATCHED_BET signal file
 * Agent writes this file when a bet is matched to signal handler
 * Returns bet info if file exists, null otherwise
 */
export function checkMatchedBetFile(path: string): MatchedBetSignal | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const { readFileSync } = require("fs");
    const content = readFileSync(path, "utf-8");
    const lines = content.trim().split("\n");
    const data: Record<string, string> = {};

    for (const line of lines) {
      const [key, value] = line.split(": ");
      if (key && value) {
        data[key.trim()] = value.trim();
      }
    }

    return {
      betId: data.betId || "unknown",
      pnl: parseFloat(data.pnl || "0"),
      timestamp: data.timestamp || new Date().toISOString()
    };
  } catch {
    return null;
  }
}

/**
 * Remove MATCHED_BET file after processing
 */
export function removeMatchedBetFile(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/**
 * Check if IN_PROGRESS_TX file exists (blocks context clear)
 */
export function checkInProgressTransaction(path: string): boolean {
  return existsSync(path);
}

/**
 * Remove CLEAR_CONTEXT file after processing
 */
export function removeClearContextFile(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/**
 * Clean up research terminal directories
 */
export function cleanResearchTerminalDirectories(researchDir: string): void {
  if (!existsSync(researchDir)) {
    return;
  }

  try {
    const entries = readdirSync(researchDir);
    for (const entry of entries) {
      if (entry.startsWith("terminal-")) {
        const terminalPath = join(researchDir, entry);
        rmSync(terminalPath, { recursive: true, force: true });
      }
    }
  } catch {
    // Silently handle errors - directories may already be gone
  }
}

/**
 * Kill research terminal processes via pkill
 */
export function killResearchTerminalProcesses(): boolean {
  try {
    const result = Bun.spawnSync(["pkill", "-f", "research/terminal-"], {
      stderr: "pipe"
    });
    // pkill returns 1 if no process found, which is OK
    return true;
  } catch {
    return false;
  }
}

/**
 * Create extended state from base handler state
 */
export function createExtendedState(baseState: HandlerState): ExtendedHandlerState {
  return {
    ...baseState,
    messageCount: 0,
    lastContextClearAt: null,
    contextClearCount: 0,
    totalBetsMatched: 0,
    totalPnL: "0"
  };
}

/**
 * Type guard to check if state is extended
 */
export function isExtendedState(state: HandlerState): state is ExtendedHandlerState {
  return (
    "messageCount" in state &&
    "lastContextClearAt" in state &&
    "contextClearCount" in state &&
    "totalBetsMatched" in state &&
    "totalPnL" in state
  );
}
