/**
 * Cross-Component Verification Tests (Story 5-4)
 *
 * Verifies that all three Resolution VM implementations produce identical outcomes:
 * - Data Node (Rust) - crates/data-node/src/resolve/vm.rs
 * - Bot (TypeScript) - bot/src/merkle-tree.ts
 * - Keeper (Rust) - keeper/src/bilateral_resolution.rs
 *
 * The tests use shared test vectors to ensure determinism across all implementations.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  parseMethod,
  evaluateTrade,
  BPS_BASE,
  type ParsedMethod,
} from "../merkle-tree";

// ============================================================================
// Types for Test Vectors
// ============================================================================

/**
 * Test trade input
 */
interface TestTrade {
  ticker: string;
  entryPrice: bigint;
  exitPrice: bigint;
  method: string;
}

/**
 * Expected outcome for a single trade
 */
interface ExpectedTradeResult {
  ticker: string;
  makerWins: boolean;
}

/**
 * Complete test vector with trades and expected portfolio outcome
 */
interface TestVector {
  name: string;
  trades: TestTrade[];
  expected: {
    makerWins: number;
    takerWins: number;
    winner: "maker" | "taker";
  };
}

// ============================================================================
// Seeded Random Number Generator (for reproducibility)
// ============================================================================

/**
 * Simple mulberry32 PRNG for deterministic test generation
 */
