/**
 * Tests for AI Trading Strategy and Price Negotiation
 *
 * Story 7.6: AI Trading Bot Launch Scripts
 * Task 2: AI Price Negotiation Engine (AC: 3, 4)
 */

import { describe, test, expect } from "bun:test";
import {
  calculateFairPrice,
  calculateImpliedRate,
  evaluateOffer,
  generateCounterRate,
  createRandomPortfolio,
  createCounterPortfolio,
  calculatePortfolioScore,
  calculatePortfolioHash,
  serializePortfolio,
  parsePortfolio,
  DEFAULT_NEGOTIATION_CONFIG,
  type Portfolio,
  type PendingBet,
  type MarketScore,
  type NegotiationConfig,
} from "../trading-strategy";

// Mock market score
const createMockMarketScore = (overrides: Partial<MarketScore> = {}): MarketScore => ({
  marketId: "0x" + Math.random().toString(16).slice(2, 10),
  question: "Test market?",
  priceYes: 0.55,
  priceNo: 0.45,
  score: 60,
  reasons: ["Test market"],
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

// Mock pending bet
const createMockPendingBet = (overrides: Partial<PendingBet> = {}): PendingBet => ({
  betId: "1",
  creator: "0x1234567890abcdef1234567890abcdef12345678",
  portfolio: createMockPortfolio(),
  amount: "1000000", // 1 USDC
  remainingAmount: "1000000",
  impliedRate: 0.55,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe("AI Trading Strategy", () => {
  describe("calculateFairPrice", () => {
    test("returns fair price based on market current price", () => {
      const market = createMockMarketScore({ priceYes: 0.65 });
      const result = calculateFairPrice(market);

      expect(result.fairYesPrice).toBe(0.65);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(0.95);
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    test("higher scored markets have higher confidence", () => {
      const lowScoreMarket = createMockMarketScore({ score: 30 });
      const highScoreMarket = createMockMarketScore({ score: 80 });

      const lowResult = calculateFairPrice(lowScoreMarket);
      const highResult = calculateFairPrice(highScoreMarket);

      expect(highResult.confidence).toBeGreaterThan(lowResult.confidence);
    });

    test("markets near 50% have lower confidence", () => {
      const uncertainMarket = createMockMarketScore({ priceYes: 0.5, score: 60 });
      const certainMarket = createMockMarketScore({ priceYes: 0.85, score: 60 });

      const uncertainResult = calculateFairPrice(uncertainMarket);
      const certainResult = calculateFairPrice(certainMarket);

      expect(certainResult.confidence).toBeGreaterThan(uncertainResult.confidence);
    });

    test("confidence is capped at 0.95", () => {
      const perfectMarket = createMockMarketScore({ score: 100, priceYes: 0.9 });
      const result = calculateFairPrice(perfectMarket);

      expect(result.confidence).toBeLessThanOrEqual(0.95);
    });
  });

  describe("calculateImpliedRate", () => {
    test("calculates weighted average of YES positions", () => {
      const portfolio: Portfolio = {
        positions: [
          { marketId: "m1", position: "YES", weight: 0.5 },
          { marketId: "m2", position: "YES", weight: 0.5 },
        ],
        createdAt: new Date().toISOString(),
      };

      const prices = new Map([
        ["m1", { priceYes: 0.6, priceNo: 0.4 }],
        ["m2", { priceYes: 0.8, priceNo: 0.2 }],
      ]);

      const rate = calculateImpliedRate(portfolio, prices);

      // (0.6 * 0.5 + 0.8 * 0.5) / 1.0 = 0.7
      expect(rate).toBe(0.7);
    });

    test("handles NO positions correctly", () => {
      const portfolio: Portfolio = {
        positions: [
          { marketId: "m1", position: "NO", weight: 1.0 },
        ],
        createdAt: new Date().toISOString(),
      };

      const prices = new Map([
        ["m1", { priceYes: 0.7, priceNo: 0.3 }],
      ]);

      const rate = calculateImpliedRate(portfolio, prices);

      // NO position uses priceNo: 0.3
      expect(rate).toBe(0.3);
    });

    test("handles mixed YES/NO positions", () => {
      const portfolio: Portfolio = {
        positions: [
          { marketId: "m1", position: "YES", weight: 0.5 },
          { marketId: "m2", position: "NO", weight: 0.5 },
        ],
        createdAt: new Date().toISOString(),
      };

      const prices = new Map([
        ["m1", { priceYes: 0.6, priceNo: 0.4 }],
        ["m2", { priceYes: 0.8, priceNo: 0.2 }],
      ]);

      const rate = calculateImpliedRate(portfolio, prices);

      // (0.6 * 0.5 + 0.2 * 0.5) / 1.0 = 0.4
      expect(rate).toBe(0.4);
    });

    test("returns 0.5 when no prices available", () => {
      const portfolio: Portfolio = {
        positions: [
          { marketId: "unknown", position: "YES", weight: 1.0 },
        ],
        createdAt: new Date().toISOString(),
      };

      const prices = new Map<string, { priceYes: number; priceNo: number }>();
      const rate = calculateImpliedRate(portfolio, prices);

      expect(rate).toBe(0.5);
    });
  });

  describe("evaluateOffer", () => {
    const config: NegotiationConfig = {
      acceptThresholdBps: 50, // 0.5%
      counterThresholdBps: 200, // 2%
      rejectThresholdBps: 500, // 5%
      negotiationTimeoutSecs: 60,
      maxCounterAttempts: 3,
      pollIntervalMs: 5000,
    };

    test("ACCEPT when price is within accept threshold (AC3)", () => {
      const bet = createMockPendingBet({ impliedRate: 0.551 });
      const fairPrice = 0.55;

      const result = evaluateOffer(bet, fairPrice, config);

      expect(result.action).toBe("ACCEPT");
      expect(result.priceDiffBps).toBeLessThanOrEqual(config.acceptThresholdBps);
      expect(result.reason).toContain("within");
    });

    test("COUNTER when price is within counter threshold (AC4)", () => {
      const bet = createMockPendingBet({ impliedRate: 0.56 });
      const fairPrice = 0.55;

      const result = evaluateOffer(bet, fairPrice, config);

      expect(result.action).toBe("COUNTER");
      expect(result.priceDiffBps).toBeGreaterThan(config.acceptThresholdBps);
      expect(result.priceDiffBps).toBeLessThanOrEqual(config.counterThresholdBps);
    });

    test("SWITCH when acceptable rate and has active offer (AC4)", () => {
      const bet = createMockPendingBet({ impliedRate: 0.58 });
      const fairPrice = 0.55;
      const hasActiveOffer = true;

      const result = evaluateOffer(bet, fairPrice, config, hasActiveOffer);

      expect(result.action).toBe("SWITCH");
      expect(result.priceDiffBps).toBeGreaterThan(config.counterThresholdBps);
      expect(result.priceDiffBps).toBeLessThanOrEqual(config.rejectThresholdBps);
    });

    test("IGNORE when price is beyond reject threshold (AC4)", () => {
      const bet = createMockPendingBet({ impliedRate: 0.70 });
      const fairPrice = 0.55;

      const result = evaluateOffer(bet, fairPrice, config);

      expect(result.action).toBe("IGNORE");
      expect(result.priceDiffBps).toBeGreaterThan(config.rejectThresholdBps);
    });

    test("uses default config when not provided", () => {
      const bet = createMockPendingBet({ impliedRate: 0.551 });
      const fairPrice = 0.55;

      const result = evaluateOffer(bet, fairPrice);

      expect(result.action).toBeDefined();
      expect(result.priceDiffBps).toBeDefined();
    });
  });

  describe("generateCounterRate", () => {
    test("first attempt moves 75% toward fair price", () => {
      const currentRate = 0.60;
      const fairPrice = 0.50;
      const counterRate = generateCounterRate(currentRate, fairPrice, 1, 3);

      // 0.60 + (0.50 - 0.60) * 0.75 = 0.60 - 0.075 = 0.525
      expect(counterRate).toBeCloseTo(0.525, 3);
    });

    test("later attempts are more willing to compromise", () => {
      const currentRate = 0.60;
      const fairPrice = 0.50;

      const attempt1 = generateCounterRate(currentRate, fairPrice, 1, 3);
      const attempt3 = generateCounterRate(currentRate, fairPrice, 3, 3);

      // Later attempts should be closer to current rate (less movement toward fair)
      expect(Math.abs(attempt3 - currentRate)).toBeLessThan(Math.abs(attempt1 - currentRate));
    });

    test("counter rate stays within valid bounds", () => {
      // Test extreme cases
      const lowRate = generateCounterRate(0.001, 0, 1, 3);
      const highRate = generateCounterRate(0.999, 1, 1, 3);

      expect(lowRate).toBeGreaterThanOrEqual(0.01);
      expect(highRate).toBeLessThanOrEqual(0.99);
    });

    test("handles single attempt correctly", () => {
      const currentRate = 0.60;
      const fairPrice = 0.50;
      const counterRate = generateCounterRate(currentRate, fairPrice, 1, 1);

      // Should use full compromise factor
      expect(counterRate).toBeCloseTo(0.525, 3);
    });
  });

  describe("createRandomPortfolio", () => {
    test("creates portfolio with requested position count", () => {
      const markets = [
        createMockMarketScore({ marketId: "m1" }),
        createMockMarketScore({ marketId: "m2" }),
        createMockMarketScore({ marketId: "m3" }),
        createMockMarketScore({ marketId: "m4" }),
        createMockMarketScore({ marketId: "m5" }),
      ];

      const portfolio = createRandomPortfolio(markets, 3);

      expect(portfolio.positions.length).toBe(3);
    });

    test("limits positions to available markets", () => {
      const markets = [
        createMockMarketScore({ marketId: "m1" }),
        createMockMarketScore({ marketId: "m2" }),
      ];

      const portfolio = createRandomPortfolio(markets, 5);

      expect(portfolio.positions.length).toBe(2);
    });

    test("assigns equal weights to positions", () => {
      const markets = [
        createMockMarketScore({ marketId: "m1" }),
        createMockMarketScore({ marketId: "m2" }),
        createMockMarketScore({ marketId: "m3" }),
        createMockMarketScore({ marketId: "m4" }),
      ];

      const portfolio = createRandomPortfolio(markets, 4);

      for (const position of portfolio.positions) {
        expect(position.weight).toBe(0.25);
      }
    });

    test("includes createdAt timestamp", () => {
      const markets = [createMockMarketScore()];
      const portfolio = createRandomPortfolio(markets, 1);

      expect(portfolio.createdAt).toBeDefined();
      expect(new Date(portfolio.createdAt).getTime()).toBeLessThanOrEqual(Date.now());
    });

    test("assigns YES or NO positions randomly", () => {
      const markets = Array(20).fill(null).map((_, i) =>
        createMockMarketScore({ marketId: `m${i}` })
      );

      const portfolio = createRandomPortfolio(markets, 20);

      const yesCount = portfolio.positions.filter(p => p.position === "YES").length;
      const noCount = portfolio.positions.filter(p => p.position === "NO").length;

      // With 20 positions, we should see some of each
      expect(yesCount).toBeGreaterThan(0);
      expect(noCount).toBeGreaterThan(0);
    });
  });

  describe("createCounterPortfolio", () => {
    test("creates opposite positions", () => {
      const original: Portfolio = {
        positions: [
          { marketId: "m1", position: "YES", weight: 0.5 },
          { marketId: "m2", position: "NO", weight: 0.5 },
        ],
        createdAt: "2026-01-01T00:00:00Z",
      };

      const counter = createCounterPortfolio(original);

      expect(counter.positions[0].position).toBe("NO");
      expect(counter.positions[1].position).toBe("YES");
    });

    test("preserves market IDs and weights", () => {
      const original: Portfolio = {
        positions: [
          { marketId: "m1", position: "YES", weight: 0.3 },
          { marketId: "m2", position: "NO", weight: 0.7 },
        ],
        createdAt: "2026-01-01T00:00:00Z",
      };

      const counter = createCounterPortfolio(original);

      expect(counter.positions[0].marketId).toBe("m1");
      expect(counter.positions[0].weight).toBe(0.3);
      expect(counter.positions[1].marketId).toBe("m2");
      expect(counter.positions[1].weight).toBe(0.7);
    });

    test("creates new timestamp", () => {
      const original: Portfolio = {
        positions: [{ marketId: "m1", position: "YES", weight: 1 }],
        createdAt: "2020-01-01T00:00:00Z",
      };

      const counter = createCounterPortfolio(original);

      expect(new Date(counter.createdAt).getTime()).toBeGreaterThan(
        new Date(original.createdAt).getTime()
      );
    });
  });

  describe("calculatePortfolioScore", () => {
    test("calculates positive score for YES positions with price increase", () => {
      const portfolio: Portfolio = {
        positions: [{ marketId: "m1", position: "YES", weight: 1 }],
        createdAt: new Date().toISOString(),
      };

      const startPrices = new Map([["m1", 0.5]]);
      const endPrices = new Map([["m1", 0.7]]);

      const score = calculatePortfolioScore(portfolio, startPrices, endPrices);

      // Price went up 0.2, YES position wins
      expect(score).toBeCloseTo(0.2, 5);
    });

    test("calculates negative score for YES positions with price decrease", () => {
      const portfolio: Portfolio = {
        positions: [{ marketId: "m1", position: "YES", weight: 1 }],
        createdAt: new Date().toISOString(),
      };

      const startPrices = new Map([["m1", 0.7]]);
      const endPrices = new Map([["m1", 0.5]]);

      const score = calculatePortfolioScore(portfolio, startPrices, endPrices);

      // Price went down 0.2, YES position loses
      expect(score).toBeCloseTo(-0.2, 5);
    });

    test("calculates positive score for NO positions with price decrease", () => {
      const portfolio: Portfolio = {
        positions: [{ marketId: "m1", position: "NO", weight: 1 }],
        createdAt: new Date().toISOString(),
      };

      const startPrices = new Map([["m1", 0.7]]);
      const endPrices = new Map([["m1", 0.5]]);

      const score = calculatePortfolioScore(portfolio, startPrices, endPrices);

      // Price went down 0.2, NO position wins
      expect(score).toBeCloseTo(0.2, 5);
    });

    test("applies weights correctly", () => {
      const portfolio: Portfolio = {
        positions: [
          { marketId: "m1", position: "YES", weight: 0.3 },
          { marketId: "m2", position: "YES", weight: 0.7 },
        ],
        createdAt: new Date().toISOString(),
      };

      const startPrices = new Map([
        ["m1", 0.5],
        ["m2", 0.5],
      ]);
      const endPrices = new Map([
        ["m1", 0.6], // +0.1
        ["m2", 0.7], // +0.2
      ]);

      const score = calculatePortfolioScore(portfolio, startPrices, endPrices);

      // 0.1 * 0.3 + 0.2 * 0.7 = 0.03 + 0.14 = 0.17
      expect(score).toBeCloseTo(0.17, 5);
    });

    test("uses 0.5 default for missing prices", () => {
      const portfolio: Portfolio = {
        positions: [{ marketId: "unknown", position: "YES", weight: 1 }],
        createdAt: new Date().toISOString(),
      };

      const startPrices = new Map<string, number>();
      const endPrices = new Map<string, number>();

      const score = calculatePortfolioScore(portfolio, startPrices, endPrices);

      // Both start and end default to 0.5, so no change
      expect(score).toBe(0);
    });
  });

  describe("Portfolio serialization", () => {
    test("serializePortfolio creates valid JSON", () => {
      const portfolio = createMockPortfolio();
      const json = serializePortfolio(portfolio);

      expect(() => JSON.parse(json)).not.toThrow();
    });

    test("parsePortfolio recovers original portfolio", () => {
      const original = createMockPortfolio();
      const json = serializePortfolio(original);
      const parsed = parsePortfolio(json);

      expect(parsed.positions.length).toBe(original.positions.length);
      expect(parsed.positions[0].marketId).toBe(original.positions[0].marketId);
      expect(parsed.createdAt).toBe(original.createdAt);
    });

    test("calculatePortfolioHash returns hex string", () => {
      const portfolio = createMockPortfolio();
      const hash = calculatePortfolioHash(portfolio);

      expect(hash).toMatch(/^0x[a-f0-9]+$/);
    });

    test("same portfolio produces same hash", () => {
      const portfolio: Portfolio = {
        positions: [{ marketId: "m1", position: "YES", weight: 1 }],
        createdAt: "2026-01-01T00:00:00Z",
      };

      const hash1 = calculatePortfolioHash(portfolio);
      const hash2 = calculatePortfolioHash(portfolio);

      expect(hash1).toBe(hash2);
    });

    test("different portfolios produce different hashes", () => {
      const portfolio1: Portfolio = {
        positions: [{ marketId: "m1", position: "YES", weight: 1 }],
        createdAt: "2026-01-01T00:00:00Z",
      };

      const portfolio2: Portfolio = {
        positions: [{ marketId: "m1", position: "NO", weight: 1 }],
        createdAt: "2026-01-01T00:00:00Z",
      };

      const hash1 = calculatePortfolioHash(portfolio1);
      const hash2 = calculatePortfolioHash(portfolio2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("Default negotiation config", () => {
    test("has reasonable default thresholds", () => {
      expect(DEFAULT_NEGOTIATION_CONFIG.acceptThresholdBps).toBeGreaterThan(0);
      expect(DEFAULT_NEGOTIATION_CONFIG.counterThresholdBps).toBeGreaterThan(
        DEFAULT_NEGOTIATION_CONFIG.acceptThresholdBps
      );
      expect(DEFAULT_NEGOTIATION_CONFIG.rejectThresholdBps).toBeGreaterThan(
        DEFAULT_NEGOTIATION_CONFIG.counterThresholdBps
      );
    });

    test("has reasonable timing config", () => {
      expect(DEFAULT_NEGOTIATION_CONFIG.negotiationTimeoutSecs).toBeGreaterThan(0);
      expect(DEFAULT_NEGOTIATION_CONFIG.maxCounterAttempts).toBeGreaterThan(0);
      expect(DEFAULT_NEGOTIATION_CONFIG.pollIntervalMs).toBeGreaterThan(0);
    });
  });
});
