/**
 * Bet Coordinator Module
 *
 * Story 2-3: Merkle Tree & Bet Commitment
 * Task 5: Integration with Proposal/Acceptance Flow
 *
 * Coordinates bilateral bet commitment after proposal acceptance:
 * 1. Build Merkle tree from agreed trades
 * 2. Both sign the commitment using CollateralVault's EIP-712 domain
 * 3. Submit to commitBet() on-chain
 * 4. Share trade data via P2P on request
 */

import { ethers } from "ethers";
import type { ChainClient } from "../chain-client";
import { P2PTransport } from "./transport";
import { buildBilateralMerkleTree, serializeTree, type MerkleTree } from "../merkle-tree";
import { storeMerkleTree } from "./trade-storage";
import {
  createBetCommitment,
  signBetCommitment,
  verifyBetCommitmentSignature,
  type BetCommitmentData,
} from "./commitment";
import type { TradeProposal, TradeAcceptance, CommitmentSignResponse } from "./types";

/** Default commitment timeout in milliseconds (configurable via COMMITMENT_TIMEOUT_MS env var) */
const DEFAULT_COMMITMENT_TIMEOUT_MS = parseInt(process.env.COMMITMENT_TIMEOUT_MS || "30000", 10);

/**
 * Result of commitment coordination
 */
export interface CommitmentResult {
  success: boolean;
  betId?: number;
  error?: string;
  txHash?: string;
}

/**
 * Event emitted on successful bet commitment
 */
export interface BetCommittedEvent {
  betId: number;
  creator: string;
  filler: string;
  tradesRoot: string;
  creatorAmount: bigint;
  fillerAmount: bigint;
  deadline: number;
  txHash: string;
}

/**
 * Handler for bet commitment events
 */
export type BetCommittedHandler = (event: BetCommittedEvent) => void;

/**
 * Coordinate bilateral bet commitment after proposal acceptance
 *
 * Story 2-3 Task 5: Complete coordination flow
 */
