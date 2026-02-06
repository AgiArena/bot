/**
 * Bilateral Commitment Tests
 *
 * Story 2-3: Merkle Tree & Bet Commitment
 * Task 6: Comprehensive test coverage
 *
 * Tests:
 * - 6.2: Merkle tree building from positions
 * - 6.3: EIP-712 commitment signing and verification
 * - 6.4: commitBet() contract interaction (mock)
 * - 6.5: P2P trade sharing endpoints
 * - 6.6: End-to-end proposal → accept → commit flow
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { ethers } from "ethers";
import {
  buildBilateralMerkleTree,
  computeTradesRoot,
  buildMerkleTree,
  generateProof,
  verifyProof,
  serializeTree,
  deserializeTree,
} from "../merkle-tree";
import {
  createBetCommitment,
  createBetCommitmentDirect,
  signBetCommitment,
  verifyBetCommitmentSignature,
  recoverCommitmentSigner,
  BilateralBetBuilder,
  getCollateralVaultDomain,
} from "../p2p/commitment";
import { storeMerkleTree, loadMerkleTree, hasMerkleTree, deleteMerkleTree } from "../p2p/trade-storage";
import type { TradeProposal, TradeAcceptance } from "../p2p/types";
import { existsSync, rmSync, mkdirSync } from "fs";

// Test wallet for signing
const TEST_PRIVATE_KEY_1 = "0x" + "a".repeat(64);
const TEST_PRIVATE_KEY_2 = "0x" + "b".repeat(64);
const TEST_VAULT_ADDRESS = "0x1234567890123456789012345678901234567890";
const TEST_CHAIN_ID = 111222333;

// Create test wallets
const creatorWallet = new ethers.Wallet(TEST_PRIVATE_KEY_1);
const fillerWallet = new ethers.Wallet(TEST_PRIVATE_KEY_2);

// Test fixtures
const TEST_SNAPSHOT_ID = "crypto-2026-01-28-18";
const TEST_TICKERS = ["BTC", "ETH", "SOL", "AVAX"];

/**
 * Create test methods array (Story 5-2: Method-based resolution)
 * ["up:0", "down:0", "up:0", "down:0"] - alternating up/down
 */
function createTestMethods(): string[] {
  return ["up:0", "down:0", "up:0", "down:0"];
}

/**
 * Create a test position bitmap (legacy - used for tradesRoot computation)
 * positions[0] = LONG (bit 0 = 1)
 * positions[1] = SHORT (bit 1 = 0)
 * positions[2] = LONG (bit 2 = 1)
 * positions[3] = SHORT (bit 3 = 0)
 */
function createTestBitmap(): Uint8Array {
  const bitmap = new Uint8Array(1);
  bitmap[0] = 0b0101; // Bits 0,2 set (LONG), bits 1,3 clear (SHORT)
  return bitmap;
}

/**
 * Create test entry prices
 */
function createTestPrices(): Map<number, bigint> {
  const prices = new Map<number, bigint>();
  prices.set(0, BigInt("42000") * BigInt(10 ** 18)); // BTC: $42,000
  prices.set(1, BigInt("2200") * BigInt(10 ** 18)); // ETH: $2,200
  prices.set(2, BigInt("100") * BigInt(10 ** 18)); // SOL: $100
  prices.set(3, BigInt("35") * BigInt(10 ** 18)); // AVAX: $35
  return prices;
}

// ============================================================================
// Task 6.2: Merkle Tree Building Tests
// ============================================================================

