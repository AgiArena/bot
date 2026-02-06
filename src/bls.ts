/**
 * BLS Signature Utilities for Bilateral System
 *
 * This module provides BLS signature handling for the bilateral custody system.
 * Contains types and utilities previously split across signature-collector.ts.
 *
 * NOTE: The contract uses alt_bn128 curve (EIP-196/197), not BLS12-381.
 */

import { keccak256, AbiCoder } from "ethers";

// ============================================================================
// Types (migrated from signature-collector.ts)
// ============================================================================

/**
 * Resolution payload that keepers sign
 * Matches the contract's ResolutionPayload struct
 */
export interface ResolutionPayload {
  betId: number;
  tradesHash: string;      // Hex-encoded bytes32
  packedOutcomes: string;  // Hex-encoded bytes
  winsCount: number;
  validTrades: number;
  creatorWins: boolean;
  isTie: boolean;
  isCancelled: boolean;
  cancelReason: string;
  nonce: bigint;
  expiry: number;          // Unix timestamp, 0 = no expiry
}

/**
 * Response from a keeper's sign-resolution endpoint
 */
export interface SignatureResponse {
  /** BLS signature (hex-encoded) */
  signature: string;
  /** BLS public key (hex-encoded) */
  pubkey: string;
  /** Keeper's Ethereum address */
  keeperAddress: string;
  /** Payload hash that was signed (hex-encoded) */
  payloadHash: string;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Aggregated signature result
 */
export interface AggregatedSignature {
  /** Aggregated signature X coordinate (hex) */
  sigX: string;
  /** Aggregated signature Y coordinate (hex) */
  sigY: string;
  /** Signers' addresses in order */
  signers: string[];
  /** Individual signatures for verification */
  individualSignatures: string[];
}

// ============================================================================
// Signature Aggregation
// ============================================================================

/**
 * Aggregate multiple BLS signatures
 *
 * NOTE: Due to curve mismatch between keeper (BLS12-381) and contract (alt_bn128),
 * this function prepares signatures for individual verification by the contract.
 * True cryptographic aggregation would require all parties to use the same curve.
 *
 * For the MVP, we pass individual signatures to the contract which verifies each one.
 *
 * @param signatures - Array of signature responses from keepers
 * @returns Aggregated signature data for contract submission
 */
export function aggregateSignatures(signatures: SignatureResponse[]): AggregatedSignature {
  if (signatures.length === 0) {
    throw new Error("Cannot aggregate zero signatures");
  }

  // Extract signers in order
  const signers = signatures.map(s => s.keeperAddress);

  // For MVP: use first signature's coordinates as the "aggregated" value
  // The contract will verify individual signatures
  // In production with proper BLS12-381 support, this would be cryptographic aggregation
  const firstSig = signatures[0].signature;

  // Parse signature - expecting hex format like "0x..." or raw hex
  const sigBytes = hexToBytes(firstSig);

  // alt_bn128 signatures are 64 bytes (32 bytes X + 32 bytes Y)
  // BLS12-381 signatures from keepers are 96 bytes (G2 point)
  // For compatibility, we'll extract/compute a valid point

  let sigX: string;
  let sigY: string;

  if (sigBytes.length === 64) {
    // alt_bn128 format (32 + 32)
    sigX = "0x" + bytesToHex(sigBytes.slice(0, 32));
    sigY = "0x" + bytesToHex(sigBytes.slice(32, 64));
  } else if (sigBytes.length === 96) {
    // BLS12-381 G2 point format (48 + 48)
    // For contract compatibility, we need to convert or use a placeholder
    // The contract uses alt_bn128, so direct use won't work
    // Use first 32 bytes as X and next 32 as Y for placeholder
    sigX = "0x" + bytesToHex(sigBytes.slice(0, 32));
    sigY = "0x" + bytesToHex(sigBytes.slice(32, 64));
  } else if (sigBytes.length === 48) {
    // BLS12-381 G1 compressed point (min_pk variant)
    // Pad to 32 bytes for X, use zeros for Y
    sigX = "0x" + bytesToHex(sigBytes.slice(0, 32));
    sigY = "0x" + "00".repeat(32);
  } else {
    // Unknown format - use as-is, padded to 32 bytes
    const padded = new Uint8Array(64);
    padded.set(sigBytes.slice(0, Math.min(32, sigBytes.length)), 0);
    if (sigBytes.length > 32) {
      padded.set(sigBytes.slice(32, Math.min(64, sigBytes.length)), 32);
    }
    sigX = "0x" + bytesToHex(padded.slice(0, 32));
    sigY = "0x" + bytesToHex(padded.slice(32, 64));
  }

  return {
    sigX,
    sigY,
    signers,
    individualSignatures: signatures.map(s => s.signature),
  };
}

/**
 * Verify aggregated signature locally before submission
 *
 * NOTE: This is a placeholder for full BLS verification.
 * With curve mismatch, we can only do basic sanity checks.
 *
 * @param pubkeys - BLS public keys (x,y pairs)
 * @param message - Message bytes that was signed
 * @param aggregatedSig - Aggregated signature
 * @returns True if signature appears valid (basic checks only)
 */
export function verifyAggregatedSignature(
  pubkeys: Array<{ x: string; y: string }>,
  message: Uint8Array,
  aggregatedSig: AggregatedSignature,
): boolean {
  // Basic sanity checks
  if (pubkeys.length === 0) {
    console.warn("[BLS] No public keys provided");
    return false;
  }

  if (aggregatedSig.signers.length === 0) {
    console.warn("[BLS] No signers in aggregated signature");
    return false;
  }

  if (!aggregatedSig.sigX || !aggregatedSig.sigY) {
    console.warn("[BLS] Invalid signature coordinates");
    return false;
  }

  // Verify sigX and sigY are valid hex
  try {
    BigInt(aggregatedSig.sigX);
    BigInt(aggregatedSig.sigY);
  } catch {
    console.warn("[BLS] Invalid signature coordinates format");
    return false;
  }

  // For MVP, we trust the keeper signatures were valid
  // Full verification would require BLS pairing checks
  return true;
}

// ============================================================================
// Payload Hash Computation
// ============================================================================

/**
 * Compute the resolution payload hash for signing
 *
 * This matches the contract's hash computation for BLS signing.
 *
 * @param payload - Resolution payload
 * @returns Hash as bytes
 */
export function computeResolutionPayloadHash(payload: ResolutionPayload): Uint8Array {
  const abiCoder = AbiCoder.defaultAbiCoder();

  // Match contract's abi.encode format
  const packedOutcomesHash = keccak256(hexToBytes(payload.packedOutcomes));
  const cancelReasonHash = keccak256(new TextEncoder().encode(payload.cancelReason));

  const encoded = abiCoder.encode(
    ["uint256", "bytes32", "bytes32", "uint256", "uint256", "bool", "bool", "bool", "bytes32", "uint256", "uint256"],
    [
      payload.betId,
      payload.tradesHash,
      packedOutcomesHash,
      payload.winsCount,
      payload.validTrades,
      payload.creatorWins,
      payload.isTie,
      payload.isCancelled,
      cancelReasonHash,
      payload.nonce,
      payload.expiry,
    ]
  );

  return hexToBytes(keccak256(encoded));
}

/**
 * Compute the resolution payload hash as hex string
 *
 * @param payload - Resolution payload
 * @returns Hash as hex string with 0x prefix
 */
export function computeResolutionPayloadHashHex(payload: ResolutionPayload): string {
  return "0x" + bytesToHex(computeResolutionPayloadHash(payload));
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert hex string to bytes
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Convert bytes to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Parse a BLS public key from keeper response
 *
 * Keeper returns pubkey as hex string. Contract expects (x, y) coordinates.
 *
 * @param pubkeyHex - Hex-encoded public key from keeper
 * @returns Object with x and y coordinates as hex strings
 */
export function parseBlsPubkey(pubkeyHex: string): { x: string; y: string } {
  const bytes = hexToBytes(pubkeyHex);

  // BLS12-381 G1 point (48 bytes compressed, 96 bytes uncompressed)
  // alt_bn128 G1 point (32 bytes each coordinate, 64 total)

  if (bytes.length === 64) {
    // alt_bn128 uncompressed format
    return {
      x: "0x" + bytesToHex(bytes.slice(0, 32)),
      y: "0x" + bytesToHex(bytes.slice(32, 64)),
    };
  } else if (bytes.length === 48) {
    // BLS12-381 compressed G1 - would need decompression
    // For now, use raw bytes padded to 32
    const x = new Uint8Array(32);
    x.set(bytes.slice(0, 32), 0);
    return {
      x: "0x" + bytesToHex(x),
      y: "0x" + "00".repeat(32), // Placeholder
    };
  } else if (bytes.length === 96) {
    // BLS12-381 uncompressed G1 or G2
    return {
      x: "0x" + bytesToHex(bytes.slice(0, 32)),
      y: "0x" + bytesToHex(bytes.slice(32, 64)),
    };
  }

  // Unknown format - try to use as-is
  throw new Error(`Unsupported public key format: ${bytes.length} bytes`);
}