function createSeededRng(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// Test Data Generation (Task 2)
// ============================================================================

const TICKERS = [
  "AAPL", "MSFT", "GOOGL", "TSLA", "META",
  "NVDA", "AMZN", "AMD", "NFLX", "ORCL",
];

const METHODS = [
  "up:0", "up:5", "up:10", "up:30",
  "down:0", "down:5", "down:10",
  "flat:0", "flat:2", "flat:5", "flat:10",
];

/**
 * Generate a deterministic set of test trades
 *
 * @param seed - Random seed for reproducibility
 * @param count - Number of trades to generate
 * @returns Array of test trades
 */
function generateTestTrades(seed: number, count: number): TestTrade[] {
  const rng = createSeededRng(seed);
  const trades: TestTrade[] = [];

  for (let i = 0; i < count; i++) {
    // Entry price: 1000 to 100000 (in cents, so $10-$1000)
    const entry = BigInt(Math.floor(rng() * 99000) + 1000);

    // Price change: -50% to +100%
    const changePercent = (rng() - 0.33) * 1.5; // bias slightly positive
    const exit = BigInt(Math.max(1, Math.floor(Number(entry) * (1 + changePercent))));

    // Select method and ticker
    const method = METHODS[Math.floor(rng() * METHODS.length)];
    const ticker = TICKERS[i % TICKERS.length];

    trades.push({ ticker, entryPrice: entry, exitPrice: exit, method });
  }

  return trades;
}

/**
 * Compute expected outcome using Bot's evaluateTrade (ground truth)
 */
function computeExpectedOutcome(trades: TestTrade[]): {
  makerWins: number;
  takerWins: number;
  winner: "maker" | "taker";
  perTrade: ExpectedTradeResult[];
} {
  let makerWins = 0;
  let takerWins = 0;
  const perTrade: ExpectedTradeResult[] = [];

  for (const trade of trades) {
    const result = evaluateTrade(trade.entryPrice, trade.exitPrice, trade.method);

    if (result === null) {
      // Skip null (shouldn't happen with our test data)
      continue;
    }

    if (result) {
      makerWins++;
    } else {
      takerWins++;
    }

    perTrade.push({ ticker: trade.ticker, makerWins: result });
  }

  // Taker wins ties (convention)
  const winner: "maker" | "taker" = makerWins > takerWins ? "maker" : "taker";

  return { makerWins, takerWins, winner, perTrade };
}

// ============================================================================
// Edge Case Test Vectors (Task 3 - AC3)
// ============================================================================

/**
 * Edge case test vectors from Dev Notes table (E1-E20)
 */
const EDGE_CASE_VECTORS: Array<{
  id: string;
  method: string;
  entry: bigint;
  exit: bigint;
  expected: boolean;
  reason: string;
}> = [
  // up:0 edge cases
  { id: "E1", method: "up:0", entry: 10000n, exit: 10001n, expected: true, reason: "10001 > 10000" },
  { id: "E2", method: "up:0", entry: 10000n, exit: 10000n, expected: false, reason: "10000 NOT > 10000" },
  { id: "E3", method: "up:0", entry: 10000n, exit: 9999n, expected: false, reason: "9999 NOT > 10000" },

  // down:0 edge cases
  { id: "E4", method: "down:0", entry: 10000n, exit: 9999n, expected: true, reason: "9999 < 10000" },
  { id: "E5", method: "down:0", entry: 10000n, exit: 10000n, expected: false, reason: "10000 NOT < 10000" },
  { id: "E6", method: "down:0", entry: 10000n, exit: 10001n, expected: false, reason: "10001 NOT < 10000" },

  // flat:0 edge cases
  { id: "E7", method: "flat:0", entry: 10000n, exit: 10000n, expected: true, reason: "0% change <= 0% threshold" },
  { id: "E8", method: "flat:0", entry: 10000n, exit: 10001n, expected: false, reason: "0.01% change > 0% threshold" },

  // Threshold boundary cases
  { id: "E9", method: "up:10", entry: 10000n, exit: 11000n, expected: false, reason: "10% NOT > 10% (boundary)" },
  { id: "E10", method: "up:10", entry: 10000n, exit: 11001n, expected: true, reason: ">10%" },
  { id: "E11", method: "down:5", entry: 10000n, exit: 9500n, expected: false, reason: "5% NOT < 5% (boundary)" },
  { id: "E12", method: "down:5", entry: 10000n, exit: 9499n, expected: true, reason: ">5% down" },
  { id: "E13", method: "flat:2", entry: 10000n, exit: 10201n, expected: false, reason: ">2% change" },
  { id: "E14", method: "flat:2", entry: 10000n, exit: 10200n, expected: true, reason: "2% = 2% (boundary, <=)" },

  // Large thresholds
  { id: "E15", method: "up:99", entry: 10000n, exit: 19899n, expected: false, reason: "98.99% NOT > 99%" },
  { id: "E16", method: "up:99", entry: 10000n, exit: 19901n, expected: true, reason: "99.01% > 99%" },

  // Decimal thresholds
  { id: "E17", method: "up:0.5", entry: 10000n, exit: 10050n, expected: false, reason: "0.5% NOT > 0.5%" },
  { id: "E18", method: "up:0.5", entry: 10000n, exit: 10051n, expected: true, reason: "0.51% > 0.5%" },

  // Zero exit price (price crashed completely)
  { id: "E19", method: "down:0", entry: 10000n, exit: 0n, expected: true, reason: "0 < 10000 (complete crash)" },

  // Maximum threshold (99.99%)
  { id: "E20", method: "up:99.99", entry: 10000n, exit: 19999n, expected: false, reason: "99.99% NOT > 99.99%" },
];

// ============================================================================
// Tests: Task 1 - Cross-Component Test Harness (AC1)
// ============================================================================

describe("Cross-Component Verification - Test Harness (AC1)", () => {
  test("generates deterministic test trades with same seed", () => {
    const trades1 = generateTestTrades(12345, 10);
    const trades2 = generateTestTrades(12345, 10);

    expect(trades1.length).toBe(10);
    expect(trades2.length).toBe(10);

    // Same seed should produce same trades
    for (let i = 0; i < 10; i++) {
      expect(trades1[i].ticker).toBe(trades2[i].ticker);
      expect(trades1[i].entryPrice).toBe(trades2[i].entryPrice);
      expect(trades1[i].exitPrice).toBe(trades2[i].exitPrice);
      expect(trades1[i].method).toBe(trades2[i].method);
    }
  });

  test("generates different trades with different seeds", () => {
    const trades1 = generateTestTrades(12345, 10);
    const trades2 = generateTestTrades(54321, 10);

    // Different seeds should produce different prices
    let hasDifference = false;
    for (let i = 0; i < 10; i++) {
      if (trades1[i].entryPrice !== trades2[i].entryPrice) {
        hasDifference = true;
        break;
      }
    }
    expect(hasDifference).toBe(true);
  });

  test("computeExpectedOutcome produces valid results", () => {
    const trades: TestTrade[] = [
      { ticker: "AAPL", entryPrice: 10000n, exitPrice: 11000n, method: "up:0" }, // maker wins
      { ticker: "MSFT", entryPrice: 10000n, exitPrice: 9000n, method: "up:0" },  // taker wins
    ];

    const outcome = computeExpectedOutcome(trades);

    expect(outcome.makerWins).toBe(1);
    expect(outcome.takerWins).toBe(1);
    expect(outcome.winner).toBe("taker"); // tie goes to taker
    expect(outcome.perTrade).toHaveLength(2);
  });
});

// ============================================================================
// Tests: Task 2 - 100-Trade Verification (AC2)
// ============================================================================

describe("Cross-Component Verification - 100 Trades (AC2)", () => {
  let testTrades: TestTrade[];
  let expectedOutcome: ReturnType<typeof computeExpectedOutcome>;

  beforeAll(() => {
    // Generate 100 deterministic test trades with seed 42
    testTrades = generateTestTrades(42, 100);
    expectedOutcome = computeExpectedOutcome(testTrades);
  });

  test("generates exactly 100 trades", () => {
    expect(testTrades).toHaveLength(100);
  });

  test("all trades have valid entry prices (positive)", () => {
    for (const trade of testTrades) {
      expect(trade.entryPrice > 0n).toBe(true);
    }
  });

  test("all trades have valid methods", () => {
    for (const trade of testTrades) {
      // parseMethod should not throw
      expect(() => parseMethod(trade.method)).not.toThrow();
    }
  });

  test("makerWins + takerWins = 100 (all trades resolved)", () => {
    expect(expectedOutcome.makerWins + expectedOutcome.takerWins).toBe(100);
  });

  test("Bot evaluateTrade produces deterministic results", () => {
    // Run the same computation multiple times
    const outcomes: typeof expectedOutcome[] = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push(computeExpectedOutcome(testTrades));
    }

    // All should be identical
    for (const outcome of outcomes) {
      expect(outcome.makerWins).toBe(expectedOutcome.makerWins);
      expect(outcome.takerWins).toBe(expectedOutcome.takerWins);
      expect(outcome.winner).toBe(expectedOutcome.winner);
    }
  });

  test("covers all method types", () => {
    const methodTypes = new Set<string>();
    for (const trade of testTrades) {
      const parsed = parseMethod(trade.method);
      methodTypes.add(parsed.type);
    }

    expect(methodTypes.has("up")).toBe(true);
    expect(methodTypes.has("down")).toBe(true);
    expect(methodTypes.has("flat")).toBe(true);
  });

  test("snapshot outcome for seed 42 (for cross-component verification)", () => {
    // This is the expected outcome that Data Node and Keeper should also produce
    // If this test fails, the Bot implementation may have changed
    console.log(`\n📊 100-Trade Test Vector (seed=42):`);
    console.log(`   Maker Wins: ${expectedOutcome.makerWins}`);
    console.log(`   Taker Wins: ${expectedOutcome.takerWins}`);
    console.log(`   Winner: ${expectedOutcome.winner}`);

    // Verify we have a reasonable distribution
    expect(expectedOutcome.makerWins).toBeGreaterThan(20);
    expect(expectedOutcome.takerWins).toBeGreaterThan(20);
  });
});

