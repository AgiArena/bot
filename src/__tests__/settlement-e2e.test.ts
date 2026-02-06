/**
 * Settlement End-to-End Tests (Story 5-2: Updated for Method-Based Resolution)
 *
 * Story 2-4: P2P Settlement (Happy Path)
 * Story 5-2: Method-based resolution (up:X, down:X, flat:X)
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { ethers, Wallet } from "ethers";
import type { MerkleTree, Trade } from "../merkle-tree";
import {
  computeOutcome,
  outcomesMatch,
  type OutcomeResult,
  type ExitPrices,
} from "../p2p/outcome-computer";
import {
  type SettlementProposal,
  type SettlementProposalResponse,
  BetStatus,
} from "../p2p/types";

// ============================================================================
// Test Setup
// ============================================================================

const MAKER = "0x1111111111111111111111111111111111111111";
const TAKER = "0x2222222222222222222222222222222222222222";
const CHAIN_ID = 111222333;
const VAULT_ADDRESS = "0x1234567890123456789012345678901234567890";

const makerWallet = new Wallet("0x" + "a".repeat(64));
const takerWallet = new Wallet("0x" + "b".repeat(64));

// Mock bet data
function createMockBet(overrides: Partial<MockBet> = {}): MockBet {
  return {
    betId: 42,
    tradesRoot: "0x" + "11".repeat(32),
    maker: MAKER,
    taker: TAKER,
    makerAmount: ethers.parseEther("50"),
    takerAmount: ethers.parseEther("50"),
    deadline: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    createdAt: Math.floor(Date.now() / 1000) - 86400,
    status: BetStatus.Active,
    ...overrides,
  };
}

interface MockBet {
  betId: number;
  tradesRoot: string;
  maker: string;
  taker: string;
  makerAmount: bigint;
  takerAmount: bigint;
  deadline: number;
  createdAt: number;
  status: BetStatus;
}

// Mock trade data (Story 5-2: Method-based resolution)
function createMockTrade(
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

function createMockMerkleTree(trades: Trade[]): MerkleTree {
  return {
    snapshotId: "test-2026-01-31-12",
    trades,
    leaves: trades.map(
      () => "0x" + "00".repeat(32) as `0x${string}`,
    ),
    root: "0x" + "11".repeat(32) as `0x${string}`,
  };
}

// ============================================================================
// End-to-End Happy Path Tests (Method-Based)
// ============================================================================

describe("E2E: Commit → Deadline → Settle (Happy Path)", () => {
  test("complete settlement flow - maker wins clearly with up:0", async () => {
    const bet = createMockBet();

    // Create trades where maker wins 7/10 (using up:0 - maker wins if price goes up)
    const trades = [
      createMockTrade(0, "up:0", 100n),
      createMockTrade(1, "up:0", 200n),
      createMockTrade(2, "up:0", 300n),
      createMockTrade(3, "up:0", 400n),
      createMockTrade(4, "up:0", 500n),
      createMockTrade(5, "down:0", 100n), // Maker wins if price goes down
      createMockTrade(6, "down:0", 200n),
      createMockTrade(7, "down:0", 300n),
      createMockTrade(8, "up:0", 400n),
      createMockTrade(9, "up:0", 500n),
    ];

    const tree = createMockMerkleTree(trades);

    // Exit prices: up trades go up (maker wins), down trades go down (maker wins)
    // Maker wins 7, taker wins 3
    const exitPrices: ExitPrices = new Map([
      [0, 150n], // up:0 → 150 > 100 → maker wins
      [1, 250n], // up:0 → 250 > 200 → maker wins
      [2, 350n], // up:0 → 350 > 300 → maker wins
      [3, 350n], // up:0 → 350 < 400 → taker wins
      [4, 450n], // up:0 → 450 < 500 → taker wins
      [5, 50n],  // down:0 → 50 < 100 → maker wins
      [6, 150n], // down:0 → 150 < 200 → maker wins
      [7, 350n], // down:0 → 350 > 300 → taker wins
      [8, 450n], // up:0 → 450 > 400 → maker wins
      [9, 550n], // up:0 → 550 > 500 → maker wins
    ]);

    const outcome = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(outcome.makerWins).toBe(7);
    expect(outcome.takerWins).toBe(3);
    expect(outcome.total).toBe(10);
    expect(outcome.winner).toBe(MAKER);
  });

  test("complete settlement flow - taker wins clearly", async () => {
    const bet = createMockBet();

    // Create trades using up:0 method
    const trades = Array.from({ length: 10 }, (_, i) =>
      createMockTrade(i, "up:0", BigInt(100 + i * 10)),
    );

    const tree = createMockMerkleTree(trades);

    // Exit prices where only 3/10 go up (taker wins clearly)
    const exitPrices: ExitPrices = new Map(
      trades.map((t, i) => {
        // Only indices 0, 1, 2 go up (maker wins 3)
        const exitPrice = i < 3 ? t.entryPrice + 50n : t.entryPrice - 50n;
        return [i, exitPrice];
      }),
    );

    const outcome = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(outcome.makerWins).toBe(3);
    expect(outcome.takerWins).toBe(7);
    expect(outcome.winner).toBe(TAKER);
  });

  test("exact tie - taker wins by convention", async () => {
    const bet = createMockBet();

    // Create 10 trades using up:0
    const trades = Array.from({ length: 10 }, (_, i) =>
      createMockTrade(i, "up:0", 100n),
    );

    const tree = createMockMerkleTree(trades);

    // 5 up, 5 down = tie
    const exitPrices: ExitPrices = new Map(
      trades.map((_, i) => [i, i < 5 ? 150n : 50n]),
    );

    const outcome = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(outcome.makerWins).toBe(5);
    expect(outcome.takerWins).toBe(5);
    expect(outcome.winner).toBe(TAKER); // Tie convention: taker wins
  });
});

describe("E2E: Signature Flow", () => {
  test("both parties agree on outcome", async () => {
    const bet = createMockBet();

    const trades = Array.from({ length: 10 }, (_, i) =>
      createMockTrade(i, "up:0", 100n),
    );

    const tree = createMockMerkleTree(trades);

    // 7/10 go up = maker wins
    const exitPrices: ExitPrices = new Map(
      trades.map((_, i) => [i, i < 7 ? 150n : 50n]),
    );

    const makerOutcome = computeOutcome(tree, exitPrices, MAKER, TAKER);
    const takerOutcome = computeOutcome(tree, exitPrices, MAKER, TAKER);

    // Both should compute identical outcomes
    expect(outcomesMatch(makerOutcome, takerOutcome)).toBe(true);
    expect(makerOutcome.winner).toBe(MAKER);
  });

  test("dispute when outcomes differ", async () => {
    const bet = createMockBet();

    const trades = Array.from({ length: 10 }, (_, i) =>
      createMockTrade(i, "up:0", 100n),
    );

    const tree = createMockMerkleTree(trades);

    // Different exit prices = different outcomes
    const makerExitPrices: ExitPrices = new Map(
      trades.map((_, i) => [i, i < 6 ? 150n : 50n]), // 6/10 up
    );

    const takerExitPrices: ExitPrices = new Map(
      trades.map((_, i) => [i, i < 4 ? 150n : 50n]), // 4/10 up
    );

    const makerOutcome = computeOutcome(tree, makerExitPrices, MAKER, TAKER);
    const takerOutcome = computeOutcome(tree, takerExitPrices, MAKER, TAKER);

    expect(outcomesMatch(makerOutcome, takerOutcome)).toBe(false);
    expect(makerOutcome.winner).toBe(MAKER);
    expect(takerOutcome.winner).toBe(TAKER);
  });
});

describe("E2E: Custom Payout Scenarios", () => {
  test("borderline outcome suggests custom payout negotiation", async () => {
    const bet = createMockBet();

    // Borderline outcome where custom payout might make sense
    const trades = Array.from({ length: 10 }, (_, i) =>
      createMockTrade(i, "up:0", 100n),
    );

    const tree = createMockMerkleTree(trades);

    // 6/10 up = maker barely wins
    const exitPrices: ExitPrices = new Map(
      trades.map((_, i) => [i, i < 6 ? 150n : 50n]),
    );

    const outcome = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(outcome.makerWins).toBe(6);
    expect(outcome.takerWins).toBe(4);
    expect(outcome.winner).toBe(MAKER);

    // In a borderline win, parties might negotiate custom payout
    const isCloseCall = Math.abs(outcome.makerWins - outcome.takerWins) <= 2;
    expect(isCloseCall).toBe(true);
  });
});

describe("E2E: Edge Cases", () => {
  test("single trade bet - maker wins", async () => {
    const bet = createMockBet();

    const trades = [createMockTrade(0, "up:0", 100n)];
    const tree = createMockMerkleTree(trades);
    const exitPrices: ExitPrices = new Map([[0, 150n]]);

    const outcome = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(outcome.makerWins).toBe(1);
    expect(outcome.winner).toBe(MAKER);
  });

  test("single trade bet - taker wins", async () => {
    const bet = createMockBet();

    const trades = [createMockTrade(0, "up:0", 100n)];
    const tree = createMockMerkleTree(trades);
    const exitPrices: ExitPrices = new Map([[0, 50n]]);

    const outcome = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(outcome.takerWins).toBe(1);
    expect(outcome.winner).toBe(TAKER);
  });

  test("all trades have null exit prices - taker wins by default", async () => {
    const bet = createMockBet();

    const trades = Array.from({ length: 5 }, (_, i) =>
      createMockTrade(i, "up:0", 100n),
    );

    const tree = createMockMerkleTree(trades);

    // All null exit prices
    const exitPrices: ExitPrices = new Map(
      trades.map((_, i) => [i, null]),
    );

    const outcome = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(outcome.total).toBe(0);
    expect(outcome.winner).toBe(TAKER); // No valid trades = taker wins
  });

  test("large bet with 100 trades", async () => {
    const bet = createMockBet();

    // 100 trades with alternating methods
    const trades = Array.from({ length: 100 }, (_, i) =>
      createMockTrade(i, i % 2 === 0 ? "up:0" : "down:0", BigInt(100 + i)),
    );

    const tree = createMockMerkleTree(trades);

    // 60% favorable exit prices
    const exitPrices: ExitPrices = new Map(
      trades.map((t, i) => {
        const isUp = t.method === "up:0";
        const favorable = i < 60;
        // For up:0, favorable = price up. For down:0, favorable = price down
        const exitPrice = favorable
          ? (isUp ? t.entryPrice + 50n : t.entryPrice - 50n)
          : (isUp ? t.entryPrice - 50n : t.entryPrice + 50n);
        return [i, exitPrice];
      }),
    );

    const outcome = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(outcome.makerWins).toBe(60);
    expect(outcome.total).toBe(100);
    expect(outcome.winner).toBe(MAKER);
  });

  test("deadline not yet passed prevents settlement", () => {
    const bet = createMockBet({
      deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour in future
    });

    const now = Math.floor(Date.now() / 1000);
    const canSettle = now > bet.deadline;

    expect(canSettle).toBe(false);
  });

  test("deadline passed allows settlement", () => {
    const bet = createMockBet({
      deadline: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    });

    const now = Math.floor(Date.now() / 1000);
    const canSettle = now > bet.deadline;

    expect(canSettle).toBe(true);
  });

  test("bet already settled cannot be re-settled", () => {
    const bet = createMockBet({ status: BetStatus.Settled });

    expect(bet.status).toBe(BetStatus.Settled);
    const canSettle = bet.status === BetStatus.Active;
    expect(canSettle).toBe(false);
  });
});

describe("E2E: Mixed Method Scenarios", () => {
  test("all up:0 methods - price goes up", async () => {
    const trades = Array.from({ length: 10 }, (_, i) =>
      createMockTrade(i, "up:0", 100n),
    );

    const tree = createMockMerkleTree(trades);
    const exitPrices: ExitPrices = new Map(
      trades.map((_, i) => [i, 150n]), // All prices up
    );

    const outcome = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(outcome.makerWins).toBe(10);
    expect(outcome.winner).toBe(MAKER);
  });

  test("all down:0 methods - price goes down", async () => {
    const trades = Array.from({ length: 10 }, (_, i) =>
      createMockTrade(i, "down:0", 100n),
    );

    const tree = createMockMerkleTree(trades);
    const exitPrices: ExitPrices = new Map(
      trades.map((_, i) => [i, 50n]), // All prices down
    );

    const outcome = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(outcome.makerWins).toBe(10);
    expect(outcome.winner).toBe(MAKER);
  });

  test("alternating up/down methods", async () => {
    const trades = Array.from({ length: 10 }, (_, i) =>
      createMockTrade(i, i % 2 === 0 ? "up:0" : "down:0", 100n),
    );

    const tree = createMockMerkleTree(trades);

    // All prices go up - up methods win, down methods lose
    const exitPrices: ExitPrices = new Map(
      trades.map((_, i) => [i, 150n]),
    );

    const outcome = computeOutcome(tree, exitPrices, MAKER, TAKER);

    // 5 up:0 trades win (price up), 5 down:0 trades lose (price up)
    expect(outcome.makerWins).toBe(5);
    expect(outcome.takerWins).toBe(5);
    expect(outcome.winner).toBe(TAKER); // Tie → taker wins
  });

  test("flat method - price stays within threshold", async () => {
    const trades = Array.from({ length: 5 }, (_, i) =>
      createMockTrade(i, "flat:2", 1000n), // 2% threshold
    );

    const tree = createMockMerkleTree(trades);

    // Prices within 2% of entry (1000 ± 20)
    const exitPrices: ExitPrices = new Map([
      [0, 1010n], // 1% change - maker wins
      [1, 990n],  // 1% change - maker wins
      [2, 1020n], // 2% change - maker wins (exactly at threshold)
      [3, 1050n], // 5% change - taker wins (outside threshold)
      [4, 900n],  // 10% change - taker wins (outside threshold)
    ]);

    const outcome = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(outcome.makerWins).toBe(3);
    expect(outcome.takerWins).toBe(2);
    expect(outcome.winner).toBe(MAKER);
  });

  test("up with threshold - maker needs bigger price increase", async () => {
    const trades = Array.from({ length: 4 }, (_, i) =>
      createMockTrade(i, "up:10", 1000n), // Must go up > 10%
    );

    const tree = createMockMerkleTree(trades);

    const exitPrices: ExitPrices = new Map([
      [0, 1150n], // 15% up - maker wins
      [1, 1050n], // 5% up - taker wins (not enough)
      [2, 1100n], // 10% up - taker wins (exactly threshold, not greater)
      [3, 1200n], // 20% up - maker wins
    ]);

    const outcome = computeOutcome(tree, exitPrices, MAKER, TAKER);

    expect(outcome.makerWins).toBe(2);
    expect(outcome.takerWins).toBe(2);
    expect(outcome.winner).toBe(TAKER); // Tie → taker wins
  });
});
