/**
 * Dead Letter Queue
 *
 * Handles tasks that fail after max retries.
 * Critical failures (MATCH_BET) trigger operator alerts.
 *
 * AC: #7
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";

// ============================================================================
// Types
// ============================================================================

export type TaskType = "MATCH_BET" | "SYNC_STATE" | "REGISTER_AGENT" | "RESEARCH" | "OTHER";

export interface DeadLetter {
  taskId: string;
  taskType: TaskType;
  attempts: number;
  firstAttempt: number;
  lastAttempt: number;
  errors: string[];
  data: unknown;
}

export interface DeadLetterStore {
  letters: DeadLetter[];
  lastReview: number;
}

export interface ReviewAnalysis {
  totalLetters: number;
  byErrorType: Record<string, number>;
  byTaskType: Record<TaskType, number>;
  criticalCount: number;
  oldestLetter: number | null;
}

// ============================================================================
// Constants
// ============================================================================

const CRITICAL_TASK_TYPES: TaskType[] = ["MATCH_BET"];

// ============================================================================
// Store Persistence
// ============================================================================

/**
 * Get default dead letter store
 */
export function getDefaultDeadLetterStore(): DeadLetterStore {
  return {
    letters: [],
    lastReview: 0
  };
}

/**
 * Load dead letter store from disk
 */
export function loadDeadLetterStore(storePath: string): DeadLetterStore {
  if (!existsSync(storePath)) {
    return getDefaultDeadLetterStore();
  }

  try {
    const content = readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(content) as DeadLetterStore;

    return {
      letters: Array.isArray(parsed.letters) ? parsed.letters : [],
      lastReview: parsed.lastReview ?? 0
    };
  } catch {
    return getDefaultDeadLetterStore();
  }
}

/**
 * Save dead letter store atomically
 */
