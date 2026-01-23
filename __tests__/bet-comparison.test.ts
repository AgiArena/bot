import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";

// Types for testing
interface AggregatedPortfolio {
  [marketId: string]: {
    score: number;
    position: number;
    confidence: number;
  };
}

interface BetPosition {
  marketId: string;
  position: "YES" | "NO";
  startingPrice: string;
  endingPrice: string | null;
}

interface ComparisonResult {
  betId: string;
  evScore: number;
  recommendedAction: "STRONG_MATCH" | "MATCH" | "CONSIDER" | "LEAN_SKIP" | "SKIP";
  confidence: number;
  reasoning: string;
  details: {
    totalMarkets: number;
    matchingMarkets: number;
    averageDelta: number;
  };
}

// Test directory setup
const TEST_DIR = join(import.meta.dir, "..", "test-tmp-comparison");

describe("Bet Comparison", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("calculateEV", () => {
    test("calculates positive EV when positions differ", async () => {
      const { calculateEV } = await import("../src/bet-comparison");

      const ourPortfolio: AggregatedPortfolio = {
        "0xmarket1": { score: 75, position: 1, confidence: 0.85 }, // We're YES (75)
        "0xmarket2": { score: 35, position: 0, confidence: 0.70 }, // We're NO (35)
        "0xmarket3": { score: 60, position: 1, confidence: 0.80 }  // We're YES (60)
      };

      const betPositions: BetPosition[] = [
        { marketId: "0xmarket1", position: "NO", startingPrice: "0.5", endingPrice: null },  // Bet is NO, we differ
        { marketId: "0xmarket2", position: "YES", startingPrice: "0.5", endingPrice: null }, // Bet is YES, we differ
        { marketId: "0xmarket3", position: "YES", startingPrice: "0.5", endingPrice: null }  // Bet is YES, same as us
      ];

      const result = calculateEV(ourPortfolio, betPositions);

      // Market 1: We score 75 (YES), bet is NO -> delta = 75 - 50 = +25
      // Market 2: We score 35 (NO), bet is YES -> delta = 50 - 35 = +15
      // Market 3: We score 60 (YES), bet is YES -> delta = 0 (positions match)
      // Average EV = (25 + 15 + 0) / 3 = 13.33

      expect(result.rawEV).toBeCloseTo(13.33, 1);
    });

    test("calculates zero EV when all positions match", async () => {
      const { calculateEV } = await import("../src/bet-comparison");

      const ourPortfolio: AggregatedPortfolio = {
        "0xmarket1": { score: 75, position: 1, confidence: 0.85 },
        "0xmarket2": { score: 35, position: 0, confidence: 0.70 }
      };

      const betPositions: BetPosition[] = [
        { marketId: "0xmarket1", position: "YES", startingPrice: "0.5", endingPrice: null },
        { marketId: "0xmarket2", position: "NO", startingPrice: "0.5", endingPrice: null }
      ];

      const result = calculateEV(ourPortfolio, betPositions);

      expect(result.rawEV).toBe(0);
    });

    test("calculates confidence-weighted EV", async () => {
      const { calculateEV } = await import("../src/bet-comparison");

      const ourPortfolio: AggregatedPortfolio = {
        "0xmarket1": { score: 75, position: 1, confidence: 1.0 },   // High confidence
        "0xmarket2": { score: 35, position: 0, confidence: 0.5 }    // Low confidence
      };

      const betPositions: BetPosition[] = [
        { marketId: "0xmarket1", position: "NO", startingPrice: "0.5", endingPrice: null },
        { marketId: "0xmarket2", position: "YES", startingPrice: "0.5", endingPrice: null }
      ];

      const result = calculateEV(ourPortfolio, betPositions);

      // Market 1: delta = 25, confidence = 1.0
      // Market 2: delta = 15, confidence = 0.5
      // Weighted EV = (25*1.0 + 15*0.5) / (1.0 + 0.5) = 32.5 / 1.5 = 21.67

      expect(result.weightedEV).toBeCloseTo(21.67, 1);
    });

    test("handles markets not in our portfolio", async () => {
      const { calculateEV } = await import("../src/bet-comparison");

      const ourPortfolio: AggregatedPortfolio = {
        "0xmarket1": { score: 75, position: 1, confidence: 0.85 }
      };

      const betPositions: BetPosition[] = [
        { marketId: "0xmarket1", position: "NO", startingPrice: "0.5", endingPrice: null },
        { marketId: "0xmarket2", position: "YES", startingPrice: "0.5", endingPrice: null }, // Not in our portfolio
        { marketId: "0xmarket3", position: "NO", startingPrice: "0.5", endingPrice: null }   // Not in our portfolio
      ];

      const result = calculateEV(ourPortfolio, betPositions);

      // Only market1 should be counted
      expect(result.matchingMarkets).toBe(1);
      expect(result.rawEV).toBe(25); // 75 - 50 = 25
    });

    test("returns zero for empty bet positions", async () => {
      const { calculateEV } = await import("../src/bet-comparison");

      const ourPortfolio: AggregatedPortfolio = {
        "0xmarket1": { score: 75, position: 1, confidence: 0.85 }
      };

      const result = calculateEV(ourPortfolio, []);

      expect(result.rawEV).toBe(0);
      expect(result.matchingMarkets).toBe(0);
    });
  });

  describe("getRecommendation", () => {
    test("returns STRONG_MATCH for EV > 15", async () => {
      const { getRecommendation } = await import("../src/bet-comparison");

      const result = getRecommendation(20);

      expect(result).toBe("STRONG_MATCH");
    });

    test("returns MATCH for EV 10-15", async () => {
      const { getRecommendation } = await import("../src/bet-comparison");

      expect(getRecommendation(15)).toBe("MATCH");
      expect(getRecommendation(10)).toBe("MATCH");
      expect(getRecommendation(12)).toBe("MATCH");
    });

    test("returns CONSIDER for EV 5-10", async () => {
      const { getRecommendation } = await import("../src/bet-comparison");

      expect(getRecommendation(9.9)).toBe("CONSIDER");
      expect(getRecommendation(5)).toBe("CONSIDER");
      expect(getRecommendation(7)).toBe("CONSIDER");
    });

    test("returns LEAN_SKIP for EV 0-5", async () => {
      const { getRecommendation } = await import("../src/bet-comparison");

      expect(getRecommendation(4.9)).toBe("LEAN_SKIP");
      expect(getRecommendation(0.1)).toBe("LEAN_SKIP");
      expect(getRecommendation(2)).toBe("LEAN_SKIP");
    });

    test("returns SKIP for EV <= 0", async () => {
      const { getRecommendation } = await import("../src/bet-comparison");

      expect(getRecommendation(0)).toBe("SKIP");
      expect(getRecommendation(-5)).toBe("SKIP");
      expect(getRecommendation(-10)).toBe("SKIP");
    });
  });

  describe("generateReasoning", () => {
    test("generates reasoning for strong edge", async () => {
      const { generateReasoning } = await import("../src/bet-comparison");

      const result = generateReasoning(20, 1000, 800, "STRONG_MATCH");

      expect(result).toContain("Strong edge");
      expect(result).toContain("800");
      expect(result).toContain("1000");
    });

    test("generates reasoning for skip recommendation", async () => {
      const { generateReasoning } = await import("../src/bet-comparison");

      const result = generateReasoning(-5, 100, 90, "SKIP");

      expect(result).toContain("Negative");
    });

    test("handles zero matching markets", async () => {
      const { generateReasoning } = await import("../src/bet-comparison");

      const result = generateReasoning(0, 100, 0, "SKIP");

      expect(result).toContain("No overlapping markets");
    });
  });

  describe("compareBet (integration)", () => {
    test("returns full comparison result", async () => {
      const { compareBet } = await import("../src/bet-comparison");

      const ourPortfolio: AggregatedPortfolio = {
        "0xmarket1": { score: 75, position: 1, confidence: 0.85 },
        "0xmarket2": { score: 35, position: 0, confidence: 0.70 },
        "0xmarket3": { score: 60, position: 1, confidence: 0.80 }
      };

      const betPositions: BetPosition[] = [
        { marketId: "0xmarket1", position: "NO", startingPrice: "0.5", endingPrice: null },
        { marketId: "0xmarket2", position: "YES", startingPrice: "0.5", endingPrice: null },
        { marketId: "0xmarket3", position: "YES", startingPrice: "0.5", endingPrice: null }
      ];

      const result = compareBet("bet123", ourPortfolio, betPositions);

      expect(result.betId).toBe("bet123");
      expect(result.evScore).toBeGreaterThan(0);
      expect(["STRONG_MATCH", "MATCH", "CONSIDER", "LEAN_SKIP", "SKIP"]).toContain(result.recommendedAction);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.reasoning).toBeDefined();
      expect(result.details.totalMarkets).toBe(3);
      expect(result.details.matchingMarkets).toBe(3);
    });

    test("handles bet with no matching markets", async () => {
      const { compareBet } = await import("../src/bet-comparison");

      const ourPortfolio: AggregatedPortfolio = {
        "0xmarket1": { score: 75, position: 1, confidence: 0.85 }
      };

      const betPositions: BetPosition[] = [
        { marketId: "0xmarket999", position: "NO", startingPrice: "0.5", endingPrice: null }
      ];

      const result = compareBet("bet456", ourPortfolio, betPositions);

      expect(result.betId).toBe("bet456");
      expect(result.evScore).toBe(0);
      expect(result.recommendedAction).toBe("SKIP");
      expect(result.details.matchingMarkets).toBe(0);
    });
  });

  describe("performance", () => {
    test("compares large portfolios efficiently", async () => {
      const { compareBet } = await import("../src/bet-comparison");

      // Create large portfolios (5K+ positions each)
      const portfolioSize = 5000;
      const ourPortfolio: AggregatedPortfolio = {};
      const betPositions: BetPosition[] = [];

      for (let i = 0; i < portfolioSize; i++) {
        const marketId = `0xmarket${i.toString().padStart(6, '0')}`;
        const score = Math.floor(Math.random() * 100);
        ourPortfolio[marketId] = {
          score,
          position: score >= 50 ? 1 : 0,
          confidence: 0.5 + Math.random() * 0.5
        };

        betPositions.push({
          marketId,
          position: Math.random() > 0.5 ? "YES" : "NO",
          startingPrice: "0.5",
          endingPrice: null
        });
      }

      const startTime = Date.now();
      const result = compareBet("largebet", ourPortfolio, betPositions);
      const endTime = Date.now();

      const duration = endTime - startTime;

      expect(result.details.totalMarkets).toBe(portfolioSize);
      expect(result.details.matchingMarkets).toBe(portfolioSize);

      // Should process 1000 positions/second minimum (5s max for 5K)
      expect(duration).toBeLessThan(5000);

      console.log(`Compared ${portfolioSize} positions in ${duration}ms`);
    });
  });
});
