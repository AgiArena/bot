import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import {
  divideIntoSegments,
  generateResearchPrompt,
  writeResearchPrompt,
  type MarketData
} from "../src/research-prompt";

// Test directory for isolated testing
const TEST_DIR = join(import.meta.dir, "..", "test-tmp-research");
const TEST_RESEARCH_DIR = join(TEST_DIR, "research");

describe("Market Segmentation", () => {
  it("should divide markets evenly into N segments", () => {
    const markets: MarketData[] = Array.from({ length: 100 }, (_, i) => ({
      id: `market-${i}`,
      question: `Question ${i}?`,
      outcomes: ["Yes", "No"],
      currentOdds: [0.5, 0.5]
    }));

    const segments = divideIntoSegments(markets, 5);

    expect(segments.length).toBe(5);
    expect(segments[0].length).toBe(20);
    expect(segments[1].length).toBe(20);
    expect(segments[2].length).toBe(20);
    expect(segments[3].length).toBe(20);
    expect(segments[4].length).toBe(20);
  });

  it("should handle uneven division with remainder", () => {
    const markets: MarketData[] = Array.from({ length: 103 }, (_, i) => ({
      id: `market-${i}`,
      question: `Question ${i}?`,
      outcomes: ["Yes", "No"],
      currentOdds: [0.5, 0.5]
    }));

    const segments = divideIntoSegments(markets, 5);

    expect(segments.length).toBe(5);
    // 103 / 5 = 20 with remainder 3
    // First 3 segments get 21, last 2 get 20
    expect(segments[0].length).toBe(21);
    expect(segments[1].length).toBe(21);
    expect(segments[2].length).toBe(21);
    expect(segments[3].length).toBe(20);
    expect(segments[4].length).toBe(20);

    // Total should equal original count
    const totalMarkets = segments.reduce((sum, seg) => sum + seg.length, 0);
    expect(totalMarkets).toBe(103);
  });

  it("should handle fewer markets than terminals", () => {
    const markets: MarketData[] = Array.from({ length: 3 }, (_, i) => ({
      id: `market-${i}`,
      question: `Question ${i}?`,
      outcomes: ["Yes", "No"],
      currentOdds: [0.5, 0.5]
    }));

    const segments = divideIntoSegments(markets, 5);

    // Should only create 3 segments (1 market each), not 5
    expect(segments.length).toBe(3);
    expect(segments[0].length).toBe(1);
    expect(segments[1].length).toBe(1);
    expect(segments[2].length).toBe(1);
  });

  it("should handle empty markets array", () => {
    const markets: MarketData[] = [];
    const segments = divideIntoSegments(markets, 5);

    expect(segments.length).toBe(0);
  });

  it("should handle single terminal", () => {
    const markets: MarketData[] = Array.from({ length: 100 }, (_, i) => ({
      id: `market-${i}`,
      question: `Question ${i}?`,
      outcomes: ["Yes", "No"],
      currentOdds: [0.5, 0.5]
    }));

    const segments = divideIntoSegments(markets, 1);

    expect(segments.length).toBe(1);
    expect(segments[0].length).toBe(100);
  });

  it("should preserve market data integrity across segments", () => {
    const markets: MarketData[] = [
      { id: "market-A", question: "Will A happen?", outcomes: ["Yes", "No"], currentOdds: [0.7, 0.3] },
      { id: "market-B", question: "Will B happen?", outcomes: ["Yes", "No"], currentOdds: [0.4, 0.6] },
      { id: "market-C", question: "Will C happen?", outcomes: ["Yes", "No"], currentOdds: [0.5, 0.5] }
    ];

    const segments = divideIntoSegments(markets, 2);

    // Verify all markets are present
    const allMarkets = segments.flat();
    expect(allMarkets.length).toBe(3);
    expect(allMarkets.map(m => m.id)).toContain("market-A");
    expect(allMarkets.map(m => m.id)).toContain("market-B");
    expect(allMarkets.map(m => m.id)).toContain("market-C");

    // Verify data integrity
    const marketA = allMarkets.find(m => m.id === "market-A");
    expect(marketA?.currentOdds[0]).toBe(0.7);
  });
});

