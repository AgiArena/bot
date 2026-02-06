/**
 * Merkle Tree Utilities for P2P Trade Resolution
 *
 * Story 15-1: Efficient Merkle tree for up to 1M trades
 * - Compute root from trade leaves
 * - Generate proofs for specific trades
 * - Verify proofs against root
 * - Memory-efficient (doesn't store full tree)
 */

import { keccak256, encodeAbiParameters, parseAbiParameters, bytesToHex } from "viem";

// ============================================================================
// Types
// ============================================================================

/**
 * Trade data structure (matches Solidity struct)
 *
 * Story 5-2: Method-based resolution (up:X, down:X, flat:X)
 * - "up:X" = maker wins if price increased > X%
 * - "down:X" = maker wins if price decreased > X%
 * - "flat:X" = maker wins if price stayed within ±X%
 */
export interface Trade {
  /** Unique trade ID: keccak256(snapshotId, index) */
  tradeId: `0x${string}`;
  /** Asset ticker (e.g., "BTC", "AAPL") */
  ticker: string;
  /** Price source (e.g., "coingecko", "stocks") */
  source: string;
  /** Resolution method (e.g., "up:0", "down:5", "flat:2") */
  method: string;
  /** Entry price at bet creation (18 decimals) */
  entryPrice: bigint;
  /** Exit price at resolution (18 decimals, 0 until resolved) */
  exitPrice: bigint;
  /** Whether maker won this trade */
  won: boolean;
  /** Whether trade was cancelled (bad data) */
  cancelled: boolean;
}

/**
 * Merkle proof for a single leaf
 */
export interface MerkleProof {
  /** Index of the leaf in the tree */
  index: number;
  /** Sibling hashes from leaf to root */
  siblings: `0x${string}`[];
}

/**
 * Complete Merkle tree data (for local storage)
 */
export interface MerkleTree {
  /** Snapshot ID reference */
  snapshotId: string;
  /** All trades in order */
  trades: Trade[];
  /** Hashed leaves (keccak256 of each trade) */
  leaves: `0x${string}`[];
  /** Merkle root */
  root: `0x${string}`;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum supported trades (2^20 = ~1M) */
export const MAX_TRADES = 1_048_576;

/** Empty leaf hash (for padding) */
export const EMPTY_LEAF: `0x${string}` = keccak256("0x");

// ============================================================================
// Trade Hashing
// ============================================================================

/**
 * Hash a trade to create a Merkle leaf
 *
 * Uses abi.encode to match Solidity's keccak256(abi.encode(...))
 *
 * Story 5-2: Removed position field, method now encodes direction+threshold
 */
export function hashTrade(trade: Trade): `0x${string}` {
  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "bytes32 tradeId, string ticker, string source, string method, uint256 entryPrice, uint256 exitPrice, bool won, bool cancelled"
    ),
    [
      trade.tradeId,
      trade.ticker,
      trade.source,
      trade.method,
      trade.entryPrice,
      trade.exitPrice,
      trade.won,
      trade.cancelled,
    ]
  );
  return keccak256(encoded);
}

/**
 * Generate trade ID from snapshot and index
 */
export function generateTradeId(
  snapshotId: string,
  index: number
): `0x${string}` {
  const encoded = encodeAbiParameters(
    parseAbiParameters("string snapshotId, uint256 index"),
    [snapshotId, BigInt(index)]
  );
  return keccak256(encoded);
}

// ============================================================================
// Merkle Tree Construction
// ============================================================================

/**
 * Compute Merkle root from leaves
 *
 * Memory-efficient: only stores current level during computation
 *
 * @param leaves - Array of leaf hashes
 * @returns Merkle root
 */
export function computeMerkleRoot(leaves: `0x${string}`[]): `0x${string}` {
  if (leaves.length === 0) {
    return EMPTY_LEAF;
  }

  if (leaves.length > MAX_TRADES) {
    throw new Error(`Too many leaves: ${leaves.length} > ${MAX_TRADES}`);
  }

  // Pad to power of 2
  let level = [...leaves];
  const targetSize = nextPowerOf2(level.length);
  while (level.length < targetSize) {
    level.push(EMPTY_LEAF);
  }

  // Build tree level by level
  while (level.length > 1) {
    const nextLevel: `0x${string}`[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1];
      nextLevel.push(hashPair(left, right));
    }
    level = nextLevel;
  }

  return level[0];
}