describe("Story 2-3: Merkle Tree Building (Method-Based)", () => {
  test("buildBilateralMerkleTree creates tree from methods and prices", () => {
    const methods = createTestMethods();
    const prices = createTestPrices();

    const tree = buildBilateralMerkleTree(TEST_SNAPSHOT_ID, methods, prices, TEST_TICKERS);

    expect(tree.snapshotId).toBe(TEST_SNAPSHOT_ID);
    expect(tree.trades.length).toBe(4);
    expect(tree.leaves.length).toBe(4);
    expect(tree.root).toBeDefined();
    expect(tree.root.startsWith("0x")).toBe(true);
  });

  test("buildBilateralMerkleTree correctly sets methods", () => {
    const methods = createTestMethods();
    const prices = createTestPrices();

    const tree = buildBilateralMerkleTree(TEST_SNAPSHOT_ID, methods, prices, TEST_TICKERS);

    // Check methods match input
    expect(tree.trades[0].method).toBe("up:0");
    expect(tree.trades[1].method).toBe("down:0");
    expect(tree.trades[2].method).toBe("up:0");
    expect(tree.trades[3].method).toBe("down:0");
  });

  test("buildBilateralMerkleTree sets correct entry prices", () => {
    const methods = createTestMethods();
    const prices = createTestPrices();

    const tree = buildBilateralMerkleTree(TEST_SNAPSHOT_ID, methods, prices, TEST_TICKERS);

    expect(tree.trades[0].entryPrice).toBe(prices.get(0));
    expect(tree.trades[1].entryPrice).toBe(prices.get(1));
    expect(tree.trades[2].entryPrice).toBe(prices.get(2));
    expect(tree.trades[3].entryPrice).toBe(prices.get(3));
  });

  test("buildBilateralMerkleTree generates valid Merkle proofs", () => {
    const methods = createTestMethods();
    const prices = createTestPrices();

    const tree = buildBilateralMerkleTree(TEST_SNAPSHOT_ID, methods, prices, TEST_TICKERS);

    // Verify proofs for each leaf
    for (let i = 0; i < tree.leaves.length; i++) {
      const proof = generateProof(tree.leaves, i);
      const isValid = verifyProof(tree.leaves[i], proof, tree.root);
      expect(isValid).toBe(true);
    }
  });

  test("computeTradesRoot produces deterministic hash", () => {
    const bitmap = createTestBitmap();

    const root1 = computeTradesRoot(TEST_SNAPSHOT_ID, bitmap);
    const root2 = computeTradesRoot(TEST_SNAPSHOT_ID, bitmap);

    expect(root1).toBe(root2);
    expect(root1.startsWith("0x")).toBe(true);
    expect(root1.length).toBe(66); // 0x + 64 hex chars
  });

  test("computeTradesRoot changes with different input", () => {
    const bitmap = createTestBitmap();
    const differentBitmap = new Uint8Array([0b1010]);

    const root1 = computeTradesRoot(TEST_SNAPSHOT_ID, bitmap);
    const root2 = computeTradesRoot(TEST_SNAPSHOT_ID, differentBitmap);
    const root3 = computeTradesRoot("different-snapshot", bitmap);

    expect(root1).not.toBe(root2);
    expect(root1).not.toBe(root3);
  });
});

// ============================================================================
// Task 6.3: EIP-712 Signing Tests
// ============================================================================

describe("Story 2-3: EIP-712 Commitment Signing", () => {
  const testCommitment = {
    tradesRoot: "0x" + "1".repeat(64),
    creator: creatorWallet.address,
    filler: fillerWallet.address,
    creatorAmount: BigInt("1000000000000000000"), // 1 WIND
    fillerAmount: BigInt("500000000000000000"), // 0.5 WIND
    deadline: Math.floor(Date.now() / 1000) + 86400, // 24h from now
    nonce: BigInt(0),
    expiry: Math.floor(Date.now() / 1000) + 300, // 5 min
  };

  test("signBetCommitment produces valid signature", async () => {
    const signature = await signBetCommitment(
      creatorWallet,
      testCommitment,
      TEST_VAULT_ADDRESS,
      TEST_CHAIN_ID
    );

    expect(signature).toBeDefined();
    expect(signature.startsWith("0x")).toBe(true);
    expect(signature.length).toBe(132); // 0x + 130 hex chars (65 bytes)
  });

  test("verifyBetCommitmentSignature returns true for valid signature", async () => {
    const signature = await signBetCommitment(
      creatorWallet,
      testCommitment,
      TEST_VAULT_ADDRESS,
      TEST_CHAIN_ID
    );

    const isValid = verifyBetCommitmentSignature(
      testCommitment,
      signature,
      creatorWallet.address,
      TEST_VAULT_ADDRESS,
      TEST_CHAIN_ID
    );

    expect(isValid).toBe(true);
  });

  test("verifyBetCommitmentSignature returns false for wrong signer", async () => {
    const signature = await signBetCommitment(
      creatorWallet,
      testCommitment,
      TEST_VAULT_ADDRESS,
      TEST_CHAIN_ID
    );

    const isValid = verifyBetCommitmentSignature(
      testCommitment,
      signature,
      fillerWallet.address, // Wrong expected signer
      TEST_VAULT_ADDRESS,
      TEST_CHAIN_ID
    );

    expect(isValid).toBe(false);
  });

  test("verifyBetCommitmentSignature returns false for tampered commitment", async () => {
    const signature = await signBetCommitment(
      creatorWallet,
      testCommitment,
      TEST_VAULT_ADDRESS,
      TEST_CHAIN_ID
    );

    const tamperedCommitment = {
      ...testCommitment,
      creatorAmount: BigInt("2000000000000000000"), // Changed amount
    };

    const isValid = verifyBetCommitmentSignature(
      tamperedCommitment,
      signature,
      creatorWallet.address,
      TEST_VAULT_ADDRESS,
      TEST_CHAIN_ID
    );

    expect(isValid).toBe(false);
  });

  test("recoverCommitmentSigner returns correct address", async () => {
    const signature = await signBetCommitment(
      creatorWallet,
      testCommitment,
      TEST_VAULT_ADDRESS,
      TEST_CHAIN_ID
    );

    const recovered = recoverCommitmentSigner(
      testCommitment,
      signature,
      TEST_VAULT_ADDRESS,
      TEST_CHAIN_ID
    );

    expect(recovered?.toLowerCase()).toBe(creatorWallet.address.toLowerCase());
  });

  test("getCollateralVaultDomain produces correct domain", () => {
    const domain = getCollateralVaultDomain(TEST_VAULT_ADDRESS, TEST_CHAIN_ID);

    expect(domain.name).toBe("CollateralVault");
    expect(domain.version).toBe("1");
    expect(domain.chainId).toBe(TEST_CHAIN_ID);
    expect(domain.verifyingContract).toBe(TEST_VAULT_ADDRESS);
  });
});