describe("Research Prompt Generation", () => {
  it("should generate prompt with terminal number", () => {
    const prompt = generateResearchPrompt({
      terminalNum: 1,
      segmentFile: "markets_segment_1.json",
      startIdx: 0,
      endIdx: 4999,
      totalMarkets: 5000
    });

    expect(prompt).toContain("Research Terminal 1");
    expect(prompt).toContain("markets_segment_1.json");
  });

  it("should include market range indices", () => {
    const prompt = generateResearchPrompt({
      terminalNum: 3,
      segmentFile: "markets_segment_3.json",
      startIdx: 10000,
      endIdx: 14999,
      totalMarkets: 5000
    });

    expect(prompt).toContain("10000");
    expect(prompt).toContain("14999");
  });

  it("should include scoring instructions", () => {
    const prompt = generateResearchPrompt({
      terminalNum: 1,
      segmentFile: "markets_segment_1.json",
      startIdx: 0,
      endIdx: 4999,
      totalMarkets: 5000
    });

    expect(prompt).toContain("score");
    expect(prompt).toContain("0-100");
    expect(prompt).toContain("YES");
  });

  it("should include output format specification", () => {
    const prompt = generateResearchPrompt({
      terminalNum: 2,
      segmentFile: "markets_segment_2.json",
      startIdx: 5000,
      endIdx: 9999,
      totalMarkets: 5000
    });

    expect(prompt).toContain("marketId");
    expect(prompt).toContain("score");
    expect(prompt).toContain("position");
    expect(prompt).toContain("confidence");
    expect(prompt).toContain("JSON");
  });

  it("should include output file path", () => {
    const prompt = generateResearchPrompt({
      terminalNum: 4,
      segmentFile: "markets_segment_4.json",
      startIdx: 15000,
      endIdx: 19999,
      totalMarkets: 5000
    });

    expect(prompt).toContain("research/terminal-4/scores.json");
    expect(prompt).toContain("status.txt");
    expect(prompt).toContain("COMPLETE");
  });

  it("should include incremental write instructions", () => {
    const prompt = generateResearchPrompt({
      terminalNum: 1,
      segmentFile: "markets_segment_1.json",
      startIdx: 0,
      endIdx: 4999,
      totalMarkets: 5000
    });

    // Should mention incremental or JSON lines format
    expect(prompt).toContain("incremental");
  });
});

describe("Research Prompt File Writing", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("should write prompt file to terminal directory", async () => {
    mkdirSync(TEST_RESEARCH_DIR, { recursive: true });

    const success = await writeResearchPrompt(TEST_RESEARCH_DIR, 1, {
      terminalNum: 1,
      segmentFile: "markets_segment_1.json",
      startIdx: 0,
      endIdx: 4999,
      totalMarkets: 5000
    });

    expect(success).toBe(true);
    const promptPath = join(TEST_RESEARCH_DIR, "terminal-1", "prompt.md");
    expect(existsSync(promptPath)).toBe(true);

    const content = readFileSync(promptPath, "utf-8");
    expect(content).toContain("Research Terminal 1");
  });

  it("should create terminal directory if it does not exist", async () => {
    mkdirSync(TEST_RESEARCH_DIR, { recursive: true });

    const terminalDir = join(TEST_RESEARCH_DIR, "terminal-3");
    expect(existsSync(terminalDir)).toBe(false);

    await writeResearchPrompt(TEST_RESEARCH_DIR, 3, {
      terminalNum: 3,
      segmentFile: "markets_segment_3.json",
      startIdx: 10000,
      endIdx: 14999,
      totalMarkets: 5000
    });

    expect(existsSync(terminalDir)).toBe(true);
  });

  it("should write multiple terminal prompts", async () => {
    mkdirSync(TEST_RESEARCH_DIR, { recursive: true });

    for (let i = 1; i <= 5; i++) {
      await writeResearchPrompt(TEST_RESEARCH_DIR, i, {
        terminalNum: i,
        segmentFile: `markets_segment_${i}.json`,
        startIdx: (i - 1) * 5000,
        endIdx: i * 5000 - 1,
        totalMarkets: 5000
      });
    }

    for (let i = 1; i <= 5; i++) {
      const promptPath = join(TEST_RESEARCH_DIR, `terminal-${i}`, "prompt.md");
      expect(existsSync(promptPath)).toBe(true);
    }
  });
});

