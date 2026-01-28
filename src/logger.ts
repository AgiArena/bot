import { join } from "path";

/**
 * Log levels for structured logging
 */
export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

/**
 * Simple file logger that writes to agent.log using Bun APIs
 * Replaces console.log for production use
 */
export class Logger {
  private readonly logPath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private lastErrorTime: number | null = null;

  constructor(logsDir: string) {
    this.logPath = join(logsDir, "agent.log");

    // Ensure logs directory exists using Bun
    const dir = Bun.file(logsDir);
    if (!dir.size) {
      // Directory doesn't exist, create it
      Bun.spawnSync(["mkdir", "-p", logsDir]);
    }
  }

  /**
   * Format a log message with timestamp and level
   */
  private formatMessage(level: LogLevel, message: string, data?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";
    return `[${timestamp}] [${level}] ${message}${dataStr}\n`;
  }

  /**
   * Write a log message to file asynchronously (non-blocking)
   */
  private write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const formatted = this.formatMessage(level, message, data);

    // Queue writes to ensure ordering without blocking
    this.writeQueue = this.writeQueue.then(async () => {
      const file = Bun.file(this.logPath);
      const existing = await file.exists() ? await file.text() : "";
      await Bun.write(this.logPath, existing + formatted);
    }).catch((error) => {
      // Log to stderr on logger failure to avoid silent failures
      // Only log once per minute to avoid log spam
      const now = Date.now();
      if (!this.lastErrorTime || now - this.lastErrorTime > 60_000) {
        this.lastErrorTime = now;
        console.error(`[Logger] Failed to write log: ${error?.message || error}`);
      }
    });
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.write("INFO", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.write("WARN", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.write("ERROR", message, data);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.write("DEBUG", message, data);
  }

  /**
   * Flush pending writes (useful before shutdown)
   */
  async flush(): Promise<void> {
    await this.writeQueue;
  }
}