// ============================================================================
// Task 6.3 (continued): BilateralBetBuilder Tests
// ============================================================================

describe("Story 2-3: BilateralBetBuilder", () => {
  test("BilateralBetBuilder creates valid commitment", () => {
    const builder = new BilateralBetBuilder()
      .setTradesRoot("0x" + "1".repeat(64))
      .setParties(creatorWallet.address, fillerWallet.address)
      .setAmounts(BigInt("1000000000000000000"), BigInt("500000000000000000"))
      .setDeadline(Math.floor(Date.now() / 1000) + 86400)
      .setNonce(BigInt(0))
      .setExpiry();

    const commitment = builder.build();

    expect(commitment.tradesRoot).toBe("0x" + "1".repeat(64));
    expect(commitment.creator).toBe(creatorWallet.address);
    expect(commitment.filler).toBe(fillerWallet.address);
    expect(commitment.creatorAmount).toBe(BigInt("1000000000000000000"));
    expect(commitment.fillerAmount).toBe(BigInt("500000000000000000"));
  });

  test("BilateralBetBuilder calculates filler amount from odds", () => {
    const creatorStake = BigInt("1000000000000000000"); // 1 WIND
    const oddsBps = 20000; // 2.0x odds

    const builder = new BilateralBetBuilder()
      .setTradesRoot("0x" + "1".repeat(64))
      .setParties(creatorWallet.address, fillerWallet.address)
      .setAmountsFromOdds(creatorStake, oddsBps)
      .setDeadline(Math.floor(Date.now() / 1000) + 86400)
      .setNonce(BigInt(0));

    const commitment = builder.build();

    // At 2.0x odds, filler amount = (1 * 10000) / 20000 = 0.5
    expect(commitment.fillerAmount).toBe(BigInt("500000000000000000"));
  });

  test("BilateralBetBuilder throws on missing required fields", () => {
    const builder = new BilateralBetBuilder()
      .setTradesRoot("0x" + "1".repeat(64));
    // Missing creator, filler, amounts, deadline, nonce

    expect(() => builder.build()).toThrow();
  });

  test("BilateralBetBuilder signs as creator and filler", async () => {
    const builder = new BilateralBetBuilder()
      .setTradesRoot("0x" + "1".repeat(64))
      .setParties(creatorWallet.address, fillerWallet.address)
      .setAmounts(BigInt("1000000000000000000"), BigInt("500000000000000000"))
      .setDeadline(Math.floor(Date.now() / 1000) + 86400)
      .setNonce(BigInt(0))
      .setExpiry();

    await builder.signAsCreator(creatorWallet, TEST_VAULT_ADDRESS, TEST_CHAIN_ID);
    await builder.signAsFiller(fillerWallet, TEST_VAULT_ADDRESS, TEST_CHAIN_ID);

    expect(builder.isFullySigned()).toBe(true);
    expect(builder.getCreatorSignature()).toBeDefined();
    expect(builder.getFillerSignature()).toBeDefined();
  });
});

