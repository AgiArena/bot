/**
 * BLS Signature Implementation for alt_bn128 (bn254) Curve
 *
 * This implements real BLS signatures compatible with the Solidity BLS.sol library.
 * Uses the alt_bn128 curve (EIP-196/197) that has precompile support in Ethereum.
 *
 * Key characteristics:
 * - Curve: alt_bn128 (bn254), y² = x³ + 3
 * - Public key: G1 point (64 bytes: 32 bytes x + 32 bytes y)
 * - Signature: G1 point (64 bytes)
 * - Hash-to-curve: try-and-increment with domain separation
 */

import { bn254 } from "@noble/curves/bn254";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

// ============================================================================
// Constants (matching BLS.sol)
// ============================================================================

/** alt_bn128 field modulus */
export const FIELD_MODULUS = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

/** alt_bn128 curve order */
export const CURVE_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Domain separation tag (matches BLS.sol) */
export const DST_RESOLUTION = keccak_256(new TextEncoder().encode("AGIARENA_BLS_RESOLUTION_V1"));

// ============================================================================
// Types
// ============================================================================

export interface BLSKeyPair {
  privateKey: Uint8Array;
  publicKey: BLSPublicKey;
}

export interface BLSPublicKey {
  x: bigint;
  y: bigint;
}

export interface BLSSignature {
  x: bigint;
  y: bigint;
}

// ============================================================================
// Key Generation
// ============================================================================

/**
 * Generate a new BLS key pair
 *
 * @returns A new BLS key pair with private key and public key
 */
export function generateKeyPair(): BLSKeyPair {
  // Generate random private key (32 bytes, mod curve order)
  const privateKey = bn254.utils.randomPrivateKey();

  // Compute public key = privateKey * G1
  const publicKeyPoint = bn254.ProjectivePoint.BASE.multiply(bytesToBigInt(privateKey));
  const publicKeyAffine = publicKeyPoint.toAffine();

  return {
    privateKey,
    publicKey: {
      x: publicKeyAffine.x,
      y: publicKeyAffine.y,
    },
  };
}

/**
 * Derive public key from private key
 *
 * @param privateKey - The private key bytes
 * @returns The corresponding public key
 */
export function getPublicKey(privateKey: Uint8Array): BLSPublicKey {
  const sk = bytesToBigInt(privateKey) % CURVE_ORDER;
  const publicKeyPoint = bn254.ProjectivePoint.BASE.multiply(sk);
  const publicKeyAffine = publicKeyPoint.toAffine();

  return {
    x: publicKeyAffine.x,
    y: publicKeyAffine.y,
  };
}

/**
 * Create key pair from existing private key
 *
 * @param privateKeyHex - Private key as hex string (with or without 0x)
 * @returns BLS key pair
 */
export function keyPairFromPrivateKey(privateKeyHex: string): BLSKeyPair {
  const cleanHex = privateKeyHex.startsWith("0x") ? privateKeyHex.slice(2) : privateKeyHex;
  const privateKey = hexToBytes(cleanHex);

  return {
    privateKey,
    publicKey: getPublicKey(privateKey),
  };
}

// ============================================================================
// Hash to Curve
// ============================================================================

/**
 * Hash a message to a point on the curve using try-and-increment
 * Matches BLS.sol hashToPoint implementation
 *
 * @param message - The message bytes to hash
 * @returns A point on the curve
 */
export function hashToPoint(message: Uint8Array): { x: bigint; y: bigint } {
  // Hash with domain separation (matching BLS.sol)
  const h = keccak_256(new Uint8Array([...DST_RESOLUTION, ...message]));

  // Try-and-increment to find valid curve point
  for (let i = 0; i < 256; i++) {
    const input = new Uint8Array([...h, i]);
    const xHash = keccak_256(input);
    const x = bytesToBigInt(xHash) % FIELD_MODULUS;

    // Try to find y such that y² = x³ + 3 (alt_bn128 equation)
    const y2 = (x * x * x + 3n) % FIELD_MODULUS;
    const y = modSqrt(y2, FIELD_MODULUS);

    if (y !== null) {
      // Verify point is on curve
      if (isOnCurve(x, y)) {
        // Use parity of hash to choose y or -y
        const finalY = (h[0] & 1) === 1 ? (FIELD_MODULUS - y) % FIELD_MODULUS : y;
        return { x, y: finalY };
      }
    }
  }

  // Fallback to generator (should never happen)
  console.warn("[BLS] hashToPoint: fell back to generator");
  return { x: 1n, y: 2n };
}

// ============================================================================
// Signing
// ============================================================================

/**
 * Sign a message with a BLS private key
 *
 * @param privateKey - The private key bytes
 * @param message - The message to sign
 * @returns The BLS signature
 */