export class BetCoordinator {
  private wallet: ethers.Wallet;
  private onBetCommitted?: BetCommittedHandler;
  private pendingCommitments: Map<string, {
    commitment: BetCommitmentData;
    tree: MerkleTree;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();

  /**
   * Create a new BetCoordinator
   *
   * @param chainClient - Chain client for on-chain interactions
   * @param p2pTransport - Transport for P2P communication
   * @param vaultAddress - CollateralVault contract address
   * @param chainId - Chain ID (default: Index L3)
   */
  constructor(
    private chainClient: ChainClient,
    private p2pTransport: P2PTransport,
    private vaultAddress: string,
    private chainId: number = 111222333,
  ) {
    this.wallet = chainClient.getWallet();
  }

  /**
   * Set handler for bet commitment events
   *
   * Story 2-3 Task 5.4: Event emission for successful bet commitment
   */
  setOnBetCommitted(handler: BetCommittedHandler): void {
    this.onBetCommitted = handler;
  }

  /**
   * Handle accepted proposal (called when we're the creator)
   *
   * Story 2-3 Task 5.2: handleAcceptedProposal implementation
   *
   * 1. Build Merkle tree
   * 2. Create and sign commitment
   * 3. Request filler signature
   * 4. Submit to chain
   * 5. Store Merkle tree locally
   *
   * @param proposal - The accepted trade proposal
   * @param acceptance - The trade acceptance
   * @param positionBitmap - Bitmap of positions
   * @param entryPrices - Map of position index to entry price
   * @param tickers - Array of asset tickers
   * @param timeoutMs - Commitment timeout in milliseconds
   */
  async handleAcceptedProposal(
    proposal: TradeProposal,
    acceptance: TradeAcceptance,
    positionBitmap: Uint8Array,
    entryPrices: Map<number, bigint>,
    tickers: string[],
    timeoutMs: number = DEFAULT_COMMITMENT_TIMEOUT_MS,
  ): Promise<CommitmentResult> {
    const proposalKey = `${proposal.tradesHash}-${proposal.nonce}`;

    try {
      // 1. Build Merkle tree
      console.log(`[BetCoordinator] Building Merkle tree for proposal ${proposalKey}`);
      const tree = buildBilateralMerkleTree(
        proposal.snapshotId,
        positionBitmap,
        entryPrices,
        tickers
      );

      // 2. Fetch nonce from vault (same for both parties per contract requirement)
      const nonce = await this.chainClient.getVaultNonce();
      console.log(`[BetCoordinator] Vault nonce: ${nonce}`);

      // 3. Create commitment
      const commitment = createBetCommitment({
        proposal,
        acceptance,
        nonce,
        positionBitmap,
      });

      // 4. Sign as creator
      console.log(`[BetCoordinator] Signing commitment as creator`);
      const creatorSig = await signBetCommitment(
        this.wallet,
        commitment,
        this.vaultAddress,
        this.chainId
      );

      // Store pending commitment with timeout
      const timeout = setTimeout(() => {
        console.log(`[BetCoordinator] Commitment timeout for ${proposalKey}`);
        this.cleanupPendingCommitment(proposalKey);
      }, timeoutMs);

      this.pendingCommitments.set(proposalKey, {
        commitment,
        tree,
        timeout,
      });

      // 5. Get filler endpoint and request signature
      const [addresses, endpoints] = await this.chainClient.getAllActiveBots();
      const fillerIndex = addresses.findIndex(
        a => a.toLowerCase() === acceptance.filler.toLowerCase()
      );

      if (fillerIndex === -1) {
        this.cleanupPendingCommitment(proposalKey);
        return { success: false, error: "Filler not found in BotRegistry" };
      }

      const fillerEndpoint = endpoints[fillerIndex];
      console.log(`[BetCoordinator] Requesting filler signature from ${fillerEndpoint}`);

      const signResponse = await this.p2pTransport.requestCommitmentSign(
        fillerEndpoint,
        {
          tradesRoot: commitment.tradesRoot,
          creator: commitment.creator,
          filler: commitment.filler,
          creatorAmount: commitment.creatorAmount,
          fillerAmount: commitment.fillerAmount,
          deadline: commitment.deadline,
          nonce: commitment.nonce,
          expiry: commitment.expiry,
        },
        creatorSig
      );

      if (!signResponse.success) {
        this.cleanupPendingCommitment(proposalKey);
        return { success: false, error: `P2P transport error: ${signResponse.error.message}` };
      }

      if (!signResponse.data.accepted) {
        this.cleanupPendingCommitment(proposalKey);
        return { success: false, error: signResponse.data.reason || "Filler rejected signing" };
      }

      // 6. Verify filler signature
      console.log(`[BetCoordinator] Verifying filler signature`);
      const fillerSigValid = verifyBetCommitmentSignature(
        commitment,
        signResponse.data.signature!,
        acceptance.filler,
        this.vaultAddress,
        this.chainId
      );

      if (!fillerSigValid) {
        this.cleanupPendingCommitment(proposalKey);
        return { success: false, error: "Invalid filler signature" };
      }

      // 7. Submit to chain
      console.log(`[BetCoordinator] Submitting commitment to chain`);
      const result = await this.chainClient.commitBilateralBet(
        {
          tradesRoot: commitment.tradesRoot,
          creator: commitment.creator,
          filler: commitment.filler,
          creatorAmount: commitment.creatorAmount,
          fillerAmount: commitment.fillerAmount,
          deadline: commitment.deadline,
          nonce: commitment.nonce,
          expiry: commitment.expiry,
        },
        creatorSig,
        signResponse.data.signature!
      );

      if (!result.success) {
        this.cleanupPendingCommitment(proposalKey);
        return { success: false, error: result.error };
      }

      const betId = parseInt(result.betId!, 10);

      // 8. Store Merkle tree locally
      console.log(`[BetCoordinator] Storing Merkle tree for bet ${betId}`);
      storeMerkleTree(betId, tree);

      // 9. Cleanup and emit event
      this.cleanupPendingCommitment(proposalKey);

      if (this.onBetCommitted) {
        this.onBetCommitted({
          betId,
          creator: commitment.creator,
          filler: commitment.filler,
          tradesRoot: commitment.tradesRoot,
          creatorAmount: commitment.creatorAmount,
          fillerAmount: commitment.fillerAmount,
          deadline: commitment.deadline,
          txHash: result.txHash!,
        });
      }

      return {
        success: true,
        betId,
        txHash: result.txHash,
      };
    } catch (error) {
      this.cleanupPendingCommitment(proposalKey);
      return {
        success: false,
        error: `Commitment failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Handle commitment sign request (called when we're the filler)
   *
   * Story 2-3 Task 5.1: Extend TradeAcceptance handler
   *
   * @param request - The commitment sign request
   * @returns Commitment sign response with our signature or rejection
   */
  async handleCommitmentSignRequest(
    request: {
      commitment: BetCommitmentData;
      requesterSignature: string;
    }
  ): Promise<CommitmentSignResponse> {
    const { commitment, requesterSignature } = request;

    // Verify we're the filler
    if (commitment.filler.toLowerCase() !== this.wallet.address.toLowerCase()) {
      return {
        accepted: false,
        reason: "Not the filler for this commitment",
      };
    }

    // Verify commitment hasn't expired
    if (commitment.expiry <= Math.floor(Date.now() / 1000)) {
      return {
        accepted: false,
        reason: "Commitment has expired",
      };
    }

    // Verify creator signature
    const creatorSigValid = verifyBetCommitmentSignature(
      commitment,
      requesterSignature,
      commitment.creator,
      this.vaultAddress,
      this.chainId
    );

    if (!creatorSigValid) {
      return {
        accepted: false,
        reason: "Invalid creator signature",
      };
    }

    // Verify nonces match on-chain for BOTH parties
    // Contract requires: nonces[creator] == commitment.nonce AND nonces[filler] == commitment.nonce
    try {
      const [ourNonce, creatorNonce] = await Promise.all([
        this.chainClient.getVaultNonce(),
        this.chainClient.getVaultNonce(commitment.creator),
      ]);

      if (ourNonce !== commitment.nonce) {
        return {
          accepted: false,
          reason: `Filler nonce mismatch: expected ${ourNonce}, got ${commitment.nonce}`,
        };
      }

      if (creatorNonce !== commitment.nonce) {
        return {
          accepted: false,
          reason: `Creator nonce changed since signing: expected ${commitment.nonce}, now ${creatorNonce}`,
        };
      }
    } catch (error) {
      return {
        accepted: false,
        reason: `Failed to verify nonces: ${(error as Error).message}`,
      };
    }

    // Verify we have sufficient balance
    try {
      const balance = await this.chainClient.getVaultBalance();
      if (balance.available < commitment.fillerAmount) {
        return {
          accepted: false,
          reason: `Insufficient balance: have ${balance.available}, need ${commitment.fillerAmount}`,
        };
      }
    } catch (error) {
      return {
        accepted: false,
        reason: `Failed to check balance: ${(error as Error).message}`,
      };
    }

    // Sign the commitment
    try {
      const signature = await signBetCommitment(
        this.wallet,
        commitment,
        this.vaultAddress,
        this.chainId
      );

      console.log(`[BetCoordinator] Signed commitment as filler`);

      return {
        accepted: true,
        signature,
      };
    } catch (error) {
      return {
        accepted: false,
        reason: `Failed to sign: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Clean up a pending commitment
   *
   * Story 2-3 Task 5.3: Cleanup on failure
   */
  private cleanupPendingCommitment(key: string): void {
    const pending = this.pendingCommitments.get(key);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingCommitments.delete(key);
    }
  }

  /**
   * Get count of pending commitments
   */
  getPendingCommitmentCount(): number {
    return this.pendingCommitments.size;
  }

  /**
   * Clean up all pending commitments (for shutdown)
   */
  cleanup(): void {
    for (const [key, pending] of this.pendingCommitments) {
      clearTimeout(pending.timeout);
    }
    this.pendingCommitments.clear();
  }
}

/**
 * Create a BetCoordinator from environment variables
 */
export function createBetCoordinatorFromEnv(
  chainClient: ChainClient,
  p2pTransport?: P2PTransport
): BetCoordinator | null {
  const vaultAddress = process.env.COLLATERAL_VAULT_ADDRESS;
  const chainId = parseInt(process.env.CHAIN_ID || "111222333", 10);

  if (!vaultAddress) {
    console.error("[BetCoordinator] COLLATERAL_VAULT_ADDRESS not set");
    return null;
  }

  return new BetCoordinator(
    chainClient,
    p2pTransport || new P2PTransport(),
    vaultAddress,
    chainId
  );
}
