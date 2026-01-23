/**
 * Failure Learning System
 *
 * Tracks failure history and detects recurring patterns:
 * - API timeouts during peak hours → Adjust schedule
 * - Terminal crashes on large segments → Increase terminal count
 *
 * AC: #5
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";

// ============================================================================
// Types
// ============================================================================

export interface FailureRecord {
  timestamp: number;
  phase: string;
  errorType: string;
  errorMessage: string;
  context: Record<string, unknown>;
  resolution: string;
}

export type PatternType =
  | "API_TIMEOUT_PEAK_HOURS"
  | "TERMINAL_OVERLOAD"
  | "REPEATED_AUTH_FAILURES"
  | "RPC_CONGESTION"
  | "UNKNOWN";

export interface FailurePattern {
  type: PatternType;
  description: string;
  occurrences: number;
  recommendation: string;
  metadata?: Record<string, unknown>;
}

export type BehaviorAdaptation =
  | "AVOID_PEAK_HOURS"
  | "INCREASE_TERMINAL_COUNT"
  | "REDUCE_SEGMENT_SIZE"
  | "SWITCH_RPC"
  | "NONE";

export interface FailureHistory {
  records: FailureRecord[];
  lastAnalysis: number;
  detectedPatterns: FailurePattern[];
  adaptationsApplied: string[];
}

// ============================================================================
// Constants
// ============================================================================

const MAX_HISTORY_SIZE = 1000;
const PATTERN_DETECTION_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
const PEAK_HOUR_THRESHOLD = 5; // 5+ timeouts in same hour = peak
const TERMINAL_OVERLOAD_THRESHOLD = 3; // 3+ crashes with large segments

// ============================================================================
// History Persistence
// ============================================================================

/**
 * Get default failure history
 */
export function getDefaultFailureHistory(): FailureHistory {
  return {
    records: [],
    lastAnalysis: 0,
    detectedPatterns: [],
    adaptationsApplied: []
  };
}

/**
 * Load failure history from disk
 */
export function loadFailureHistory(historyPath: string): FailureHistory {
  if (!existsSync(historyPath)) {
    return getDefaultFailureHistory();
  }

  try {
    const content = readFileSync(historyPath, "utf-8");
    const parsed = JSON.parse(content) as FailureHistory;

    // Validate and apply defaults
    return {
      records: Array.isArray(parsed.records) ? parsed.records : [],
      lastAnalysis: parsed.lastAnalysis ?? 0,
      detectedPatterns: Array.isArray(parsed.detectedPatterns) ? parsed.detectedPatterns : [],
      adaptationsApplied: Array.isArray(parsed.adaptationsApplied) ? parsed.adaptationsApplied : []
    };
  } catch {
    return getDefaultFailureHistory();
  }
}

/**
 * Save failure history atomically
 */