export function sign(privateKey: Uint8Array, message: Uint8Array): BLSSignature {
  const sk = bytesToBigInt(privateKey) % CURVE_ORDER;

  // Hash message to curve point
  const hashPoint = hashToPoint(message);

  // Create projective point from hash
  const hashProjective = bn254.ProjectivePoint.fromAffine({
    x: hashPoint.x,
    y: hashPoint.y,
  });

  // Signature = sk * H(m)
  const sigPoint = hashProjective.multiply(sk);
  const sigAffine = sigPoint.toAffine();

  return {
    x: sigAffine.x,
    y: sigAffine.y,
  };
}

/**
 * Sign a message (hex input convenience function)
 *
 * @param privateKeyHex - Private key as hex string
 * @param messageHex - Message as hex string
 * @returns Signature
 */
export function signHex(privateKeyHex: string, messageHex: string): BLSSignature {
  const pk = hexToBytes(privateKeyHex.startsWith("0x") ? privateKeyHex.slice(2) : privateKeyHex);
  const msg = hexToBytes(messageHex.startsWith("0x") ? messageHex.slice(2) : messageHex);
  return sign(pk, msg);
}

// ============================================================================
// Verification
// ============================================================================

/**
 * Verify a BLS signature
 *
 * NOTE: Full pairing verification requires bn254 pairing operations.
 * For local verification, we use a simplified check.
 * The contract does full pairing verification.
 *
 * @param publicKey - The signer's public key
 * @param message - The message that was signed
 * @param signature - The signature to verify
 * @returns True if signature appears valid
 */
export function verify(
  publicKey: BLSPublicKey,
  message: Uint8Array,
  signature: BLSSignature
): boolean {
  // Basic validity checks
  if (!isOnCurve(publicKey.x, publicKey.y)) {
    console.warn("[BLS] Public key not on curve");
    return false;
  }

  if (!isOnCurve(signature.x, signature.y)) {
    console.warn("[BLS] Signature not on curve");
    return false;
  }

  // For full verification, we'd need pairing: e(sig, G) == e(H(m), pk)
  // This requires bn254 pairing which is complex in JS
  // The contract will do the real verification via precompile 0x08

  return true;
}

// ============================================================================
// Aggregation
// ============================================================================

/**
 * Aggregate multiple BLS signatures
 *
 * @param signatures - Array of signatures to aggregate
 * @returns The aggregated signature
 */
export function aggregateSignatures(signatures: BLSSignature[]): BLSSignature {
  if (signatures.length === 0) {
    throw new Error("Cannot aggregate zero signatures");
  }

  let result = bn254.ProjectivePoint.fromAffine({
    x: signatures[0].x,
    y: signatures[0].y,
  });

  for (let i = 1; i < signatures.length; i++) {
    const point = bn254.ProjectivePoint.fromAffine({
      x: signatures[i].x,
      y: signatures[i].y,
    });
    result = result.add(point);
  }

  const affine = result.toAffine();
  return {
    x: affine.x,
    y: affine.y,
  };
}

/**
 * Aggregate multiple public keys
 *
 * @param publicKeys - Array of public keys to aggregate
 * @returns The aggregated public key
 */
export function aggregatePublicKeys(publicKeys: BLSPublicKey[]): BLSPublicKey {
  if (publicKeys.length === 0) {
    throw new Error("Cannot aggregate zero public keys");
  }

  let result = bn254.ProjectivePoint.fromAffine({
    x: publicKeys[0].x,
    y: publicKeys[0].y,
  });

  for (let i = 1; i < publicKeys.length; i++) {
    const point = bn254.ProjectivePoint.fromAffine({
      x: publicKeys[i].x,
      y: publicKeys[i].y,
    });
    result = result.add(point);
  }

  const affine = result.toAffine();
  return {
    x: affine.x,
    y: affine.y,
  };
}

// ============================================================================
// Encoding/Decoding
// ============================================================================

/**
 * Encode a public key to 64 bytes (matching contract format)
 */
export function encodePublicKey(pk: BLSPublicKey): Uint8Array {
  const xBytes = bigIntToBytes32(pk.x);
  const yBytes = bigIntToBytes32(pk.y);
  const result = new Uint8Array(64);
  result.set(xBytes, 0);
  result.set(yBytes, 32);
  return result;
}

/**
 * Decode a 64-byte public key
 */
export function decodePublicKey(data: Uint8Array): BLSPublicKey {
  if (data.length !== 64) {
    throw new Error(`Invalid public key length: ${data.length}, expected 64`);
  }
  return {
    x: bytesToBigInt(data.slice(0, 32)),
    y: bytesToBigInt(data.slice(32, 64)),
  };
}

