/**
 * Unit tests for bitmap-utils.ts
 *
 * Story 9.2: Bot Bitmap Position Encoding and Upload
 * Task 1: Create bitmap utilities
 */

import { describe, it, expect } from 'bun:test';
import {
  encodePositionBitmap,
  decodePosition,
  bitmapToBase64,
  base64ToBitmap,
  computeBitmapHash,
  extractPositionsFromTrades,
  calculateBitmapSize,
  validateBitmapSize,
  calculateSizeReduction,
  type BitmapPosition,
} from '../bitmap-utils';

describe('encodePositionBitmap', () => {
  it('encodes empty array to empty bitmap', () => {
    const bitmap = encodePositionBitmap([]);
    expect(bitmap.length).toBe(0);
  });

  it('encodes single LONG position', () => {
    const bitmap = encodePositionBitmap(['LONG']);
    expect(bitmap.length).toBe(1);
    expect(bitmap[0]).toBe(0b00000001);
  });

  it('encodes single SHORT position', () => {
    const bitmap = encodePositionBitmap(['SHORT']);
    expect(bitmap.length).toBe(1);
    expect(bitmap[0]).toBe(0b00000000);
  });

  it('encodes YES as 1 (same as LONG)', () => {
    const bitmap = encodePositionBitmap(['YES']);
    expect(bitmap[0]).toBe(0b00000001);
  });

  it('encodes NO as 0 (same as SHORT)', () => {
    const bitmap = encodePositionBitmap(['NO']);
    expect(bitmap[0]).toBe(0b00000000);
  });

  it('encodes 8 positions into 1 byte', () => {
    const positions: BitmapPosition[] = [
      'LONG', 'SHORT', 'LONG', 'SHORT', 'LONG', 'SHORT', 'LONG', 'SHORT'
    ];
    const bitmap = encodePositionBitmap(positions);
    expect(bitmap.length).toBe(1);
    // Bit 0,2,4,6 = 1: 0b01010101 = 85
    expect(bitmap[0]).toBe(0b01010101);
  });

  it('encodes 9 positions into 2 bytes', () => {
    const positions: BitmapPosition[] = [
      'LONG', 'LONG', 'LONG', 'LONG', 'LONG', 'LONG', 'LONG', 'LONG', // First 8
      'LONG'  // 9th position in second byte
    ];
    const bitmap = encodePositionBitmap(positions);
    expect(bitmap.length).toBe(2);
    expect(bitmap[0]).toBe(0b11111111); // All 8 bits set
    expect(bitmap[1]).toBe(0b00000001); // Only first bit of second byte
  });

  it('correctly positions bits (position[i] = bit i%8 of byte i/8)', () => {
    // Test specific bit positions
    const positions: BitmapPosition[] = new Array(16).fill('SHORT');
    positions[0] = 'LONG';  // byte 0, bit 0
    positions[7] = 'LONG';  // byte 0, bit 7
    positions[8] = 'LONG';  // byte 1, bit 0
    positions[15] = 'LONG'; // byte 1, bit 7

    const bitmap = encodePositionBitmap(positions);
    expect(bitmap.length).toBe(2);
    expect(bitmap[0]).toBe(0b10000001); // bits 0 and 7
    expect(bitmap[1]).toBe(0b10000001); // bits 0 and 7
  });

  it('handles 10K positions efficiently', () => {
    const positions: BitmapPosition[] = new Array(10000).fill('LONG');
    positions.forEach((_, i) => {
      if (i % 2 === 0) positions[i] = 'SHORT';
    });

    const bitmap = encodePositionBitmap(positions);
    expect(bitmap.length).toBe(1250); // 10000 / 8 = 1250
  });
});

