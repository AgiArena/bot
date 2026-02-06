/**
 * BLS-bn254 Implementation Tests
 *
 * Tests the real BLS signature implementation using alt_bn128 curve.
 */

import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  getPublicKey,
  keyPairFromPrivateKey,
  sign,
  verify,
  aggregateSignatures,
  aggregatePublicKeys,
  hashToPoint,
  isOnCurve,
  encodePublicKey,
  decodePublicKey,
  encodeSignature,
  decodeSignature,
  publicKeyToHex,
  signatureToHex,
  signatureToXY,
  BLSSigner,
  FIELD_MODULUS,
  CURVE_ORDER,
} from "../bls-bn254";

describe("BLS-bn254", () => {
  describe("Key Generation", () => {
    it("generates valid key pair", () => {
      const keyPair = generateKeyPair();

      expect(keyPair.privateKey).toBeInstanceOf(Uint8Array);
      expect(keyPair.privateKey.length).toBe(32);
      expect(keyPair.publicKey.x).toBeDefined();
      expect(keyPair.publicKey.y).toBeDefined();
      expect(isOnCurve(keyPair.publicKey.x, keyPair.publicKey.y)).toBe(true);
    });

    it("derives consistent public key from private key", () => {
      const keyPair = generateKeyPair();
      const derivedPk = getPublicKey(keyPair.privateKey);

      expect(derivedPk.x).toBe(keyPair.publicKey.x);
      expect(derivedPk.y).toBe(keyPair.publicKey.y);
    });

    it("creates key pair from hex private key", () => {
      // Use a known private key
      const privateKeyHex = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const keyPair = keyPairFromPrivateKey(privateKeyHex);

      expect(keyPair.privateKey.length).toBe(32);
      expect(isOnCurve(keyPair.publicKey.x, keyPair.publicKey.y)).toBe(true);

      // Same private key should give same public key
      const keyPair2 = keyPairFromPrivateKey(privateKeyHex);
      expect(keyPair2.publicKey.x).toBe(keyPair.publicKey.x);
      expect(keyPair2.publicKey.y).toBe(keyPair.publicKey.y);
    });
  });

  describe("Hash to Curve", () => {
    it("hashes message to valid curve point", () => {
      const message = new TextEncoder().encode("test message");
      const point = hashToPoint(message);

      expect(point.x).toBeGreaterThan(0n);
      expect(point.y).toBeGreaterThan(0n);
      expect(point.x).toBeLessThan(FIELD_MODULUS);
      expect(point.y).toBeLessThan(FIELD_MODULUS);
      expect(isOnCurve(point.x, point.y)).toBe(true);
    });

    it("produces deterministic output", () => {
      const message = new TextEncoder().encode("deterministic test");
      const point1 = hashToPoint(message);
      const point2 = hashToPoint(message);

      expect(point1.x).toBe(point2.x);
      expect(point1.y).toBe(point2.y);
    });

    it("produces different points for different messages", () => {
      const message1 = new TextEncoder().encode("message 1");
      const message2 = new TextEncoder().encode("message 2");

      const point1 = hashToPoint(message1);
      const point2 = hashToPoint(message2);

      expect(point1.x).not.toBe(point2.x);
    });
  });

  describe("Signing", () => {
    it("produces valid signature on curve", () => {
      const keyPair = generateKeyPair();
      const message = new TextEncoder().encode("sign this message");
      const signature = sign(keyPair.privateKey, message);

      expect(signature.x).toBeGreaterThan(0n);
      expect(signature.y).toBeGreaterThan(0n);
      expect(isOnCurve(signature.x, signature.y)).toBe(true);
    });

    it("produces deterministic signatures", () => {
      const keyPair = generateKeyPair();
      const message = new TextEncoder().encode("deterministic signature");

      const sig1 = sign(keyPair.privateKey, message);
      const sig2 = sign(keyPair.privateKey, message);

      expect(sig1.x).toBe(sig2.x);
      expect(sig1.y).toBe(sig2.y);
    });

    it("produces different signatures for different messages", () => {
      const keyPair = generateKeyPair();
      const message1 = new TextEncoder().encode("message 1");
      const message2 = new TextEncoder().encode("message 2");

      const sig1 = sign(keyPair.privateKey, message1);
      const sig2 = sign(keyPair.privateKey, message2);

      expect(sig1.x).not.toBe(sig2.x);
    });

    it("different keys produce different signatures for same message", () => {
      const keyPair1 = generateKeyPair();
      const keyPair2 = generateKeyPair();
      const message = new TextEncoder().encode("same message");

      const sig1 = sign(keyPair1.privateKey, message);
      const sig2 = sign(keyPair2.privateKey, message);

      expect(sig1.x).not.toBe(sig2.x);
    });
  });

  describe("Verification", () => {
    it("verifies valid signature (basic checks)", () => {
      const keyPair = generateKeyPair();
      const message = new TextEncoder().encode("verify this");
      const signature = sign(keyPair.privateKey, message);

      const isValid = verify(keyPair.publicKey, message, signature);
      expect(isValid).toBe(true);
    });
  });

  describe("Aggregation", () => {
    it("aggregates multiple signatures", () => {
      const keyPair1 = generateKeyPair();
      const keyPair2 = generateKeyPair();
      const keyPair3 = generateKeyPair();

      const message = new TextEncoder().encode("aggregate me");

      const sig1 = sign(keyPair1.privateKey, message);
      const sig2 = sign(keyPair2.privateKey, message);
      const sig3 = sign(keyPair3.privateKey, message);

      const aggSig = aggregateSignatures([sig1, sig2, sig3]);

      expect(aggSig.x).toBeGreaterThan(0n);
      expect(aggSig.y).toBeGreaterThan(0n);
      expect(isOnCurve(aggSig.x, aggSig.y)).toBe(true);
    });

    it("aggregates multiple public keys", () => {
      const keyPair1 = generateKeyPair();
      const keyPair2 = generateKeyPair();
      const keyPair3 = generateKeyPair();

      const aggPk = aggregatePublicKeys([
        keyPair1.publicKey,
        keyPair2.publicKey,
        keyPair3.publicKey,
      ]);

      expect(aggPk.x).toBeGreaterThan(0n);
      expect(aggPk.y).toBeGreaterThan(0n);
      expect(isOnCurve(aggPk.x, aggPk.y)).toBe(true);
    });

    it("aggregation is commutative", () => {
      const keyPair1 = generateKeyPair();
      const keyPair2 = generateKeyPair();

      const message = new TextEncoder().encode("commutative test");

      const sig1 = sign(keyPair1.privateKey, message);
      const sig2 = sign(keyPair2.privateKey, message);

      const agg1 = aggregateSignatures([sig1, sig2]);
      const agg2 = aggregateSignatures([sig2, sig1]);

      expect(agg1.x).toBe(agg2.x);
      expect(agg1.y).toBe(agg2.y);
    });
  });

  describe("Encoding/Decoding", () => {
    it("encodes and decodes public key", () => {
      const keyPair = generateKeyPair();
      const encoded = encodePublicKey(keyPair.publicKey);

      expect(encoded.length).toBe(64);

      const decoded = decodePublicKey(encoded);
      expect(decoded.x).toBe(keyPair.publicKey.x);
      expect(decoded.y).toBe(keyPair.publicKey.y);
    });

    it("encodes and decodes signature", () => {
      const keyPair = generateKeyPair();
      const message = new TextEncoder().encode("encode me");
      const signature = sign(keyPair.privateKey, message);

      const encoded = encodeSignature(signature);
      expect(encoded.length).toBe(64);

      const decoded = decodeSignature(encoded);
      expect(decoded.x).toBe(signature.x);
      expect(decoded.y).toBe(signature.y);
    });

    it("converts public key to hex", () => {
      const keyPair = generateKeyPair();
      const hex = publicKeyToHex(keyPair.publicKey);

      expect(hex).toMatch(/^0x[0-9a-f]{128}$/);
    });

    it("converts signature to hex", () => {
      const keyPair = generateKeyPair();
      const message = new TextEncoder().encode("hex test");
      const signature = sign(keyPair.privateKey, message);

      const hex = signatureToHex(signature);
      expect(hex).toMatch(/^0x[0-9a-f]{128}$/);
    });

    it("converts signature to X,Y format for contracts", () => {
      const keyPair = generateKeyPair();
      const message = new TextEncoder().encode("contract format");
      const signature = sign(keyPair.privateKey, message);

      const { sigX, sigY } = signatureToXY(signature);

      expect(sigX).toMatch(/^0x[0-9a-f]{64}$/);
      expect(sigY).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe("BLSSigner Class", () => {
    it("creates signer with new key pair", () => {
      const signer = new BLSSigner();

      expect(signer.publicKey.x).toBeGreaterThan(0n);
      expect(signer.publicKeyHex).toMatch(/^0x[0-9a-f]{128}$/);
    });

    it("creates signer from private key", () => {
      const privateKeyHex = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const signer = new BLSSigner(privateKeyHex);

      expect(isOnCurve(signer.publicKey.x, signer.publicKey.y)).toBe(true);
    });

    it("signs messages", () => {
      const signer = new BLSSigner();
      const message = new TextEncoder().encode("signer test");

      const signature = signer.sign(message);
      expect(isOnCurve(signature.x, signature.y)).toBe(true);
    });

    it("signToXY returns contract-ready format", () => {
      const signer = new BLSSigner();
      const message = new TextEncoder().encode("contract ready");

      const { sigX, sigY } = signer.signToXY(message);

      expect(sigX).toMatch(/^0x[0-9a-f]{64}$/);
      expect(sigY).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });

  describe("Integration: Multiple Keepers", () => {
    it("simulates 3 keepers signing and aggregating", () => {
      // Create 3 keeper signers
      const keeper1 = new BLSSigner();
      const keeper2 = new BLSSigner();
      const keeper3 = new BLSSigner();

      // Resolution message (simulating a bet resolution)
      const resolutionMessage = new TextEncoder().encode(
        JSON.stringify({
          betId: 1,
          winner: "0x1234567890123456789012345678901234567890",
          winsCount: 100,
          totalTrades: 188,
        })
      );

      // Each keeper signs
      const sig1 = keeper1.sign(resolutionMessage);
      const sig2 = keeper2.sign(resolutionMessage);
      const sig3 = keeper3.sign(resolutionMessage);

      // All signatures should be on curve
      expect(isOnCurve(sig1.x, sig1.y)).toBe(true);
      expect(isOnCurve(sig2.x, sig2.y)).toBe(true);
      expect(isOnCurve(sig3.x, sig3.y)).toBe(true);

      // Aggregate signatures
      const aggSig = aggregateSignatures([sig1, sig2, sig3]);
      expect(isOnCurve(aggSig.x, aggSig.y)).toBe(true);

      // Aggregate public keys
      const aggPk = aggregatePublicKeys([
        keeper1.publicKey,
        keeper2.publicKey,
        keeper3.publicKey,
      ]);
      expect(isOnCurve(aggPk.x, aggPk.y)).toBe(true);

      // Get contract-ready format
      const { sigX, sigY } = signatureToXY(aggSig);
      expect(sigX).toMatch(/^0x[0-9a-f]{64}$/);
      expect(sigY).toMatch(/^0x[0-9a-f]{64}$/);

      console.log("Keeper 1 pubkey:", keeper1.publicKeyHex.slice(0, 20) + "...");
      console.log("Keeper 2 pubkey:", keeper2.publicKeyHex.slice(0, 20) + "...");
      console.log("Keeper 3 pubkey:", keeper3.publicKeyHex.slice(0, 20) + "...");
      console.log("Aggregated sig:", signatureToHex(aggSig).slice(0, 20) + "...");
    });
  });
});