export function saveFailureHistory(history: FailureHistory, historyPath: string): void {
  const dir = dirname(historyPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${historyPath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(history, null, 2));
  renameSync(tempPath, historyPath);
}

// ============================================================================
// Pattern Detection
// ============================================================================

/**
 * Group failures by hour of day
 */
function groupByHour(records: FailureRecord[]): Map<number, FailureRecord[]> {
  const byHour = new Map<number, FailureRecord[]>();

  for (const record of records) {
    const date = new Date(record.timestamp);
    const hour = date.getHours();

    if (!byHour.has(hour)) {
      byHour.set(hour, []);
    }
    byHour.get(hour)!.push(record);
  }

  return byHour;
}

/**
 * Detect API timeout peak hours pattern
 */
function detectApiTimeoutPeakHours(records: FailureRecord[]): FailurePattern | null {
  // Filter for API timeout errors in detection window
  const cutoff = Date.now() - PATTERN_DETECTION_WINDOW;
  const timeoutRecords = records.filter(
    r => r.timestamp > cutoff &&
      (r.errorType === "TIMEOUT" || r.errorType === "API_TIMEOUT" || r.errorMessage.toLowerCase().includes("timeout"))
  );

  if (timeoutRecords.length < PEAK_HOUR_THRESHOLD) return null;

  // Group by hour
  const byHour = groupByHour(timeoutRecords);

  // Find peak hours
  const peakHours: number[] = [];
  for (const [hour, hourRecords] of byHour) {
    if (hourRecords.length >= PEAK_HOUR_THRESHOLD) {
      peakHours.push(hour);
    }
  }

  if (peakHours.length === 0) return null;

  return {
    type: "API_TIMEOUT_PEAK_HOURS",
    description: `API timeouts concentrated during hours: ${peakHours.join(", ")}`,
    occurrences: timeoutRecords.length,
    recommendation: "AVOID_PEAK_HOURS",
    metadata: { peakHours }
  };
}

/**
 * Detect terminal overload pattern
 */
function detectTerminalOverload(records: FailureRecord[]): FailurePattern | null {
  // Filter for terminal crashes in detection window
  const cutoff = Date.now() - PATTERN_DETECTION_WINDOW;
  const crashRecords = records.filter(
    r => r.timestamp > cutoff &&
      r.phase === "research" &&
      (r.errorType === "CRASH" || r.errorType === "OOM" || r.errorMessage.toLowerCase().includes("crash"))
  );

  if (crashRecords.length < TERMINAL_OVERLOAD_THRESHOLD) return null;

  // Check if crashes correlate with large segment sizes
  const largeSegmentCrashes = crashRecords.filter(r => {
    const segmentSize = r.context.segmentSize as number | undefined;
    return segmentSize && segmentSize > 5000;
  });

  if (largeSegmentCrashes.length < TERMINAL_OVERLOAD_THRESHOLD) return null;

  return {
    type: "TERMINAL_OVERLOAD",
    description: `Terminal crashes when processing large segments (>5000 markets)`,
    occurrences: largeSegmentCrashes.length,
    recommendation: "INCREASE_TERMINAL_COUNT",
    metadata: {
      averageSegmentSize: largeSegmentCrashes.reduce(
        (sum, r) => sum + (r.context.segmentSize as number || 0),
        0
      ) / largeSegmentCrashes.length
    }
  };
}

/**
 * Detect RPC congestion pattern
 */
function detectRpcCongestion(records: FailureRecord[]): FailurePattern | null {
  const cutoff = Date.now() - PATTERN_DETECTION_WINDOW;
  const rpcErrors = records.filter(
    r => r.timestamp > cutoff &&
      (r.errorType === "RPC_ERROR" || r.errorMessage.toLowerCase().includes("rpc"))
  );

  if (rpcErrors.length < 5) return null;

  return {
    type: "RPC_CONGESTION",
    description: `Frequent RPC errors detected (${rpcErrors.length} in 24h)`,
    occurrences: rpcErrors.length,
    recommendation: "SWITCH_RPC"
  };
}

/**
 * Detect all patterns in failure history
 */
export function detectPatterns(records: FailureRecord[]): FailurePattern[] {
  const patterns: FailurePattern[] = [];

  const peakHours = detectApiTimeoutPeakHours(records);
  if (peakHours) patterns.push(peakHours);

  const terminalOverload = detectTerminalOverload(records);
  if (terminalOverload) patterns.push(terminalOverload);

  const rpcCongestion = detectRpcCongestion(records);
  if (rpcCongestion) patterns.push(rpcCongestion);

  return patterns;
}

// ============================================================================
// Behavior Adaptation
// ============================================================================

export interface AdaptationResult {
  adapted: boolean;
  adaptation: BehaviorAdaptation;
  description: string;
}

/**
 * Apply behavior adaptation based on detected pattern
 */
export function adaptBehavior(
  pattern: FailurePattern,
  currentConfig: { peakHoursToAvoid?: number[]; terminalCount?: number }
): AdaptationResult {
  switch (pattern.recommendation) {
    case "AVOID_PEAK_HOURS": {
      const peakHours = (pattern.metadata?.peakHours as number[]) || [];
      return {
        adapted: true,
        adaptation: "AVOID_PEAK_HOURS",
        description: `Updated schedule to avoid peak hours: ${peakHours.join(", ")}`
      };
    }

    case "INCREASE_TERMINAL_COUNT": {
      const currentCount = currentConfig.terminalCount || 5;
      const newCount = Math.min(currentCount + 2, 10);
      return {
        adapted: true,
        adaptation: "INCREASE_TERMINAL_COUNT",
        description: `Increased terminal count from ${currentCount} to ${newCount}`
      };
    }

    case "SWITCH_RPC": {
      return {
        adapted: true,
        adaptation: "SWITCH_RPC",
        description: "Switched to secondary RPC provider"
      };
    }

    default:
      return {
        adapted: false,
        adaptation: "NONE",
        description: "No adaptation applied"
      };
  }
}

// ============================================================================
// Failure Learning Class
// ============================================================================

export interface FailureLearningConfig {
  historyPath: string;
  maxHistorySize: number;
  patternDetectionWindow: number;
}

export class FailureLearning {
  private readonly config: FailureLearningConfig;
  private history: FailureHistory;
  private onAdaptation: ((result: AdaptationResult) => void) | null = null;

  constructor(config: FailureLearningConfig) {
    this.config = config;
    this.history = loadFailureHistory(config.historyPath);
  }

  /**
   * Set callback for when adaptation is applied
   */
  setOnAdaptation(callback: (result: AdaptationResult) => void): void {
    this.onAdaptation = callback;
  }

  /**
   * Record a failure event
   */
  recordFailure(failure: Omit<FailureRecord, "timestamp">): void {
    const record: FailureRecord = {
      ...failure,
      timestamp: Date.now()
    };

    this.history.records.push(record);

    // Trim history if too large
    if (this.history.records.length > this.config.maxHistorySize) {
      this.history.records = this.history.records.slice(-this.config.maxHistorySize);
    }

    this.save();
  }

  /**
   * Analyze failures and detect patterns
   */
  analyzePatterns(): FailurePattern[] {
    const patterns = detectPatterns(this.history.records);
    this.history.detectedPatterns = patterns;
    this.history.lastAnalysis = Date.now();
    this.save();
    return patterns;
  }

  /**
   * Apply adaptations based on detected patterns
   */
  applyAdaptations(currentConfig: { peakHoursToAvoid?: number[]; terminalCount?: number }): AdaptationResult[] {
    const results: AdaptationResult[] = [];

    for (const pattern of this.history.detectedPatterns) {
      // Skip if adaptation already applied for this pattern type
      if (this.history.adaptationsApplied.includes(pattern.type)) {
        continue;
      }

      const result = adaptBehavior(pattern, currentConfig);
      results.push(result);

      if (result.adapted) {
        this.history.adaptationsApplied.push(pattern.type);
        if (this.onAdaptation) {
          this.onAdaptation(result);
        }
      }
    }

    this.save();
    return results;
  }

  /**
   * Get failure history summary
   */
  getSummary(): {
    totalFailures: number;
    recentFailures: number;
    detectedPatterns: number;
    adaptationsApplied: number;
  } {
    const cutoff = Date.now() - this.config.patternDetectionWindow;
    return {
      totalFailures: this.history.records.length,
      recentFailures: this.history.records.filter(r => r.timestamp > cutoff).length,
      detectedPatterns: this.history.detectedPatterns.length,
      adaptationsApplied: this.history.adaptationsApplied.length
    };
  }

  /**
   * Get detected patterns
   */
  getDetectedPatterns(): FailurePattern[] {
    return [...this.history.detectedPatterns];
  }

  /**
   * Clear history
   */
  clearHistory(): void {
    this.history = getDefaultFailureHistory();
    this.save();
  }

  /**
   * Reset adaptations (allow re-detection)
   */
  resetAdaptations(): void {
    this.history.adaptationsApplied = [];
    this.save();
  }

  /**
   * Save history to disk
   */
  private save(): void {
    saveFailureHistory(this.history, this.config.historyPath);
  }
}

/**
 * Get default failure learning configuration
 * @param botDir - Root directory of the bot
 * @returns FailureLearningConfig with default values for history storage and pattern detection
 */
export function getDefaultFailureLearningConfig(botDir: string): FailureLearningConfig {
  return {
    historyPath: join(botDir, "agent", "failure-history.json"),
    maxHistorySize: MAX_HISTORY_SIZE,
    patternDetectionWindow: PATTERN_DETECTION_WINDOW
  };
}