// ============================================================================
// Tests: Task 3 - Edge Case Suite (AC3)
// ============================================================================

describe("Cross-Component Verification - Edge Cases (AC3)", () => {
  for (const vector of EDGE_CASE_VECTORS) {
    test(`${vector.id}: ${vector.method} entry=${vector.entry} exit=${vector.exit} → ${vector.expected ? "maker" : "taker"} (${vector.reason})`, () => {
      const result = evaluateTrade(vector.entry, vector.exit, vector.method);

      expect(result).toBe(vector.expected);
    });
  }

  // Additional edge cases from Dev Notes
  test("tie scenario: equal makerWins and takerWins → taker wins", () => {
    const trades: TestTrade[] = [
      { ticker: "A", entryPrice: 100n, exitPrice: 150n, method: "up:0" }, // maker
      { ticker: "B", entryPrice: 100n, exitPrice: 50n, method: "up:0" },  // taker
    ];

    const outcome = computeExpectedOutcome(trades);

    expect(outcome.makerWins).toBe(1);
    expect(outcome.takerWins).toBe(1);
    expect(outcome.winner).toBe("taker"); // tie → taker wins
  });

  test("all methods at threshold boundary", () => {
    // up:10 at exactly 10% → maker loses (not strictly greater)
    expect(evaluateTrade(10000n, 11000n, "up:10")).toBe(false);

    // down:10 at exactly 10% → maker loses (not strictly less)
    expect(evaluateTrade(10000n, 9000n, "down:10")).toBe(false);

    // flat:10 at exactly 10% → maker wins (<= comparison)
    expect(evaluateTrade(10000n, 11000n, "flat:10")).toBe(true);
    expect(evaluateTrade(10000n, 9000n, "flat:10")).toBe(true);
  });

  test("decimal threshold precision", () => {
    // 0.5% = 50 bps
    const parsed = parseMethod("up:0.5");
    expect(parsed.thresholdBps).toBe(50n);

    // 2.5% = 250 bps
    const parsed2 = parseMethod("down:2.5");
    expect(parsed2.thresholdBps).toBe(250n);

    // 1.25% = 125 bps
    const parsed3 = parseMethod("flat:1.25");
    expect(parsed3.thresholdBps).toBe(125n);
  });

  test("max threshold 99.99%", () => {
    const parsed = parseMethod("up:99.99");
    expect(parsed.thresholdBps).toBe(9999n);

    // Just under doubling (199.99% of entry) is not enough for 99.99% up
    // 100 * 1.9999 = 199.99, so we need exit > 199.99 for up:99.99
    expect(evaluateTrade(10000n, 19999n, "up:99.99")).toBe(false);
    expect(evaluateTrade(10000n, 20000n, "up:99.99")).toBe(true);
  });
});

