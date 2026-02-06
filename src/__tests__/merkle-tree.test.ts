/**
 * Merkle Tree Tests (Story 5-2: Updated for Method-Based Resolution)
 *
 * Story 15-1: Test Merkle tree utilities
 * Story 5-2: Updated Trade interface - removed position, use method for resolution
 */

import { describe, it, expect } from "bun:test";
import {
  hashTrade,
  generateTradeId,
  computeMerkleRoot,
  buildMerkleTree,
  generateProof,
  generateProofs,
  verifyProof,
  verifyTrade,
  resolveTradeOutcome,
  resolveAllTrades,
  serializeTree,
  deserializeTree,
  getTreeDepth,
  EMPTY_LEAF,
  MAX_TRADES,
  type Trade,
  type MerkleTree,
} from "../merkle-tree";

// ============================================================================
// Test Helpers
// ============================================================================

function createTrade(
  index: number,
  overrides: Partial<Trade> = {}
): Trade {
  return {
    tradeId: generateTradeId("test-snapshot", index),
    ticker: `TICKER${index}`,
    source: "coingecko",
    method: "up:0",  // Story 5-2: Default to method-based resolution
    entryPrice: BigInt(1000 * (index + 1)) * 10n ** 18n,
    exitPrice: 0n,
    won: false,
    cancelled: false,
    ...overrides,
  };
}

function createTrades(count: number): Trade[] {
  return Array.from({ length: count }, (_, i) => createTrade(i));
}

// ============================================================================
// Trade Hashing Tests
// ============================================================================

describe("Trade Hashing", () => {
  it("should generate consistent trade ID", () => {
    const id1 = generateTradeId("snapshot-123", 0);
    const id2 = generateTradeId("snapshot-123", 0);
    const id3 = generateTradeId("snapshot-123", 1);

    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1.startsWith("0x")).toBe(true);
    expect(id1.length).toBe(66); // 0x + 64 hex chars
  });

  it("should hash trades deterministically", () => {
    const trade = createTrade(0);
    const hash1 = hashTrade(trade);
    const hash2 = hashTrade(trade);

    expect(hash1).toBe(hash2);
    expect(hash1.startsWith("0x")).toBe(true);
    expect(hash1.length).toBe(66);
  });

  it("should produce different hashes for different trades", () => {
    const trade1 = createTrade(0);
    const trade2 = createTrade(1);

    expect(hashTrade(trade1)).not.toBe(hashTrade(trade2));
  });

  it("should produce different hashes when any field changes", () => {
    const base = createTrade(0);
    const hashes = [
      hashTrade(base),
      hashTrade({ ...base, ticker: "DIFFERENT" }),
      hashTrade({ ...base, method: "down:5" }),  // Story 5-2: Changed from position to method
      hashTrade({ ...base, entryPrice: 999n }),
      hashTrade({ ...base, won: true }),
    ];

    // All hashes should be unique
    const uniqueHashes = new Set(hashes);
    expect(uniqueHashes.size).toBe(hashes.length);
  });
});

// ============================================================================
// Merkle Root Tests
// ============================================================================