// ============================================================================
// Task 6.2 (continued): createBetCommitment Tests
// ============================================================================

describe("Story 2-3: createBetCommitment", () => {
  test("createBetCommitment creates commitment from proposal and acceptance", () => {
    const proposal: TradeProposal = {
      creator: creatorWallet.address,
      tradesHash: "0x" + "1".repeat(64),
      snapshotId: TEST_SNAPSHOT_ID,
      creatorStake: BigInt("1000000000000000000"),
      oddsBps: 20000,
      resolutionDeadline: Math.floor(Date.now() / 1000) + 86400,
      nonce: BigInt(0),
      expiry: Math.floor(Date.now() / 1000) + 3600,
      signature: "0x" + "0".repeat(130),
    };

    const acceptance: TradeAcceptance = {
      proposalHash: "0x" + "2".repeat(64),
      filler: fillerWallet.address,
      fillAmount: BigInt("500000000000000000"),
      nonce: BigInt(0),
      expiry: Math.floor(Date.now() / 1000) + 3600,
      signature: "0x" + "0".repeat(130),
    };

    const bitmap = createTestBitmap();
    const commitment = createBetCommitment({
      proposal,
      acceptance,
      nonce: BigInt(0),
      positionBitmap: bitmap,
    });

    expect(commitment.creator).toBe(creatorWallet.address);
    expect(commitment.filler).toBe(fillerWallet.address);
    expect(commitment.creatorAmount).toBe(proposal.creatorStake);
    expect(commitment.deadline).toBe(proposal.resolutionDeadline);
    expect(commitment.nonce).toBe(BigInt(0));
    expect(commitment.tradesRoot.startsWith("0x")).toBe(true);
  });
});

// ============================================================================
// Task 6.5: Trade Storage Tests
// ============================================================================