/**
 * Build complete Merkle tree from trades
 *
 * @param snapshotId - Snapshot reference
 * @param trades - Array of trades
 * @returns Complete tree data for local storage
 */
export function buildMerkleTree(
  snapshotId: string,
  trades: Trade[]
): MerkleTree {
  if (trades.length > MAX_TRADES) {
    throw new Error(`Too many trades: ${trades.length} > ${MAX_TRADES}`);
  }

  // Hash all trades to leaves
  const leaves = trades.map((t) => hashTrade(t));

  // Compute root
  const root = computeMerkleRoot(leaves);

  return {
    snapshotId,
    trades,
    leaves,
    root,
  };
}

// ============================================================================
// Proof Generation
// ============================================================================

/**
 * Generate Merkle proof for a specific leaf index
 *
 * @param leaves - All leaves in the tree
 * @param index - Index of the leaf to prove
 * @returns Merkle proof (siblings from leaf to root)
 */
export function generateProof(
  leaves: `0x${string}`[],
  index: number
): MerkleProof {
  if (index < 0 || index >= leaves.length) {
    throw new Error(`Index out of bounds: ${index}`);
  }

  // Pad to power of 2
  let level = [...leaves];
  const targetSize = nextPowerOf2(level.length);
  while (level.length < targetSize) {
    level.push(EMPTY_LEAF);
  }

  const siblings: `0x${string}`[] = [];
  let currentIndex = index;

  // Collect siblings at each level
  while (level.length > 1) {
    // Sibling is the adjacent node
    const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
    siblings.push(level[siblingIndex]);

    // Build next level
    const nextLevel: `0x${string}`[] = [];
    for (let i = 0; i < level.length; i += 2) {
      nextLevel.push(hashPair(level[i], level[i + 1]));
    }
    level = nextLevel;

    // Update index for next level
    currentIndex = Math.floor(currentIndex / 2);
  }

  return { index, siblings };
}

/**
 * Generate proofs for multiple leaves (optimized - builds tree once)
 *
 * @param leaves - All leaves in the tree
 * @param indices - Indices of leaves to prove
 * @returns Array of proofs
 */
export function generateProofs(
  leaves: `0x${string}`[],
  indices: number[]
): MerkleProof[] {
  if (leaves.length === 0 || indices.length === 0) {
    return [];
  }

  // Build all tree levels once
  const levels = buildTreeLevels(leaves);

  // Generate proofs using cached levels
  return indices.map((index) => generateProofFromLevels(levels, index, leaves.length));
}

/**
 * Build all tree levels (for batch proof generation)
 */
function buildTreeLevels(leaves: `0x${string}`[]): `0x${string}`[][] {
  // Pad to power of 2
  let level = [...leaves];
  const targetSize = nextPowerOf2(level.length);
  while (level.length < targetSize) {
    level.push(EMPTY_LEAF);
  }

  const levels: `0x${string}`[][] = [level];

  // Build tree level by level
  while (level.length > 1) {
    const nextLevel: `0x${string}`[] = [];
    for (let i = 0; i < level.length; i += 2) {
      nextLevel.push(hashPair(level[i], level[i + 1]));
    }
    levels.push(nextLevel);
    level = nextLevel;
  }

  return levels;
}

/**
 * Generate proof from pre-computed levels
 */
function generateProofFromLevels(
  levels: `0x${string}`[][],
  index: number,
  originalLeafCount: number
): MerkleProof {
  if (index < 0 || index >= originalLeafCount) {
    throw new Error(`Index out of bounds: ${index}`);
  }

  const siblings: `0x${string}`[] = [];
  let currentIndex = index;

  // Collect siblings from each level (except the root level)
  for (let levelIdx = 0; levelIdx < levels.length - 1; levelIdx++) {
    const level = levels[levelIdx];
    const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
    siblings.push(level[siblingIndex]);
    currentIndex = Math.floor(currentIndex / 2);
  }

  return { index, siblings };
}

// ============================================================================
// Proof Verification
// ============================================================================

