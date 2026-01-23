import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";

// Types for testing
interface TerminalScore {
  marketId: string;
  score: number;
  position: number;
  confidence: number;
}

interface AggregatedPortfolio {
  [marketId: string]: {
    score: number;
    position: number;
    confidence: number;
  };
}

interface PortfolioMetrics {
  totalMarkets: number;
  averageScore: number;
  confidenceWeightedScore: number;
  positionDistribution: {
    yes: number;
    no: number;
  };
  averageConfidence: number;
  aggregatedAt: string;
}

// Test directory setup
const TEST_DIR = join(import.meta.dir, "..", "test-tmp-aggregation");
const RESEARCH_DIR = join(TEST_DIR, "research");

describe("Score Aggregation", () => {
  beforeEach(() => {
    // Clean up and create test directories
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(RESEARCH_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directories
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("parseJsonLines", () => {
    test("parses valid JSON Lines format", async () => {
      const { parseJsonLines } = await import("../src/score-aggregation");

      const content = `{"marketId": "0x123", "score": 75, "position": 1, "confidence": 0.85}
{"marketId": "0x456", "score": 30, "position": 0, "confidence": 0.70}`;

      const scores = parseJsonLines(content);

      expect(scores).toHaveLength(2);
      expect(scores[0]).toEqual({
        marketId: "0x123",
        score: 75,
        position: 1,
        confidence: 0.85
      });
      expect(scores[1]).toEqual({
        marketId: "0x456",
        score: 30,
        position: 0,
        confidence: 0.70
      });
    });

    test("skips empty lines", async () => {
      const { parseJsonLines } = await import("../src/score-aggregation");

      const content = `{"marketId": "0x123", "score": 75, "position": 1, "confidence": 0.85}

{"marketId": "0x456", "score": 30, "position": 0, "confidence": 0.70}
`;

      const scores = parseJsonLines(content);
      expect(scores).toHaveLength(2);
    });

    test("skips malformed JSON lines with warning", async () => {
      const { parseJsonLines } = await import("../src/score-aggregation");

      const content = `{"marketId": "0x123", "score": 75, "position": 1, "confidence": 0.85}
{invalid json}
{"marketId": "0x456", "score": 30, "position": 0, "confidence": 0.70}`;

      const scores = parseJsonLines(content);
      expect(scores).toHaveLength(2);
    });

    test("returns empty array for empty content", async () => {
      const { parseJsonLines } = await import("../src/score-aggregation");

      const scores = parseJsonLines("");
      expect(scores).toHaveLength(0);
    });
  });

  describe("discoverTerminalFiles", () => {
    test("discovers all terminal score files", async () => {
      const { discoverTerminalFiles } = await import("../src/score-aggregation");

      // Create test terminal directories
      for (let i = 1; i <= 3; i++) {
        const terminalDir = join(RESEARCH_DIR, `terminal-${i}`);
        mkdirSync(terminalDir, { recursive: true });
        await Bun.write(join(terminalDir, "scores.json"), `{"marketId": "0x${i}", "score": 50, "position": 1, "confidence": 0.5}`);
        await Bun.write(join(terminalDir, "status.txt"), "COMPLETE");
      }

      const files = await discoverTerminalFiles(RESEARCH_DIR);

      expect(files).toHaveLength(3);
      expect(files.every(f => f.endsWith("scores.json"))).toBe(true);
    });

    test("only includes terminals with COMPLETE status", async () => {
      const { discoverTerminalFiles } = await import("../src/score-aggregation");

      // Create 3 terminals, only 2 complete
      for (let i = 1; i <= 3; i++) {
        const terminalDir = join(RESEARCH_DIR, `terminal-${i}`);
        mkdirSync(terminalDir, { recursive: true });
        await Bun.write(join(terminalDir, "scores.json"), `{"marketId": "0x${i}", "score": 50, "position": 1, "confidence": 0.5}`);
        if (i < 3) {
          await Bun.write(join(terminalDir, "status.txt"), "COMPLETE");
        }
      }

      const files = await discoverTerminalFiles(RESEARCH_DIR);

      expect(files).toHaveLength(2);
    });

    test("returns empty array when no terminals exist", async () => {
      const { discoverTerminalFiles } = await import("../src/score-aggregation");

      const files = await discoverTerminalFiles(RESEARCH_DIR);

      expect(files).toHaveLength(0);
    });
  });

  describe("mergeScores", () => {
    test("merges scores from multiple terminals", async () => {
      const { mergeScores } = await import("../src/score-aggregation");

      const allScores: TerminalScore[][] = [
        [
          { marketId: "0x123", score: 75, position: 1, confidence: 0.85 },
          { marketId: "0x456", score: 30, position: 0, confidence: 0.70 }
        ],
        [
          { marketId: "0x789", score: 60, position: 1, confidence: 0.80 },
          { marketId: "0xabc", score: 40, position: 0, confidence: 0.65 }
        ]
      ];

      const merged = mergeScores(allScores);

      expect(Object.keys(merged)).toHaveLength(4);
      expect(merged["0x123"]).toEqual({ score: 75, position: 1, confidence: 0.85 });
      expect(merged["0x456"]).toEqual({ score: 30, position: 0, confidence: 0.70 });
      expect(merged["0x789"]).toEqual({ score: 60, position: 1, confidence: 0.80 });
      expect(merged["0xabc"]).toEqual({ score: 40, position: 0, confidence: 0.65 });
    });

    test("keeps first occurrence for duplicate marketIds", async () => {
      const { mergeScores } = await import("../src/score-aggregation");

      const allScores: TerminalScore[][] = [
        [{ marketId: "0x123", score: 75, position: 1, confidence: 0.85 }],
        [{ marketId: "0x123", score: 50, position: 1, confidence: 0.60 }] // Duplicate
      ];

      const merged = mergeScores(allScores);

      expect(Object.keys(merged)).toHaveLength(1);
      expect(merged["0x123"].score).toBe(75); // First occurrence kept
    });

    test("handles empty input", async () => {
      const { mergeScores } = await import("../src/score-aggregation");

      const merged = mergeScores([]);

      expect(Object.keys(merged)).toHaveLength(0);
    });
  });

  describe("calculateMetrics", () => {
    test("calculates correct metrics for portfolio", async () => {
      const { calculateMetrics } = await import("../src/score-aggregation");

      const portfolio: AggregatedPortfolio = {
        "0x123": { score: 80, position: 1, confidence: 0.90 },
        "0x456": { score: 20, position: 0, confidence: 0.80 },
        "0x789": { score: 60, position: 1, confidence: 0.70 },
        "0xabc": { score: 40, position: 0, confidence: 0.60 }
      };

      const metrics = calculateMetrics(portfolio);

      expect(metrics.totalMarkets).toBe(4);
      expect(metrics.averageScore).toBe(50); // (80+20+60+40)/4
      expect(metrics.positionDistribution.yes).toBe(50); // 2 YES out of 4
      expect(metrics.positionDistribution.no).toBe(50); // 2 NO out of 4
      expect(metrics.averageConfidence).toBeCloseTo(0.75, 2); // (0.9+0.8+0.7+0.6)/4
    });

    test("calculates confidence-weighted score", async () => {
      const { calculateMetrics } = await import("../src/score-aggregation");

      const portfolio: AggregatedPortfolio = {
        "0x123": { score: 100, position: 1, confidence: 1.0 },
        "0x456": { score: 0, position: 0, confidence: 0.0 }
      };

      const metrics = calculateMetrics(portfolio);

      // Confidence-weighted: (100*1.0 + 0*0.0) / (1.0 + 0.0) = 100
      expect(metrics.confidenceWeightedScore).toBe(100);
    });

    test("handles empty portfolio", async () => {
      const { calculateMetrics } = await import("../src/score-aggregation");

      const metrics = calculateMetrics({});

      expect(metrics.totalMarkets).toBe(0);
      expect(metrics.averageScore).toBe(0);
      expect(metrics.confidenceWeightedScore).toBe(0);
      expect(metrics.positionDistribution.yes).toBe(0);
      expect(metrics.positionDistribution.no).toBe(0);
      expect(metrics.averageConfidence).toBe(0);
    });
  });

  describe("aggregateScores (integration)", () => {
    test("aggregates scores from terminal files", async () => {
      const { aggregateScores } = await import("../src/score-aggregation");

      // Create test terminals with JSON Lines format
      for (let i = 1; i <= 2; i++) {
        const terminalDir = join(RESEARCH_DIR, `terminal-${i}`);
        mkdirSync(terminalDir, { recursive: true });

        const content = i === 1
          ? `{"marketId": "0x001", "score": 75, "position": 1, "confidence": 0.85}
{"marketId": "0x002", "score": 30, "position": 0, "confidence": 0.70}`
          : `{"marketId": "0x003", "score": 60, "position": 1, "confidence": 0.80}
{"marketId": "0x004", "score": 40, "position": 0, "confidence": 0.65}`;

        await Bun.write(join(terminalDir, "scores.json"), content);
        await Bun.write(join(terminalDir, "status.txt"), "COMPLETE");
      }

      const result = await aggregateScores(RESEARCH_DIR);

      expect(result.portfolio).toBeDefined();
      expect(Object.keys(result.portfolio)).toHaveLength(4);
      expect(result.metrics.totalMarkets).toBe(4);
    });

    test("returns error when no completed terminals", async () => {
      const { aggregateScores } = await import("../src/score-aggregation");

      const result = await aggregateScores(RESEARCH_DIR);

      expect(result.error).toBeDefined();
      expect(result.error).toContain("No completed research terminals found");
    });

    test("handles partial terminal completion", async () => {
      const { aggregateScores } = await import("../src/score-aggregation");

      // Create 3 terminals, only 2 complete
      for (let i = 1; i <= 3; i++) {
        const terminalDir = join(RESEARCH_DIR, `terminal-${i}`);
        mkdirSync(terminalDir, { recursive: true });
        await Bun.write(join(terminalDir, "scores.json"), `{"marketId": "0x00${i}", "score": 50, "position": 1, "confidence": 0.5}`);
        if (i <= 2) {
          await Bun.write(join(terminalDir, "status.txt"), "COMPLETE");
        }
      }

      const result = await aggregateScores(RESEARCH_DIR);

      expect(result.portfolio).toBeDefined();
      expect(Object.keys(result.portfolio)).toHaveLength(2); // Only complete terminals
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.some(w => w.includes("Partial terminal completion"))).toBe(true);
    });
  });

  describe("performance", () => {
    test("aggregates 20K+ markets in reasonable time", async () => {
      const { aggregateScores } = await import("../src/score-aggregation");

      // Create 5 terminals with 4000+ markets each (20K+ total)
      const MARKETS_PER_TERMINAL = 4100;
      const NUM_TERMINALS = 5;

      for (let t = 1; t <= NUM_TERMINALS; t++) {
        const terminalDir = join(RESEARCH_DIR, `terminal-${t}`);
        mkdirSync(terminalDir, { recursive: true });

        // Generate JSON Lines content
        const lines: string[] = [];
        for (let m = 0; m < MARKETS_PER_TERMINAL; m++) {
          const marketId = `0x${t.toString().padStart(2, '0')}${m.toString().padStart(6, '0')}`;
          const score = Math.floor(Math.random() * 100);
          const position = score >= 50 ? 1 : 0;
          const confidence = 0.5 + Math.random() * 0.5;
          lines.push(JSON.stringify({ marketId, score, position, confidence: Math.round(confidence * 100) / 100 }));
        }

        await Bun.write(join(terminalDir, "scores.json"), lines.join("\n"));
        await Bun.write(join(terminalDir, "status.txt"), "COMPLETE");
      }

      const startTime = Date.now();
      const result = await aggregateScores(RESEARCH_DIR);
      const endTime = Date.now();

      const duration = endTime - startTime;
      const totalMarkets = MARKETS_PER_TERMINAL * NUM_TERMINALS;

      expect(result.portfolio).toBeDefined();
      expect(Object.keys(result.portfolio).length).toBe(totalMarkets);
      expect(result.metrics.totalMarkets).toBe(totalMarkets);

      // Performance target: <2 minutes (120000ms)
      expect(duration).toBeLessThan(120000);

      // Log performance metrics
      console.log(`Aggregated ${totalMarkets} markets in ${duration}ms`);
    }, 180000); // 3 minute timeout for performance test
  });
});