export function saveDeadLetterStore(store: DeadLetterStore, storePath: string): void {
  const dir = dirname(storePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${storePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(store, null, 2));
  renameSync(tempPath, storePath);
}

// ============================================================================
// Analysis Functions
// ============================================================================

/**
 * Analyze dead letters for review
 */
export function analyzeDeadLetters(letters: DeadLetter[]): ReviewAnalysis {
  const byErrorType: Record<string, number> = {};
  const byTaskType: Record<TaskType, number> = {
    MATCH_BET: 0,
    SYNC_STATE: 0,
    REGISTER_AGENT: 0,
    RESEARCH: 0,
    OTHER: 0
  };
  let criticalCount = 0;
  let oldestLetter: number | null = null;

  for (const letter of letters) {
    // Count by task type
    byTaskType[letter.taskType]++;

    // Count critical
    if (CRITICAL_TASK_TYPES.includes(letter.taskType)) {
      criticalCount++;
    }

    // Track oldest
    if (oldestLetter === null || letter.firstAttempt < oldestLetter) {
      oldestLetter = letter.firstAttempt;
    }

    // Group errors by type (extract error type from message)
    for (const error of letter.errors) {
      const errorType = extractErrorType(error);
      byErrorType[errorType] = (byErrorType[errorType] || 0) + 1;
    }
  }

  return {
    totalLetters: letters.length,
    byErrorType,
    byTaskType,
    criticalCount,
    oldestLetter
  };
}

/**
 * Extract error type from error message
 */
function extractErrorType(error: string): string {
  // Try to extract common error patterns
  if (error.includes("TIMEOUT") || error.toLowerCase().includes("timeout")) {
    return "TIMEOUT";
  }
  if (error.includes("ECONNREFUSED") || error.includes("connection refused")) {
    return "CONNECTION_REFUSED";
  }
  if (error.includes("INSUFFICIENT") || error.toLowerCase().includes("insufficient")) {
    return "INSUFFICIENT_FUNDS";
  }
  if (error.includes("REVERT") || error.toLowerCase().includes("revert")) {
    return "CONTRACT_REVERT";
  }
  if (error.includes("RATE_LIMIT") || error.toLowerCase().includes("rate limit")) {
    return "RATE_LIMITED";
  }
  return "UNKNOWN";
}

// ============================================================================
// Dead Letter Queue Class
// ============================================================================

export interface DeadLetterQueueConfig {
  storePath: string;
  /** Weekly review interval in milliseconds (default: 7 days) */
  weeklyReviewIntervalMs?: number;
}

export class DeadLetterQueue {
  private readonly config: DeadLetterQueueConfig;
  private store: DeadLetterStore;
  private onAlert: ((letter: DeadLetter) => void) | null = null;
  private onWeeklyReview: ((analysis: ReviewAnalysis) => void) | null = null;
  private weeklyReviewInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: DeadLetterQueueConfig) {
    this.config = config;
    this.store = loadDeadLetterStore(config.storePath);
  }

  /**
   * Set callback for weekly review analysis (AC#7)
   */
  setOnWeeklyReview(callback: (analysis: ReviewAnalysis) => void): void {
    this.onWeeklyReview = callback;
  }

  /**
   * Start the weekly review scheduler (AC#7)
   * Runs review analysis once per week and calls onWeeklyReview callback
   */
  startWeeklyReviewScheduler(): void {
    if (this.weeklyReviewInterval) return;

    const intervalMs = this.config.weeklyReviewIntervalMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days

    // Check if a review is due (more than a week since last review)
    const timeSinceLastReview = Date.now() - this.store.lastReview;
    if (timeSinceLastReview >= intervalMs) {
      // Run initial review if overdue
      this.runScheduledReview();
    }

    // Schedule weekly reviews
    this.weeklyReviewInterval = setInterval(() => {
      this.runScheduledReview();
    }, intervalMs);
  }

  /**
   * Stop the weekly review scheduler
   */
  stopWeeklyReviewScheduler(): void {
    if (this.weeklyReviewInterval) {
      clearInterval(this.weeklyReviewInterval);
      this.weeklyReviewInterval = null;
    }
  }

  /**
   * Run scheduled weekly review
   */
  private runScheduledReview(): void {
    const analysis = this.reviewDeadLetters();

    // Log summary to stderr for operator visibility
    console.error(`[DEAD LETTER WEEKLY REVIEW] ${new Date().toISOString()}`);
    console.error(`  Total letters: ${analysis.totalLetters}`);
    console.error(`  Critical count: ${analysis.criticalCount}`);
    console.error(`  By task type: ${JSON.stringify(analysis.byTaskType)}`);
    console.error(`  By error type: ${JSON.stringify(analysis.byErrorType)}`);

    if (this.onWeeklyReview) {
      this.onWeeklyReview(analysis);
    }
  }

  /**
   * Set callback for critical task alerts
   */
  setOnAlert(callback: (letter: DeadLetter) => void): void {
    this.onAlert = callback;
  }

  /**
   * Move a failed task to the dead letter queue
   */
  moveToDeadLetter(
    taskId: string,
    taskType: TaskType,
    attempts: number,
    errors: string[],
    data: unknown
  ): DeadLetter {
    const now = Date.now();

    // Check if this task is already in the queue
    const existing = this.store.letters.find(l => l.taskId === taskId);
    if (existing) {
      existing.attempts = attempts;
      existing.lastAttempt = now;
      existing.errors = errors;
      existing.data = data;
      this.save();
      return existing;
    }

    // Create new dead letter
    const letter: DeadLetter = {
      taskId,
      taskType,
      attempts,
      firstAttempt: now,
      lastAttempt: now,
      errors,
      data
    };

    this.store.letters.push(letter);
    this.save();

    // Alert if critical
    if (CRITICAL_TASK_TYPES.includes(taskType)) {
      this.alertOperator(letter);
    }

    return letter;
  }

  /**
   * Alert operator about critical failure
   */
  private alertOperator(letter: DeadLetter): void {
    // Log to stderr for operator visibility
    console.error(`[DEAD LETTER ALERT] Critical task failed: ${letter.taskType}`);
    console.error(`  Task ID: ${letter.taskId}`);
    console.error(`  Attempts: ${letter.attempts}`);
    console.error(`  Last Error: ${letter.errors[letter.errors.length - 1]}`);

    if (this.onAlert) {
      this.onAlert(letter);
    }
  }

  /**
   * Get all dead letters
   */
  getAll(): DeadLetter[] {
    return [...this.store.letters];
  }

  /**
   * Get dead letters by task type
   */
  getByTaskType(taskType: TaskType): DeadLetter[] {
    return this.store.letters.filter(l => l.taskType === taskType);
  }

  /**
   * Get a specific dead letter by task ID
   */
  get(taskId: string): DeadLetter | null {
    return this.store.letters.find(l => l.taskId === taskId) || null;
  }

  /**
   * Retry a dead letter (remove from queue for retry)
   */
  retryDeadLetter(taskId: string): DeadLetter | null {
    const index = this.store.letters.findIndex(l => l.taskId === taskId);
    if (index === -1) return null;

    const [letter] = this.store.letters.splice(index, 1);
    this.save();
    return letter;
  }

  /**
   * Remove a dead letter (acknowledged/resolved)
   */
  remove(taskId: string): boolean {
    const index = this.store.letters.findIndex(l => l.taskId === taskId);
    if (index === -1) return false;

    this.store.letters.splice(index, 1);
    this.save();
    return true;
  }

  /**
   * Review dead letters for analysis
   */
  reviewDeadLetters(): ReviewAnalysis {
    this.store.lastReview = Date.now();
    this.save();
    return analyzeDeadLetters(this.store.letters);
  }

  /**
   * Get count of dead letters
   */
  getCount(): number {
    return this.store.letters.length;
  }

  /**
   * Get count of critical dead letters
   */
  getCriticalCount(): number {
    return this.store.letters.filter(l => CRITICAL_TASK_TYPES.includes(l.taskType)).length;
  }

  /**
   * Clear all dead letters
   */
  clearAll(): void {
    this.store = getDefaultDeadLetterStore();
    this.save();
  }

  /**
   * Save store to disk
   */
  private save(): void {
    saveDeadLetterStore(this.store, this.config.storePath);
  }
}

/**
 * Get default dead letter queue configuration
 * @param botDir - Root directory of the bot
 * @returns DeadLetterQueueConfig with default store path and weekly review interval (7 days)
 */
export function getDefaultDeadLetterQueueConfig(botDir: string): DeadLetterQueueConfig {
  return {
    storePath: join(botDir, "agent", "dead-letters.json"),
    weeklyReviewIntervalMs: 7 * 24 * 60 * 60 * 1000 // 7 days
  };
}
