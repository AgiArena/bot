/**
 * Scenario B: Dispute Path E2E Test (Story 5-4 AC5)
 *
 * Tests the bilateral settlement dispute path where keepers arbitrate:
 * 1. Bots disagree on outcome (one bot claims wrong)
 * 2. requestArbitration is called
 * 3. All keepers compute outcomes independently
 * 4. All keepers produce IDENTICAL outcomes
 * 5. 2-of-3 BLS signatures aggregate
 * 6. settleByArbitration succeeds
 *
 * NOTE: This is a simulation test. Full E2E testing requires live chain.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  parseMethod,
  evaluateTrade,
  buildBilateralMerkleTree,
  type MerkleTree,
} from "../merkle-tree";
import {
  computeOutcome,
  outcomesMatch,
  type OutcomeResult,
  type ExitPrices,
} from "../p2p/outcome-computer";
import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";

// ============================================================================
// Test Constants
// ============================================================================

const MAKER_ADDRESS = "0x1111111111111111111111111111111111111111";
const TAKER_ADDRESS = "0x2222222222222222222222222222222222222222";

const KEEPER_1 = "0xC0d3ca67da45613e7C5b2d55F09b00B3c99721f4";
const KEEPER_2 = "0xC0D3C8DFd3445fd2e4dfED9D11b5B7032B3BD1ac";
const KEEPER_3 = "0xC0D3C397033aa62245aF6A734D582C956ABd7Fa9";

const SNAPSHOT_ID = "stock-all-2026-02-02-dispute";

// Test portfolio
const TEST_STOCKS = [
  { ticker: "AAPL", entryPrice: 17850n, exitPrice: 18500n },  // up +3.6%
  { ticker: "MSFT", entryPrice: 41520n, exitPrice: 42000n },  // up +1.2%
  { ticker: "GOOGL", entryPrice: 14180n, exitPrice: 13000n }, // down -8.3%
  { ticker: "TSLA", entryPrice: 24500n, exitPrice: 26000n },  // up +6.1%
  { ticker: "META", entryPrice: 52030n, exitPrice: 51000n },  // down -2.0%
];

// ============================================================================
// Simulated Keeper Resolution (mimics keeper/src/bilateral_resolution.rs)
// ============================================================================

/**
 * Simulated Keeper Resolution VM
 *
 * This mimics what the Rust keeper does:
 * 1. Fetch trades from Data Node postgres
 * 2. Parse each trade's method
 * 3. Evaluate using integer math
 * 4. Determine winner
 *
 * Uses same formulas as TypeScript Bot for consistency verification.
 */
interface KeeperTrade {
  ticker: string;
  entryPrice: bigint;
  exitPrice: bigint;
  method: string;
}

interface KeeperOutcome {
  makerWins: number;
  takerWins: number;
  winner: "maker" | "taker";
}

function keeperEvaluateTrade(entry: bigint, exit: bigint, method: string): boolean {
  // Parse method (e.g., "up:10" → type="up", threshold=1000 bps)
  const parsed = parseMethod(method);
  const BPS_BASE = 10000n;

  switch (parsed.type) {
    case "up":
      // maker wins if exit * BPS_BASE > entry * (BPS_BASE + threshold)
      return exit * BPS_BASE > entry * (BPS_BASE + parsed.thresholdBps);
    case "down":
      // maker wins if exit * BPS_BASE < entry * (BPS_BASE - threshold)
      return exit * BPS_BASE < entry * (BPS_BASE - parsed.thresholdBps);
    case "flat":
      // maker wins if |exit - entry| * BPS_BASE <= entry * threshold
      const diff = exit > entry ? exit - entry : entry - exit;
      return diff * BPS_BASE <= entry * parsed.thresholdBps;
    default:
      throw new Error(`Unknown method type: ${parsed.type}`);
  }
}

function keeperComputeOutcome(trades: KeeperTrade[]): KeeperOutcome {
  let makerWins = 0;
  let takerWins = 0;

  for (const trade of trades) {
    const result = keeperEvaluateTrade(trade.entryPrice, trade.exitPrice, trade.method);
    if (result) {
      makerWins++;
    } else {
      takerWins++;
    }
  }

  // Taker wins ties (keeper convention from vital-test.md)
  const winner: "maker" | "taker" = makerWins > takerWins ? "maker" : "taker";

  return { makerWins, takerWins, winner };
}

// ============================================================================
// Simulated BLS Signature Aggregation
// ============================================================================