describe("Merkle Root", () => {
  it("should compute root for empty array", () => {
    const root = computeMerkleRoot([]);
    expect(root).toBe(EMPTY_LEAF);
  });

  it("should compute root for single leaf", () => {
    const leaf = hashTrade(createTrade(0));
    const root = computeMerkleRoot([leaf]);

    // With padding, single leaf gets paired with empty
    expect(root).not.toBe(leaf);
    expect(root.startsWith("0x")).toBe(true);
  });

  it("should compute root for power of 2 leaves", () => {
    const trades = createTrades(4);
    const leaves = trades.map(hashTrade);
    const root = computeMerkleRoot(leaves);

    expect(root.startsWith("0x")).toBe(true);
    expect(root.length).toBe(66);
  });

  it("should compute root for non-power of 2 leaves", () => {
    const trades = createTrades(5);
    const leaves = trades.map(hashTrade);
    const root = computeMerkleRoot(leaves);

    expect(root.startsWith("0x")).toBe(true);
  });

  it("should be deterministic", () => {
    const trades = createTrades(10);
    const leaves = trades.map(hashTrade);

    const root1 = computeMerkleRoot(leaves);
    const root2 = computeMerkleRoot(leaves);

    expect(root1).toBe(root2);
  });

  it("should change when any leaf changes", () => {
    const trades = createTrades(4);
    const leaves = trades.map(hashTrade);
    const root1 = computeMerkleRoot(leaves);

    // Change one trade
    const modified = [...trades];
    modified[2] = { ...modified[2], ticker: "CHANGED" };
    const modifiedLeaves = modified.map(hashTrade);
    const root2 = computeMerkleRoot(modifiedLeaves);

    expect(root1).not.toBe(root2);
  });
});

// ============================================================================
// Build Tree Tests
// ============================================================================

describe("Build Merkle Tree", () => {
  it("should build tree with all components", () => {
    const trades = createTrades(8);
    const tree = buildMerkleTree("test-snapshot", trades);

    expect(tree.snapshotId).toBe("test-snapshot");
    expect(tree.trades).toEqual(trades);
    expect(tree.leaves.length).toBe(8);
    expect(tree.root.startsWith("0x")).toBe(true);
  });

  it("should compute correct root", () => {
    const trades = createTrades(4);
    const tree = buildMerkleTree("test", trades);
    const expectedRoot = computeMerkleRoot(tree.leaves);

    expect(tree.root).toBe(expectedRoot);
  });
});

// ============================================================================
// Proof Generation Tests
// ============================================================================

describe("Proof Generation", () => {
  it("should generate valid proof for each leaf", () => {
    const trades = createTrades(8);
    const tree = buildMerkleTree("test", trades);

    for (let i = 0; i < trades.length; i++) {
      const proof = generateProof(tree.leaves, i);
      expect(proof.index).toBe(i);
      expect(proof.siblings.length).toBe(3); // log2(8) = 3
    }
  });

  it("should generate proof with correct depth", () => {
    const cases = [
      { count: 1, expectedDepth: 1 }, // Padded to 2
      { count: 2, expectedDepth: 1 },
      { count: 4, expectedDepth: 2 },
      { count: 8, expectedDepth: 3 },
      { count: 16, expectedDepth: 4 },
      { count: 5, expectedDepth: 3 }, // Padded to 8
      { count: 100, expectedDepth: 7 }, // Padded to 128
    ];

    for (const { count, expectedDepth } of cases) {
      const trades = createTrades(count);
      const tree = buildMerkleTree("test", trades);
      const proof = generateProof(tree.leaves, 0);
      expect(proof.siblings.length).toBe(expectedDepth);
    }
  });

  it("should throw for out of bounds index", () => {
    const trades = createTrades(4);
    const tree = buildMerkleTree("test", trades);

    expect(() => generateProof(tree.leaves, -1)).toThrow();
    expect(() => generateProof(tree.leaves, 4)).toThrow();
  });
});

// ============================================================================
// Proof Verification Tests
// ============================================================================

