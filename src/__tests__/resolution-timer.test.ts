/**
 * Tests for Resolution Timer Module
 *
 * Story 7.6: AI Trading Bot Launch Scripts
 * Task 4: 30-Minute Resolution (AC: 5)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createResolutionState,
  isReadyForResolution,
  getTimeRemainingSeconds,
  formatTimeRemaining,
  markAsResolving,
  markAsResolved,
  markAsFailed,
  ResolutionTimerManager,
  DEFAULT_TIMER_CONFIG,
  type ResolutionState,
  type TimerConfig,
} from "../resolution-timer";

describe("Resolution Timer", () => {
  describe("createResolutionState", () => {
    test("creates state with correct betId", () => {
      const state = createResolutionState("bet-123");
      expect(state.betId).toBe("bet-123");
    });

    test("creates state with pending status", () => {
      const state = createResolutionState("bet-123");
      expect(state.status).toBe("pending");
    });

    test("creates state with zero retry count", () => {
      const state = createResolutionState("bet-123");
      expect(state.retryCount).toBe(0);
    });

    test("sets resolution time 30 minutes in future by default", () => {
      const before = Date.now();
      const state = createResolutionState("bet-123");
      const after = Date.now();

      const startTime = new Date(state.startTime).getTime();
      const resolutionTime = new Date(state.resolutionTime).getTime();

      // Start time should be around now
      expect(startTime).toBeGreaterThanOrEqual(before);
      expect(startTime).toBeLessThanOrEqual(after);

      // Resolution time should be 30 minutes later
      const expectedResolution = startTime + 30 * 60 * 1000;
      expect(resolutionTime).toBe(expectedResolution);
    });

    test("respects custom resolution minutes", () => {
      const state = createResolutionState("bet-123", { resolutionMinutes: 5 });

      const startTime = new Date(state.startTime).getTime();
      const resolutionTime = new Date(state.resolutionTime).getTime();

      const diffMinutes = (resolutionTime - startTime) / (60 * 1000);
      expect(diffMinutes).toBe(5);
    });
  });

  describe("isReadyForResolution", () => {
    test("returns false for future resolution time", () => {
      const state = createResolutionState("bet-123", { resolutionMinutes: 30 });
      expect(isReadyForResolution(state)).toBe(false);
    });

    test("returns true for past resolution time", () => {
      const state: ResolutionState = {
        betId: "bet-123",
        startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
        resolutionTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
        status: "pending",
        retryCount: 0,
      };

      expect(isReadyForResolution(state)).toBe(true);
    });

    test("returns false for non-pending status", () => {
      const state: ResolutionState = {
        betId: "bet-123",
        startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        resolutionTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        status: "resolving",
        retryCount: 0,
      };

      expect(isReadyForResolution(state)).toBe(false);
    });

    test("returns false for resolved status", () => {
      const state: ResolutionState = {
        betId: "bet-123",
        startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        resolutionTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        status: "resolved",
        retryCount: 0,
      };

      expect(isReadyForResolution(state)).toBe(false);
    });
  });

  describe("getTimeRemainingSeconds", () => {
    test("returns positive seconds for future resolution", () => {
      const state = createResolutionState("bet-123", { resolutionMinutes: 30 });
      const remaining = getTimeRemainingSeconds(state);

      // Should be close to 30 minutes
      expect(remaining).toBeGreaterThan(29 * 60);
      expect(remaining).toBeLessThanOrEqual(30 * 60);
    });

    test("returns zero for past resolution", () => {
      const state: ResolutionState = {
        betId: "bet-123",
        startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        resolutionTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        status: "pending",
        retryCount: 0,
      };

      expect(getTimeRemainingSeconds(state)).toBe(0);
    });

    test("returns zero for non-pending status", () => {
      const state: ResolutionState = {
        betId: "bet-123",
        startTime: new Date().toISOString(),
        resolutionTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        status: "resolved",
        retryCount: 0,
      };

      expect(getTimeRemainingSeconds(state)).toBe(0);
    });
  });

  describe("formatTimeRemaining", () => {
    test("formats zero as ready message", () => {
      expect(formatTimeRemaining(0)).toBe("Ready for resolution");
    });

    test("formats negative as ready message", () => {
      expect(formatTimeRemaining(-10)).toBe("Ready for resolution");
    });

    test("formats seconds only", () => {
      expect(formatTimeRemaining(45)).toBe("45s");
    });

    test("formats minutes and seconds", () => {
      expect(formatTimeRemaining(90)).toBe("1m 30s");
    });

    test("formats large values", () => {
      expect(formatTimeRemaining(30 * 60)).toBe("30m 0s");
    });
  });

  describe("State transitions", () => {
    const initialState: ResolutionState = {
      betId: "bet-123",
      startTime: new Date().toISOString(),
      resolutionTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      status: "pending",
      retryCount: 0,
    };

    test("markAsResolving changes status", () => {
      const resolved = markAsResolving(initialState);
      expect(resolved.status).toBe("resolving");
      expect(resolved.betId).toBe(initialState.betId);
    });

    test("markAsResolved changes status", () => {
      const resolving = markAsResolving(initialState);
      const resolved = markAsResolved(resolving);
      expect(resolved.status).toBe("resolved");
    });

    test("markAsFailed increments retry count", () => {
      const failed = markAsFailed(initialState);
      expect(failed.retryCount).toBe(1);
    });

    test("markAsFailed returns to pending under max retries", () => {
      const failed = markAsFailed(initialState, { maxRetries: 3 });
      expect(failed.status).toBe("pending");
    });

    test("markAsFailed sets failed status at max retries", () => {
      const state: ResolutionState = {
        ...initialState,
        retryCount: 2,
      };
      const failed = markAsFailed(state, { maxRetries: 3 });
      expect(failed.status).toBe("failed");
      expect(failed.retryCount).toBe(3);
    });
  });

  describe("ResolutionTimerManager", () => {
    let manager: ResolutionTimerManager;

    beforeEach(() => {
      manager = new ResolutionTimerManager({ resolutionMinutes: 1 });
    });

    afterEach(() => {
      manager.stop();
    });

    test("addBet creates and tracks resolution state", () => {
      const state = manager.addBet("bet-123");

      expect(state.betId).toBe("bet-123");
      expect(state.status).toBe("pending");

      const retrieved = manager.getState("bet-123");
      expect(retrieved).toBeDefined();
      expect(retrieved?.betId).toBe("bet-123");
    });

    test("removeBet removes from tracking", () => {
      manager.addBet("bet-123");
      manager.removeBet("bet-123");

      expect(manager.getState("bet-123")).toBeUndefined();
    });

    test("getPendingResolutions returns only pending", () => {
      manager.addBet("bet-1");
      manager.addBet("bet-2");

      const pending = manager.getPendingResolutions();
      expect(pending.length).toBe(2);
      expect(pending.every((s) => s.status === "pending")).toBe(true);
    });

    test("getReadyResolutions returns only ready bets", () => {
      // Add a future bet
      manager.addBet("bet-future");

      // Manually add a past bet
      const pastState: ResolutionState = {
        betId: "bet-past",
        startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        resolutionTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        status: "pending",
        retryCount: 0,
      };
      manager.importState([pastState]);

      const ready = manager.getReadyResolutions();
      expect(ready.length).toBe(1);
      expect(ready[0].betId).toBe("bet-past");
    });

    test("getSummary returns correct counts", () => {
      manager.addBet("bet-1");
      manager.addBet("bet-2");

      const summary = manager.getSummary();
      expect(summary.pending).toBe(2);
      expect(summary.resolving).toBe(0);
      expect(summary.resolved).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.total).toBe(2);
    });

    test("exportState returns all states", () => {
      manager.addBet("bet-1");
      manager.addBet("bet-2");

      const exported = manager.exportState();
      expect(exported.length).toBe(2);
    });

    test("importState restores states", () => {
      const states: ResolutionState[] = [
        {
          betId: "imported-1",
          startTime: new Date().toISOString(),
          resolutionTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          status: "pending",
          retryCount: 0,
        },
        {
          betId: "imported-2",
          startTime: new Date().toISOString(),
          resolutionTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          status: "resolved",
          retryCount: 0,
        },
      ];

      manager.importState(states);

      expect(manager.getState("imported-1")).toBeDefined();
      expect(manager.getState("imported-2")).toBeDefined();
      expect(manager.getState("imported-2")?.status).toBe("resolved");
    });

    test("processReadyResolutions calls callback", async () => {
      let resolvedBetId: string | null = null;

      manager.setCallback(async (betId) => {
        resolvedBetId = betId;
        return true;
      });

      // Add a bet that's ready for resolution
      const pastState: ResolutionState = {
        betId: "ready-bet",
        startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        resolutionTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        status: "pending",
        retryCount: 0,
      };
      manager.importState([pastState]);

      await manager.processReadyResolutions();

      expect(resolvedBetId).toBe("ready-bet");
      expect(manager.getState("ready-bet")?.status).toBe("resolved");
    });

    test("processReadyResolutions handles callback failure", async () => {
      manager.setCallback(async (_betId) => {
        return false;
      });

      const pastState: ResolutionState = {
        betId: "failing-bet",
        startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        resolutionTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        status: "pending",
        retryCount: 0,
      };
      manager.importState([pastState]);

      await manager.processReadyResolutions();

      const state = manager.getState("failing-bet");
      expect(state?.retryCount).toBe(1);
      expect(state?.status).toBe("pending"); // Goes back to pending for retry
    });

    test("processReadyResolutions handles callback exception", async () => {
      manager.setCallback(async (_betId) => {
        throw new Error("Test error");
      });

      const pastState: ResolutionState = {
        betId: "error-bet",
        startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        resolutionTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        status: "pending",
        retryCount: 0,
      };
      manager.importState([pastState]);

      await manager.processReadyResolutions();

      const state = manager.getState("error-bet");
      expect(state?.retryCount).toBe(1);
    });
  });

  describe("DEFAULT_TIMER_CONFIG", () => {
    test("has 30-minute resolution by default", () => {
      expect(DEFAULT_TIMER_CONFIG.resolutionMinutes).toBe(30);
    });

    test("has reasonable max retries", () => {
      expect(DEFAULT_TIMER_CONFIG.maxRetries).toBe(3);
    });

    test("has reasonable poll interval", () => {
      expect(DEFAULT_TIMER_CONFIG.pollIntervalMs).toBeGreaterThan(0);
    });
  });
});