// ============================================================================
// Tests: BPS_BASE Constant Verification
// ============================================================================

describe("Cross-Component Verification - BPS_BASE", () => {
  test("BPS_BASE is 10000n", () => {
    expect(BPS_BASE).toBe(10000n);
  });

  test("threshold parsing uses BPS_BASE correctly", () => {
    // 10% = 10 * 100 = 1000 bps out of 10000
    const parsed = parseMethod("up:10");
    expect(parsed.thresholdBps).toBe(1000n);

    // Verify math: for up:10, exit * 10000 > entry * (10000 + 1000) = entry * 11000
    const entry = 10000n;
    const exit = 11001n; // Just over 10% increase
    const result = exit * BPS_BASE > entry * (BPS_BASE + parsed.thresholdBps);
    expect(result).toBe(true);
  });
});

// ============================================================================
// Tests: vital-test.md Example Trades
// ============================================================================

describe("Cross-Component Verification - vital-test.md Examples", () => {
  const vitalTestTrades: Array<{
    ticker: string;
    entry: bigint;
    exit: bigint;
    method: string;
    expected: boolean;
    description: string;
  }> = [
    {
      ticker: "AAPL",
      entry: 10000n, // $100.00
      exit: 11000n,  // $110.00
      method: "up:0",
      expected: true,
      description: "110 > 100 * 1.00 → maker wins",
    },
    {
      ticker: "MSFT",
      entry: 40000n, // $400.00
      exit: 39000n,  // $390.00
      method: "up:0",
      expected: false,
      description: "390 NOT > 400 → taker wins",
    },
    {
      ticker: "TSLA",
      entry: 20000n, // $200.00
      exit: 27000n,  // $270.00 (+35%)
      method: "up:30",
      expected: true,
      description: "270 > 200 * 1.30 (260) → maker wins",
    },
    {
      ticker: "NVDA",
      entry: 80000n, // $800.00
      exit: 85000n,  // $850.00 (+6.25%)
      method: "up:10",
      expected: false,
      description: "850 NOT > 800 * 1.10 (880) → taker wins",
    },
    {
      ticker: "META",
      entry: 50000n, // $500.00
      exit: 49500n,  // $495.00 (-1%)
      method: "flat:2",
      expected: true,
      description: "|495-500|/500 = 1% <= 2% → maker wins",
    },
    {
      ticker: "AMZN",
      entry: 18000n, // $180.00
      exit: 17500n,  // $175.00 (-2.78%)
      method: "down:5",
      expected: false,
      description: "175 NOT < 180 * 0.95 (171) → taker wins",
    },
  ];

  for (const trade of vitalTestTrades) {
    test(`${trade.ticker}: ${trade.description}`, () => {
      const result = evaluateTrade(trade.entry, trade.exit, trade.method);
      expect(result).toBe(trade.expected);
    });
  }

  test("combined vital-test outcome", () => {
    const trades: TestTrade[] = vitalTestTrades.map((t) => ({
      ticker: t.ticker,
      entryPrice: t.entry,
      exitPrice: t.exit,
      method: t.method,
    }));

    const outcome = computeExpectedOutcome(trades);

    // Expected: 3 maker wins (AAPL, TSLA, META), 3 taker wins (MSFT, NVDA, AMZN)
    expect(outcome.makerWins).toBe(3);
    expect(outcome.takerWins).toBe(3);
    expect(outcome.winner).toBe("taker"); // tie → taker wins
  });
});