interface KeeperSignature {
  keeper: string;
  outcome: KeeperOutcome;
  signature: `0x${string}`; // Simulated BLS signature
}

function simulateKeeperSign(keeper: string, outcome: KeeperOutcome): KeeperSignature {
  // Simulate BLS signature by hashing outcome + keeper address
  const signature = keccak256(
    encodeAbiParameters(
      parseAbiParameters("uint256 makerWins, uint256 takerWins, string winner, address keeper"),
      [BigInt(outcome.makerWins), BigInt(outcome.takerWins), outcome.winner, keeper as `0x${string}`]
    )
  );

  return { keeper, outcome, signature };
}

function aggregateBLSSignatures(signatures: KeeperSignature[]): {
  aggregatedSig: `0x${string}`;
  signersBitmap: number;
  outcomeConsistent: boolean;
} {
  // Check all signatures agree on outcome
  const first = signatures[0].outcome;
  const outcomeConsistent = signatures.every(
    (s) =>
      s.outcome.makerWins === first.makerWins &&
      s.outcome.takerWins === first.takerWins &&
      s.outcome.winner === first.winner
  );

  // Simulate aggregated signature (in reality this uses BLS math)
  const aggregatedSig = keccak256(
    encodeAbiParameters(
      parseAbiParameters("bytes32[] sigs"),
      [signatures.map((s) => s.signature)]
    )
  );

  // Build bitmap (keeper 1 = bit 0, keeper 2 = bit 1, keeper 3 = bit 2)
  let signersBitmap = 0;
  for (let i = 0; i < signatures.length; i++) {
    signersBitmap |= 1 << i;
  }

  return { aggregatedSig, signersBitmap, outcomeConsistent };
}

// ============================================================================
// Test Setup
// ============================================================================

function buildTestPortfolio(): {
  tree: MerkleTree;
  exitPrices: ExitPrices;
  keeperTrades: KeeperTrade[];
} {
  const tickers = TEST_STOCKS.map((s) => s.ticker);
  const methods = TEST_STOCKS.map(() => "up:0");
  const entryPrices = new Map<number, bigint>();
  const exitPrices: ExitPrices = new Map();
  const keeperTrades: KeeperTrade[] = [];

  TEST_STOCKS.forEach((stock, i) => {
    entryPrices.set(i, stock.entryPrice);
    exitPrices.set(i, stock.exitPrice);
    keeperTrades.push({
      ticker: stock.ticker,
      entryPrice: stock.entryPrice,
      exitPrice: stock.exitPrice,
      method: "up:0",
    });
  });

  const tree = buildBilateralMerkleTree(SNAPSHOT_ID, methods, entryPrices, tickers);

  return { tree, exitPrices, keeperTrades };
}

// ============================================================================
// Scenario B Tests (AC5)
// ============================================================================