describe("Proof Verification", () => {
  it("should verify valid proofs", () => {
    const trades = createTrades(16);
    const tree = buildMerkleTree("test", trades);

    for (let i = 0; i < trades.length; i++) {
      const proof = generateProof(tree.leaves, i);
      const isValid = verifyProof(tree.leaves[i], proof, tree.root);
      expect(isValid).toBe(true);
    }
  });

  it("should reject invalid proofs", () => {
    const trades = createTrades(8);
    const tree = buildMerkleTree("test", trades);

    // Wrong leaf
    const proof = generateProof(tree.leaves, 0);
    const wrongLeaf = tree.leaves[1];
    expect(verifyProof(wrongLeaf, proof, tree.root)).toBe(false);

    // Wrong root
    const wrongRoot = "0x" + "00".repeat(32) as `0x${string}`;
    expect(verifyProof(tree.leaves[0], proof, wrongRoot)).toBe(false);

    // Corrupted proof
    const corruptedProof = {
      ...proof,
      siblings: [...proof.siblings.slice(0, -1), wrongRoot],
    };
    expect(verifyProof(tree.leaves[0], corruptedProof, tree.root)).toBe(false);
  });

  it("should verify trades directly", () => {
    const trades = createTrades(4);
    const tree = buildMerkleTree("test", trades);
    const proof = generateProof(tree.leaves, 2);

    expect(verifyTrade(trades[2], proof, tree.root)).toBe(true);
    expect(verifyTrade(trades[0], proof, tree.root)).toBe(false);
  });
});

// ============================================================================
// Trade Resolution Tests (Story 5-2: Method-Based)
// ============================================================================

describe("Trade Resolution (Method-Based)", () => {
  it("should resolve up:0 - maker wins when exit > entry", () => {
    const trade = createTrade(0, {
      method: "up:0",
      entryPrice: 100n * 10n ** 18n,
    });

    const resolved = resolveTradeOutcome(trade, 150n * 10n ** 18n);
    expect(resolved.won).toBe(true);
    expect(resolved.cancelled).toBe(false);
  });

  it("should resolve up:0 - maker loses when exit < entry", () => {
    const trade = createTrade(0, {
      method: "up:0",
      entryPrice: 100n * 10n ** 18n,
    });

    const resolved = resolveTradeOutcome(trade, 50n * 10n ** 18n);
    expect(resolved.won).toBe(false);
    expect(resolved.cancelled).toBe(false);
  });

  it("should resolve down:0 - maker wins when exit < entry", () => {
    const trade = createTrade(0, {
      method: "down:0",
      entryPrice: 100n * 10n ** 18n,
    });

    const resolved = resolveTradeOutcome(trade, 50n * 10n ** 18n);
    expect(resolved.won).toBe(true);
  });

  it("should resolve flat:2 - maker wins when price within threshold", () => {
    const trade = createTrade(0, {
      method: "flat:2",
      entryPrice: 100n * 10n ** 18n,
    });

    // 1% change is within 2% threshold
    const resolved = resolveTradeOutcome(trade, 101n * 10n ** 18n);
    expect(resolved.won).toBe(true);
    expect(resolved.cancelled).toBe(false);
  });

  it("should cancel when exit is zero", () => {
    const trade = createTrade(0);
    const resolved = resolveTradeOutcome(trade, 0n);
    expect(resolved.cancelled).toBe(true);
  });

  it("should cancel when entry is zero", () => {
    const trade = createTrade(0, { entryPrice: 0n });
    const resolved = resolveTradeOutcome(trade, 100n);
    expect(resolved.cancelled).toBe(true);
  });

  it("should cancel for invalid method", () => {
    const trade = createTrade(0, { method: "invalid" });
    const resolved = resolveTradeOutcome(trade, 150n * 10n ** 18n);
    expect(resolved.cancelled).toBe(true);
  });
});

// ============================================================================
// Bulk Resolution Tests (Story 5-2: Updated for makerWins)
// ============================================================================

