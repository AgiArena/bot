/**
 * Scenario A: Happy Path E2E Test (Story 5-4 AC4)
 *
 * Tests the bilateral settlement happy path where both bots agree on the outcome:
 * 1. Bot1 (Maker) and Bot2 (Taker) create portfolios
 * 2. Both compute outcomes independently
 * 3. Both produce IDENTICAL outcomes
 * 4. settleByAgreement succeeds with both signatures
 *
 * NOTE: This is a unit test that simulates the scenario.
 * Full E2E testing requires running against live chain (see scripts/run-cross-component-tests.sh)
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  parseMethod,
  evaluateTrade,
  buildBilateralMerkleTree,
  computeTradesRoot,
  type MerkleTree,
  type Trade,
} from "../merkle-tree";
import {
  computeOutcome,
  computeOutcomeFromTrades,
  outcomesMatch,
  type OutcomeResult,
  type ExitPrices,
} from "../p2p/outcome-computer";
import { encodeAbiParameters, parseAbiParameters, keccak256 } from "viem";

// ============================================================================
// Test Constants
// ============================================================================

const MAKER_ADDRESS = "0x1111111111111111111111111111111111111111";
const TAKER_ADDRESS = "0x2222222222222222222222222222222222222222";
const SNAPSHOT_ID = "stock-all-2026-02-02-16";

// Sample stocks with entry and exit prices (in cents)
const SAMPLE_STOCKS = [
  { ticker: "AAPL", entryPrice: 17850n, exitPrice: 18230n },  // +2.1%
  { ticker: "MSFT", entryPrice: 41520n, exitPrice: 41050n },  // -1.1%
  { ticker: "GOOGL", entryPrice: 14180n, exitPrice: 19500n }, // +37%
  { ticker: "TSLA", entryPrice: 24500n, exitPrice: 22000n },  // -10%
  { ticker: "META", entryPrice: 52030n, exitPrice: 52500n },  // +0.9%
  { ticker: "NVDA", entryPrice: 89000n, exitPrice: 90000n },  // +1.1%
  { ticker: "AMZN", entryPrice: 18000n, exitPrice: 17500n },  // -2.8%
  { ticker: "AMD", entryPrice: 16000n, exitPrice: 16500n },   // +3.1%
  { ticker: "NFLX", entryPrice: 62000n, exitPrice: 60000n },  // -3.2%
  { ticker: "ORCL", entryPrice: 12500n, exitPrice: 12500n },  // 0%
];

// Maker's portfolio: all betting price goes up (up:0)
const MAKER_METHODS = SAMPLE_STOCKS.map(() => "up:0");

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Build a portfolio identical to what both bots would have
 */
function buildSharedPortfolio(): {
  tree: MerkleTree;
  exitPrices: ExitPrices;
  tickers: string[];
} {
  const tickers = SAMPLE_STOCKS.map((s) => s.ticker);
  const entryPrices = new Map<number, bigint>();
  const exitPrices: ExitPrices = new Map();

  SAMPLE_STOCKS.forEach((stock, i) => {
    entryPrices.set(i, stock.entryPrice);
    exitPrices.set(i, stock.exitPrice);
  });

  const tree = buildBilateralMerkleTree(
    SNAPSHOT_ID,
    MAKER_METHODS,
    entryPrices,
    tickers
  );

  return { tree, exitPrices, tickers };
}

/**
 * Simulate Bot 1 computing outcome
 */
function bot1ComputeOutcome(
  tree: MerkleTree,
  exitPrices: ExitPrices
): OutcomeResult {
  return computeOutcome(tree, exitPrices, MAKER_ADDRESS, TAKER_ADDRESS);
}

/**
 * Simulate Bot 2 computing outcome (should be identical to Bot 1)
 */
function bot2ComputeOutcome(
  tree: MerkleTree,
  exitPrices: ExitPrices
): OutcomeResult {
  return computeOutcome(tree, exitPrices, MAKER_ADDRESS, TAKER_ADDRESS);
}

// ============================================================================
// Scenario A Tests (AC4)
// ============================================================================

