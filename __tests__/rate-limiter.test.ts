/**
 * Tests for Rate Limiter module
 */

import { describe, test, expect } from "bun:test";
import {
  checkRateLimits,
  recordFill,
  pruneFillHistory,
  formatRateLimitStatus,
  DEFAULT_RATE_LIMITS,
  type FillRecord,
  type RateLimits,
} from "../src/rate-limiter";

describe("Rate Limiter", () => {
  const defaultLimits: RateLimits = {
    maxBetsPerHour: 5,
    maxBetsPerDay: 20,
    maxBetsPerWeek: 100,
    maxBetsPerMonth: 300,
    maxUsdcPerDay: 500,
  };

  const ONE_HOUR_MS = 60 * 60 * 1000;
  const ONE_DAY_MS = 24 * ONE_HOUR_MS;

  describe("checkRateLimits", () => {
    test("allows bet when no history", () => {
      const result = checkRateLimits([], defaultLimits, 10);
      expect(result.allowed).toBe(true);
    });

    test("rejects when hourly limit reached", () => {
      const now = Date.now();
      const history: FillRecord[] = Array(5).fill(null).map((_, i) => ({
        timestamp: now - i * 1000,
        amount: 10,
        betId: `bet-${i}`,
      }));

      const result = checkRateLimits(history, defaultLimits, 10, now);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Hourly limit");
    });

    test("rejects when daily limit reached", () => {
      const now = Date.now();
      // Use custom limits with higher hourly to test daily limit
      const customLimits: RateLimits = {
        ...defaultLimits,
        maxBetsPerHour: 100, // High hourly limit so daily hits first
      };

      // All 20 bets within the last day, spread across hours
      const history: FillRecord[] = Array(20).fill(null).map((_, i) => ({
        timestamp: now - (i * 30 * 60 * 1000), // Every 30 minutes over ~10 hours
        amount: 10,
        betId: `bet-${i}`,
      }));

      const result = checkRateLimits(history, customLimits, 10, now);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Daily limit");
    });

    test("rejects when USDC daily limit would be exceeded", () => {
      const now = Date.now();
      const history: FillRecord[] = [
        { timestamp: now - 1000, amount: 490, betId: "bet-1" },
      ];

      const result = checkRateLimits(history, defaultLimits, 20, now);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Daily USDC limit");
    });

    test("allows when under all limits", () => {
      const now = Date.now();
      const history: FillRecord[] = [
        { timestamp: now - 1000, amount: 10, betId: "bet-1" },
        { timestamp: now - 2000, amount: 10, betId: "bet-2" },
      ];

      const result = checkRateLimits(history, defaultLimits, 10, now);
      expect(result.allowed).toBe(true);
    });

    test("returns current counts", () => {
      const now = Date.now();
      const history: FillRecord[] = [
        { timestamp: now - 1000, amount: 10, betId: "bet-1" },
        { timestamp: now - ONE_HOUR_MS - 1000, amount: 10, betId: "bet-2" },
      ];

      const result = checkRateLimits(history, defaultLimits, 10, now);
      expect(result.currentCounts?.hour).toBe(1);
      expect(result.currentCounts?.day).toBe(2);
    });

    test("old fills don't count against limits", () => {
      const now = Date.now();
      const history: FillRecord[] = Array(10).fill(null).map((_, i) => ({
        timestamp: now - ONE_DAY_MS - 1000 - i * 1000, // All > 1 day old
        amount: 50,
        betId: `bet-${i}`,
      }));

      const result = checkRateLimits(history, defaultLimits, 10, now);
      expect(result.allowed).toBe(true);
    });
  });

  describe("recordFill", () => {
    test("adds new fill to history", () => {
      const history: FillRecord[] = [];
      const updated = recordFill(history, "bet-1", 10);
      expect(updated.length).toBe(1);
      expect(updated[0].betId).toBe("bet-1");
      expect(updated[0].amount).toBe(10);
    });

    test("preserves existing history", () => {
      const history: FillRecord[] = [
        { timestamp: Date.now(), amount: 5, betId: "bet-0" },
      ];
      const updated = recordFill(history, "bet-1", 10);
      expect(updated.length).toBe(2);
    });

    test("uses provided timestamp", () => {
      const customTime = 1234567890000;
      const updated = recordFill([], "bet-1", 10, customTime);
      expect(updated[0].timestamp).toBe(customTime);
    });
  });

  describe("pruneFillHistory", () => {
    test("removes old records", () => {
      const now = Date.now();
      const history: FillRecord[] = [
        { timestamp: now - 32 * ONE_DAY_MS, amount: 10, betId: "old" },
        { timestamp: now - 1000, amount: 10, betId: "new" },
      ];

      const pruned = pruneFillHistory(history, 31 * ONE_DAY_MS, now);
      expect(pruned.length).toBe(1);
      expect(pruned[0].betId).toBe("new");
    });

    test("keeps all recent records", () => {
      const now = Date.now();
      const history: FillRecord[] = Array(10).fill(null).map((_, i) => ({
        timestamp: now - i * ONE_DAY_MS,
        amount: 10,
        betId: `bet-${i}`,
      }));

      const pruned = pruneFillHistory(history, 31 * ONE_DAY_MS, now);
      expect(pruned.length).toBe(10);
    });

    test("returns empty array for all old records", () => {
      const now = Date.now();
      const history: FillRecord[] = [
        { timestamp: now - 40 * ONE_DAY_MS, amount: 10, betId: "old1" },
        { timestamp: now - 50 * ONE_DAY_MS, amount: 10, betId: "old2" },
      ];

      const pruned = pruneFillHistory(history, 31 * ONE_DAY_MS, now);
      expect(pruned.length).toBe(0);
    });
  });

  describe("formatRateLimitStatus", () => {
    test("formats allowed result", () => {
      const result = { allowed: true, currentCounts: { hour: 1, day: 2, week: 3, month: 4, usdcToday: 50 } };
      const formatted = formatRateLimitStatus(result);
      expect(formatted).toContain("1/hr");
      expect(formatted).toContain("$50.00");
    });

    test("formats rejected result", () => {
      const result = { allowed: false, reason: "Hourly limit reached" };
      const formatted = formatRateLimitStatus(result);
      expect(formatted).toContain("Rate limited");
    });
  });

  describe("DEFAULT_RATE_LIMITS", () => {
    test("has all required fields", () => {
      expect(DEFAULT_RATE_LIMITS.maxBetsPerHour).toBeGreaterThan(0);
      expect(DEFAULT_RATE_LIMITS.maxBetsPerDay).toBeGreaterThan(0);
      expect(DEFAULT_RATE_LIMITS.maxBetsPerWeek).toBeGreaterThan(0);
      expect(DEFAULT_RATE_LIMITS.maxBetsPerMonth).toBeGreaterThan(0);
      expect(DEFAULT_RATE_LIMITS.maxUsdcPerDay).toBeGreaterThan(0);
    });
  });
});
