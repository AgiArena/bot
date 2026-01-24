/**
 * Resolution Timer Module
 *
 * Manages the 30-minute resolution timeline for test bets:
 * - Timer creation and management
 * - Resolution trigger callbacks
 * - State persistence for recovery
 *
 * Story 7.6: AI Trading Bot Launch Scripts
 * AC: 5 - 30-Minute Resolution
 */

/**
 * Resolution state for a bet
 */
export interface ResolutionState {
  betId: string;
  startTime: string; // ISO timestamp when bet was matched
  resolutionTime: string; // ISO timestamp when resolution should occur
  status: "pending" | "resolving" | "resolved" | "failed";
  retryCount: number;
}

/**
 * Timer configuration
 */
export interface TimerConfig {
  /** Resolution period in minutes (default: 30) */
  resolutionMinutes: number;
  /** Max retries for failed resolution */
  maxRetries: number;
  /** Polling interval in milliseconds */
  pollIntervalMs: number;
}

/**
 * Default timer configuration
 */
export const DEFAULT_TIMER_CONFIG: TimerConfig = {
  resolutionMinutes: parseInt(process.env.RESOLUTION_MINUTES || "30", 10),
  maxRetries: 3,
  pollIntervalMs: 10000, // 10 seconds
};

import { join } from "path";
import { Logger } from "./logger";

// Initialize logger for this module
const logsDir = process.env.AGENT_LOGS_DIR || join(process.cwd(), "agent");
const logger = new Logger(logsDir);

/**
 * Create a new resolution state for a matched bet
 */
export function createResolutionState(
  betId: string,
  config: Partial<TimerConfig> = {}
): ResolutionState {
  const cfg = { ...DEFAULT_TIMER_CONFIG, ...config };

  const startTime = new Date();
  const resolutionTime = new Date(
    startTime.getTime() + cfg.resolutionMinutes * 60 * 1000
  );

  return {
    betId,
    startTime: startTime.toISOString(),
    resolutionTime: resolutionTime.toISOString(),
    status: "pending",
    retryCount: 0,
  };
}

/**
 * Check if a bet is ready for resolution
 */
export function isReadyForResolution(state: ResolutionState): boolean {
  if (state.status !== "pending") {
    return false;
  }

  const now = Date.now();
  const resolutionTime = new Date(state.resolutionTime).getTime();

  return now >= resolutionTime;
}

/**
 * Calculate time remaining until resolution (in seconds)
 */
export function getTimeRemainingSeconds(state: ResolutionState): number {
  if (state.status !== "pending") {
    return 0;
  }

  const now = Date.now();
  const resolutionTime = new Date(state.resolutionTime).getTime();
  const remainingMs = Math.max(0, resolutionTime - now);

  return Math.ceil(remainingMs / 1000);
}

/**
 * Format time remaining as human-readable string
 */
export function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) {
    return "Ready for resolution";
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }

  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Update resolution state to resolving
 */
export function markAsResolving(state: ResolutionState): ResolutionState {
  return {
    ...state,
    status: "resolving",
  };
}

/**
 * Update resolution state to resolved
 */
export function markAsResolved(state: ResolutionState): ResolutionState {
  return {
    ...state,
    status: "resolved",
  };
}

/**
 * Update resolution state to failed
 */
export function markAsFailed(
  state: ResolutionState,
  config: Partial<TimerConfig> = {}
): ResolutionState {
  const cfg = { ...DEFAULT_TIMER_CONFIG, ...config };

  const newRetryCount = state.retryCount + 1;

  // If under max retries, go back to pending for retry
  if (newRetryCount < cfg.maxRetries) {
    return {
      ...state,
      status: "pending",
      retryCount: newRetryCount,
    };
  }

  // Otherwise, mark as permanently failed
  return {
    ...state,
    status: "failed",
    retryCount: newRetryCount,
  };
}

/**
 * Resolution callback type
 */
export type ResolutionCallback = (betId: string) => Promise<boolean>;

/**
 * Resolution timer manager
 *
 * Manages multiple pending resolutions and triggers callbacks
 */
export class ResolutionTimerManager {
  private resolutions: Map<string, ResolutionState> = new Map();
  private config: TimerConfig;
  private pollInterval: NodeJS.Timer | null = null;
  private onResolve: ResolutionCallback | null = null;