/**
 * Verify a Merkle proof
 *
 * @param leaf - The leaf hash to verify
 * @param proof - The Merkle proof
 * @param root - The expected root
 * @returns True if proof is valid
 */
export function verifyProof(
  leaf: `0x${string}`,
  proof: MerkleProof,
  root: `0x${string}`
): boolean {
  let hash = leaf;
  let index = proof.index;

  for (const sibling of proof.siblings) {
    if (index % 2 === 0) {
      hash = hashPair(hash, sibling);
    } else {
      hash = hashPair(sibling, hash);
    }
    index = Math.floor(index / 2);
  }

  return hash === root;
}

/**
 * Verify a trade exists in the tree
 *
 * @param trade - The trade to verify
 * @param proof - The Merkle proof
 * @param root - The expected root
 * @returns True if trade is in the tree
 */
export function verifyTrade(
  trade: Trade,
  proof: MerkleProof,
  root: `0x${string}`
): boolean {
  const leaf = hashTrade(trade);
  return verifyProof(leaf, proof, root);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Hash two nodes together (sorted for consistency)
 */
function hashPair(a: `0x${string}`, b: `0x${string}`): `0x${string}` {
  // Sort to ensure consistent ordering (smaller first)
  const [first, second] = a < b ? [a, b] : [b, a];
  const encoded = encodeAbiParameters(
    parseAbiParameters("bytes32 a, bytes32 b"),
    [first as `0x${string}`, second as `0x${string}`]
  );
  return keccak256(encoded);
}

/**
 * Get next power of 2 >= n (minimum 2 for merkle tree padding)
 */
function nextPowerOf2(n: number): number {
  if (n <= 2) return 2; // Always at least 2 for proper merkle tree
  return Math.pow(2, Math.ceil(Math.log2(n)));
}

/**
 * Get tree depth for n leaves
 */
export function getTreeDepth(leafCount: number): number {
  if (leafCount <= 1) return 0;
  return Math.ceil(Math.log2(leafCount));
}

// ============================================================================
// Trade Outcome Resolution (Story 5-2: Method-Based)
// ============================================================================

/** Basis points base for integer arithmetic */
export const BPS_BASE = 10000n;

/**
 * Parsed method with type and threshold
 */
export interface ParsedMethod {
  type: 'up' | 'down' | 'flat';
  thresholdBps: bigint;
}

/**
 * Parse method string into type and threshold
 *
 * Uses INTEGER-ONLY parsing for cross-component determinism.
 * Avoids parseFloat to prevent floating point inconsistencies between
 * TypeScript Bot, Rust Data Node, and Rust Keeper implementations.
 *
 * @param method - Method string (e.g., "up:10", "down:5", "flat:2")
 * @returns Parsed method object
 * @throws Error if method format is invalid
 */
export function parseMethod(method: string): ParsedMethod {
  // Validate format: type:threshold where threshold is 0-9999 with optional decimals
  const match = method.match(/^(up|down|flat):(\d{1,4}(?:\.\d{1,2})?)$/);
  if (!match) {
    throw new Error(`Invalid method format: "${method}". Expected "up:X", "down:X", or "flat:X" where X is 0-99.99`);
  }

  const type = match[1] as 'up' | 'down' | 'flat';
  const thresholdStr = match[2];

  // INTEGER-ONLY threshold parsing (matches Rust keeper/data-node implementations)
  // Split on decimal point and compute bps without floating point
  let thresholdBps: bigint;
  const dotIndex = thresholdStr.indexOf('.');

  if (dotIndex === -1) {
    // No decimal: "10" -> 1000 bps
    thresholdBps = BigInt(parseInt(thresholdStr, 10)) * 100n;
  } else {
    // Has decimal: parse integer and decimal parts separately
    const intPart = thresholdStr.substring(0, dotIndex);
    const decPart = thresholdStr.substring(dotIndex + 1);

    const intVal = intPart === '' ? 0n : BigInt(parseInt(intPart, 10));

    // Decimal part: pad or truncate to 2 digits
    // "5" -> 50, "55" -> 55, "555" -> 55 (truncate to 2)
    let decVal: bigint;
    if (decPart.length === 0) {
      decVal = 0n;
    } else if (decPart.length === 1) {
      // Single digit: "5" means 50 hundredths
      decVal = BigInt(parseInt(decPart, 10)) * 10n;
    } else {
      // Two or more digits: take first 2
      decVal = BigInt(parseInt(decPart.substring(0, 2), 10));
    }

    // Combine: intVal * 100 + decVal
    // 10.5 -> 10 * 100 + 50 = 1050 bps
    thresholdBps = intVal * 100n + decVal;
  }

  // Validate threshold range (0-9999 bps = 0-99.99%)
  if (thresholdBps > 9999n) {
    throw new Error(`Invalid threshold: ${thresholdStr}%. Must be 0-99.99%`);
  }

  return { type, thresholdBps };
}

/**
 * Evaluate a single trade using method-based resolution
 *
 * Story 5-2: BigInt arithmetic ONLY for determinism
 *
 * @param entry - Entry price (any positive bigint)
 * @param exit - Exit price (any positive bigint, or null if pending)
 * @param method - Method string (e.g., "up:10", "down:5", "flat:2")
 * @returns true if maker wins, false if taker wins, null if pending/invalid
 */
export function evaluateTrade(
  entry: bigint,
  exit: bigint | null,
  method: string
): boolean | null {
  // Null exit = pending resolution
  if (exit === null) {
    return null;
  }

  // Zero entry = invalid (can't compute percentage)
  if (entry === 0n) {
    throw new Error("Invalid trade: entry price cannot be zero");
  }

  // No movement = skip (don't count toward either side)
  if (entry === exit) {
    return null;
  }

  const { type, thresholdBps } = parseMethod(method);

  switch (type) {
    case 'up':
      // Maker wins if exit > entry * (1 + threshold%)
      // Integer form: exit * BPS_BASE > entry * (BPS_BASE + thresholdBps)
      return exit * BPS_BASE > entry * (BPS_BASE + thresholdBps);

    case 'down':
      // Maker wins if exit < entry * (1 - threshold%)
      // Integer form: exit * BPS_BASE < entry * (BPS_BASE - thresholdBps)
      return exit * BPS_BASE < entry * (BPS_BASE - thresholdBps);

    case 'flat':
      // Maker wins if |exit - entry| / entry <= threshold%
      // Integer form: |exit - entry| * BPS_BASE <= entry * thresholdBps
      const diff = exit > entry ? exit - entry : entry - exit;
      return diff * BPS_BASE <= entry * thresholdBps;

    default:
      throw new Error(`Unknown method type: ${type}`);
  }
}

/**
 * Compute trade outcome based on entry/exit prices and method
 *
 * Story 5-2: Method-based resolution (up:X, down:X, flat:X)
 *
 * @param trade - Trade with entry price and method
 * @param exitPrice - Exit price at resolution
 * @returns Updated trade with exit price, won, cancelled
 */
export function resolveTradeOutcome(
  trade: Trade,
  exitPrice: bigint
): Trade {
  // Check for invalid exit data
  if (exitPrice === 0n) {
    return { ...trade, exitPrice: 0n, won: false, cancelled: true };
  }

  // Check for zero entry (can't compute percentage)
  if (trade.entryPrice === 0n) {
    return { ...trade, exitPrice, won: false, cancelled: true };
  }

  try {
    const makerWins = evaluateTrade(trade.entryPrice, exitPrice, trade.method);

    // Null result = pending (shouldn't happen with non-null exitPrice)
    if (makerWins === null) {
      return { ...trade, exitPrice, won: false, cancelled: true };
    }

    return { ...trade, exitPrice, won: makerWins, cancelled: false };
  } catch {
    // Invalid method = cancelled
    return { ...trade, exitPrice, won: false, cancelled: true };
  }
}

/**
 * Compute resolution for all trades
 *
 * Story 5-2: Method-based resolution - maker/taker terminology
 *
 * @param trades - Original trades with entry prices and methods
 * @param exitPrices - Map of tradeId -> exitPrice
 * @returns Resolved trades and summary
 */
export function resolveAllTrades(
  trades: Trade[],
  exitPrices: Map<string, bigint>
): {
  resolvedTrades: Trade[];
  winsCount: number;
  validTrades: number;
  cancelledCount: number;
  makerWins: boolean;
  isTie: boolean;
} {
  const resolvedTrades: Trade[] = [];
  let winsCount = 0;
  let cancelledCount = 0;

  for (const trade of trades) {
    const exitPrice = exitPrices.get(trade.tradeId) ?? 0n;
    const resolved = resolveTradeOutcome(trade, exitPrice);
    resolvedTrades.push(resolved);

    if (resolved.cancelled) {
      cancelledCount++;
    } else if (resolved.won) {
      winsCount++;
    }
  }

  const validTrades = trades.length - cancelledCount;
  const isCancelled = validTrades === 0;
  const isTie = !isCancelled && winsCount * 2 === validTrades;
  const makerWins = !isCancelled && !isTie && winsCount * 2 > validTrades;

  return {
    resolvedTrades,
    winsCount,
    validTrades,
    cancelledCount,
    makerWins,
    isTie,
  };
}

// ============================================================================
// Serialization (for local storage / P2P transfer)
// ============================================================================

/**
 * Serialize tree to JSON-compatible format
 */
export function serializeTree(tree: MerkleTree): string {
  return JSON.stringify({
    snapshotId: tree.snapshotId,
    trades: tree.trades.map((t) => ({
      ...t,
      tradeId: t.tradeId,
      entryPrice: t.entryPrice.toString(),
      exitPrice: t.exitPrice.toString(),
    })),
    leaves: tree.leaves,
    root: tree.root,
  });
}

/**
 * Deserialize tree from JSON
 */
export function deserializeTree(json: string): MerkleTree {
  const data = JSON.parse(json);
  return {
    snapshotId: data.snapshotId,
    trades: data.trades.map((t: any) => ({
      ...t,
      entryPrice: BigInt(t.entryPrice),
      exitPrice: BigInt(t.exitPrice),
    })),
    leaves: data.leaves,
    root: data.root,
  };
}

/**
 * Serialize proof to JSON-compatible format
 */
export function serializeProof(proof: MerkleProof): string {
  return JSON.stringify(proof);
}

/**
 * Deserialize proof from JSON
 */
export function deserializeProof(json: string): MerkleProof {
  return JSON.parse(json);
}

// ============================================================================
// Bilateral Bet Merkle Tree (Story 2-3)
// ============================================================================

/**
 * Build Merkle tree for bilateral bet from trade methods
 *
 * Story 5-2: Method-based resolution (up:X, down:X, flat:X)
 *
 * @param snapshotId - Snapshot reference (e.g., "crypto-2026-01-28-18")
 * @param methods - Array of method strings (e.g., ["up:0", "down:5", "flat:2"])
 * @param entryPrices - Map of index -> entry price (18 decimals)
 * @param tickers - Array of asset tickers matching method indices
 * @returns Complete Merkle tree data
 */
export function buildBilateralMerkleTree(
  snapshotId: string,
  methods: string[],
  entryPrices: Map<number, bigint>,
  tickers: string[],
): MerkleTree {
  const trades: Trade[] = [];

  for (let i = 0; i < tickers.length; i++) {
    const trade: Trade = {
      tradeId: generateTradeId(snapshotId, i),
      ticker: tickers[i],
      source: "snapshot",
      method: methods[i] ?? "up:0",
      entryPrice: entryPrices.get(i) ?? 0n,
      exitPrice: 0n,
      won: false,
      cancelled: false,
    };

    trades.push(trade);
  }

  return buildMerkleTree(snapshotId, trades);
}

/**
 * Compute tradesRoot: keccak256(snapshotId || positionBitmap)
 * This is what goes on-chain, not the full Merkle root
 *
 * Story 2-3 Task 1.4: tradesHash computation
 *
 * NOTE: positionBitmap is used for on-chain bet COMMITMENT (identifying the trade set),
 * while the `method` field on Trade is used for RESOLUTION logic (up/down/flat evaluation).
 * These are separate concerns: bitmap = what trades, method = how to evaluate.
 *
 * CRITICAL: Must match ChainClient.computeTradesHash exactly
 */
export function computeTradesRoot(snapshotId: string, positionBitmap: Uint8Array): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("string snapshotId, bytes bitmap"),
      [snapshotId, bytesToHex(positionBitmap)]
    )
  );
}