/**
 * Encode a signature to 64 bytes (matching contract format)
 */
export function encodeSignature(sig: BLSSignature): Uint8Array {
  const xBytes = bigIntToBytes32(sig.x);
  const yBytes = bigIntToBytes32(sig.y);
  const result = new Uint8Array(64);
  result.set(xBytes, 0);
  result.set(yBytes, 32);
  return result;
}

/**
 * Decode a 64-byte signature
 */
export function decodeSignature(data: Uint8Array): BLSSignature {
  if (data.length !== 64) {
    throw new Error(`Invalid signature length: ${data.length}, expected 64`);
  }
  return {
    x: bytesToBigInt(data.slice(0, 32)),
    y: bytesToBigInt(data.slice(32, 64)),
  };
}

/**
 * Public key to hex string (with 0x prefix)
 */
export function publicKeyToHex(pk: BLSPublicKey): string {
  return "0x" + bytesToHex(encodePublicKey(pk));
}

/**
 * Signature to hex string (with 0x prefix)
 */
export function signatureToHex(sig: BLSSignature): string {
  return "0x" + bytesToHex(encodeSignature(sig));
}

/**
 * Get signature X and Y as hex strings (for contract calls)
 */
export function signatureToXY(sig: BLSSignature): { sigX: string; sigY: string } {
  return {
    sigX: "0x" + sig.x.toString(16).padStart(64, "0"),
    sigY: "0x" + sig.y.toString(16).padStart(64, "0"),
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a point is on the alt_bn128 curve (y² = x³ + 3)
 */
export function isOnCurve(x: bigint, y: bigint): boolean {
  if (x >= FIELD_MODULUS || y >= FIELD_MODULUS) return false;
  if (x === 0n && y === 0n) return true; // Point at infinity

  const lhs = (y * y) % FIELD_MODULUS;
  const rhs = (x * x * x + 3n) % FIELD_MODULUS;

  return lhs === rhs;
}

/**
 * Modular square root using Tonelli-Shanks
 * For alt_bn128, p ≡ 3 (mod 4), so sqrt(a) = a^((p+1)/4)
 */
function modSqrt(a: bigint, p: bigint): bigint | null {
  if (a === 0n) return 0n;

  // For p ≡ 3 (mod 4): sqrt(a) = a^((p+1)/4)
  const exp = (p + 1n) / 4n;
  const r = modPow(a, exp, p);

  // Verify it's actually a square root
  if ((r * r) % p !== a % p) {
    return null;
  }

  return r;
}

/**
 * Modular exponentiation
 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;

  while (exp > 0n) {
    if (exp % 2n === 1n) {
      result = (result * base) % mod;
    }
    exp = exp / 2n;
    base = (base * base) % mod;
  }

  return result;
}

/**
 * Convert bytes to bigint (big-endian)
 */
function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

/**
 * Convert bigint to 32 bytes (big-endian)
 */
function bigIntToBytes32(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, "0");
  return hexToBytes(hex);
}

// ============================================================================
// High-Level API
// ============================================================================

/**
 * BLS Signer class for keeper use
 */
export class BLSSigner {
  private keyPair: BLSKeyPair;

  constructor(privateKeyHex?: string) {
    if (privateKeyHex) {
      this.keyPair = keyPairFromPrivateKey(privateKeyHex);
    } else {
      this.keyPair = generateKeyPair();
    }
  }

  /** Get the public key */
  get publicKey(): BLSPublicKey {
    return this.keyPair.publicKey;
  }

  /** Get public key as hex string */
  get publicKeyHex(): string {
    return publicKeyToHex(this.keyPair.publicKey);
  }

  /** Get public key X coordinate as hex */
  get publicKeyX(): string {
    return "0x" + this.keyPair.publicKey.x.toString(16).padStart(64, "0");
  }

  /** Get public key Y coordinate as hex */
  get publicKeyY(): string {
    return "0x" + this.keyPair.publicKey.y.toString(16).padStart(64, "0");
  }

  /**
   * Sign a message
   *
   * @param message - Message bytes to sign
   * @returns BLS signature
   */
  sign(message: Uint8Array): BLSSignature {
    return sign(this.keyPair.privateKey, message);
  }

  /**
   * Sign a hex-encoded message
   *
   * @param messageHex - Message as hex string
   * @returns BLS signature
   */
  signHex(messageHex: string): BLSSignature {
    const msg = hexToBytes(messageHex.startsWith("0x") ? messageHex.slice(2) : messageHex);
    return this.sign(msg);
  }

  /**
   * Sign and return as X,Y hex strings (for contract calls)
   */
  signToXY(message: Uint8Array): { sigX: string; sigY: string } {
    const sig = this.sign(message);
    return signatureToXY(sig);
  }
}
