/**
 * Bitmap Utilities for Position Encoding
 *
 * Story 9.2: Bot Bitmap Position Encoding and Upload
 *
 * Implements compact bitmap encoding for positions:
 * - LONG/YES = 1 bit
 * - SHORT/NO = 0 bit
 * - 10K trades → 1250 bytes → ~1.7KB base64
 *
 * Hash computation uses keccak256 matching backend Rust implementation.
 */

import { keccak256, toUtf8Bytes, concat } from "ethers";

/**
 * Valid position types for bitmap encoding
 */
export type BitmapPosition = 'LONG' | 'SHORT' | 'YES' | 'NO';

/**
 * Encode positions as a compact bitmap
 *
 * Bit encoding:
 * - LONG/YES = 1
 * - SHORT/NO = 0
 *
 * Bit order: position[i] maps to bit (i % 8) of byte floor(i / 8)
 * This matches the backend Rust implementation exactly.
 *
 * @param positions Array of position values
 * @returns Uint8Array bitmap
 */
export function encodePositionBitmap(
  positions: BitmapPosition[]
): Uint8Array {
  const byteCount = Math.ceil(positions.length / 8);
  const bitmap = new Uint8Array(byteCount);

  for (let i = 0; i < positions.length; i++) {
    const isLong = positions[i] === 'LONG' || positions[i] === 'YES';
    if (isLong) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = i % 8;
      bitmap[byteIndex] |= (1 << bitIndex);
    }
  }

  return bitmap;
}

/**
 * Decode a position from bitmap at given index
 *
 * @param bitmap The bitmap bytes
 * @param index Position index
 * @param throwOnOutOfBounds If true, throws error for out-of-bounds access (default: false for backwards compat)
 * @returns 'LONG' if bit is 1, 'SHORT' if bit is 0
 * @throws Error if index is out of bounds and throwOnOutOfBounds is true
 */
export function decodePosition(
  bitmap: Uint8Array,
  index: number,
  throwOnOutOfBounds: boolean = false
): 'LONG' | 'SHORT' {
  const byteIndex = Math.floor(index / 8);
  const bitIndex = index % 8;

  if (byteIndex >= bitmap.length) {
    if (throwOnOutOfBounds) {
      throw new Error(
        `Bitmap index ${index} out of bounds: bitmap has ${bitmap.length} bytes ` +
        `(max index: ${bitmap.length * 8 - 1})`
      );
    }
    // Legacy behavior: default to LONG for backwards compatibility
    // Note: This should be avoided - always validate bitmap size before decoding
    return 'LONG';
  }

  const bit = (bitmap[byteIndex] >> bitIndex) & 1;
  return bit === 1 ? 'LONG' : 'SHORT';
}

/**
 * Convert bitmap to base64 string for API transmission
 *
 * @param bitmap Uint8Array bitmap
 * @returns Base64 encoded string
 */
export function bitmapToBase64(bitmap: Uint8Array): string {
  return Buffer.from(bitmap).toString('base64');
}

/**
 * Convert base64 string back to bitmap
 *
 * @param base64 Base64 encoded bitmap
 * @returns Uint8Array bitmap
 */
export function base64ToBitmap(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Compute bitmap hash for on-chain commitment
 *
 * CRITICAL: This MUST match the backend Rust implementation:
 * ```rust
 * let mut hash_input = snapshot_id.as_bytes().to_vec();
 * hash_input.extend_from_slice(&bitmap_bytes);
 * let computed_hash = keccak256(&hash_input);
 * ```
 *
 * @param snapshotId Snapshot ID string (e.g., "crypto-2026-01-28-12-00")
 * @param bitmap Position bitmap bytes
 * @returns Hash string with 0x prefix
 */
export function computeBitmapHash(
  snapshotId: string,
  bitmap: Uint8Array
): string {
  // Convert snapshot ID string to UTF-8 bytes
  const snapshotIdBytes = toUtf8Bytes(snapshotId);

  // Concatenate: snapshot_id_bytes + bitmap_bytes
  const packed = concat([snapshotIdBytes, bitmap]);

  // Compute keccak256 hash
  return keccak256(packed);
}

/**
 * Extract positions from trades array for bitmap encoding
 *
 * @param trades Array of trades with position field
 * @returns Array of BitmapPosition values in order
 */
export function extractPositionsFromTrades(
  trades: Array<{ position: string }>
): BitmapPosition[] {
  return trades.map(trade => {
    const pos = trade.position.toUpperCase();
    if (pos === 'LONG' || pos === 'YES') {
      return 'LONG';
    }
    return 'SHORT';
  });
}

/**
 * Calculate expected bitmap size for a given number of trades
 *
 * @param tradeCount Number of trades
 * @returns Size in bytes
 */
export function calculateBitmapSize(tradeCount: number): number {
  return Math.ceil(tradeCount / 8);
}

/**
 * Validate bitmap size matches expected trade count
 *
 * @param bitmap The bitmap bytes
 * @param tradeCount Expected number of trades
 * @returns true if bitmap is large enough
 */
export function validateBitmapSize(bitmap: Uint8Array, tradeCount: number): boolean {
  const expectedBytes = calculateBitmapSize(tradeCount);
  return bitmap.length >= expectedBytes;
}

/**
 * Size reduction stats for logging
 */
export interface SizeReduction {
  originalJsonBytes: number;
  bitmapBytes: number;
  base64Bytes: number;
  reductionPercent: number;
}

/**
 * Calculate size reduction from JSON to bitmap encoding
 *
 * @param tradeCount Number of trades
 * @param avgJsonBytesPerTrade Average JSON bytes per trade (default ~80)
 * @returns Size reduction statistics
 */
export function calculateSizeReduction(
  tradeCount: number,
  avgJsonBytesPerTrade: number = 80
): SizeReduction {
  const originalJsonBytes = tradeCount * avgJsonBytesPerTrade;
  const bitmapBytes = calculateBitmapSize(tradeCount);
  const base64Bytes = Math.ceil(bitmapBytes * 4 / 3); // Base64 overhead

  return {
    originalJsonBytes,
    bitmapBytes,
    base64Bytes,
    reductionPercent: 100 - (base64Bytes / originalJsonBytes) * 100,
  };
}