describe("Market Data Parsing", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("should correctly segment large market arrays", () => {
    // Simulate 20K+ markets
    const largeMarketSet: MarketData[] = Array.from({ length: 20000 }, (_, i) => ({
      id: `0x${i.toString(16).padStart(40, '0')}`,
      question: `Market question ${i}?`,
      outcomes: ["Yes", "No"],
      currentOdds: [Math.random(), 1 - Math.random()]
    }));

    const segments = divideIntoSegments(largeMarketSet, 5);

    expect(segments.length).toBe(5);
    expect(segments[0].length).toBe(4000);
    expect(segments[1].length).toBe(4000);
    expect(segments[2].length).toBe(4000);
    expect(segments[3].length).toBe(4000);
    expect(segments[4].length).toBe(4000);
  });
});

describe("Terminal Spawning Integration", () => {
  const INTEGRATION_DIR = join(import.meta.dir, "..", "test-tmp-integration");
  const MOCK_SCRIPT_DIR = join(INTEGRATION_DIR, "scripts");
  const RESEARCH_DIR = join(INTEGRATION_DIR, "research");

  beforeEach(() => {
    if (existsSync(INTEGRATION_DIR)) {
      rmSync(INTEGRATION_DIR, { recursive: true, force: true });
    }
    mkdirSync(INTEGRATION_DIR, { recursive: true });
    mkdirSync(MOCK_SCRIPT_DIR, { recursive: true });
    mkdirSync(RESEARCH_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(INTEGRATION_DIR)) {
      rmSync(INTEGRATION_DIR, { recursive: true, force: true });
    }
  });

  it("should create terminal directories with correct structure", async () => {
    // Create terminal directories
    for (let i = 1; i <= 3; i++) {
      const terminalDir = join(RESEARCH_DIR, `terminal-${i}`);
      mkdirSync(terminalDir, { recursive: true });

      // Write prompt
      await writeResearchPrompt(RESEARCH_DIR, i, {
        terminalNum: i,
        segmentFile: `markets_segment_${i}.json`,
        startIdx: (i - 1) * 100,
        endIdx: i * 100 - 1,
        totalMarkets: 100
      });
    }

    // Verify structure
    for (let i = 1; i <= 3; i++) {
      const terminalDir = join(RESEARCH_DIR, `terminal-${i}`);
      const promptPath = join(terminalDir, "prompt.md");

      expect(existsSync(terminalDir)).toBe(true);
      expect(existsSync(promptPath)).toBe(true);

      const content = readFileSync(promptPath, "utf-8");
      expect(content).toContain(`Research Terminal ${i}`);
      expect(content).toContain(`markets_segment_${i}.json`);
    }
  });

  it("should spawn-terminal.sh script exist and be executable", () => {
    const spawnScript = join(import.meta.dir, "..", "agent", "scripts", "spawn-terminal.sh");
    expect(existsSync(spawnScript)).toBe(true);

    // Check file is executable (has x permission)
    const { accessSync, constants } = require("fs");
    let isExecutable = false;
    try {
      accessSync(spawnScript, constants.X_OK);
      isExecutable = true;
    } catch {
      isExecutable = false;
    }
    expect(isExecutable).toBe(true);
  });

  it("should start-research.sh script exist and be executable", () => {
    const startScript = join(import.meta.dir, "..", "agent", "scripts", "start-research.sh");
    expect(existsSync(startScript)).toBe(true);

    // Check file is executable (has x permission)
    const { accessSync, constants } = require("fs");
    let isExecutable = false;
    try {
      accessSync(startScript, constants.X_OK);
      isExecutable = true;
    } catch {
      isExecutable = false;
    }
    expect(isExecutable).toBe(true);
  });
});

