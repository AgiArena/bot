/**
 * Outcome Computer Tests (Story 5-2: Method-Based Resolution)
 *
 * Tests for method-based outcome computation:
 * - parseMethod validation (AC: #1)
 * - evaluateTrade for up/down/flat methods (AC: #2, #3, #4)
 * - BigInt determinism (AC: #5)
 * - Tie-breaking convention (AC: #6)
 * - Null exit price handling (AC: #7)
 */

import { describe, test, expect } from "bun:test";
import {
  parseMethod,
  evaluateTrade,
  computeOutcome,
  computeOutcomeFromTrades,
  outcomesMatch,
  validateOutcomeConsistency,
  type OutcomeResult,
  type ExitPrices,
  type ParsedMethod,
} from "../p2p/outcome-computer";
import type { MerkleTree, Trade } from "../merkle-tree";

// ============================================================================
// Test Helpers
// ============================================================================

const MAKER = "0x1111111111111111111111111111111111111111";
const TAKER = "0x2222222222222222222222222222222222222222";

function createTrade(
  index: number,
  method: string,
  entryPrice: bigint,
): Trade {
  return {
    tradeId: `0x${"0".repeat(62)}${index.toString(16).padStart(2, "0")}` as `0x${string}`,
    ticker: `TICKER${index}`,
    source: "test",
    method,
    entryPrice,
    exitPrice: 0n,
    won: false,
    cancelled: false,
  };
}