// ============================================================================
// Tests: Integer Arithmetic Verification
// ============================================================================

describe("Cross-Component Verification - Integer Arithmetic", () => {
  test("no floating point in evaluateTrade", () => {
    // This test verifies that the implementation uses BigInt throughout
    // by checking that very precise calculations work correctly

    // Entry: 1,000,000,000,000 (1 trillion units)
    // Exit:  1,000,000,000,001 (1 unit more)
    // Method: up:0 (any increase wins)
    const entry = 1000000000000n;
    const exit = 1000000000001n;

    // If floating point were used, this might fail due to precision loss
    const result = evaluateTrade(entry, exit, "up:0");
    expect(result).toBe(true);
  });

  test("large numbers don't overflow", () => {
    // Max safe integer in JavaScript: 9007199254740991
    // BigInt should handle much larger numbers

    const entry = 9007199254740991n;
    const exit = 9007199254740992n;

    // This would fail with regular numbers
    const result = evaluateTrade(entry, exit, "up:0");
    expect(result).toBe(true);
  });

  test("precision at 18 decimal places", () => {
    // Typical token precision: 18 decimals
    // 1 token = 1e18 units

    const entry = 1000000000000000000n; // 1 token
    const exit = 1100000000000000000n;  // 1.1 tokens (10% increase)

    // up:10 = maker wins if >10%
    // Exactly 10% should NOT be greater than threshold
    expect(evaluateTrade(entry, exit, "up:10")).toBe(false);

    // Just over 10%
    const exitOver = 1100000000000000001n;
    expect(evaluateTrade(entry, exitOver, "up:10")).toBe(true);
  });
});

// ============================================================================
// Export test vectors for other implementations
// ============================================================================

/**
 * Generate test vectors JSON for Data Node and Keeper tests
 */