describe("Resolve All Trades", () => {
  it("should compute correct summary", () => {
    const trades = [
      createTrade(0, { method: "up:0", entryPrice: 100n * 10n ** 18n }),
      createTrade(1, { method: "up:0", entryPrice: 100n * 10n ** 18n }),
      createTrade(2, { method: "up:0", entryPrice: 100n * 10n ** 18n }),
      createTrade(3, { method: "up:0", entryPrice: 100n * 10n ** 18n }),
    ];

    // 3 wins, 1 loss
    const exitPrices = new Map([
      [trades[0].tradeId, 150n * 10n ** 18n], // Win
      [trades[1].tradeId, 150n * 10n ** 18n], // Win
      [trades[2].tradeId, 150n * 10n ** 18n], // Win
      [trades[3].tradeId, 50n * 10n ** 18n],  // Lose
    ]);

    const result = resolveAllTrades(trades, exitPrices);

    expect(result.winsCount).toBe(3);
    expect(result.validTrades).toBe(4);
    expect(result.cancelledCount).toBe(0);
    expect(result.makerWins).toBe(true); // 3/4 > 50%
    expect(result.isTie).toBe(false);
  });

  it("should detect tie", () => {
    const trades = [
      createTrade(0, { method: "up:0", entryPrice: 100n * 10n ** 18n }),
      createTrade(1, { method: "up:0", entryPrice: 100n * 10n ** 18n }),
    ];

    const exitPrices = new Map([
      [trades[0].tradeId, 150n * 10n ** 18n], // Win
      [trades[1].tradeId, 50n * 10n ** 18n],  // Lose
    ]);

    const result = resolveAllTrades(trades, exitPrices);

    expect(result.winsCount).toBe(1);
    expect(result.validTrades).toBe(2);
    expect(result.isTie).toBe(true);
    expect(result.makerWins).toBe(false);
  });

  it("should handle cancellations", () => {
    const trades = [
      createTrade(0, { method: "up:0", entryPrice: 100n * 10n ** 18n }),
      createTrade(1, { method: "up:0", entryPrice: 100n * 10n ** 18n }),
    ];

    const exitPrices = new Map([
      [trades[0].tradeId, 150n * 10n ** 18n], // Win
      [trades[1].tradeId, 0n],                // Cancelled (no exit price)
    ]);

    const result = resolveAllTrades(trades, exitPrices);

    expect(result.winsCount).toBe(1);
    expect(result.validTrades).toBe(1);
    expect(result.cancelledCount).toBe(1);
    expect(result.makerWins).toBe(true); // 1/1 > 50%
  });
});

// ============================================================================
// Serialization Tests
// ============================================================================

describe("Serialization", () => {
  it("should serialize and deserialize tree", () => {
    const trades = createTrades(4);
    const tree = buildMerkleTree("test-snapshot", trades);

    const json = serializeTree(tree);
    const restored = deserializeTree(json);

    expect(restored.snapshotId).toBe(tree.snapshotId);
    expect(restored.root).toBe(tree.root);
    expect(restored.leaves).toEqual(tree.leaves);
    expect(restored.trades.length).toBe(tree.trades.length);

    // Check BigInt values preserved
    for (let i = 0; i < trades.length; i++) {
      expect(restored.trades[i].entryPrice).toBe(tree.trades[i].entryPrice);
      expect(restored.trades[i].tradeId).toBe(tree.trades[i].tradeId);
    }
  });
});

// ============================================================================
// Performance Tests
// ============================================================================

describe("Performance", () => {
  it("should handle 1000 trades efficiently", () => {
    const start = Date.now();
    const trades = createTrades(1000);
    const tree = buildMerkleTree("test", trades);

    // Generate proofs for all using batch function (builds tree once)
    const indices = Array.from({ length: trades.length }, (_, i) => i);
    const proofs = generateProofs(tree.leaves, indices);

    // Verify all proofs
    for (let i = 0; i < trades.length; i++) {
      verifyProof(tree.leaves[i], proofs[i], tree.root);
    }

    const elapsed = Date.now() - start;
    console.log(`1000 trades: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(5000); // Should complete in < 5s
  });

  it("should compute tree depth correctly", () => {
    expect(getTreeDepth(1)).toBe(0);
    expect(getTreeDepth(2)).toBe(1);
    expect(getTreeDepth(4)).toBe(2);
    expect(getTreeDepth(8)).toBe(3);
    expect(getTreeDepth(1000)).toBe(10);
    expect(getTreeDepth(1_000_000)).toBe(20);
  });
});