describe('decodePosition', () => {
  it('decodes LONG from set bit', () => {
    const bitmap = new Uint8Array([0b00000001]);
    expect(decodePosition(bitmap, 0)).toBe('LONG');
  });

  it('decodes SHORT from unset bit', () => {
    const bitmap = new Uint8Array([0b00000001]);
    expect(decodePosition(bitmap, 1)).toBe('SHORT');
  });

  it('handles out of bounds by returning LONG (legacy behavior)', () => {
    const bitmap = new Uint8Array([0b00000000]);
    // Default behavior for backwards compatibility
    expect(decodePosition(bitmap, 100)).toBe('LONG');
  });

  it('throws error on out of bounds when throwOnOutOfBounds is true', () => {
    const bitmap = new Uint8Array([0b00000000]); // 1 byte = indices 0-7
    expect(() => decodePosition(bitmap, 100, true)).toThrow('out of bounds');
    expect(() => decodePosition(bitmap, 8, true)).toThrow('out of bounds');
    // Index 7 should NOT throw (last valid index for 1 byte)
    expect(() => decodePosition(bitmap, 7, true)).not.toThrow();
  });

  it('correctly decodes all positions in a byte', () => {
    const bitmap = new Uint8Array([0b10110100]); // bits 2,4,5,7 are set
    expect(decodePosition(bitmap, 0)).toBe('SHORT');
    expect(decodePosition(bitmap, 1)).toBe('SHORT');
    expect(decodePosition(bitmap, 2)).toBe('LONG');
    expect(decodePosition(bitmap, 3)).toBe('SHORT');
    expect(decodePosition(bitmap, 4)).toBe('LONG');
    expect(decodePosition(bitmap, 5)).toBe('LONG');
    expect(decodePosition(bitmap, 6)).toBe('SHORT');
    expect(decodePosition(bitmap, 7)).toBe('LONG');
  });
});