describe("Scenario B: Dispute Path - Keepers Arbitrate (AC5)", () => {
  let testTree: MerkleTree;
  let testExitPrices: ExitPrices;
  let keeperTrades: KeeperTrade[];

  beforeAll(() => {
    const portfolio = buildTestPortfolio();
    testTree = portfolio.tree;
    testExitPrices = portfolio.exitPrices;
    keeperTrades = portfolio.keeperTrades;
  });

  test("5.1: Bot 1 claims correct outcome", () => {
    const outcome = computeOutcome(testTree, testExitPrices, MAKER_ADDRESS, TAKER_ADDRESS);

    // For up:0 method:
    // AAPL: 18500 > 17850 → maker
    // MSFT: 42000 > 41520 → maker
    // GOOGL: 13000 > 14180 → false → taker
    // TSLA: 26000 > 24500 → maker
    // META: 51000 > 52030 → false → taker

    expect(outcome.makerWins).toBe(3);
    expect(outcome.takerWins).toBe(2);
    expect(outcome.winner).toBe(MAKER_ADDRESS);
  });

  test("5.2: Bot 2 (malicious) claims wrong outcome", () => {
    // Simulate Bot 2 claiming taker wins (fraudulent claim)
    const maliciousClaim: OutcomeResult = {
      makerWins: 2,
      takerWins: 3,
      total: 5,
      winner: TAKER_ADDRESS,
    };

    const honestClaim = computeOutcome(testTree, testExitPrices, MAKER_ADDRESS, TAKER_ADDRESS);

    // Outcomes don't match - dispute triggered
    expect(outcomesMatch(honestClaim, maliciousClaim)).toBe(false);
  });

  test("5.3: Keeper 1 computes correct outcome from trades", () => {
    const keeper1Outcome = keeperComputeOutcome(keeperTrades);

    expect(keeper1Outcome.makerWins).toBe(3);
    expect(keeper1Outcome.takerWins).toBe(2);
    expect(keeper1Outcome.winner).toBe("maker");
  });

  test("5.4: Keeper 2 computes identical outcome", () => {
    const keeper2Outcome = keeperComputeOutcome(keeperTrades);

    expect(keeper2Outcome.makerWins).toBe(3);
    expect(keeper2Outcome.takerWins).toBe(2);
    expect(keeper2Outcome.winner).toBe("maker");
  });

  test("5.5: Keeper 3 computes identical outcome", () => {
    const keeper3Outcome = keeperComputeOutcome(keeperTrades);

    expect(keeper3Outcome.makerWins).toBe(3);
    expect(keeper3Outcome.takerWins).toBe(2);
    expect(keeper3Outcome.winner).toBe("maker");
  });

  test("5.6: All 3 keepers produce identical outcomes", () => {
    const outcomes = [
      keeperComputeOutcome(keeperTrades),
      keeperComputeOutcome(keeperTrades),
      keeperComputeOutcome(keeperTrades),
    ];

    // All should match
    const first = outcomes[0];
    for (const outcome of outcomes) {
      expect(outcome.makerWins).toBe(first.makerWins);
      expect(outcome.takerWins).toBe(first.takerWins);
      expect(outcome.winner).toBe(first.winner);
    }
  });

  test("5.7: Bot and Keeper outcomes match", () => {
    const botOutcome = computeOutcome(testTree, testExitPrices, MAKER_ADDRESS, TAKER_ADDRESS);
    const keeperOutcome = keeperComputeOutcome(keeperTrades);

    // Critical: Bot (TS) and Keeper (simulated Rust) produce same results
    expect(botOutcome.makerWins).toBe(keeperOutcome.makerWins);
    expect(botOutcome.takerWins).toBe(keeperOutcome.takerWins);

    // Winner format differs (address vs string) but semantic match
    const botWinnerIsMaker = botOutcome.winner.toLowerCase() === MAKER_ADDRESS.toLowerCase();
    const keeperWinnerIsMaker = keeperOutcome.winner === "maker";
    expect(botWinnerIsMaker).toBe(keeperWinnerIsMaker);
  });

  test("5.8: 2-of-3 BLS signature aggregation", () => {
    // All 3 keepers sign the same outcome
    const outcome = keeperComputeOutcome(keeperTrades);

    const sig1 = simulateKeeperSign(KEEPER_1, outcome);
    const sig2 = simulateKeeperSign(KEEPER_2, outcome);
    const sig3 = simulateKeeperSign(KEEPER_3, outcome);

    // Aggregate 2-of-3 (any 2 is enough for quorum)
    const twoOfThree = aggregateBLSSignatures([sig1, sig2]);

    expect(twoOfThree.outcomeConsistent).toBe(true);
    expect(twoOfThree.signersBitmap).toBe(0b011); // Keepers 1 and 2

    // Full 3-of-3 aggregation
    const fullConsensus = aggregateBLSSignatures([sig1, sig2, sig3]);

    expect(fullConsensus.outcomeConsistent).toBe(true);
    expect(fullConsensus.signersBitmap).toBe(0b111); // All 3 keepers
    expect(fullConsensus.aggregatedSig.startsWith("0x")).toBe(true);
  });

  test("5.9: settleByArbitration simulation", () => {
    const keeperOutcome = keeperComputeOutcome(keeperTrades);

    const sig1 = simulateKeeperSign(KEEPER_1, keeperOutcome);
    const sig2 = simulateKeeperSign(KEEPER_2, keeperOutcome);
    const sig3 = simulateKeeperSign(KEEPER_3, keeperOutcome);

    const aggregated = aggregateBLSSignatures([sig1, sig2, sig3]);

    // Verify correct winner is determined
    const correctWinner = keeperOutcome.winner === "maker" ? MAKER_ADDRESS : TAKER_ADDRESS;

    console.log(`\n✅ Scenario B would settle via arbitration with:`);
    console.log(`   Maker Wins: ${keeperOutcome.makerWins}`);
    console.log(`   Taker Wins: ${keeperOutcome.takerWins}`);
    console.log(`   Winner: ${correctWinner} (${keeperOutcome.winner})`);
    console.log(`   Signers Bitmap: ${aggregated.signersBitmap.toString(2).padStart(3, "0")} (${aggregated.signersBitmap})`);
    console.log(`   Aggregated Sig: ${aggregated.aggregatedSig.slice(0, 18)}...`);

    // The correct winner should receive collateral
    expect(correctWinner).toBe(MAKER_ADDRESS);
    expect(aggregated.outcomeConsistent).toBe(true);
  });
});

