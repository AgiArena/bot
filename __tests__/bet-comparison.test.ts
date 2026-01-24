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

  describe("Odds-Adjusted EV Calculations", () => {
    describe("bpsToDecimal", () => {
      test("converts 10000 bps to 1.0 decimal", async () => {
        const { bpsToDecimal } = await import("../src/bet-comparison");
        expect(bpsToDecimal(10000)).toBe(1.0);
      });

      test("converts 20000 bps to 2.0 decimal", async () => {
        const { bpsToDecimal } = await import("../src/bet-comparison");
        expect(bpsToDecimal(20000)).toBe(2.0);
      });

      test("converts 5000 bps to 0.5 decimal", async () => {
        const { bpsToDecimal } = await import("../src/bet-comparison");
        expect(bpsToDecimal(5000)).toBe(0.5);
      });

      test("converts 15000 bps to 1.5 decimal", async () => {
        const { bpsToDecimal } = await import("../src/bet-comparison");
        expect(bpsToDecimal(15000)).toBe(1.5);
      });

      test("throws error for zero bps", async () => {
        const { bpsToDecimal } = await import("../src/bet-comparison");
        expect(() => bpsToDecimal(0)).toThrow("Invalid oddsBps: 0");
      });

      test("throws error for negative bps", async () => {
        const { bpsToDecimal } = await import("../src/bet-comparison");
        expect(() => bpsToDecimal(-5000)).toThrow("Invalid oddsBps: -5000");
      });
    });

    describe("decimalToBps", () => {
      test("converts 1.0 decimal to 10000 bps", async () => {
        const { decimalToBps } = await import("../src/bet-comparison");
        expect(decimalToBps(1.0)).toBe(10000);
      });

      test("converts 2.0 decimal to 20000 bps", async () => {
        const { decimalToBps } = await import("../src/bet-comparison");
        expect(decimalToBps(2.0)).toBe(20000);
      });

      test("converts 0.5 decimal to 5000 bps", async () => {
        const { decimalToBps } = await import("../src/bet-comparison");
        expect(decimalToBps(0.5)).toBe(5000);
      });

      test("throws error for zero decimal", async () => {
        const { decimalToBps } = await import("../src/bet-comparison");
        expect(() => decimalToBps(0)).toThrow("Invalid decimal odds: 0");
      });

      test("throws error for negative decimal", async () => {
        const { decimalToBps } = await import("../src/bet-comparison");
        expect(() => decimalToBps(-1.5)).toThrow("Invalid decimal odds: -1.5");
      });
    });

    describe("calculateMatcherReturn", () => {
      test("calculates 3x return at 2.0 odds", async () => {
        const { calculateMatcherReturn } = await import("../src/bet-comparison");
        const result = calculateMatcherReturn(2.0);
        expect(result.matcherReturn).toBe(3.0);
        expect(result.impliedProbNeeded).toBeCloseTo(0.333, 2);
      });

      test("calculates 2x return at 1.0 odds (fair)", async () => {
        const { calculateMatcherReturn } = await import("../src/bet-comparison");
        const result = calculateMatcherReturn(1.0);
        expect(result.matcherReturn).toBe(2.0);
        expect(result.impliedProbNeeded).toBe(0.5);
      });

      test("calculates 1.5x return at 0.5 odds", async () => {
        const { calculateMatcherReturn } = await import("../src/bet-comparison");
        const result = calculateMatcherReturn(0.5);
        expect(result.matcherReturn).toBe(1.5);
        expect(result.impliedProbNeeded).toBeCloseTo(0.667, 2);
      });
    });

    describe("calculateOddsAdjustedEV", () => {
      test("adjusts EV upward for favorable odds (2.0x)", async () => {
        const { calculateOddsAdjustedEV } = await import("../src/bet-comparison");

        const ourPortfolio: AggregatedPortfolio = {
          "0xmarket1": { score: 60, position: 1, confidence: 0.8 }
        };

        const betPositions: BetPosition[] = [
          { marketId: "0xmarket1", position: "NO", startingPrice: "0.5", endingPrice: null }
        ];

        const result = calculateOddsAdjustedEV(ourPortfolio, betPositions, 20000);

        // Raw EV = 60 - 50 = 10
        // Odds multiplier at 2.0x = 0.5 / (1/3) = 1.5
        // Adjusted EV = 10 * 1.5 = 15
        expect(result.rawEV).toBe(10);
        expect(result.oddsDecimal).toBe(2.0);
        expect(result.oddsMultiplier).toBeCloseTo(1.5, 1);
        expect(result.adjustedEV).toBeCloseTo(15, 0);
        expect(result.requiredEdge).toBeLessThan(0); // Negative = favorable
      });

      test("adjusts EV downward for unfavorable odds (0.5x)", async () => {
        const { calculateOddsAdjustedEV } = await import("../src/bet-comparison");

        const ourPortfolio: AggregatedPortfolio = {
          "0xmarket1": { score: 60, position: 1, confidence: 0.8 }
        };

        const betPositions: BetPosition[] = [
          { marketId: "0xmarket1", position: "NO", startingPrice: "0.5", endingPrice: null }
        ];

        const result = calculateOddsAdjustedEV(ourPortfolio, betPositions, 5000);

        // Raw EV = 10
        // Odds multiplier at 0.5x = 0.5 / 0.667 = 0.75
        // Adjusted EV = 10 * 0.75 = 7.5
        expect(result.rawEV).toBe(10);
        expect(result.oddsDecimal).toBe(0.5);
        expect(result.oddsMultiplier).toBeCloseTo(0.75, 1);
        expect(result.adjustedEV).toBeCloseTo(7.5, 0);
        expect(result.requiredEdge).toBeGreaterThan(0); // Positive = unfavorable
      });

      test("returns unchanged EV at fair odds (1.0x)", async () => {
        const { calculateOddsAdjustedEV } = await import("../src/bet-comparison");

        const ourPortfolio: AggregatedPortfolio = {
          "0xmarket1": { score: 60, position: 1, confidence: 0.8 }
        };

        const betPositions: BetPosition[] = [
          { marketId: "0xmarket1", position: "NO", startingPrice: "0.5", endingPrice: null }
        ];

        const result = calculateOddsAdjustedEV(ourPortfolio, betPositions, 10000);

        expect(result.rawEV).toBe(10);
        expect(result.oddsDecimal).toBe(1.0);
        expect(result.oddsMultiplier).toBe(1.0);
        expect(result.adjustedEV).toBe(10);
        expect(result.requiredEdge).toBe(0);
      });

      test("handles edge case of very high odds (5.0x)", async () => {
        const { calculateOddsAdjustedEV } = await import("../src/bet-comparison");

        const ourPortfolio: AggregatedPortfolio = {
          "0xmarket1": { score: 60, position: 1, confidence: 0.8 }
        };

        const betPositions: BetPosition[] = [
          { marketId: "0xmarket1", position: "NO", startingPrice: "0.5", endingPrice: null }
        ];

        const result = calculateOddsAdjustedEV(ourPortfolio, betPositions, 50000);

        expect(result.oddsDecimal).toBe(5.0);
        expect(result.oddsMultiplier).toBeGreaterThan(1.5);
        expect(result.adjustedEV).toBeGreaterThan(result.rawEV);
      });

      test("handles edge case of very low odds (0.1x)", async () => {
        const { calculateOddsAdjustedEV } = await import("../src/bet-comparison");

        const ourPortfolio: AggregatedPortfolio = {
          "0xmarket1": { score: 60, position: 1, confidence: 0.8 }
        };

        const betPositions: BetPosition[] = [
          { marketId: "0xmarket1", position: "NO", startingPrice: "0.5", endingPrice: null }
        ];

        const result = calculateOddsAdjustedEV(ourPortfolio, betPositions, 1000);

        expect(result.oddsDecimal).toBe(0.1);
        expect(result.oddsMultiplier).toBeLessThan(1.0);
        expect(result.adjustedEV).toBeLessThan(result.rawEV);
      });
    });

    describe("getOddsAdjustedRecommendation", () => {
      test("lowers thresholds for favorable odds", async () => {
        const { getOddsAdjustedRecommendation } = await import("../src/bet-comparison");

        // With 1.5x odds multiplier, STRONG_MATCH threshold drops from 15 to 10
        // So adjustedEV of 12 should be STRONG_MATCH
        const result = getOddsAdjustedRecommendation(12, 1.5);
        expect(result).toBe("STRONG_MATCH");
      });

      test("raises thresholds for unfavorable odds", async () => {
        const { getOddsAdjustedRecommendation } = await import("../src/bet-comparison");

        // With 0.75x odds multiplier:
        // - STRONG_MATCH threshold rises from 15 to 20
        // - MATCH threshold rises from 10 to 13.33
        // So adjustedEV of 14 should be MATCH (between 13.33 and 20)
        const result = getOddsAdjustedRecommendation(14, 0.75);
        expect(result).toBe("MATCH");
      });

      test("maintains standard thresholds at fair odds", async () => {
        const { getOddsAdjustedRecommendation } = await import("../src/bet-comparison");

        expect(getOddsAdjustedRecommendation(20, 1.0)).toBe("STRONG_MATCH");
        expect(getOddsAdjustedRecommendation(12, 1.0)).toBe("MATCH");
        expect(getOddsAdjustedRecommendation(7, 1.0)).toBe("CONSIDER");
        expect(getOddsAdjustedRecommendation(3, 1.0)).toBe("LEAN_SKIP");
        expect(getOddsAdjustedRecommendation(-5, 1.0)).toBe("SKIP");
      });
    });

    describe("OddsAdjustedEV interface", () => {
      test("returns all required fields in result", async () => {
        const { calculateOddsAdjustedEV } = await import("../src/bet-comparison");

        const ourPortfolio: AggregatedPortfolio = {
          "0xmarket1": { score: 70, position: 1, confidence: 0.9 }
        };

        const betPositions: BetPosition[] = [
          { marketId: "0xmarket1", position: "NO", startingPrice: "0.5", endingPrice: null }
        ];

        const result = calculateOddsAdjustedEV(ourPortfolio, betPositions, 15000);

        // Verify all OddsAdjustedEV fields are present
        expect(typeof result.rawEV).toBe("number");
        expect(typeof result.oddsDecimal).toBe("number");
        expect(typeof result.oddsMultiplier).toBe("number");
        expect(typeof result.adjustedEV).toBe("number");
        expect(typeof result.requiredEdge).toBe("number");
        expect(["STRONG_MATCH", "MATCH", "CONSIDER", "LEAN_SKIP", "SKIP"]).toContain(result.recommendation);
      });
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

      // Performance: Compared ${portfolioSize} positions in ${duration}ms
    });
  });
});
