/**
 * Tests for Bet Lifecycle Management
 *
 * Story 7.6: AI Trading Bot Launch Scripts
 * Task 3: Bet Lifecycle Management (AC: 3, 4)
 */

import { describe, test, expect } from "bun:test";
import {
  calculateRemainingAmount,
  canMatchBet,
  calculateFillAmount,
  formatUSDC,
  parseUSDC,
  createInitialBotState,
  getAvailableCapital,
  canPlaceNewBet,
  updateStateAfterPlace,
  updateStateAfterMatch,
  updateStateAfterComplete,
  preparePortfolioForChain,
  validatePortfolio,
  generateBetReference,
  type Bet,
  type BotState,
} from "../bet-lifecycle";
import type { Portfolio } from "../trading-strategy";

// Mock bet data
const createMockBet = (overrides: Partial<Bet> = {}): Bet => ({
  betId: "1",
  creator: "0x1234567890abcdef1234567890abcdef12345678",
  betHash: "0xabcdef",
  portfolioSize: 5,
  amount: "10000000", // 10 USDC
  matchedAmount: "0",
  status: "pending",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

// Mock portfolio
const createMockPortfolio = (overrides: Partial<Portfolio> = {}): Portfolio => ({
  positions: [
    { marketId: "0xmarket1", position: "YES", weight: 0.5 },
    { marketId: "0xmarket2", position: "NO", weight: 0.5 },
  ],
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe("Bet Lifecycle", () => {
  describe("calculateRemainingAmount", () => {
    test("returns full amount when nothing matched", () => {
      const bet = createMockBet({
        amount: "10000000",
        matchedAmount: "0",
      });

      const remaining = calculateRemainingAmount(bet);

      expect(remaining.toString()).toBe("10000000");
    });

    test("returns remaining when partially matched", () => {
      const bet = createMockBet({
        amount: "10000000",
        matchedAmount: "3000000",
      });

      const remaining = calculateRemainingAmount(bet);

      expect(remaining.toString()).toBe("7000000");
    });

    test("returns zero when fully matched", () => {
      const bet = createMockBet({
        amount: "10000000",
        matchedAmount: "10000000",
      });

      const remaining = calculateRemainingAmount(bet);

      expect(remaining.toString()).toBe("0");
    });

    test("handles large amounts correctly", () => {
      const bet = createMockBet({
        amount: "1000000000000", // 1M USDC
        matchedAmount: "500000000000", // 500K USDC
      });

      const remaining = calculateRemainingAmount(bet);

      expect(remaining.toString()).toBe("500000000000");
    });
  });

  describe("canMatchBet", () => {
    test("returns true for pending bet with remaining amount", () => {
      const bet = createMockBet({
        status: "pending",
        amount: "10000000",
        matchedAmount: "0",
      });

      expect(canMatchBet(bet)).toBe(true);
    });

    test("returns true for partially matched bet", () => {
      const bet = createMockBet({
        status: "partially_matched",
        amount: "10000000",
        matchedAmount: "5000000",
      });

      expect(canMatchBet(bet)).toBe(true);
    });

    test("returns false for fully matched bet", () => {
      const bet = createMockBet({
        status: "fully_matched",
        amount: "10000000",
        matchedAmount: "10000000",
      });

      expect(canMatchBet(bet)).toBe(false);
    });

    test("returns false for cancelled bet", () => {
      const bet = createMockBet({ status: "cancelled" });
      expect(canMatchBet(bet)).toBe(false);
    });

    test("returns false for settled bet", () => {
      const bet = createMockBet({ status: "settled" });
      expect(canMatchBet(bet)).toBe(false);
    });
  });

  describe("calculateFillAmount", () => {
    test("calculates correct fill for standard case", () => {
      const capital = 100; // $100
      const riskPercent = 0.05; // 5%
      const remainingAmount = "10000000"; // $10

      const fill = calculateFillAmount(capital, riskPercent, remainingAmount);

      // 5% of $100 = $5 = 5000000 base units
      expect(fill).toBe("5000000");
    });

    test("limits fill to remaining amount", () => {
      const capital = 100;
      const riskPercent = 0.2; // 20% = $20
      const remainingAmount = "5000000"; // $5 remaining

      const fill = calculateFillAmount(capital, riskPercent, remainingAmount);

      // Should be capped at $5
      expect(fill).toBe("5000000");
    });

    test("handles small percentages", () => {
      const capital = 1000;
      const riskPercent = 0.01; // 1% = $10
      const remainingAmount = "100000000"; // $100

      const fill = calculateFillAmount(capital, riskPercent, remainingAmount);

      // 1% of $1000 = $10 = 10000000 base units
      expect(fill).toBe("10000000");
    });

    test("floors to whole base units", () => {
      const capital = 1.5; // $1.50
      const riskPercent = 1; // 100%
      const remainingAmount = "10000000";

      const fill = calculateFillAmount(capital, riskPercent, remainingAmount);

      // Should floor to 1500000 (not 1500000.x)
      expect(fill).toBe("1500000");
    });
  });

  describe("USDC formatting", () => {
    test("formatUSDC handles standard amounts", () => {
      expect(formatUSDC("1000000")).toBe("1.000000");
      expect(formatUSDC("10000000")).toBe("10.000000");
      expect(formatUSDC("1500000")).toBe("1.500000");
    });

    test("formatUSDC handles small amounts", () => {
      expect(formatUSDC("1")).toBe("0.000001");
      expect(formatUSDC("10000")).toBe("0.010000");
      expect(formatUSDC("100000")).toBe("0.100000");
    });

    test("formatUSDC handles large amounts", () => {
      expect(formatUSDC("1000000000000")).toBe("1000000.000000");
    });

    test("parseUSDC handles standard amounts", () => {
      expect(parseUSDC("1")).toBe("1000000");
      expect(parseUSDC("10.5")).toBe("10500000");
      expect(parseUSDC("0.01")).toBe("10000");
    });

    test("parseUSDC handles edge cases", () => {
      expect(parseUSDC("0")).toBe("0");
      expect(parseUSDC("0.000001")).toBe("1");
      expect(parseUSDC("1.1234567")).toBe("1123456"); // Truncates at 6 decimals
    });

    test("parseUSDC and formatUSDC are inverse operations", () => {
      const original = "12345678";
      const formatted = formatUSDC(original);
      const parsed = parseUSDC(formatted);
      expect(parsed).toBe(original);
    });
  });

  describe("Bot state management", () => {
    describe("createInitialBotState", () => {
      test("creates state with correct address and capital", () => {
        const state = createInitialBotState("0x1234", 1000);

        expect(state.address).toBe("0x1234");
        expect(state.capital).toBe(1000);
        expect(state.allocatedCapital).toBe(0);
        expect(state.activeBetIds).toEqual([]);
        expect(state.matchedBetIds).toEqual([]);
      });

      test("sets timestamps", () => {
        const before = new Date().toISOString();
        const state = createInitialBotState("0x1234", 1000);
        const after = new Date().toISOString();

        expect(state.sessionStart >= before).toBe(true);
        expect(state.sessionStart <= after).toBe(true);
        expect(state.lastActivity >= before).toBe(true);
      });
    });

    describe("getAvailableCapital", () => {
      test("returns full capital when nothing allocated", () => {
        const state = createInitialBotState("0x1234", 1000);
        expect(getAvailableCapital(state)).toBe(1000);
      });

      test("subtracts allocated capital", () => {
        const state: BotState = {
          ...createInitialBotState("0x1234", 1000),
          allocatedCapital: 300,
        };
        expect(getAvailableCapital(state)).toBe(700);
      });
    });

    describe("canPlaceNewBet", () => {
      test("returns true when under limits", () => {
        const state = createInitialBotState("0x1234", 1000);
        const config = { maxPendingBets: 3, minBetAmount: 1 };

        expect(canPlaceNewBet(state, config)).toBe(true);
      });

      test("returns false when max pending reached", () => {
        const state: BotState = {
          ...createInitialBotState("0x1234", 1000),
          activeBetIds: ["1", "2", "3"],
        };
        const config = { maxPendingBets: 3, minBetAmount: 1 };

        expect(canPlaceNewBet(state, config)).toBe(false);
      });

      test("returns false when insufficient capital", () => {
        const state: BotState = {
          ...createInitialBotState("0x1234", 10),
          allocatedCapital: 9.5,
        };
        const config = { maxPendingBets: 3, minBetAmount: 1 };

        expect(canPlaceNewBet(state, config)).toBe(false);
      });
    });

    describe("updateStateAfterPlace", () => {
      test("adds bet to active list", () => {
        const state = createInitialBotState("0x1234", 1000);
        const updated = updateStateAfterPlace(state, "bet-1", "10000000");

        expect(updated.activeBetIds).toContain("bet-1");
      });

      test("increases allocated capital", () => {
        const state = createInitialBotState("0x1234", 1000);
        const updated = updateStateAfterPlace(state, "bet-1", "10000000"); // $10

        expect(updated.allocatedCapital).toBe(10);
      });

      test("updates last activity", () => {
        const state = createInitialBotState("0x1234", 1000);
        const before = new Date().toISOString();
        const updated = updateStateAfterPlace(state, "bet-1", "10000000");

        expect(updated.lastActivity >= before).toBe(true);
      });
    });

    describe("updateStateAfterMatch", () => {
      test("adds bet to matched list", () => {
        const state = createInitialBotState("0x1234", 1000);
        const updated = updateStateAfterMatch(state, "bet-1", "5000000");

        expect(updated.matchedBetIds).toContain("bet-1");
      });

      test("increases allocated capital", () => {
        const state = createInitialBotState("0x1234", 1000);
        const updated = updateStateAfterMatch(state, "bet-1", "5000000"); // $5

        expect(updated.allocatedCapital).toBe(5);
      });
    });

    describe("updateStateAfterComplete", () => {
      test("removes bet from active list", () => {
        const state: BotState = {
          ...createInitialBotState("0x1234", 1000),
          activeBetIds: ["bet-1", "bet-2"],
          allocatedCapital: 20,
        };

        const updated = updateStateAfterComplete(state, "bet-1");

        expect(updated.activeBetIds).not.toContain("bet-1");
        expect(updated.activeBetIds).toContain("bet-2");
      });

      test("decreases allocated capital by refund", () => {
        const state: BotState = {
          ...createInitialBotState("0x1234", 1000),
          allocatedCapital: 20,
        };

        const updated = updateStateAfterComplete(state, "bet-1", "5000000"); // $5 refund

        expect(updated.allocatedCapital).toBe(15);
      });

      test("handles no refund", () => {
        const state: BotState = {
          ...createInitialBotState("0x1234", 1000),
          allocatedCapital: 20,
        };

        const updated = updateStateAfterComplete(state, "bet-1");

        expect(updated.allocatedCapital).toBe(20);
      });

      test("does not go negative", () => {
        const state: BotState = {
          ...createInitialBotState("0x1234", 1000),
          allocatedCapital: 5,
        };

        const updated = updateStateAfterComplete(state, "bet-1", "10000000"); // $10 refund

        expect(updated.allocatedCapital).toBe(0);
      });
    });
  });

  describe("Portfolio preparation", () => {
    describe("preparePortfolioForChain", () => {
      test("returns hash and JSON string", () => {
        const portfolio = createMockPortfolio();
        const { betHash, portfolioJson } = preparePortfolioForChain(portfolio);

        expect(betHash).toMatch(/^0x[a-f0-9]+$/);
        expect(portfolioJson).toContain("positions");
        expect(JSON.parse(portfolioJson)).toBeDefined();
      });

      test("same portfolio produces same hash", () => {
        const portfolio: Portfolio = {
          positions: [{ marketId: "m1", position: "YES", weight: 1 }],
          createdAt: "2026-01-01T00:00:00Z",
        };

        const result1 = preparePortfolioForChain(portfolio);
        const result2 = preparePortfolioForChain(portfolio);

        expect(result1.betHash).toBe(result2.betHash);
      });
    });

    describe("validatePortfolio", () => {
      test("valid portfolio passes", () => {
        const portfolio = createMockPortfolio();
        const result = validatePortfolio(portfolio);

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      });

      test("empty positions fails", () => {
        const portfolio: Portfolio = {
          positions: [],
          createdAt: new Date().toISOString(),
        };

        const result = validatePortfolio(portfolio);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain("Portfolio must have at least one position");
      });

      test("weights not summing to 1 fails", () => {
        const portfolio: Portfolio = {
          positions: [
            { marketId: "m1", position: "YES", weight: 0.3 },
            { marketId: "m2", position: "NO", weight: 0.3 },
          ],
          createdAt: new Date().toISOString(),
        };

        const result = validatePortfolio(portfolio);

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes("sum to 1"))).toBe(true);
      });

      test("missing marketId fails", () => {
        const portfolio: Portfolio = {
          positions: [
            { marketId: "", position: "YES", weight: 1 },
          ],
          createdAt: new Date().toISOString(),
        };

        const result = validatePortfolio(portfolio);

        expect(result.valid).toBe(false);
        expect(result.errors).toContain("Position missing marketId");
      });

      test("invalid position value fails", () => {
        const portfolio = {
          positions: [
            { marketId: "m1", position: "MAYBE" as "YES" | "NO", weight: 1 },
          ],
          createdAt: new Date().toISOString(),
        };

        const result = validatePortfolio(portfolio);

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes("Invalid position"))).toBe(true);
      });

      test("invalid weight fails", () => {
        const portfolio: Portfolio = {
          positions: [
            { marketId: "m1", position: "YES", weight: 0 },
          ],
          createdAt: new Date().toISOString(),
        };

        const result = validatePortfolio(portfolio);

        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes("Invalid weight"))).toBe(true);
      });
    });
  });

  describe("generateBetReference", () => {
    test("includes bot address prefix", () => {
      const ref = generateBetReference("0x1234567890abcdef");
      expect(ref).toContain("bot-123456");
    });

    test("generates unique references", () => {
      const refs = new Set<string>();
      for (let i = 0; i < 100; i++) {
        refs.add(generateBetReference("0x1234567890abcdef"));
      }
      expect(refs.size).toBe(100);
    });

    test("includes timestamp component", () => {
      const before = Date.now();
      const ref = generateBetReference("0x1234567890abcdef");
      const after = Date.now();

      // Extract timestamp from reference
      const parts = ref.split("-");
      const timestamp = parseInt(parts[2], 10);

      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });
});