describe("Scenario A: Happy Path - Both Bots Agree (AC4)", () => {
  let sharedTree: MerkleTree;
  let sharedExitPrices: ExitPrices;

  beforeAll(() => {
    const portfolio = buildSharedPortfolio();
    sharedTree = portfolio.tree;
    sharedExitPrices = portfolio.exitPrices;
  });

  test("4.1: Both bots have identical portfolio (shared tree)", () => {
    expect(sharedTree.trades).toHaveLength(10);
    expect(sharedTree.snapshotId).toBe(SNAPSHOT_ID);

    // Verify all trades have correct structure
    for (let i = 0; i < 10; i++) {
      const trade = sharedTree.trades[i];
      expect(trade.ticker).toBe(SAMPLE_STOCKS[i].ticker);
      expect(trade.entryPrice).toBe(SAMPLE_STOCKS[i].entryPrice);
      expect(trade.method).toBe("up:0");
    }
  });

  test("4.2: Both bots have same exit prices from Data Node", () => {
    // In real scenario, both bots fetch from same Data Node snapshot
    expect(sharedExitPrices.size).toBe(10);

    for (let i = 0; i < 10; i++) {
      expect(sharedExitPrices.get(i)).toBe(SAMPLE_STOCKS[i].exitPrice);
    }
  });

  test("4.3: Bot 1 computes outcome correctly", () => {
    const outcome = bot1ComputeOutcome(sharedTree, sharedExitPrices);

    // Expected outcomes for up:0 method:
    // AAPL: 18230 > 17850 → maker wins
    // MSFT: 41050 > 41520 → false → taker wins
    // GOOGL: 19500 > 14180 → maker wins
    // TSLA: 22000 > 24500 → false → taker wins
    // META: 52500 > 52030 → maker wins
    // NVDA: 90000 > 89000 → maker wins
    // AMZN: 17500 > 18000 → false → taker wins
    // AMD: 16500 > 16000 → maker wins
    // NFLX: 60000 > 62000 → false → taker wins
    // ORCL: 12500 > 12500 → false → taker wins (not strictly greater)

    expect(outcome.makerWins).toBe(5); // AAPL, GOOGL, META, NVDA, AMD
    expect(outcome.takerWins).toBe(5); // MSFT, TSLA, AMZN, NFLX, ORCL
    expect(outcome.total).toBe(10);
    expect(outcome.winner).toBe(TAKER_ADDRESS); // tie → taker wins
  });

  test("4.4: Bot 2 computes IDENTICAL outcome to Bot 1", () => {
    const outcome1 = bot1ComputeOutcome(sharedTree, sharedExitPrices);
    const outcome2 = bot2ComputeOutcome(sharedTree, sharedExitPrices);

    expect(outcome1.makerWins).toBe(outcome2.makerWins);
    expect(outcome1.takerWins).toBe(outcome2.takerWins);
    expect(outcome1.total).toBe(outcome2.total);
    expect(outcome1.winner.toLowerCase()).toBe(outcome2.winner.toLowerCase());
  });

  test("4.5: outcomesMatch returns true for both bots", () => {
    const outcome1 = bot1ComputeOutcome(sharedTree, sharedExitPrices);
    const outcome2 = bot2ComputeOutcome(sharedTree, sharedExitPrices);

    expect(outcomesMatch(outcome1, outcome2)).toBe(true);
  });

  test("4.6: Outcomes deterministic across multiple computations", () => {
    const outcomes: OutcomeResult[] = [];

    for (let i = 0; i < 10; i++) {
      outcomes.push(computeOutcome(sharedTree, sharedExitPrices, MAKER_ADDRESS, TAKER_ADDRESS));
    }

    // All should be identical
    const first = outcomes[0];
    for (const outcome of outcomes) {
      expect(outcome.makerWins).toBe(first.makerWins);
      expect(outcome.takerWins).toBe(first.takerWins);
      expect(outcome.winner).toBe(first.winner);
    }
  });

  test("4.7: tradesRoot is deterministic", () => {
    // Build bitmap (all positions are 'up:0' which we encode as 1)
    const bitmap = new Uint8Array(Math.ceil(10 / 8)); // 2 bytes for 10 trades
    for (let i = 0; i < 10; i++) {
      bitmap[Math.floor(i / 8)] |= 1 << (i % 8);
    }

    const root1 = computeTradesRoot(SNAPSHOT_ID, bitmap);
    const root2 = computeTradesRoot(SNAPSHOT_ID, bitmap);

    expect(root1).toBe(root2);
    expect(root1.startsWith("0x")).toBe(true);
    expect(root1).toHaveLength(66); // 0x + 64 hex chars
  });
});