function createTree(trades: Trade[]): MerkleTree {
  return {
    snapshotId: "test-snapshot",
    trades,
    leaves: trades.map(() => "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`),
    root: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
  };
}

// ============================================================================
// Task 5.2: parseMethod tests (AC: #1)
// ============================================================================

describe("parseMethod - valid formats", () => {
  test("parses up:0 correctly", () => {
    const result = parseMethod("up:0");
    expect(result.type).toBe("up");
    expect(result.thresholdBps).toBe(0n);
  });

  test("parses up:10 correctly (10% → 1000 bps)", () => {
    const result = parseMethod("up:10");
    expect(result.type).toBe("up");
    expect(result.thresholdBps).toBe(1000n);
  });

  test("parses down:5 correctly (5% → 500 bps)", () => {
    const result = parseMethod("down:5");
    expect(result.type).toBe("down");
    expect(result.thresholdBps).toBe(500n);
  });

  test("parses flat:2 correctly (2% → 200 bps)", () => {
    const result = parseMethod("flat:2");
    expect(result.type).toBe("flat");
    expect(result.thresholdBps).toBe(200n);
  });

  test("parses decimal thresholds correctly (10.5% → 1050 bps)", () => {
    const result = parseMethod("up:10.5");
    expect(result.thresholdBps).toBe(1050n);
  });

  test("parses up:30 correctly (30% → 3000 bps)", () => {
    const result = parseMethod("up:30");
    expect(result.type).toBe("up");
    expect(result.thresholdBps).toBe(3000n);
  });

  test("parses down:0.5 correctly (0.5% → 50 bps)", () => {
    const result = parseMethod("down:0.5");
    expect(result.type).toBe("down");
    expect(result.thresholdBps).toBe(50n);
  });

  test("parses flat:0 correctly", () => {
    const result = parseMethod("flat:0");
    expect(result.type).toBe("flat");
    expect(result.thresholdBps).toBe(0n);
  });
});

describe("parseMethod - invalid formats", () => {
  test("throws for uppercase type", () => {
    expect(() => parseMethod("UP:10")).toThrow("Invalid method format");
  });

  test("throws for mixed case type", () => {
    expect(() => parseMethod("Up:10")).toThrow("Invalid method format");
  });

  test("throws for unknown type", () => {
    expect(() => parseMethod("sideways:5")).toThrow("Invalid method format");
  });

  test("throws for missing colon", () => {
    expect(() => parseMethod("up10")).toThrow("Invalid method format");
  });

  test("throws for missing threshold", () => {
    expect(() => parseMethod("up:")).toThrow("Invalid method format");
  });

  test("throws for negative threshold", () => {
    expect(() => parseMethod("up:-5")).toThrow("Invalid method format");
  });

  test("throws for threshold > 99.99%", () => {
    expect(() => parseMethod("up:100")).toThrow("Invalid threshold");
  });

  test("throws for threshold with too many decimals", () => {
    expect(() => parseMethod("up:10.555")).toThrow("Invalid method format");
  });
});

// ============================================================================
// Task 5.3: evaluateTrade tests for up method (AC: #2)
// ============================================================================

describe("evaluateTrade - up method (AC: #2)", () => {
  test("up:0 - returns true when exit > entry", () => {
    // entry=10000, exit=11000, method="up:0"
    // 11000 * 10000 > 10000 * 10000 → TRUE
    const result = evaluateTrade(10000n, 11000n, "up:0");
    expect(result).toBe(true);
  });

  test("up:0 - returns null when exit = entry (no movement = skip)", () => {
    // entry=10000, exit=10000 → no price movement → skip
    const result = evaluateTrade(10000n, 10000n, "up:0");
    expect(result).toBe(null);
  });

  test("up:0 - returns false when exit < entry", () => {
    const result = evaluateTrade(10000n, 9000n, "up:0");
    expect(result).toBe(false);
  });

  test("up:10 - returns true when exit > entry * 1.10", () => {
    // entry=10000, exit=11001 > 10000 * 1.10 = 11000 → TRUE
    const result = evaluateTrade(10000n, 11001n, "up:10");
    expect(result).toBe(true);
  });

  test("up:10 - returns false when exit = entry * 1.10 (boundary)", () => {
    // entry=10000, exit=11000 = 10000 * 1.10 → FALSE (not greater than)
    const result = evaluateTrade(10000n, 11000n, "up:10");
    expect(result).toBe(false);
  });

  test("up:30 - test from vital-test.md (TSLA)", () => {
    // entry=20000, exit=27000, method="up:30"
    // 27000 * 10000 = 270,000,000 > 20000 * 13000 = 260,000,000 → TRUE
    const result = evaluateTrade(20000n, 27000n, "up:30");
    expect(result).toBe(true);
  });

  test("up:10 - test from vital-test.md (NVDA)", () => {
    // entry=80000, exit=85000, method="up:10"
    // 85000 * 10000 = 850,000,000 > 80000 * 11000 = 880,000,000 → FALSE
    const result = evaluateTrade(80000n, 85000n, "up:10");
    expect(result).toBe(false);
  });
});

// ============================================================================
// Task 5.4: evaluateTrade tests for down method (AC: #3)
// ============================================================================

describe("evaluateTrade - down method (AC: #3)", () => {
  test("down:0 - returns true when exit < entry", () => {
    // entry=10000, exit=9000, method="down:0"
    // 9000 * 10000 < 10000 * 10000 → TRUE
    const result = evaluateTrade(10000n, 9000n, "down:0");
    expect(result).toBe(true);
  });

  test("down:0 - returns null when exit = entry (no movement = skip)", () => {
    // entry=10000, exit=10000 → no price movement → skip
    const result = evaluateTrade(10000n, 10000n, "down:0");
    expect(result).toBe(null);
  });

  test("down:0 - returns false when exit > entry", () => {
    const result = evaluateTrade(10000n, 11000n, "down:0");
    expect(result).toBe(false);
  });

  test("down:5 - returns true when exit < entry * 0.95", () => {
    // entry=10000, exit=9400 < 10000 * 0.95 = 9500 → TRUE
    const result = evaluateTrade(10000n, 9400n, "down:5");
    expect(result).toBe(true);
  });

  test("down:5 - returns false when exit = entry * 0.95 (boundary)", () => {
    // entry=10000, exit=9500 = 10000 * 0.95 → FALSE (not less than)
    const result = evaluateTrade(10000n, 9500n, "down:5");
    expect(result).toBe(false);
  });

  test("down:5 - test from vital-test.md (AMZN)", () => {
    // entry=18000, exit=17500, method="down:5"
    // 17500 * 10000 = 175,000,000 < 18000 * 9500 = 171,000,000 → FALSE
    const result = evaluateTrade(18000n, 17500n, "down:5");
    expect(result).toBe(false);
  });

  test("down:10 - returns true when price dropped > 10%", () => {
    // entry=10000, exit=8900 < 10000 * 0.90 = 9000 → TRUE
    const result = evaluateTrade(10000n, 8900n, "down:10");
    expect(result).toBe(true);
  });
});

// ============================================================================
// Task 5.5: evaluateTrade tests for flat method (AC: #4)
// ============================================================================

describe("evaluateTrade - flat method (AC: #4)", () => {
  test("flat:0 - returns null when exit = entry (no movement = skip)", () => {
    // entry=10000, exit=10000 → no price movement → skip
    const result = evaluateTrade(10000n, 10000n, "flat:0");
    expect(result).toBe(null);
  });

  test("flat:0 - returns false when exit != entry", () => {
    // entry=10000, exit=10001, method="flat:0"
    // |10001 - 10000| * 10000 = 10000 <= 10000 * 0 = 0 → FALSE
    const result = evaluateTrade(10000n, 10001n, "flat:0");
    expect(result).toBe(false);
  });

  test("flat:2 - test from vital-test.md (META)", () => {
    // entry=50000, exit=49500, method="flat:2"
    // |49500 - 50000| * 10000 = 500 * 10000 = 5,000,000 <= 50000 * 200 = 10,000,000 → TRUE
    const result = evaluateTrade(50000n, 49500n, "flat:2");
    expect(result).toBe(true);
  });

  test("flat:2 - returns false when change > 2%", () => {
    // entry=50000, exit=48000 (4% drop)
    // |48000 - 50000| * 10000 = 2000 * 10000 = 20,000,000 <= 50000 * 200 = 10,000,000 → FALSE
    const result = evaluateTrade(50000n, 48000n, "flat:2");
    expect(result).toBe(false);
  });

  test("flat:5 - returns true for price increase within threshold", () => {
    // entry=10000, exit=10400 (4% up)
    // |10400 - 10000| * 10000 = 400 * 10000 = 4,000,000 <= 10000 * 500 = 5,000,000 → TRUE
    const result = evaluateTrade(10000n, 10400n, "flat:5");
    expect(result).toBe(true);
  });

  test("flat:5 - boundary case at exactly 5%", () => {
    // entry=10000, exit=10500 (exactly 5% up)
    // |10500 - 10000| * 10000 = 500 * 10000 = 5,000,000 <= 10000 * 500 = 5,000,000 → TRUE (<=)
    const result = evaluateTrade(10000n, 10500n, "flat:5");
    expect(result).toBe(true);
  });
});

// ============================================================================
// Task 5.6: Edge case tests (AC: #7)
// ============================================================================

describe("evaluateTrade - edge cases", () => {
  test("returns null for null exit price (pending)", () => {
    const result = evaluateTrade(10000n, null, "up:0");
    expect(result).toBe(null);
  });

  test("throws for zero entry price", () => {
    expect(() => evaluateTrade(0n, 10000n, "up:0")).toThrow("entry price cannot be zero");
  });

  test("handles very large prices without overflow", () => {
    // 18 decimals: 1 billion dollars worth at $1 = 1e27
    const entry = 1000000000000000000000000000n; // 1e27
    const exit = 1100000000000000000000000000n;  // 1.1e27
    const result = evaluateTrade(entry, exit, "up:0");
    expect(result).toBe(true);
  });

  test("handles small price differences correctly", () => {
    // entry=1000000, exit=1000001 (0.0001% change)
    const result = evaluateTrade(1000000n, 1000001n, "up:0");
    expect(result).toBe(true);
  });
});

// ============================================================================
// Task 5.7: computeOutcome tests with tie scenarios (AC: #6)
// ============================================================================

describe("computeOutcome - tie scenarios (AC: #6)", () => {
  test("taker wins on exact tie", () => {
    const trades = [
      createTrade(0, "up:0", 100n),
      createTrade(1, "up:0", 100n),
    ];
    const tree = createTree(trades);

    const exitPrices: ExitPrices = new Map([
      [0, 150n], // Maker wins
      [1, 50n],  // Taker wins
    ]);

    const result = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(result.makerWins).toBe(1);
    expect(result.takerWins).toBe(1);
    expect(result.total).toBe(2);
    expect(result.winner).toBe(TAKER); // Taker wins ties
  });

  test("maker wins when more wins than taker", () => {
    const trades = [
      createTrade(0, "up:0", 100n),
      createTrade(1, "up:0", 100n),
      createTrade(2, "up:0", 100n),
    ];
    const tree = createTree(trades);

    const exitPrices: ExitPrices = new Map([
      [0, 150n], // Maker wins
      [1, 150n], // Maker wins
      [2, 50n],  // Taker wins
    ]);

    const result = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(result.makerWins).toBe(2);
    expect(result.takerWins).toBe(1);
    expect(result.winner).toBe(MAKER);
  });

  test("taker wins when more wins than maker", () => {
    const trades = [
      createTrade(0, "up:0", 100n),
      createTrade(1, "up:0", 100n),
      createTrade(2, "up:0", 100n),
    ];
    const tree = createTree(trades);

    const exitPrices: ExitPrices = new Map([
      [0, 50n],  // Taker wins
      [1, 50n],  // Taker wins
      [2, 150n], // Maker wins
    ]);

    const result = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(result.makerWins).toBe(1);
    expect(result.takerWins).toBe(2);
    expect(result.winner).toBe(TAKER);
  });

  test("taker wins when all trades lost by maker", () => {
    const trades = [
      createTrade(0, "up:0", 100n),
      createTrade(1, "up:0", 100n),
    ];
    const tree = createTree(trades);

    const exitPrices: ExitPrices = new Map([
      [0, 50n], // Taker wins
      [1, 50n], // Taker wins
    ]);

    const result = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(result.makerWins).toBe(0);
    expect(result.takerWins).toBe(2);
    expect(result.winner).toBe(TAKER);
  });
});

// ============================================================================
// Task 5.8: Determinism tests (AC: #5)
// ============================================================================

describe("evaluateTrade - determinism (AC: #5)", () => {
  test("same input produces same output (BigInt precision)", () => {
    const entry = 123456789012345678901234567890n;
    const exit = 135802467913580246791358024689n;
    const method = "up:10";

    const results: (boolean | null)[] = [];
    for (let i = 0; i < 100; i++) {
      results.push(evaluateTrade(entry, exit, method));
    }

    // All results should be identical
    const allSame = results.every((r) => r === results[0]);
    expect(allSame).toBe(true);
  });

  test("BigInt arithmetic matches expected calculation", () => {
    // Verify: 85000 * 10000 > 80000 * 11000
    // 850,000,000 > 880,000,000 = false
    const entry = 80000n;
    const exit = 85000n;
    const method = "up:10";

    const expected = (exit * 10000n) > (entry * 11000n); // false
    const result = evaluateTrade(entry, exit, method);

    expect(result).toBe(expected);
  });
});

// ============================================================================
// Complete scenario tests from vital-test.md
// ============================================================================

describe("computeOutcome - vital-test.md scenarios", () => {
  test("vital-test.md trades produce expected outcome", () => {
    // From Dev Notes table in story
    const trades = [
      createTrade(0, "up:0", 10000n),  // AAPL: entry=10000, exit=11000
      createTrade(1, "up:0", 40000n),  // MSFT: entry=40000, exit=39000
      createTrade(2, "up:30", 20000n), // TSLA: entry=20000, exit=27000
      createTrade(3, "up:10", 80000n), // NVDA: entry=80000, exit=85000
      createTrade(4, "flat:2", 50000n),// META: entry=50000, exit=49500
      createTrade(5, "down:5", 18000n),// AMZN: entry=18000, exit=17500
    ];
    const tree = createTree(trades);

    const exitPrices: ExitPrices = new Map([
      [0, 11000n], // AAPL: TRUE → Maker
      [1, 39000n], // MSFT: FALSE → Taker
      [2, 27000n], // TSLA: TRUE → Maker
      [3, 85000n], // NVDA: FALSE → Taker
      [4, 49500n], // META: TRUE → Maker
      [5, 17500n], // AMZN: FALSE → Taker
    ]);

    const result = computeOutcome(tree, exitPrices, MAKER, TAKER);

    // Expected: 3 maker wins (AAPL, TSLA, META), 3 taker wins (MSFT, NVDA, AMZN)
    expect(result.makerWins).toBe(3);
    expect(result.takerWins).toBe(3);
    expect(result.total).toBe(6);
    expect(result.winner).toBe(TAKER); // Tie → Taker wins
  });
});

// ============================================================================
// Null exit price handling (AC: #7)
// ============================================================================

describe("computeOutcome - null exit price handling (AC: #7)", () => {
  test("skips trades with null exit price", () => {
    const trades = [
      createTrade(0, "up:0", 100n),
      createTrade(1, "up:0", 100n),
      createTrade(2, "up:0", 100n),
    ];
    const tree = createTree(trades);

    const exitPrices: ExitPrices = new Map([
      [0, 150n],  // Maker wins
      [1, null],  // Pending - skipped
      [2, 50n],   // Taker wins
    ]);

    const result = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(result.makerWins).toBe(1);
    expect(result.takerWins).toBe(1);
    expect(result.total).toBe(2); // Only 2 counted
    expect(result.winner).toBe(TAKER); // Tie → Taker wins
  });

  test("skips trades with undefined exit price", () => {
    const trades = [
      createTrade(0, "up:0", 100n),
      createTrade(1, "up:0", 100n),
    ];
    const tree = createTree(trades);

    // Only provide one exit price
    const exitPrices: ExitPrices = new Map([
      [0, 150n], // Maker wins
      // [1] not set
    ]);

    const result = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(result.makerWins).toBe(1);
    expect(result.takerWins).toBe(0);
    expect(result.total).toBe(1);
    expect(result.winner).toBe(MAKER);
  });
});

// ============================================================================
// Utility function tests
// ============================================================================

describe("outcomesMatch", () => {
  test("matching outcomes return true", () => {
    const a: OutcomeResult = {
      makerWins: 5,
      takerWins: 3,
      total: 8,
      winner: MAKER,
    };
    const b: OutcomeResult = {
      makerWins: 5,
      takerWins: 3,
      total: 8,
      winner: MAKER.toLowerCase(),
    };

    expect(outcomesMatch(a, b)).toBe(true);
  });

  test("different makerWins returns false", () => {
    const a: OutcomeResult = {
      makerWins: 5,
      takerWins: 3,
      total: 8,
      winner: MAKER,
    };
    const b: OutcomeResult = {
      makerWins: 6,
      takerWins: 3,
      total: 9,
      winner: MAKER,
    };

    expect(outcomesMatch(a, b)).toBe(false);
  });

  test("different winner returns false", () => {
    const a: OutcomeResult = {
      makerWins: 5,
      takerWins: 3,
      total: 8,
      winner: MAKER,
    };
    const b: OutcomeResult = {
      makerWins: 5,
      takerWins: 3,
      total: 8,
      winner: TAKER,
    };

    expect(outcomesMatch(a, b)).toBe(false);
  });
});

describe("validateOutcomeConsistency", () => {
  test("valid outcome passes", () => {
    const outcome: OutcomeResult = {
      makerWins: 6,
      takerWins: 4,
      total: 10,
      winner: MAKER,
    };

    expect(validateOutcomeConsistency(outcome)).toBe(true);
  });

  test("invalid - total mismatch", () => {
    const outcome: OutcomeResult = {
      makerWins: 6,
      takerWins: 4,
      total: 11, // Should be 10
      winner: MAKER,
    };

    expect(validateOutcomeConsistency(outcome)).toBe(false);
  });
});

describe("computeOutcomeFromTrades", () => {
  test("works same as computeOutcome", () => {
    const trades = [
      createTrade(0, "up:0", 100n),
      createTrade(1, "down:0", 200n),
    ];

    const exitPrices: ExitPrices = new Map([
      [0, 150n], // up:0 → exit 150 > entry 100 → Maker wins
      [1, 150n], // down:0 → exit 150 < entry 200 → Maker wins (price dropped)
    ]);

    const result = computeOutcomeFromTrades(trades, exitPrices, MAKER, TAKER);

    expect(result.makerWins).toBe(2); // Both trades maker wins
    expect(result.takerWins).toBe(0);
    expect(result.total).toBe(2);
    expect(result.winner).toBe(MAKER);
  });
});

// ============================================================================
// Mixed method scenarios
// ============================================================================

describe("computeOutcome - mixed methods", () => {
  test("mixed up/down/flat methods", () => {
    const trades = [
      createTrade(0, "up:0", 1000n),   // price goes up → maker wins
      createTrade(1, "down:0", 1000n), // price goes up → taker wins (down expects drop)
      createTrade(2, "flat:10", 1000n),// price stays flat → maker wins
    ];
    const tree = createTree(trades);

    const exitPrices: ExitPrices = new Map([
      [0, 1100n], // up:0 → 1100 > 1000 → maker wins
      [1, 1100n], // down:0 → 1100 < 1000 = false → taker wins
      [2, 1050n], // flat:10 → |1050-1000|*10000 = 500000 <= 1000*1000 = 1000000 → maker wins
    ]);

    const result = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(result.makerWins).toBe(2);
    expect(result.takerWins).toBe(1);
    expect(result.winner).toBe(MAKER);
  });
});
