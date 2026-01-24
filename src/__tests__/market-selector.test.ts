/**
 * Tests for Market Selector
 *
 * Story 7.6: AI Trading Bot Launch Scripts
 * Task 1: Market Selection (AC: 1, 2)
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  filterMarkets,
  scoreMarket,
  selectBestMarkets,
  randomlySelectMarkets,
  type Market,
  type MarketScore,
} from "../market-selector";

// Mock market data
const createMockMarket = (overrides: Partial<Market> = {}): Market => ({
  marketId: "0x" + Math.random().toString(16).slice(2, 10),
  question: "Test market question?",
  priceYes: 0.55,
  priceNo: 0.45,
  volume: 5000,
  liquidity: 10000,
  isActive: true,
  endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 1 week from now
  category: "crypto",
  lastUpdated: new Date().toISOString(),
  ...overrides,
});

describe("Market Selector", () => {
  describe("filterMarkets", () => {
    test("filters out inactive markets", () => {
      const markets = [
        createMockMarket({ marketId: "active", isActive: true, volume: 2000 }),
        createMockMarket({ marketId: "inactive", isActive: false, volume: 5000 }),
      ];

      const filtered = filterMarkets(markets);

      expect(filtered.length).toBe(1);
      expect(filtered[0].marketId).toBe("active");
    });

    test("filters out markets with volume below threshold (AC2)", () => {
      const markets = [
        createMockMarket({ marketId: "high-volume", volume: 5000 }),
        createMockMarket({ marketId: "low-volume", volume: 500 }),
        createMockMarket({ marketId: "at-threshold", volume: 1000 }),
      ];

      const filtered = filterMarkets(markets, { minVolume: 1000 });

      expect(filtered.length).toBe(2);
      expect(filtered.map(m => m.marketId)).toContain("high-volume");
      expect(filtered.map(m => m.marketId)).toContain("at-threshold");
      expect(filtered.map(m => m.marketId)).not.toContain("low-volume");
    });

    test("filters out expired markets", () => {
      const markets = [
        createMockMarket({
          marketId: "future",
          endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          volume: 2000,
        }),
        createMockMarket({
          marketId: "past",
          endDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          volume: 2000,
        }),
      ];

      const filtered = filterMarkets(markets);

      expect(filtered.length).toBe(1);
      expect(filtered[0].marketId).toBe("future");
    });

    test("filters out markets without valid prices", () => {
      const markets = [
        createMockMarket({ marketId: "has-prices", priceYes: 0.6, priceNo: 0.4, volume: 2000 }),
        createMockMarket({ marketId: "no-yes-price", priceYes: null, priceNo: 0.4, volume: 2000 }),
        createMockMarket({ marketId: "no-no-price", priceYes: 0.6, priceNo: null, volume: 2000 }),
      ];

      const filtered = filterMarkets(markets);

      expect(filtered.length).toBe(1);
      expect(filtered[0].marketId).toBe("has-prices");
    });

    test("applies all filters together", () => {
      const markets = [
        createMockMarket({
          marketId: "perfect",
          isActive: true,
          volume: 10000,
          priceYes: 0.55,
          priceNo: 0.45,
          endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        }),
        createMockMarket({
          marketId: "inactive-high-vol",
          isActive: false,
          volume: 50000,
        }),
        createMockMarket({
          marketId: "active-low-vol",
          isActive: true,
          volume: 100,
        }),
      ];

      const filtered = filterMarkets(markets);

      expect(filtered.length).toBe(1);
      expect(filtered[0].marketId).toBe("perfect");
    });
  });

  describe("scoreMarket", () => {
    test("scores high volume markets higher", () => {
      const lowVolume = createMockMarket({ volume: 1000 });
      const highVolume = createMockMarket({ volume: 100000 });

      const lowScore = scoreMarket(lowVolume);
      const highScore = scoreMarket(highVolume);

      expect(highScore.score).toBeGreaterThan(lowScore.score);
      expect(highScore.reasons).toContain("Very high volume (100k+)");
    });

    test("scores uncertain markets (near 50/50) higher", () => {
      const uncertain = createMockMarket({ priceYes: 0.5, priceNo: 0.5 });
      const certain = createMockMarket({ priceYes: 0.9, priceNo: 0.1 });

      const uncertainScore = scoreMarket(uncertain);
      const certainScore = scoreMarket(certain);

      expect(uncertainScore.score).toBeGreaterThan(certainScore.score);
      expect(uncertainScore.reasons).toContain("High uncertainty (40-60%)");
    });

    test("scores markets with good liquidity higher", () => {
      const lowLiquidity = createMockMarket({ liquidity: 500 });
      const highLiquidity = createMockMarket({ liquidity: 50000 });

      const lowScore = scoreMarket(lowLiquidity);
      const highScore = scoreMarket(highLiquidity);

      expect(highScore.score).toBeGreaterThan(lowScore.score);
      expect(highScore.reasons).toContain("Excellent liquidity");
    });

    test("scores markets with longer expiry higher", () => {
      const shortExpiry = createMockMarket({
        endDate: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(), // 3 hours
      });
      const longExpiry = createMockMarket({
        endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(), // 2 weeks
      });

      const shortScore = scoreMarket(shortExpiry);
      const longScore = scoreMarket(longExpiry);

      expect(longScore.score).toBeGreaterThan(shortScore.score);
      expect(longScore.reasons).toContain("Long time to expiry");
    });

    test("returns market info in score object", () => {
      const market = createMockMarket({
        marketId: "0xtest123",
        question: "Will this test pass?",
        priceYes: 0.65,
        priceNo: 0.35,
      });

      const score = scoreMarket(market);

      expect(score.marketId).toBe("0xtest123");
      expect(score.question).toBe("Will this test pass?");
      expect(score.priceYes).toBe(0.65);
      expect(score.priceNo).toBe(0.35);
      expect(score.score).toBeGreaterThan(0);
      expect(score.reasons.length).toBeGreaterThan(0);
    });
  });

  describe("selectBestMarkets", () => {
    test("returns top N markets by score", () => {
      const markets = [
        createMockMarket({ marketId: "low", volume: 1000, liquidity: 500 }),
        createMockMarket({ marketId: "high", volume: 100000, liquidity: 50000 }),
        createMockMarket({ marketId: "medium", volume: 10000, liquidity: 10000 }),
      ];

      const selected = selectBestMarkets(markets, 2);

      expect(selected.length).toBe(2);
      // High volume/liquidity should be first
      expect(selected[0].marketId).toBe("high");
    });

    test("returns all markets if count exceeds available", () => {
      const markets = [
        createMockMarket({ marketId: "one" }),
        createMockMarket({ marketId: "two" }),
      ];

      const selected = selectBestMarkets(markets, 10);

      expect(selected.length).toBe(2);
    });

    test("returns empty array for empty input", () => {
      const selected = selectBestMarkets([], 5);
      expect(selected.length).toBe(0);
    });

    test("markets are sorted by score descending", () => {
      const markets = [
        createMockMarket({ volume: 1000, liquidity: 500 }),
        createMockMarket({ volume: 50000, liquidity: 20000 }),
        createMockMarket({ volume: 10000, liquidity: 5000 }),
        createMockMarket({ volume: 100000, liquidity: 50000 }),
      ];

      const selected = selectBestMarkets(markets, 4);

      for (let i = 1; i < selected.length; i++) {
        expect(selected[i - 1].score).toBeGreaterThanOrEqual(selected[i].score);
      }
    });
  });

  describe("randomlySelectMarkets", () => {
    test("returns requested count of markets", () => {
      const scored: MarketScore[] = [
        { marketId: "a", question: "A?", priceYes: 0.5, priceNo: 0.5, score: 50, reasons: [] },
        { marketId: "b", question: "B?", priceYes: 0.5, priceNo: 0.5, score: 40, reasons: [] },
        { marketId: "c", question: "C?", priceYes: 0.5, priceNo: 0.5, score: 30, reasons: [] },
        { marketId: "d", question: "D?", priceYes: 0.5, priceNo: 0.5, score: 20, reasons: [] },
        { marketId: "e", question: "E?", priceYes: 0.5, priceNo: 0.5, score: 10, reasons: [] },
      ];

      const selected = randomlySelectMarkets(scored, 3);

      expect(selected.length).toBe(3);
    });

    test("returns all markets if count exceeds available", () => {
      const scored: MarketScore[] = [
        { marketId: "a", question: "A?", priceYes: 0.5, priceNo: 0.5, score: 50, reasons: [] },
        { marketId: "b", question: "B?", priceYes: 0.5, priceNo: 0.5, score: 40, reasons: [] },
      ];

      const selected = randomlySelectMarkets(scored, 5);

      expect(selected.length).toBe(2);
    });

    test("does not duplicate markets", () => {
      const scored: MarketScore[] = [
        { marketId: "a", question: "A?", priceYes: 0.5, priceNo: 0.5, score: 50, reasons: [] },
        { marketId: "b", question: "B?", priceYes: 0.5, priceNo: 0.5, score: 40, reasons: [] },
        { marketId: "c", question: "C?", priceYes: 0.5, priceNo: 0.5, score: 30, reasons: [] },
      ];

      const selected = randomlySelectMarkets(scored, 3);

      const ids = selected.map(m => m.marketId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    test("weighted selection favors higher scored markets", () => {
      // Run multiple times to verify weighted selection
      const scored: MarketScore[] = [
        { marketId: "high", question: "H?", priceYes: 0.5, priceNo: 0.5, score: 100, reasons: [] },
        { marketId: "low", question: "L?", priceYes: 0.5, priceNo: 0.5, score: 1, reasons: [] },
      ];

      let highCount = 0;
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        const selected = randomlySelectMarkets(scored, 1);
        if (selected[0].marketId === "high") {
          highCount++;
        }
      }

      // High score market should be selected more often than low score
      // With scores 100:1, high should be selected ~99% of the time
      expect(highCount).toBeGreaterThan(50);
    });
  });

  describe("Configuration", () => {
    test("respects custom minVolume config", () => {
      const markets = [
        createMockMarket({ marketId: "passes", volume: 5000 }),
        createMockMarket({ marketId: "fails", volume: 4000 }),
      ];

      const filtered = filterMarkets(markets, { minVolume: 4500 });

      expect(filtered.length).toBe(1);
      expect(filtered[0].marketId).toBe("passes");
    });
  });
});