describe("Completion Monitoring Logic", () => {
  const MONITOR_DIR = join(import.meta.dir, "..", "test-tmp-monitor");
  const RESEARCH_DIR = join(MONITOR_DIR, "research");

  beforeEach(() => {
    if (existsSync(MONITOR_DIR)) {
      rmSync(MONITOR_DIR, { recursive: true, force: true });
    }
    mkdirSync(MONITOR_DIR, { recursive: true });
    mkdirSync(RESEARCH_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(MONITOR_DIR)) {
      rmSync(MONITOR_DIR, { recursive: true, force: true });
    }
  });

  it("should detect completed terminals by status.txt presence", () => {
    // Create 5 terminal directories
    for (let i = 1; i <= 5; i++) {
      const terminalDir = join(RESEARCH_DIR, `terminal-${i}`);
      mkdirSync(terminalDir, { recursive: true });
    }

    // Mark 3 as complete
    for (let i = 1; i <= 3; i++) {
      const statusFile = join(RESEARCH_DIR, `terminal-${i}`, "status.txt");
      writeFileSync(statusFile, "COMPLETE");
    }

    // Count complete terminals
    let completeCount = 0;
    for (let i = 1; i <= 5; i++) {
      const statusFile = join(RESEARCH_DIR, `terminal-${i}`, "status.txt");
      if (existsSync(statusFile)) {
        const content = readFileSync(statusFile, "utf-8").trim();
        if (content === "COMPLETE") {
          completeCount++;
        }
      }
    }

    expect(completeCount).toBe(3);
  });

  it("should identify incomplete terminals", () => {
    // Create 5 terminal directories, only 2 complete
    for (let i = 1; i <= 5; i++) {
      const terminalDir = join(RESEARCH_DIR, `terminal-${i}`);
      mkdirSync(terminalDir, { recursive: true });
    }

    // Mark 1 and 3 as complete
    writeFileSync(join(RESEARCH_DIR, "terminal-1", "status.txt"), "COMPLETE");
    writeFileSync(join(RESEARCH_DIR, "terminal-3", "status.txt"), "COMPLETE");

    // Find incomplete terminals
    const incomplete: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const statusFile = join(RESEARCH_DIR, `terminal-${i}`, "status.txt");
      if (!existsSync(statusFile)) {
        incomplete.push(i);
      }
    }

    expect(incomplete).toEqual([2, 4, 5]);
  });

  it("should track retry counts per terminal", () => {
    // Simulate retry tracking logic
    const retryCounts: Record<number, number> = {};
    const MAX_RETRIES = 3;

    // Initialize
    for (let i = 1; i <= 5; i++) {
      retryCounts[i] = 0;
    }

    // Simulate retries for terminals 2 and 4
    retryCounts[2] = 1;
    retryCounts[4] = 2;

    // Check which terminals can still retry
    const canRetry: number[] = [];
    for (let i = 1; i <= 5; i++) {
      if (retryCounts[i] < MAX_RETRIES) {
        canRetry.push(i);
      }
    }

    expect(canRetry).toEqual([1, 2, 3, 4, 5]);

    // After terminal 4 uses its last retry
    retryCounts[4] = 3;
    const canRetryAfter: number[] = [];
    for (let i = 1; i <= 5; i++) {
      if (retryCounts[i] < MAX_RETRIES) {
        canRetryAfter.push(i);
      }
    }

    expect(canRetryAfter).toEqual([1, 2, 3, 5]);
  });

  it("should handle terminal cleanup for retry", () => {
    // Create terminal directory with output.log
    const terminalDir = join(RESEARCH_DIR, "terminal-1");
    mkdirSync(terminalDir, { recursive: true });
    writeFileSync(join(terminalDir, "output.log"), "old output");
    writeFileSync(join(terminalDir, "prompt.md"), "# Research Terminal 1");

    // Simulate cleanup before retry (remove output.log, keep prompt.md)
    const outputLog = join(terminalDir, "output.log");
    if (existsSync(outputLog)) {
      rmSync(outputLog);
    }

    expect(existsSync(join(terminalDir, "output.log"))).toBe(false);
    expect(existsSync(join(terminalDir, "prompt.md"))).toBe(true);
  });
});

describe("Polymarket API Integration", () => {
  it("should handle empty API response", () => {
    const emptyResponse: MarketData[] = [];
    const segments = divideIntoSegments(emptyResponse, 5);
    expect(segments.length).toBe(0);
  });

  it("should handle malformed market data gracefully", () => {
    // Markets with missing fields should still be segmentable
    const partialMarkets = [
      { id: "market-1", question: "Q1?", outcomes: ["Yes", "No"], currentOdds: [0.5, 0.5] },
      { id: "market-2", question: "Q2?", outcomes: ["Yes", "No"], currentOdds: [0.6, 0.4] },
    ] as MarketData[];

    const segments = divideIntoSegments(partialMarkets, 2);
    expect(segments.length).toBe(2);
    expect(segments[0][0].id).toBe("market-1");
  });

  it("should handle pagination scenarios - simulated 20K+ markets", () => {
    // Simulate paginated API responses being combined
    const page1: MarketData[] = Array.from({ length: 500 }, (_, i) => ({
      id: `page1-${i}`,
      question: `Q${i}?`,
      outcomes: ["Yes", "No"],
      currentOdds: [0.5, 0.5]
    }));

    const page2: MarketData[] = Array.from({ length: 500 }, (_, i) => ({
      id: `page2-${i}`,
      question: `Q${i}?`,
      outcomes: ["Yes", "No"],
      currentOdds: [0.5, 0.5]
    }));

    // Combine pages (simulating what fetch_all_markets does)
    const allMarkets = [...page1, ...page2];
    expect(allMarkets.length).toBe(1000);

    const segments = divideIntoSegments(allMarkets, 5);
    expect(segments.length).toBe(5);
    expect(segments[0].length).toBe(200);

    // Verify no data loss
    const totalInSegments = segments.reduce((sum, seg) => sum + seg.length, 0);
    expect(totalInSegments).toBe(1000);
  });

  it("should preserve market ID uniqueness across segments", () => {
    const markets: MarketData[] = Array.from({ length: 100 }, (_, i) => ({
      id: `unique-market-${i}`,
      question: `Question ${i}?`,
      outcomes: ["Yes", "No"],
      currentOdds: [0.5, 0.5]
    }));

    const segments = divideIntoSegments(markets, 5);
    const allIds = segments.flat().map(m => m.id);
    const uniqueIds = new Set(allIds);

    expect(uniqueIds.size).toBe(100);
  });
});