describe("Scenario B: Edge Cases - Keeper Disagreement", () => {
  test("detects if one keeper computes different outcome (Byzantine fault)", () => {
    const keeperTrades: KeeperTrade[] = [
      { ticker: "A", entryPrice: 100n, exitPrice: 150n, method: "up:0" },
      { ticker: "B", entryPrice: 100n, exitPrice: 50n, method: "up:0" },
    ];

    // Honest keepers compute correctly
    const honest1 = keeperComputeOutcome(keeperTrades);
    const honest2 = keeperComputeOutcome(keeperTrades);

    // Malicious keeper returns wrong result
    const malicious: KeeperOutcome = { makerWins: 0, takerWins: 2, winner: "taker" };

    // Try to aggregate with malicious keeper
    const aggregated = aggregateBLSSignatures([
      simulateKeeperSign(KEEPER_1, honest1),
      simulateKeeperSign(KEEPER_2, honest2),
      simulateKeeperSign(KEEPER_3, malicious), // Byzantine
    ]);

    // Should detect inconsistency
    expect(aggregated.outcomeConsistent).toBe(false);
  });

  test("2-of-3 honest keepers can override 1 Byzantine", () => {
    const keeperTrades: KeeperTrade[] = [
      { ticker: "A", entryPrice: 100n, exitPrice: 150n, method: "up:0" },
    ];

    const honest = keeperComputeOutcome(keeperTrades);
    expect(honest.makerWins).toBe(1);
    expect(honest.winner).toBe("maker");

    // 2 honest keepers sign correct outcome
    const sig1 = simulateKeeperSign(KEEPER_1, honest);
    const sig2 = simulateKeeperSign(KEEPER_2, honest);

    // Aggregate only honest signatures (ignore Byzantine)
    const aggregated = aggregateBLSSignatures([sig1, sig2]);

    expect(aggregated.outcomeConsistent).toBe(true);
    expect(aggregated.signersBitmap).toBe(0b011); // 2-of-3 quorum achieved
  });
});

describe("Scenario B: Cross-Component Determinism", () => {
  test("identical results for same trades across 100 iterations", () => {
    const keeperTrades: KeeperTrade[] = [
      { ticker: "AAPL", entryPrice: 17850n, exitPrice: 18500n, method: "up:0" },
      { ticker: "MSFT", entryPrice: 41520n, exitPrice: 42000n, method: "up:5" },
      { ticker: "TSLA", entryPrice: 24500n, exitPrice: 24000n, method: "down:0" },
      { ticker: "META", entryPrice: 52030n, exitPrice: 52030n, method: "flat:0" },
    ];

    const outcomes: KeeperOutcome[] = [];
    for (let i = 0; i < 100; i++) {
      outcomes.push(keeperComputeOutcome(keeperTrades));
    }

    // All 100 should be identical
    const first = outcomes[0];
    for (const outcome of outcomes) {
      expect(outcome.makerWins).toBe(first.makerWins);
      expect(outcome.takerWins).toBe(first.takerWins);
      expect(outcome.winner).toBe(first.winner);
    }
  });

  test("evaluateTrade matches between Bot and simulated Keeper for each method type", () => {
    const testCases: Array<{
      entry: bigint;
      exit: bigint;
      method: string;
    }> = [
      { entry: 10000n, exit: 11000n, method: "up:0" },
      { entry: 10000n, exit: 10000n, method: "up:0" },
      { entry: 10000n, exit: 11001n, method: "up:10" },
      { entry: 10000n, exit: 9000n, method: "down:0" },
      { entry: 10000n, exit: 8999n, method: "down:10" },
      { entry: 10000n, exit: 10000n, method: "flat:0" },
      { entry: 10000n, exit: 10500n, method: "flat:5" },
      { entry: 10000n, exit: 10501n, method: "flat:5" },
    ];

    for (const tc of testCases) {
      // Bot evaluation (TypeScript)
      const botResult = evaluateTrade(tc.entry, tc.exit, tc.method);

      // Keeper evaluation (simulated Rust)
      const keeperResult = keeperEvaluateTrade(tc.entry, tc.exit, tc.method);

      expect(botResult).toBe(keeperResult);
    }
  });
});