  constructor(config: Partial<TimerConfig> = {}) {
    this.config = { ...DEFAULT_TIMER_CONFIG, ...config };
  }

  /**
   * Set the resolution callback
   */
  setCallback(callback: ResolutionCallback): void {
    this.onResolve = callback;
  }

  /**
   * Add a bet for resolution tracking
   */
  addBet(betId: string): ResolutionState {
    const state = createResolutionState(betId, this.config);
    this.resolutions.set(betId, state);

    logger.info(`Added bet ${betId} for resolution`, {
      resolutionTime: state.resolutionTime,
      minutes: this.config.resolutionMinutes,
    });

    return state;
  }

  /**
   * Get resolution state for a bet
   */
  getState(betId: string): ResolutionState | undefined {
    return this.resolutions.get(betId);
  }

  /**
   * Remove a bet from tracking
   */
  removeBet(betId: string): void {
    this.resolutions.delete(betId);
    logger.info(`Removed bet ${betId} from resolution tracking`);
  }

  /**
   * Get all pending resolutions
   */
  getPendingResolutions(): ResolutionState[] {
    return Array.from(this.resolutions.values()).filter(
      (s) => s.status === "pending"
    );
  }

  /**
   * Get all resolutions ready for resolution
   */
  getReadyResolutions(): ResolutionState[] {
    return Array.from(this.resolutions.values()).filter(isReadyForResolution);
  }

  /**
   * Process ready resolutions
   */
  async processReadyResolutions(): Promise<void> {
    const ready = this.getReadyResolutions();

    if (ready.length === 0) {
      return;
    }

    logger.info(`Processing ${ready.length} ready resolutions`);

    for (const state of ready) {
      await this.resolvebet(state);
    }
  }

  /**
   * Resolve a single bet
   */
  private async resolvebet(state: ResolutionState): Promise<void> {
    if (!this.onResolve) {
      logger.warn(`No resolution callback set for bet ${state.betId}`);
      return;
    }

    // Mark as resolving
    const resolvingState = markAsResolving(state);
    this.resolutions.set(state.betId, resolvingState);

    logger.info(`Resolving bet ${state.betId}...`);

    try {
      const success = await this.onResolve(state.betId);

      if (success) {
        const resolvedState = markAsResolved(resolvingState);
        this.resolutions.set(state.betId, resolvedState);
        logger.info(`Bet ${state.betId} resolved successfully`);
      } else {
        const failedState = markAsFailed(resolvingState, this.config);
        this.resolutions.set(state.betId, failedState);
        logger.warn(`Bet ${state.betId} resolution failed (retry: ${failedState.retryCount}/${this.config.maxRetries})`);
      }
    } catch (error) {
      const failedState = markAsFailed(resolvingState, this.config);
      this.resolutions.set(state.betId, failedState);
      logger.error(`Bet ${state.betId} resolution error: ${error}`);
    }
  }

  /**
   * Start the resolution polling loop
   */
  start(): void {
    if (this.pollInterval) {
      return;
    }

    logger.info(`Starting resolution timer (poll interval: ${this.config.pollIntervalMs}ms)`);

    this.pollInterval = setInterval(async () => {
      await this.processReadyResolutions();
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop the resolution polling loop
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      logger.info("Resolution timer stopped");
    }
  }

  /**
   * Get summary of all resolutions
   */
  getSummary(): {
    pending: number;
    resolving: number;
    resolved: number;
    failed: number;
    total: number;
  } {
    const states = Array.from(this.resolutions.values());

    return {
      pending: states.filter((s) => s.status === "pending").length,
      resolving: states.filter((s) => s.status === "resolving").length,
      resolved: states.filter((s) => s.status === "resolved").length,
      failed: states.filter((s) => s.status === "failed").length,
      total: states.length,
    };
  }

  /**
   * Export state for persistence
   */
  exportState(): ResolutionState[] {
    return Array.from(this.resolutions.values());
  }

  /**
   * Import state from persistence
   */
  importState(states: ResolutionState[]): void {
    for (const state of states) {
      this.resolutions.set(state.betId, state);
    }
    logger.info(`Imported ${states.length} resolution states`);
  }
}