describe('bitmapToBase64 and base64ToBitmap', () => {
  it('round-trips correctly', () => {
    const original = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
    const base64 = bitmapToBase64(original);
    const decoded = base64ToBitmap(base64);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('produces valid base64 string', () => {
    const bitmap = new Uint8Array([255, 0, 128, 64]);
    const base64 = bitmapToBase64(bitmap);
    expect(typeof base64).toBe('string');
    expect(base64.length).toBeGreaterThan(0);
    // Should only contain valid base64 chars
    expect(/^[A-Za-z0-9+/=]+$/.test(base64)).toBe(true);
  });

  it('10K positions produce ~1.7KB base64', () => {
    const positions: BitmapPosition[] = new Array(10000).fill('LONG');
    const bitmap = encodePositionBitmap(positions);
    const base64 = bitmapToBase64(bitmap);

    // 1250 bytes * 4/3 ≈ 1667 chars (base64 overhead)
    expect(base64.length).toBeLessThanOrEqual(1700);
    expect(base64.length).toBeGreaterThanOrEqual(1600);
  });
});

describe('computeBitmapHash', () => {
  it('produces 0x-prefixed hex string', () => {
    const snapshotId = 'crypto-2026-01-28-12-00';
    const bitmap = new Uint8Array([0x01, 0x02, 0x03]);
    const hash = computeBitmapHash(snapshotId, bitmap);

    expect(hash.startsWith('0x')).toBe(true);
    expect(hash.length).toBe(66); // 0x + 64 hex chars
  });

  it('produces different hashes for different snapshots', () => {
    const bitmap = new Uint8Array([0x01, 0x02, 0x03]);
    const hash1 = computeBitmapHash('snapshot-a', bitmap);
    const hash2 = computeBitmapHash('snapshot-b', bitmap);

    expect(hash1).not.toBe(hash2);
  });

  it('produces different hashes for different bitmaps', () => {
    const snapshotId = 'test-snapshot';
    const hash1 = computeBitmapHash(snapshotId, new Uint8Array([0x00]));
    const hash2 = computeBitmapHash(snapshotId, new Uint8Array([0xff]));

    expect(hash1).not.toBe(hash2);
  });

  it('produces consistent hash for same inputs', () => {
    const snapshotId = 'crypto-2026-01-28-12-00';
    const bitmap = new Uint8Array([0xaa, 0xbb, 0xcc]);

    const hash1 = computeBitmapHash(snapshotId, bitmap);
    const hash2 = computeBitmapHash(snapshotId, bitmap);

    expect(hash1).toBe(hash2);
  });
});

describe('extractPositionsFromTrades', () => {
  it('extracts LONG positions', () => {
    const trades = [
      { position: 'LONG' },
      { position: 'long' }, // case insensitive
    ];
    const positions = extractPositionsFromTrades(trades);
    expect(positions).toEqual(['LONG', 'LONG']);
  });

  it('extracts SHORT positions', () => {
    const trades = [
      { position: 'SHORT' },
      { position: 'short' },
    ];
    const positions = extractPositionsFromTrades(trades);
    expect(positions).toEqual(['SHORT', 'SHORT']);
  });

  it('converts YES to LONG', () => {
    const trades = [{ position: 'YES' }];
    const positions = extractPositionsFromTrades(trades);
    expect(positions).toEqual(['LONG']);
  });

  it('converts NO to SHORT', () => {
    const trades = [{ position: 'NO' }];
    const positions = extractPositionsFromTrades(trades);
    expect(positions).toEqual(['SHORT']);
  });

  it('handles mixed positions', () => {
    const trades = [
      { position: 'LONG' },
      { position: 'SHORT' },
      { position: 'YES' },
      { position: 'NO' },
    ];
    const positions = extractPositionsFromTrades(trades);
    expect(positions).toEqual(['LONG', 'SHORT', 'LONG', 'SHORT']);
  });
});

describe('calculateBitmapSize', () => {
  it('returns 0 for 0 trades', () => {
    expect(calculateBitmapSize(0)).toBe(0);
  });

  it('returns 1 for 1-8 trades', () => {
    expect(calculateBitmapSize(1)).toBe(1);
    expect(calculateBitmapSize(8)).toBe(1);
  });

  it('returns 2 for 9-16 trades', () => {
    expect(calculateBitmapSize(9)).toBe(2);
    expect(calculateBitmapSize(16)).toBe(2);
  });

  it('returns 1250 for 10000 trades', () => {
    expect(calculateBitmapSize(10000)).toBe(1250);
  });
});

describe('validateBitmapSize', () => {
  it('returns true for exact size', () => {
    const bitmap = new Uint8Array(125);
    expect(validateBitmapSize(bitmap, 1000)).toBe(true);
  });

  it('returns true for larger than needed', () => {
    const bitmap = new Uint8Array(200);
    expect(validateBitmapSize(bitmap, 1000)).toBe(true);
  });

  it('returns false for too small', () => {
    const bitmap = new Uint8Array(100);
    expect(validateBitmapSize(bitmap, 1000)).toBe(false);
  });
});

describe('calculateSizeReduction', () => {
  it('calculates correct reduction for 10K trades', () => {
    const stats = calculateSizeReduction(10000);

    expect(stats.originalJsonBytes).toBe(800000); // 10000 * 80
    expect(stats.bitmapBytes).toBe(1250);
    expect(stats.base64Bytes).toBeLessThanOrEqual(1700);
    expect(stats.reductionPercent).toBeGreaterThan(99); // >99% reduction
  });

  it('calculates correct reduction for 1K trades', () => {
    const stats = calculateSizeReduction(1000);

    expect(stats.originalJsonBytes).toBe(80000);
    expect(stats.bitmapBytes).toBe(125);
    expect(stats.reductionPercent).toBeGreaterThan(99);
  });
});

describe('encode/decode round-trip', () => {
  it('round-trips 10K random positions correctly', () => {
    // Generate random positions
    const original: BitmapPosition[] = new Array(10000)
      .fill(null)
      .map(() => Math.random() > 0.5 ? 'LONG' : 'SHORT');

    // Encode
    const bitmap = encodePositionBitmap(original);

    // Decode and verify
    for (let i = 0; i < original.length; i++) {
      const decoded = decodePosition(bitmap, i);
      const expected = original[i] === 'LONG' || original[i] === 'YES' ? 'LONG' : 'SHORT';
      expect(decoded).toBe(expected);
    }
  });
});