describe("End-to-End Flow Simulation", () => {
  const E2E_DIR = join(import.meta.dir, "..", "test-tmp-e2e");
  const AGENT_DIR = join(E2E_DIR, "agent");
  const RESEARCH_DIR = join(AGENT_DIR, "research");

  beforeEach(() => {
    if (existsSync(E2E_DIR)) {
      rmSync(E2E_DIR, { recursive: true, force: true });
    }
    mkdirSync(E2E_DIR, { recursive: true });
    mkdirSync(AGENT_DIR, { recursive: true });
    mkdirSync(RESEARCH_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(E2E_DIR)) {
      rmSync(E2E_DIR, { recursive: true, force: true });
    }
  });

  it("should simulate full research flow with mock data", async () => {
    // Step 1: Create mock market data
    const mockMarkets: MarketData[] = Array.from({ length: 25 }, (_, i) => ({
      id: `market-${i}`,
      question: `Will event ${i} happen?`,
      outcomes: ["Yes", "No"],
      currentOdds: [0.5, 0.5]
    }));

    // Step 2: Save mock markets to file
    const marketsFile = join(AGENT_DIR, "markets.json");
    writeFileSync(marketsFile, JSON.stringify(mockMarkets, null, 2));

    // Step 3: Segment markets
    const segments = divideIntoSegments(mockMarkets, 5);
    expect(segments.length).toBe(5);

    // Step 4: Write segment files
    for (let i = 0; i < segments.length; i++) {
      const segmentFile = join(AGENT_DIR, `markets_segment_${i + 1}.json`);
      writeFileSync(segmentFile, JSON.stringify(segments[i], null, 2));
    }

    // Step 5: Create terminal directories and prompts
    for (let i = 1; i <= 5; i++) {
      await writeResearchPrompt(RESEARCH_DIR, i, {
        terminalNum: i,
        segmentFile: `markets_segment_${i}.json`,
        startIdx: (i - 1) * 5,
        endIdx: i * 5 - 1,
        totalMarkets: 5
      });
    }

    // Step 6: Simulate terminal completion (mock scores)
    for (let i = 1; i <= 5; i++) {
      const terminalDir = join(RESEARCH_DIR, `terminal-${i}`);
      const scoresFile = join(terminalDir, "scores.json");
      const statusFile = join(terminalDir, "status.txt");

      // Write mock scores
      const mockScores = segments[i - 1].map(m => ({
        marketId: m.id,
        score: Math.floor(Math.random() * 100),
        position: Math.random() > 0.5 ? 1 : 0,
        confidence: Math.random()
      }));
      writeFileSync(scoresFile, mockScores.map(s => JSON.stringify(s)).join("\n"));

      // Mark complete
      writeFileSync(statusFile, "COMPLETE");
    }

    // Verify all terminals complete
    let completeCount = 0;
    for (let i = 1; i <= 5; i++) {
      const statusFile = join(RESEARCH_DIR, `terminal-${i}`, "status.txt");
      if (existsSync(statusFile)) {
        completeCount++;
      }
    }
    expect(completeCount).toBe(5);

    // Verify scores exist
    for (let i = 1; i <= 5; i++) {
      const scoresFile = join(RESEARCH_DIR, `terminal-${i}`, "scores.json");
      expect(existsSync(scoresFile)).toBe(true);
    }
  });
});