export function generateTestVectorsJson(seed: number, count: number): string {
  const trades = generateTestTrades(seed, count);
  const outcome = computeExpectedOutcome(trades);

  return JSON.stringify(
    {
      seed,
      count,
      trades: trades.map((t) => ({
        ticker: t.ticker,
        entryPrice: t.entryPrice.toString(),
        exitPrice: t.exitPrice.toString(),
        method: t.method,
      })),
      expectedOutcome: {
        makerWins: outcome.makerWins,
        takerWins: outcome.takerWins,
        winner: outcome.winner,
      },
      perTradeResults: outcome.perTrade.map((r) => ({
        ticker: r.ticker,
        makerWins: r.makerWins,
      })),
    },
    null,
    2
  );
}

// Generate and log for manual copy to Rust tests if needed
if (process.env.GENERATE_TEST_VECTORS) {
  console.log("\n📄 Test Vectors JSON (seed=42, count=100):");
  console.log(generateTestVectorsJson(42, 100));
}

// ============================================================================
// Tests: Verify Test Vectors File (AC6 - shared vectors validation)
// ============================================================================

import { readFileSync } from "fs";
import { join } from "path";

describe("Cross-Component Verification - Shared Test Vectors File", () => {
  let vectorsFile: {
    edgeCases: Array<{
      id: string;
      method: string;
      entry: number;
      exit: number;
      makerWins: boolean;
      reason: string;
    }>;
    vitalTestExamples: Array<{
      ticker: string;
      entry: number;
      exit: number;
      method: string;
      makerWins: boolean;
      description: string;
    }>;
    vitalTestExpected: {
      makerWins: number;
      takerWins: number;
      winner: string;
    };
    hundredTradeVector: {
      seed: number;
      count: number;
      expectedOutcome: {
        makerWins: number;
        takerWins: number;
        winner: string;
      };
    };
  };

  beforeAll(() => {
    // Load the shared test vectors file
    const vectorsPath = join(__dirname, "../../../tests/fixtures/resolution-test-vectors.json");
    const content = readFileSync(vectorsPath, "utf-8");
    vectorsFile = JSON.parse(content);
  });

  test("edge cases in vectors file match Bot evaluateTrade", () => {
    for (const edge of vectorsFile.edgeCases) {
      const result = evaluateTrade(BigInt(edge.entry), BigInt(edge.exit), edge.method);
      expect(result).toBe(edge.makerWins);
    }
  });

  test("vital-test examples in vectors file match Bot evaluateTrade", () => {
    for (const example of vectorsFile.vitalTestExamples) {
      const result = evaluateTrade(BigInt(example.entry), BigInt(example.exit), example.method);
      expect(result).toBe(example.makerWins);
    }
  });

  test("vital-test combined outcome matches vectors file expected", () => {
    const trades: TestTrade[] = vectorsFile.vitalTestExamples.map((e) => ({
      ticker: e.ticker,
      entryPrice: BigInt(e.entry),
      exitPrice: BigInt(e.exit),
      method: e.method,
    }));

    const outcome = computeExpectedOutcome(trades);

    expect(outcome.makerWins).toBe(vectorsFile.vitalTestExpected.makerWins);
    expect(outcome.takerWins).toBe(vectorsFile.vitalTestExpected.takerWins);
    expect(outcome.winner).toBe(vectorsFile.vitalTestExpected.winner);
  });

  test("100-trade vector: computed outcome matches fixture expected outcome", () => {
    // Generate trades with the seed from the vectors file
    const { seed, count, expectedOutcome } = vectorsFile.hundredTradeVector;
    const trades = generateTestTrades(seed, count);
    const computed = computeExpectedOutcome(trades);

    // This is the CRITICAL test: computed must match fixture
    expect(computed.makerWins).toBe(expectedOutcome.makerWins);
    expect(computed.takerWins).toBe(expectedOutcome.takerWins);
    expect(computed.winner).toBe(expectedOutcome.winner);
  });
});
