/**
 * Tests for Cancellation module
 */

import { describe, test, expect } from "bun:test";
import {
  evaluateCancellation,
  evaluateAllBetsForCancellation,
  getBetsToCancel,
  formatCancellationDecision,
  DEFAULT_CANCELLATION_CONFIG,
  type CancellationConfig,
  type ActiveBetContext,
} from "../src/cancellation";
import type { Bet } from "../src/bet-lifecycle";

describe("Cancellation", () => {
  const defaultConfig: CancellationConfig = {
    minAgeBeforeCancel: 1,
    maxUnfilledAge: 3,
    priceChangeThreshold: 200,
    cancelBeforeDeadlineMinutes: 10,
    opportunityCostThreshold: 0.10,
  };

  const createMockBet = (overrides: Partial<Bet> = {}): Bet => ({
    betId: "test-bet-1",
    creatorAddress: "0x1234567890123456789012345678901234567890",
    betHash: "0xhash",
    portfolioSize: 5,
    amount: "100000000", // 100 USDC
    creatorStake: "100000000",
    requiredMatch: "100000000",
    matchedAmount: "0",
    oddsBps: 10000,
    status: "pending",
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min old
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  describe("evaluateCancellation", () => {
    test("does not cancel bet that is too new", () => {
      const bet = createMockBet({
        createdAt: new Date(Date.now() - 30 * 1000).toISOString(), // 30 sec old
      });

      const decision = evaluateCancellation(bet, defaultConfig);
      expect(decision.shouldCancel).toBe(false);
    });

    test("cancels unfilled bet that is too old", () => {
      const bet = createMockBet({
        createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min old
        matchedAmount: "0",
      });

      const decision = evaluateCancellation(bet, defaultConfig);
      expect(decision.shouldCancel).toBe(true);
      expect(decision.reason).toBe("too_old");
    });

    test("does not cancel fully matched bet", () => {
      const bet = createMockBet({
        status: "fully_matched",
      });

      const decision = evaluateCancellation(bet, defaultConfig);
      expect(decision.shouldCancel).toBe(false);
    });

    test("cancels bet approaching deadline", () => {
      const now = Date.now();
      const bet = createMockBet({
        createdAt: new Date(now - 2 * 60 * 1000).toISOString(), // 2 min old
        resolutionDeadline: Math.floor((now + 5 * 60 * 1000) / 1000), // 5 min from now
      });

      const decision = evaluateCancellation(bet, defaultConfig);
      expect(decision.shouldCancel).toBe(true);
      expect(decision.reason).toBe("approaching_deadline");
    });

    test("cancels when market moved significantly", () => {
      const bet = createMockBet({
        createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 min old
        matchedAmount: "50000000", // Partially matched
      });

      const context = {
        originalPrice: 0.50,
        currentPrice: 0.55, // 10% move (1000 bps)
      };

      const decision = evaluateCancellation(bet, defaultConfig, Date.now(), context);
      expect(decision.shouldCancel).toBe(true);
      expect(decision.reason).toBe("market_moved");
    });

    test("does not cancel when market move is small", () => {
      const bet = createMockBet({
        createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        matchedAmount: "50000000",
      });

      const context = {
        originalPrice: 0.50,
        currentPrice: 0.505, // 1% move (100 bps)
      };

      const decision = evaluateCancellation(bet, defaultConfig, Date.now(), context);
      expect(decision.shouldCancel).toBe(false);
    });

    test("prioritizes deadline approaching over too_old", () => {
      const now = Date.now();
      const bet = createMockBet({
        createdAt: new Date(now - 10 * 60 * 1000).toISOString(), // 10 min old
        resolutionDeadline: Math.floor((now + 5 * 60 * 1000) / 1000), // 5 min from now
      });

      const decision = evaluateCancellation(bet, defaultConfig);
      expect(decision.shouldCancel).toBe(true);
      expect(decision.reason).toBe("approaching_deadline");
      expect(decision.priority).toBe(100);
    });
  });

  describe("evaluateAllBetsForCancellation", () => {
    test("evaluates multiple bets", () => {
      const oldBet = createMockBet({
        betId: "old-bet",
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });

      const newBet = createMockBet({
        betId: "new-bet",
        createdAt: new Date(Date.now() - 30 * 1000).toISOString(),
      });

      const contexts: ActiveBetContext[] = [
        { bet: oldBet },
        { bet: newBet },
      ];

      const decisions = evaluateAllBetsForCancellation(contexts, defaultConfig);
      expect(decisions.size).toBe(2);
      expect(decisions.get("old-bet")?.shouldCancel).toBe(true);
      expect(decisions.get("new-bet")?.shouldCancel).toBe(false);
    });
  });

  describe("getBetsToCancel", () => {
    test("returns only bets that should be canceled", () => {
      const decisions = new Map([
        ["bet-1", { shouldCancel: true, reason: "too_old" as const, priority: 80 }],
        ["bet-2", { shouldCancel: false, priority: 0 }],
        ["bet-3", { shouldCancel: true, reason: "approaching_deadline" as const, priority: 100 }],
      ]);

      const toCancel = getBetsToCancel(decisions);
      expect(toCancel.length).toBe(2);
      expect(toCancel[0].betId).toBe("bet-3"); // Higher priority first
      expect(toCancel[1].betId).toBe("bet-1");
    });

    test("returns empty array when nothing to cancel", () => {
      const decisions = new Map([
        ["bet-1", { shouldCancel: false, priority: 0 }],
        ["bet-2", { shouldCancel: false, priority: 0 }],
      ]);

      const toCancel = getBetsToCancel(decisions);
      expect(toCancel.length).toBe(0);
    });
  });

  describe("formatCancellationDecision", () => {
    test("formats keep decision", () => {
      const decision = { shouldCancel: false, priority: 0 };
      const formatted = formatCancellationDecision("bet-1", decision);
      expect(formatted).toContain("Keep");
    });

    test("formats cancel decision with reason", () => {
      const decision = {
        shouldCancel: true,
        reason: "too_old" as const,
        priority: 80,
        explanation: "Unfilled for 5 minutes",
      };
      const formatted = formatCancellationDecision("bet-1", decision);
      expect(formatted).toContain("CANCEL");
      expect(formatted).toContain("too_old");
      expect(formatted).toContain("Unfilled for 5 minutes");
    });
  });

  describe("DEFAULT_CANCELLATION_CONFIG", () => {
    test("has all required fields", () => {
      expect(DEFAULT_CANCELLATION_CONFIG.minAgeBeforeCancel).toBeGreaterThan(0);
      expect(DEFAULT_CANCELLATION_CONFIG.maxUnfilledAge).toBeGreaterThan(0);
      expect(DEFAULT_CANCELLATION_CONFIG.priceChangeThreshold).toBeGreaterThan(0);
      expect(DEFAULT_CANCELLATION_CONFIG.cancelBeforeDeadlineMinutes).toBeGreaterThan(0);
      expect(DEFAULT_CANCELLATION_CONFIG.opportunityCostThreshold).toBeGreaterThan(0);
    });

    test("has fast defaults as specified", () => {
      expect(DEFAULT_CANCELLATION_CONFIG.maxUnfilledAge).toBe(3); // 3 minutes
      expect(DEFAULT_CANCELLATION_CONFIG.minAgeBeforeCancel).toBe(1); // 1 minute
      expect(DEFAULT_CANCELLATION_CONFIG.priceChangeThreshold).toBe(200); // 2%
    });
  });
});
