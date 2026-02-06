/**
 * Bet Commitment Module
 *
 * Story 2-3: Merkle Tree & Bet Commitment
 * Task 2: Create Bet Commitment module for EIP-712 signing
 *
 * Handles bet commitment creation, signing, and verification for
 * bilateral bets on CollateralVault.
 */

import { ethers } from "ethers";
import { computeTradesRoot } from "../merkle-tree";
import type { TradeProposal, TradeAcceptance } from "./types";

// ============================================================================
// Constants
// ============================================================================

/** Chain ID for Index L3 (Orbit) */
const DEFAULT_CHAIN_ID = 111222333;

/**
 * EIP-712 domain for CollateralVault
 * Note: Different from P2P domain - uses contract as verifyingContract
 */
export function getCollateralVaultDomain(vaultAddress: string, chainId: number = DEFAULT_CHAIN_ID) {
  return {
    name: "CollateralVault",
    version: "1",
    chainId,
    verifyingContract: vaultAddress,
  };
}

/**
 * EIP-712 type definitions for BetCommitment
 * Must match CollateralVault.sol BET_COMMITMENT_TYPEHASH
 */
export const BET_COMMITMENT_TYPES = {
  BetCommitment: [
    { name: "tradesRoot", type: "bytes32" },
    { name: "creator", type: "address" },
    { name: "filler", type: "address" },
    { name: "creatorAmount", type: "uint256" },
    { name: "fillerAmount", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

// ============================================================================
// Types
// ============================================================================

/**
 * Bet commitment data structure
 * Matches CollateralVault.BetCommitment struct
 */
export interface BetCommitmentData {
  /** keccak256(snapshotId, positionBitmap) - identifies the trade set */
  tradesRoot: string;
  /** Creator's address (proposer) */
  creator: string;
  /** Filler's address (acceptor) */
  filler: string;
  /** Creator's stake amount in wei */
  creatorAmount: bigint;
  /** Filler's stake amount in wei */
  fillerAmount: bigint;
  /** Unix timestamp when bet can be resolved */
  deadline: number;
  /** Nonce for replay protection (must match on-chain for both parties) */
  nonce: bigint;
  /** Signature expiry timestamp (short-lived, e.g., 5 minutes) */
  expiry: number;
}

/**
 * Signed bet commitment with both signatures
 */
export interface SignedBetCommitment extends BetCommitmentData {
  /** Creator's EIP-712 signature */
  creatorSignature?: string;
  /** Filler's EIP-712 signature */
  fillerSignature?: string;
}

/**
 * Parameters for creating a bet commitment from a proposal
 */
export interface CreateCommitmentParams {
  /** The accepted trade proposal */
  proposal: TradeProposal;
  /** The trade acceptance */
  acceptance: TradeAcceptance;
  /** Nonce from CollateralVault (same for both parties) */
  nonce: bigint;
  /** Position bitmap bytes */
  positionBitmap: Uint8Array;
}

// ============================================================================
// Commitment Creation
// ============================================================================

/**
 * Create bet commitment data from accepted proposal
 *
 * Story 2-3 Task 2.3: createBetCommitment implementation
 *
 * @param params - Parameters including proposal, acceptance, nonce, and bitmap
 * @returns BetCommitmentData ready for signing
 */
export function createBetCommitment(params: CreateCommitmentParams): BetCommitmentData {
  const { proposal, acceptance, nonce, positionBitmap } = params;

  // Compute tradesRoot from snapshotId and bitmap
  const tradesRoot = computeTradesRoot(proposal.snapshotId, positionBitmap);

  // Calculate filler amount from odds
  // fillerAmount = (creatorStake * 10000) / oddsBps
  const fillerAmount = (proposal.creatorStake * BigInt(10000)) / BigInt(proposal.oddsBps);

  // Default expiry: 5 minutes from now
  const expiry = Math.floor(Date.now() / 1000) + 300;

  return {
    tradesRoot,
    creator: proposal.creator,
    filler: acceptance.filler,
    creatorAmount: proposal.creatorStake,
    fillerAmount,
    deadline: proposal.resolutionDeadline,
    nonce,
    expiry,
  };
}

/**
 * Create bet commitment from raw parameters (without proposal/acceptance)
 *
 * @param params - Direct commitment parameters
 * @returns BetCommitmentData ready for signing
 */
export function createBetCommitmentDirect(params: {
  tradesRoot: string;
  creator: string;
  filler: string;
  creatorAmount: bigint;
  fillerAmount: bigint;
  deadline: number;
  nonce: bigint;
  expiry?: number;
}): BetCommitmentData {
  return {
    tradesRoot: params.tradesRoot,
    creator: params.creator,
    filler: params.filler,
    creatorAmount: params.creatorAmount,
    fillerAmount: params.fillerAmount,
    deadline: params.deadline,
    nonce: params.nonce,
    expiry: params.expiry ?? Math.floor(Date.now() / 1000) + 300,
  };
}

// ============================================================================
// Commitment Signing
// ============================================================================

/**
 * Sign bet commitment using EIP-712
 *
 * Story 2-3 Task 2.4: signBetCommitment implementation
 *
 * @param wallet - Ethers wallet to sign with
 * @param commitment - The commitment data to sign
 * @param vaultAddress - CollateralVault contract address
 * @param chainId - Chain ID (default: Index L3)
 * @returns EIP-712 signature string
 */
export async function signBetCommitment(
  wallet: ethers.Wallet,
  commitment: BetCommitmentData,
  vaultAddress: string,
  chainId: number = DEFAULT_CHAIN_ID,
): Promise<string> {
  const domain = getCollateralVaultDomain(vaultAddress, chainId);

  const value = {
    tradesRoot: commitment.tradesRoot,
    creator: commitment.creator,
    filler: commitment.filler,
    creatorAmount: commitment.creatorAmount,
    fillerAmount: commitment.fillerAmount,
    deadline: commitment.deadline,
    nonce: commitment.nonce,
    expiry: commitment.expiry,
  };

  return await wallet.signTypedData(domain, BET_COMMITMENT_TYPES, value);
}

// ============================================================================
// Signature Verification
// ============================================================================

/**
 * Verify commitment signature
 *
 * Story 2-3 Task 2.5: verifyBetCommitmentSignature implementation
 *
 * @param commitment - The commitment data that was signed
 * @param signature - The EIP-712 signature to verify
 * @param expectedSigner - The address that should have signed
 * @param vaultAddress - CollateralVault contract address
 * @param chainId - Chain ID (default: Index L3)
 * @returns True if signature is valid and matches expected signer
 */
export function verifyBetCommitmentSignature(
  commitment: BetCommitmentData,
  signature: string,
  expectedSigner: string,
  vaultAddress: string,
  chainId: number = DEFAULT_CHAIN_ID,
): boolean {
  try {
    const domain = getCollateralVaultDomain(vaultAddress, chainId);

    const value = {
      tradesRoot: commitment.tradesRoot,
      creator: commitment.creator,
      filler: commitment.filler,
      creatorAmount: commitment.creatorAmount,
      fillerAmount: commitment.fillerAmount,
      deadline: commitment.deadline,
      nonce: commitment.nonce,
      expiry: commitment.expiry,
    };

    const recoveredAddress = ethers.verifyTypedData(
      domain,
      BET_COMMITMENT_TYPES,
      value,
      signature
    );

    return recoveredAddress.toLowerCase() === expectedSigner.toLowerCase();
  } catch (error) {
    console.error("[Commitment] Signature verification error:", error);
    return false;
  }
}

/**
 * Recover signer address from commitment signature
 *
 * @param commitment - The commitment data that was signed
 * @param signature - The EIP-712 signature
 * @param vaultAddress - CollateralVault contract address
 * @param chainId - Chain ID
 * @returns Recovered signer address or null if invalid
 */
export function recoverCommitmentSigner(
  commitment: BetCommitmentData,
  signature: string,
  vaultAddress: string,
  chainId: number = DEFAULT_CHAIN_ID,
): string | null {
  try {
    const domain = getCollateralVaultDomain(vaultAddress, chainId);

    const value = {
      tradesRoot: commitment.tradesRoot,
      creator: commitment.creator,
      filler: commitment.filler,
      creatorAmount: commitment.creatorAmount,
      fillerAmount: commitment.fillerAmount,
      deadline: commitment.deadline,
      nonce: commitment.nonce,
      expiry: commitment.expiry,
    };

    return ethers.verifyTypedData(domain, BET_COMMITMENT_TYPES, value, signature);
  } catch {
    return null;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Compute hash of a bet commitment (for tracking/logging)
 */
export function computeCommitmentHash(commitment: BetCommitmentData): string {
  return ethers.solidityPackedKeccak256(
    ['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
    [
      commitment.tradesRoot,
      commitment.creator,
      commitment.filler,
      commitment.creatorAmount,
      commitment.fillerAmount,
      commitment.deadline,
      commitment.nonce,
      commitment.expiry,
    ]
  );
}

/**
 * Check if commitment has expired
 */
export function isCommitmentExpired(commitment: BetCommitmentData): boolean {
  return Math.floor(Date.now() / 1000) > commitment.expiry;
}

/**
 * Check if commitment deadline is in the past
 */
export function isDeadlineInPast(commitment: BetCommitmentData): boolean {
  return Math.floor(Date.now() / 1000) > commitment.deadline;
}

// ============================================================================
// BilateralBetBuilder Class
// ============================================================================

/**
 * Builder class to orchestrate bilateral bet commitment
 *
 * Story 2-3 Task 2.2: BilateralBetBuilder class
 *
 * Provides a fluent API for building and signing bet commitments.
 */
export class BilateralBetBuilder {
  private commitment: Partial<BetCommitmentData> = {};
  private creatorSig?: string;
  private fillerSig?: string;

  /**
   * Set trades root
   */
  setTradesRoot(tradesRoot: string): this {
    this.commitment.tradesRoot = tradesRoot;
    return this;
  }

  /**
   * Set trades root from snapshot and bitmap
   */
  setTradesRootFromBitmap(snapshotId: string, positionBitmap: Uint8Array): this {
    this.commitment.tradesRoot = computeTradesRoot(snapshotId, positionBitmap);
    return this;
  }

  /**
   * Set parties
   */
  setParties(creator: string, filler: string): this {
    this.commitment.creator = creator;
    this.commitment.filler = filler;
    return this;
  }

  /**
   * Set amounts
   */
  setAmounts(creatorAmount: bigint, fillerAmount: bigint): this {
    this.commitment.creatorAmount = creatorAmount;
    this.commitment.fillerAmount = fillerAmount;
    return this;
  }

  /**
   * Set amounts from stake and odds
   */
  setAmountsFromOdds(creatorStake: bigint, oddsBps: number): this {
    this.commitment.creatorAmount = creatorStake;
    this.commitment.fillerAmount = (creatorStake * BigInt(10000)) / BigInt(oddsBps);
    return this;
  }

  /**
   * Set deadline
   */
  setDeadline(deadline: number): this {
    this.commitment.deadline = deadline;
    return this;
  }

  /**
   * Set nonce
   */
  setNonce(nonce: bigint): this {
    this.commitment.nonce = nonce;
    return this;
  }

  /**
   * Set expiry (default: 5 minutes from now)
   */
  setExpiry(expiry?: number): this {
    this.commitment.expiry = expiry ?? Math.floor(Date.now() / 1000) + 300;
    return this;
  }

  /**
   * Build the commitment data
   * @throws Error if required fields are missing
   */
  build(): BetCommitmentData {
    if (!this.commitment.tradesRoot) throw new Error("tradesRoot is required");
    if (!this.commitment.creator) throw new Error("creator is required");
    if (!this.commitment.filler) throw new Error("filler is required");
    if (this.commitment.creatorAmount === undefined) throw new Error("creatorAmount is required");
    if (this.commitment.fillerAmount === undefined) throw new Error("fillerAmount is required");
    if (this.commitment.deadline === undefined) throw new Error("deadline is required");
    if (this.commitment.nonce === undefined) throw new Error("nonce is required");

    // Set default expiry if not set
    if (this.commitment.expiry === undefined) {
      this.commitment.expiry = Math.floor(Date.now() / 1000) + 300;
    }

    return this.commitment as BetCommitmentData;
  }

  /**
   * Sign as creator
   */
  async signAsCreator(wallet: ethers.Wallet, vaultAddress: string, chainId?: number): Promise<string> {
    const commitment = this.build();
    this.creatorSig = await signBetCommitment(wallet, commitment, vaultAddress, chainId);
    return this.creatorSig;
  }

  /**
   * Sign as filler
   */
  async signAsFiller(wallet: ethers.Wallet, vaultAddress: string, chainId?: number): Promise<string> {
    const commitment = this.build();
    this.fillerSig = await signBetCommitment(wallet, commitment, vaultAddress, chainId);
    return this.fillerSig;
  }

  /**
   * Get creator signature
   */
  getCreatorSignature(): string | undefined {
    return this.creatorSig;
  }

  /**
   * Get filler signature
   */
  getFillerSignature(): string | undefined {
    return this.fillerSig;
  }

  /**
   * Check if both signatures are present
   */
  isFullySigned(): boolean {
    return !!this.creatorSig && !!this.fillerSig;
  }

  /**
   * Get the fully signed commitment
   */
  getSignedCommitment(): SignedBetCommitment {
    return {
      ...this.build(),
      creatorSignature: this.creatorSig,
      fillerSignature: this.fillerSig,
    };
  }
}