describe("Scenario A: Happy Path - Edge Cases", () => {
  test("handles large portfolio (500 stocks)", () => {
    const tickers: string[] = [];
    const methods: string[] = [];
    const entryPrices = new Map<number, bigint>();
    const exitPrices: ExitPrices = new Map();

    // Generate 500 stocks
    for (let i = 0; i < 500; i++) {
      tickers.push(`STOCK${i.toString().padStart(3, "0")}`);
      methods.push("up:0");
      const entry = BigInt(10000 + (i * 100)); // Different entry prices
      const exit = i % 2 === 0 ? entry + 100n : entry - 100n; // Alternating wins
      entryPrices.set(i, entry);
      exitPrices.set(i, exit);
    }

    const tree = buildBilateralMerkleTree(
      "large-snapshot",
      methods,
      entryPrices,
      tickers
    );

    const outcome = computeOutcome(tree, exitPrices, MAKER_ADDRESS, TAKER_ADDRESS);

    expect(outcome.total).toBe(500);
    expect(outcome.makerWins).toBe(250); // Even indices
    expect(outcome.takerWins).toBe(250); // Odd indices
    expect(outcome.winner).toBe(TAKER_ADDRESS); // tie → taker
  });

  test("handles portfolio with mixed methods", () => {
    const tickers = ["A", "B", "C", "D", "E"];
    const methods = ["up:0", "down:0", "flat:5", "up:10", "down:5"];
    const entryPrices = new Map<number, bigint>();
    const exitPrices: ExitPrices = new Map();

    // Set up specific scenarios
    entryPrices.set(0, 10000n); exitPrices.set(0, 11000n); // up:0 → maker (went up)
    entryPrices.set(1, 10000n); exitPrices.set(1, 9000n);  // down:0 → maker (went down)
    entryPrices.set(2, 10000n); exitPrices.set(2, 10300n); // flat:5 → maker (3% within 5%)
    entryPrices.set(3, 10000n); exitPrices.set(3, 10500n); // up:10 → taker (5% < 10%)
    entryPrices.set(4, 10000n); exitPrices.set(4, 9600n);  // down:5 → taker (4% < 5%)

    const tree = buildBilateralMerkleTree(
      "mixed-methods",
      methods,
      entryPrices,
      tickers
    );

    const outcome = computeOutcome(tree, exitPrices, MAKER_ADDRESS, TAKER_ADDRESS);

    expect(outcome.makerWins).toBe(3); // A, B, C
    expect(outcome.takerWins).toBe(2); // D, E
    expect(outcome.winner).toBe(MAKER_ADDRESS);
  });

  test("handles all maker wins scenario", () => {
    const tickers = ["A", "B", "C"];
    const methods = ["up:0", "up:0", "up:0"];
    const entryPrices = new Map<number, bigint>();
    const exitPrices: ExitPrices = new Map();

    entryPrices.set(0, 100n); exitPrices.set(0, 200n);
    entryPrices.set(1, 100n); exitPrices.set(1, 150n);
    entryPrices.set(2, 100n); exitPrices.set(2, 101n);

    const tree = buildBilateralMerkleTree(
      "all-maker",
      methods,
      entryPrices,
      tickers
    );

    const outcome = computeOutcome(tree, exitPrices, MAKER_ADDRESS, TAKER_ADDRESS);

    expect(outcome.makerWins).toBe(3);
    expect(outcome.takerWins).toBe(0);
    expect(outcome.winner).toBe(MAKER_ADDRESS);
  });

  test("handles all taker wins scenario", () => {
    const tickers = ["A", "B", "C"];
    const methods = ["up:0", "up:0", "up:0"];
    const entryPrices = new Map<number, bigint>();
    const exitPrices: ExitPrices = new Map();

    entryPrices.set(0, 100n); exitPrices.set(0, 50n);
    entryPrices.set(1, 100n); exitPrices.set(1, 99n);
    entryPrices.set(2, 100n); exitPrices.set(2, 100n); // equal is NOT greater

    const tree = buildBilateralMerkleTree(
      "all-taker",
      methods,
      entryPrices,
      tickers
    );

    const outcome = computeOutcome(tree, exitPrices, MAKER_ADDRESS, TAKER_ADDRESS);

    expect(outcome.makerWins).toBe(0);
    expect(outcome.takerWins).toBe(3);
    expect(outcome.winner).toBe(TAKER_ADDRESS);
  });
});

describe("Scenario A: settleByAgreement Simulation", () => {
  test("both bots can sign same outcome hash", () => {
    const portfolio = buildSharedPortfolio();
    const outcome = computeOutcome(portfolio.tree, portfolio.exitPrices, MAKER_ADDRESS, TAKER_ADDRESS);

    // EIP-712 style outcome encoding (simplified)
    const outcomeHash = keccak256(
      encodeAbiParameters(
        parseAbiParameters("uint256 makerWins, uint256 takerWins, address winner"),
        [BigInt(outcome.makerWins), BigInt(outcome.takerWins), outcome.winner as `0x${string}`]
      )
    );

    // Both bots would sign this same hash
    expect(outcomeHash.startsWith("0x")).toBe(true);
    expect(outcomeHash).toHaveLength(66);

    // In real scenario, both signatures would be submitted to settleByAgreement
    console.log(`\n✅ Scenario A would settle with:`);
    console.log(`   Maker Wins: ${outcome.makerWins}`);
    console.log(`   Taker Wins: ${outcome.takerWins}`);
    console.log(`   Winner: ${outcome.winner}`);
    console.log(`   Outcome Hash: ${outcomeHash}`);
  });
});
