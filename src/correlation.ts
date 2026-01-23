/**
 * Correlation Tracker
 *
 * Tags all operations with correlation IDs for distributed tracing.
 * Format: {operationType}-{timestamp}-{randomId}
 * Logs to logs/structured.jsonl for tracing.
 *
 * AC: #9
 */

import { existsSync, appendFileSync, mkdirSync, statSync, renameSync, unlinkSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";
import { AsyncLocalStorage } from "async_hooks";

// ============================================================================
// Types
// ============================================================================

export interface CorrelationLog {
  correlationId: string;
  timestamp: number;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  message: string;
  data?: unknown;
}

export interface OperationContext {
  correlationId: string;
  operationType: string;
  startTime: number;
  logs: CorrelationLog[];
}

// ============================================================================
// Correlation ID Generation
// ============================================================================

/**
 * Generate a correlation ID
 * Format: {operationType}-{timestamp}-{randomId}
 */
export function generateCorrelationId(operationType: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${operationType}-${timestamp}-${random}`;
}

// ============================================================================
// Context Storage (using AsyncLocalStorage for async context propagation)
// ============================================================================

const operationStorage = new AsyncLocalStorage<OperationContext>();

/**
 * Get current operation context
 */
export function getCurrentContext(): OperationContext | undefined {
  return operationStorage.getStore();
}

/**
 * Get current correlation ID
 */
export function getCorrelationId(): string | undefined {
  const context = getCurrentContext();
  return context?.correlationId;
}

// ============================================================================
// Correlation Tracker Class
// ============================================================================

export interface CorrelationTrackerConfig {
  logPath: string;
  enableFileLogging: boolean;
  /** Maximum log file size in MB before rotation (default: 10) */
  maxLogSizeMB?: number;
  /** Maximum number of rotated log files to keep (default: 5) */
  maxLogFiles?: number;
}

export class CorrelationTracker {
  private readonly config: CorrelationTrackerConfig;
  private activeOperations: Map<string, OperationContext> = new Map();
  private readonly maxLogSizeBytes: number;
  private readonly maxLogFiles: number;

  constructor(config: CorrelationTrackerConfig) {
    this.config = config;
    this.maxLogSizeBytes = (config.maxLogSizeMB ?? 10) * 1024 * 1024;
    this.maxLogFiles = config.maxLogFiles ?? 5;

    // Ensure log directory exists
    if (config.enableFileLogging) {
      const dir = dirname(config.logPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Rotate log file if it exceeds max size
   * Rotates to structured.jsonl.1, .2, etc. and removes oldest
   */
  private rotateLogIfNeeded(): void {
    if (!this.config.enableFileLogging) return;
    if (!existsSync(this.config.logPath)) return;

    try {
      const stats = statSync(this.config.logPath);
      if (stats.size < this.maxLogSizeBytes) return;

      const dir = dirname(this.config.logPath);
      const baseName = basename(this.config.logPath);

      // Shift existing rotated files (structured.jsonl.4 -> .5, etc.)
      for (let i = this.maxLogFiles - 1; i >= 1; i--) {
        const oldPath = join(dir, `${baseName}.${i}`);
        const newPath = join(dir, `${baseName}.${i + 1}`);
        if (existsSync(oldPath)) {
          if (i === this.maxLogFiles - 1) {
            // Delete the oldest
            unlinkSync(oldPath);
          } else {
            renameSync(oldPath, newPath);
          }
        }
      }

      // Rotate current log to .1
      renameSync(this.config.logPath, join(dir, `${baseName}.1`));
    } catch {
      // Silently fail - don't let rotation errors crash the system
    }
  }

  /**
   * Start a new operation with correlation ID
   * Returns a function to run code within this operation's context
   */
  startOperation<T>(
    operationType: string,
    fn: () => T
  ): { correlationId: string; result: T } {
    const correlationId = generateCorrelationId(operationType);

    const context: OperationContext = {
      correlationId,
      operationType,
      startTime: Date.now(),
      logs: []
    };

    this.activeOperations.set(correlationId, context);

    // Log operation start
    this.logEntry(correlationId, "INFO", `Operation started: ${operationType}`);

    // Run the function within the async local storage context
    const result = operationStorage.run(context, fn);

    return { correlationId, result };
  }

  /**
   * Start an async operation with correlation ID
   */
  async startAsyncOperation<T>(
    operationType: string,
    fn: () => Promise<T>
  ): Promise<{ correlationId: string; result: T }> {
    const correlationId = generateCorrelationId(operationType);

    const context: OperationContext = {
      correlationId,
      operationType,
      startTime: Date.now(),
      logs: []
    };

    this.activeOperations.set(correlationId, context);

    // Log operation start
    this.logEntry(correlationId, "INFO", `Operation started: ${operationType}`);

    // Run the async function within the async local storage context
    const result = await operationStorage.run(context, fn);

    return { correlationId, result };
  }

  /**
   * End an operation
   */
  endOperation(correlationId: string, success: boolean = true): void {
    const context = this.activeOperations.get(correlationId);
    if (!context) return;

    const duration = Date.now() - context.startTime;
    const status = success ? "completed" : "failed";

    this.logEntry(
      correlationId,
      success ? "INFO" : "ERROR",
      `Operation ${status}: ${context.operationType}`,
      { durationMs: duration }
    );

    this.activeOperations.delete(correlationId);
  }

  /**
   * Log a message with correlation ID
   */
  log(
    correlationId: string | undefined,
    level: CorrelationLog["level"],
    message: string,
    data?: unknown
  ): void {
    const cid = correlationId || getCorrelationId();
    if (!cid) {
      // No correlation ID, log without it
      this.writeLog({ correlationId: "NONE", timestamp: Date.now(), level, message, data });
      return;
    }

    this.logEntry(cid, level, message, data);
  }

  /**
   * Convenience methods
   */
  debug(message: string, data?: unknown): void {
    this.log(undefined, "DEBUG", message, data);
  }

  info(message: string, data?: unknown): void {
    this.log(undefined, "INFO", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log(undefined, "WARN", message, data);
  }

  error(message: string, data?: unknown): void {
    this.log(undefined, "ERROR", message, data);
  }

  /**
   * Get operation context by correlation ID
   */
  getOperationContext(correlationId: string): OperationContext | undefined {
    return this.activeOperations.get(correlationId);
  }

  /**
   * Get all active operations
   */
  getActiveOperations(): Map<string, OperationContext> {
    return new Map(this.activeOperations);
  }

  /**
   * Get count of active operations
   */
  getActiveOperationCount(): number {
    return this.activeOperations.size;
  }

  /**
   * Internal: Log entry and persist
   */
  private logEntry(
    correlationId: string,
    level: CorrelationLog["level"],
    message: string,
    data?: unknown
  ): void {
    const log: CorrelationLog = {
      correlationId,
      timestamp: Date.now(),
      level,
      message,
      data
    };

    // Add to context logs if available
    const context = this.activeOperations.get(correlationId);
    if (context) {
      context.logs.push(log);
    }

    // Write to file
    this.writeLog(log);
  }

  /**
   * Internal: Write log to file with automatic rotation
   */
  private writeLog(log: CorrelationLog): void {
    if (!this.config.enableFileLogging) return;

    try {
      // Check and rotate if needed before writing
      this.rotateLogIfNeeded();

      const line = JSON.stringify(log) + "\n";
      appendFileSync(this.config.logPath, line);
    } catch {
      // Silently fail - don't let logging errors crash the system
    }
  }
}

/**
 * Get default correlation tracker configuration
 * @param botDir - Root directory of the bot
 * @returns Configuration with log rotation settings
 */
export function getDefaultCorrelationTrackerConfig(botDir: string): CorrelationTrackerConfig {
  return {
    logPath: join(botDir, "logs", "structured.jsonl"),
    enableFileLogging: true,
    maxLogSizeMB: 10,    // Rotate after 10MB
    maxLogFiles: 5       // Keep 5 rotated files
  };
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultTracker: CorrelationTracker | null = null;

/**
 * Get or create default correlation tracker
 */
export function getDefaultCorrelationTracker(botDir: string): CorrelationTracker {
  if (!defaultTracker) {
    defaultTracker = new CorrelationTracker(getDefaultCorrelationTrackerConfig(botDir));
  }
  return defaultTracker;
}

/**
 * Helper to run a function with correlation tracking
 */
export async function withCorrelation<T>(
  tracker: CorrelationTracker,
  operationType: string,
  fn: () => Promise<T>
): Promise<T> {
  const { correlationId, result } = await tracker.startAsyncOperation(operationType, async () => {
    try {
      const res = await fn();
      return { success: true, result: res };
    } catch (error) {
      return { success: false, error };
    }
  });

  const outcome = result as { success: boolean; result?: T; error?: unknown };

  tracker.endOperation(correlationId, outcome.success);

  if (!outcome.success) {
    throw outcome.error;
  }

  return outcome.result as T;
}