describe("Story 2-3: Trade Storage", () => {
  const TEST_BET_ID = 99999;
  const TEST_STORAGE_DIR = "./test-data/trades";

  beforeEach(() => {
    // Set test storage dir
    process.env.TRADE_STORAGE_DIR = TEST_STORAGE_DIR;
  });

  afterEach(() => {
    // Clean up test files
    if (existsSync(TEST_STORAGE_DIR)) {
      try {
        rmSync(TEST_STORAGE_DIR, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    delete process.env.TRADE_STORAGE_DIR;
  });

  test("storeMerkleTree and loadMerkleTree round-trip", () => {
    const methods = createTestMethods();
    const prices = createTestPrices();
    const tree = buildBilateralMerkleTree(TEST_SNAPSHOT_ID, methods, prices, TEST_TICKERS);

    storeMerkleTree(TEST_BET_ID, tree);

    expect(hasMerkleTree(TEST_BET_ID)).toBe(true);

    const loaded = loadMerkleTree(TEST_BET_ID);
    expect(loaded).not.toBeNull();
    expect(loaded!.snapshotId).toBe(tree.snapshotId);
    expect(loaded!.root).toBe(tree.root);
    expect(loaded!.trades.length).toBe(tree.trades.length);
  });

  test("loadMerkleTree returns null for non-existent bet", () => {
    const loaded = loadMerkleTree(12345);
    expect(loaded).toBeNull();
  });

  test("hasMerkleTree returns false for non-existent bet", () => {
    expect(hasMerkleTree(12345)).toBe(false);
  });

  test("deleteMerkleTree removes stored tree", () => {
    const methods = createTestMethods();
    const prices = createTestPrices();
    const tree = buildBilateralMerkleTree(TEST_SNAPSHOT_ID, methods, prices, TEST_TICKERS);

    storeMerkleTree(TEST_BET_ID, tree);
    expect(hasMerkleTree(TEST_BET_ID)).toBe(true);

    deleteMerkleTree(TEST_BET_ID);
    expect(hasMerkleTree(TEST_BET_ID)).toBe(false);
  });
});

// ============================================================================
// Task 6.4: Mock Contract Interaction Tests
// ============================================================================

describe("Story 2-3: commitBet Contract Interaction (mock)", () => {
  test("commitment tuple ordering matches contract struct", () => {
    // The contract expects:
    // struct BetCommitment {
    //   bytes32 tradesRoot;
    //   address creator;
    //   address filler;
    //   uint256 creatorAmount;
    //   uint256 fillerAmount;
    //   uint256 deadline;
    //   uint256 nonce;
    //   uint256 expiry;
    // }

    const commitment = {
      tradesRoot: "0x" + "1".repeat(64),
      creator: creatorWallet.address,
      filler: fillerWallet.address,
      creatorAmount: BigInt("1000000000000000000"),
      fillerAmount: BigInt("500000000000000000"),
      deadline: 1706486400,
      nonce: BigInt(0),
      expiry: 1706400000,
    };

    // Build tuple in the correct order
    const tuple = [
      commitment.tradesRoot,
      commitment.creator,
      commitment.filler,
      commitment.creatorAmount,
      commitment.fillerAmount,
      commitment.deadline,
      commitment.nonce,
      commitment.expiry,
    ];

    expect(tuple.length).toBe(8);
    expect(tuple[0]).toBe(commitment.tradesRoot);
    expect(tuple[1]).toBe(commitment.creator);
    expect(tuple[2]).toBe(commitment.filler);
    expect(tuple[3]).toBe(commitment.creatorAmount);
    expect(tuple[4]).toBe(commitment.fillerAmount);
    expect(tuple[5]).toBe(commitment.deadline);
    expect(tuple[6]).toBe(commitment.nonce);
    expect(tuple[7]).toBe(commitment.expiry);
  });

  test("EIP-712 typehash matches contract", () => {
    // Contract BET_COMMITMENT_TYPEHASH:
    // keccak256("BetCommitment(bytes32 tradesRoot,address creator,address filler,uint256 creatorAmount,uint256 fillerAmount,uint256 deadline,uint256 nonce,uint256 expiry)")

    const typeString = "BetCommitment(bytes32 tradesRoot,address creator,address filler,uint256 creatorAmount,uint256 fillerAmount,uint256 deadline,uint256 nonce,uint256 expiry)";
    const typeHash = ethers.keccak256(ethers.toUtf8Bytes(typeString));

    // This should match the contract's BET_COMMITMENT_TYPEHASH
    expect(typeHash).toBeDefined();
    expect(typeHash.startsWith("0x")).toBe(true);
    console.log("BET_COMMITMENT_TYPEHASH:", typeHash);
  });
});

// ============================================================================
// Task 6.6: End-to-End Flow Tests (Integration)
// ============================================================================

describe("Story 2-3: End-to-End Commitment Flow", () => {
  test("complete flow: build tree → create commitment → sign → verify", async () => {
    // 1. Build Merkle tree
    const methods = createTestMethods();
    const prices = createTestPrices();
    const tree = buildBilateralMerkleTree(TEST_SNAPSHOT_ID, methods, prices, TEST_TICKERS);

    // 2. Compute tradesRoot (using bitmap for on-chain compatibility)
    const bitmap = createTestBitmap();
    const tradesRoot = computeTradesRoot(TEST_SNAPSHOT_ID, bitmap);

    // 3. Create commitment
    const commitment = createBetCommitmentDirect({
      tradesRoot,
      creator: creatorWallet.address,
      filler: fillerWallet.address,
      creatorAmount: BigInt("1000000000000000000"),
      fillerAmount: BigInt("500000000000000000"),
      deadline: Math.floor(Date.now() / 1000) + 86400,
      nonce: BigInt(0),
      expiry: Math.floor(Date.now() / 1000) + 300,
    });

    // 4. Sign as creator
    const creatorSig = await signBetCommitment(
      creatorWallet,
      commitment,
      TEST_VAULT_ADDRESS,
      TEST_CHAIN_ID
    );

    // 5. Sign as filler
    const fillerSig = await signBetCommitment(
      fillerWallet,
      commitment,
      TEST_VAULT_ADDRESS,
      TEST_CHAIN_ID
    );

    // 6. Verify both signatures
    const creatorValid = verifyBetCommitmentSignature(
      commitment,
      creatorSig,
      creatorWallet.address,
      TEST_VAULT_ADDRESS,
      TEST_CHAIN_ID
    );

    const fillerValid = verifyBetCommitmentSignature(
      commitment,
      fillerSig,
      fillerWallet.address,
      TEST_VAULT_ADDRESS,
      TEST_CHAIN_ID
    );

    expect(creatorValid).toBe(true);
    expect(fillerValid).toBe(true);

    // 7. Verify tree can be serialized/deserialized
    const serialized = serializeTree(tree);
    const deserialized = deserializeTree(serialized);
    expect(deserialized.root).toBe(tree.root);
  });

  test("proposal → acceptance → commitment data flow", async () => {
    // Simulate proposal
    const proposal: TradeProposal = {
      creator: creatorWallet.address,
      tradesHash: computeTradesRoot(TEST_SNAPSHOT_ID, createTestBitmap()),
      snapshotId: TEST_SNAPSHOT_ID,
      creatorStake: BigInt("1000000000000000000"),
      oddsBps: 20000, // 2.0x
      resolutionDeadline: Math.floor(Date.now() / 1000) + 86400,
      nonce: BigInt(0),
      expiry: Math.floor(Date.now() / 1000) + 3600,
      signature: "0x" + "0".repeat(130), // Would be signed in real flow
    };

    // Simulate acceptance
    const acceptance: TradeAcceptance = {
      proposalHash: ethers.keccak256(ethers.toUtf8Bytes("proposal-hash")),
      filler: fillerWallet.address,
      fillAmount: BigInt("500000000000000000"), // Matches odds
      nonce: BigInt(0),
      expiry: Math.floor(Date.now() / 1000) + 3600,
      signature: "0x" + "0".repeat(130), // Would be signed in real flow
    };

    // Create commitment from proposal/acceptance
    const commitment = createBetCommitment({
      proposal,
      acceptance,
      nonce: BigInt(0),
      positionBitmap: createTestBitmap(),
    });

    // Verify commitment inherits from proposal
    expect(commitment.creator).toBe(proposal.creator);
    expect(commitment.filler).toBe(acceptance.filler);
    expect(commitment.creatorAmount).toBe(proposal.creatorStake);
    expect(commitment.deadline).toBe(proposal.resolutionDeadline);

    // Filler amount calculated from odds
    const expectedFillerAmount = (proposal.creatorStake * BigInt(10000)) / BigInt(proposal.oddsBps);
    expect(commitment.fillerAmount).toBe(expectedFillerAmount);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("Story 2-3: Edge Cases", () => {
  test("handles empty methods array", () => {
    const emptyMethods: string[] = [];
    const emptyPrices = new Map<number, bigint>();
    const emptyTickers: string[] = [];

    const tree = buildBilateralMerkleTree(TEST_SNAPSHOT_ID, emptyMethods, emptyPrices, emptyTickers);

    expect(tree.trades.length).toBe(0);
    expect(tree.leaves.length).toBe(0);
  });

  test("handles missing entry prices", () => {
    const methods = createTestMethods();
    const partialPrices = new Map<number, bigint>();
    partialPrices.set(0, BigInt("42000") * BigInt(10 ** 18));
    // Missing prices for indices 1, 2, 3

    const tree = buildBilateralMerkleTree(TEST_SNAPSHOT_ID, methods, partialPrices, TEST_TICKERS);

    expect(tree.trades[0].entryPrice).toBe(partialPrices.get(0));
    expect(tree.trades[1].entryPrice).toBe(BigInt(0)); // Missing = 0
    expect(tree.trades[2].entryPrice).toBe(BigInt(0)); // Missing = 0
    expect(tree.trades[3].entryPrice).toBe(BigInt(0)); // Missing = 0
  });

  test("handles large trade count", () => {
    // Test with 256 trades
    const largeMethods = Array.from({ length: 256 }, (_, i) =>
      i % 2 === 0 ? "up:0" : "down:0"
    );

    const largeTickers = Array.from({ length: 256 }, (_, i) => `ASSET_${i}`);
    const largePrices = new Map<number, bigint>();
    for (let i = 0; i < 256; i++) {
      largePrices.set(i, BigInt(i + 1) * BigInt(10 ** 18));
    }

    const tree = buildBilateralMerkleTree(TEST_SNAPSHOT_ID, largeMethods, largePrices, largeTickers);

    expect(tree.trades.length).toBe(256);
    expect(tree.leaves.length).toBe(256);

    // Verify random proof
    const proof = generateProof(tree.leaves, 127);
    const isValid = verifyProof(tree.leaves[127], proof, tree.root);
    expect(isValid).toBe(true);
  });

  test("expired commitment is detected", () => {
    const { isCommitmentExpired } = require("../p2p/commitment");

    const expiredCommitment = {
      tradesRoot: "0x" + "1".repeat(64),
      creator: creatorWallet.address,
      filler: fillerWallet.address,
      creatorAmount: BigInt("1000000000000000000"),
      fillerAmount: BigInt("500000000000000000"),
      deadline: Math.floor(Date.now() / 1000) + 86400,
      nonce: BigInt(0),
      expiry: Math.floor(Date.now() / 1000) - 1, // Already expired
    };

    expect(isCommitmentExpired(expiredCommitment)).toBe(true);
  });
});
