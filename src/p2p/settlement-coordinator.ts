/**
 * Settlement Coordinator Module
 *
 * Story 2-4: P2P Settlement (Happy Path)
 * Task 6: Create Settlement Coordinator
 *
 * Orchestrates the P2P settlement flow after bet commitment:
 * 1. Fetch exit prices from snapshot service
 * 2. Compute outcomes by comparing entry vs exit prices
 * 3. Exchange settlement proposals via P2P
 * 4. If agreed, call settleByAgreement() or customPayout() on CollateralVault
 * 5. If disagreed, call requestArbitration() for keeper resolution
 */

import { ethers } from "ethers";
import type { ChainClient, TransactionResult } from "../chain-client";
import { P2PTransport } from "./transport";
import type { MerkleTree } from "../merkle-tree";
import { loadMerkleTree } from "./trade-storage";
import { computeOutcome, type OutcomeResult } from "./outcome-computer";
import {
  fetchExitPricesCached,
  computeExitPricesHash,
  validateExitPricesComplete,
  type ExitPriceResult,
} from "./exit-price-fetcher";
import {
  type SettlementProposal,
  type SettlementProposalResponse,
  type SettlementResult,
  type PeerInfo,
  P2P_DOMAIN,
  SETTLEMENT_PROPOSAL_TYPES,
  BetStatus,
} from "./types";

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for Settlement Coordinator
 */
export interface SettlementCoordinatorConfig {
  /** Maximum retries for settlement attempts */
  maxRetries?: number;
  /** Timeout for P2P communication in ms */
  p2pTimeoutMs?: number;
  /** Timeout before escalating to arbitration (ms) */
  arbitrationTimeoutMs?: number;
  /** Backend URL for price fetching */
  backendUrl?: string;
  /** Proposal expiry in seconds (default: 3600 = 1 hour) */
  proposalExpirySeconds?: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<SettlementCoordinatorConfig> = {
  maxRetries: 3,
  p2pTimeoutMs: 30_000,
  arbitrationTimeoutMs: 300_000, // 5 minutes
  backendUrl: process.env.BACKEND_URL || "http://localhost:3001",
  proposalExpirySeconds: 3600, // 1 hour
};

// ============================================================================
// Settlement Coordinator
// ============================================================================

/**
 * Settlement Coordinator class
 *
 * Story 2-4 Task 6.2: SettlementCoordinator class implementation
 */
export class SettlementCoordinator {
  private chainClient: ChainClient;
  private p2pTransport: P2PTransport;
  private config: Required<SettlementCoordinatorConfig>;

  /**
   * Story 2-4 Task 6.1: Create settlement-coordinator.ts module
   */
  constructor(
    chainClient: ChainClient,
    p2pTransport?: P2PTransport,
    config?: SettlementCoordinatorConfig,
  ) {
    this.chainClient = chainClient;
    this.p2pTransport = p2pTransport ?? new P2PTransport();
    this.config = {
      maxRetries: config?.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      p2pTimeoutMs: config?.p2pTimeoutMs ?? DEFAULT_CONFIG.p2pTimeoutMs,
      arbitrationTimeoutMs: config?.arbitrationTimeoutMs ?? DEFAULT_CONFIG.arbitrationTimeoutMs,
      backendUrl: config?.backendUrl ?? DEFAULT_CONFIG.backendUrl,
      proposalExpirySeconds: config?.proposalExpirySeconds ?? DEFAULT_CONFIG.proposalExpirySeconds,
    };
  }

  /**
   * Handle bet deadline reached - initiate settlement
   *
   * Story 2-4 Task 6.3: handleBetDeadlineReached implementation
   *
   * Called by bot's deadline monitoring loop when a bet is ready for resolution.
   *
   * @param betId - The bet ID that reached deadline
   * @returns Settlement result
   */
  async handleBetDeadlineReached(betId: number): Promise<SettlementResult> {
    console.log(`[SettlementCoordinator] Handling deadline reached for bet ${betId}`);

    // 1. Load bet from chain
    const bet = await this.chainClient.getBetFromVault(betId);
    if (!bet) {
      return { success: false, error: "Bet not found on chain" };
    }

    if (bet.status !== BetStatus.Active) {
      return { success: false, error: `Bet is not active (status: ${bet.status})` };
    }

    // Check if deadline has passed
    const now = Math.floor(Date.now() / 1000);
    if (now <= bet.deadline) {
      return { success: false, error: `Deadline not yet passed (${bet.deadline - now}s remaining)` };
    }

    // 2. Load Merkle tree from local storage
    const tree = loadMerkleTree(betId);
    if (!tree) {
      // This is a data integrity issue - log as error, not just warning
      console.error(`[SettlementCoordinator] CRITICAL: No Merkle tree found for bet ${betId}`);
      console.error(`[SettlementCoordinator] This indicates data loss or corruption. Investigate before arbitration.`);
      return { success: false, error: `Missing Merkle tree for bet ${betId} - data integrity issue` };
    }

    // 3. Fetch exit prices
    const tickers = tree.trades.map(t => t.ticker);
    const exitPriceResult = await fetchExitPricesCached(
      betId,
      tree.snapshotId,
      tickers,
      this.config.backendUrl,
    );

    // 3b. Validate all exit prices are present
    const priceValidation = validateExitPricesComplete(exitPriceResult.prices, tree.trades.length);
    if (!priceValidation.complete) {
      console.error(`[SettlementCoordinator] Missing exit prices for trades: ${priceValidation.missingIndices.join(", ")}`);
      return { success: false, error: `Missing exit prices for ${priceValidation.missingIndices.length} trades` };
    }

    // 3c. Compute exit prices hash for proposal validation
    const exitPricesHash = computeExitPricesHash(exitPriceResult.prices, tree.trades.length);

    // 4. Compute our outcome
    const outcome = computeOutcome(
      tree,
      exitPriceResult.prices,
      bet.creator,
      bet.filler,
    );

    console.log(`[SettlementCoordinator] Computed outcome for bet ${betId}:`);
    console.log(`  winsCount: ${outcome.winsCount}/${outcome.validTrades}`);
    console.log(`  creatorWins: ${outcome.creatorWins}, isTie: ${outcome.isTie}`);
    console.log(`  winner: ${outcome.winner}`);
    console.log(`  exitPricesHash: ${exitPricesHash}`);

    // 5. Get counterparty endpoint
    const myAddress = this.chainClient.getAddress();
    const isCreator = bet.creator.toLowerCase() === myAddress.toLowerCase();
    const counterpartyAddress = isCreator ? bet.filler : bet.creator;

    const counterpartyEndpoint = await this.getCounterpartyEndpoint(counterpartyAddress);
    if (!counterpartyEndpoint) {
      console.warn(`[SettlementCoordinator] Cannot reach counterparty, escalating to arbitration`);
      return this.escalateToArbitration(betId);
    }

    // 5b. Synchronize nonces for settlement signing
    // CRITICAL: Both parties must sign with the same nonce for contract verification
    const [creatorNonce, fillerNonce] = await Promise.all([
      this.chainClient.getVaultNonce(bet.creator),
      this.chainClient.getVaultNonce(bet.filler),
    ]);

    if (creatorNonce !== fillerNonce) {
      console.warn(`[SettlementCoordinator] Nonce mismatch: creator=${creatorNonce}, filler=${fillerNonce}`);
      // Use the higher nonce - both parties should have consumed lower nonces
      // This is a safe default as the contract validates nonces >= current
    }
    const settlementNonce = creatorNonce > fillerNonce ? creatorNonce : fillerNonce;
    console.log(`[SettlementCoordinator] Using settlement nonce: ${settlementNonce}`);

    // 6. Create and send settlement proposal
    const proposal = await this.createSettlementProposal(betId, outcome, settlementNonce, exitPricesHash);

    console.log(`[SettlementCoordinator] Proposing settlement to ${counterpartyEndpoint}`);
    const response = await this.p2pTransport.proposeSettlementWithRetry(
      counterpartyEndpoint,
      proposal,
      this.config.maxRetries,
    );

    if (!response.success) {
      console.warn(`[SettlementCoordinator] Settlement proposal failed: ${response.error.message}`);
      return this.escalateToArbitration(betId);
    }

    // 7. Handle response
    const proposalResponse = response.data;
    return this.handleProposalResponse(betId, outcome, proposalResponse, bet.creator, bet.filler, settlementNonce);
  }

  /**
   * Compute and propose settlement
   *
   * Story 2-4 Task 6.4: computeAndProposeSettlement implementation
   *
   * @param betId - The bet ID to settle
   * @returns Settlement proposal for the bet
   */
  async computeAndProposeSettlement(betId: number): Promise<SettlementProposal | null> {
    const bet = await this.chainClient.getBetFromVault(betId);
    if (!bet) return null;

    const tree = loadMerkleTree(betId);
    if (!tree) return null;

    const tickers = tree.trades.map(t => t.ticker);
    const exitPriceResult = await fetchExitPricesCached(
      betId,
      tree.snapshotId,
      tickers,
      this.config.backendUrl,
    );

    const outcome = computeOutcome(
      tree,
      exitPriceResult.prices,
      bet.creator,
      bet.filler,
    );

    return this.createSettlementProposal(betId, outcome);
  }

  /**
   * Handle incoming settlement proposal
   *
   * Story 2-4 Task 6.5: handleIncomingProposal implementation
   *
   * Compare counterparty's proposal with our own computed outcome.
   *
   * @param proposal - The incoming settlement proposal
   * @returns Settlement proposal response
   */
  async handleIncomingProposal(proposal: SettlementProposal): Promise<SettlementProposalResponse> {
    console.log(`[SettlementCoordinator] Received settlement proposal for bet ${proposal.betId}`);

    // Load bet from chain
    const bet = await this.chainClient.getBetFromVault(proposal.betId);
    if (!bet) {
      console.warn(`[SettlementCoordinator] Bet ${proposal.betId} not found on chain`);
      return { status: "disagree", ourOutcome: undefined };
    }

    // VALIDATION: Verify this bot is a party to the bet before signing anything
    const myAddress = this.chainClient.getAddress().toLowerCase();
    const isCreator = bet.creator.toLowerCase() === myAddress;
    const isFiller = bet.filler.toLowerCase() === myAddress;
    if (!isCreator && !isFiller) {
      console.error(`[SettlementCoordinator] REJECTED: Not a party to bet ${proposal.betId}`);
      return { status: "disagree", ourOutcome: undefined };
    }

    // VALIDATION: Verify bet is still Active
    if (bet.status !== BetStatus.Active) {
      console.warn(`[SettlementCoordinator] Bet ${proposal.betId} is not active (status: ${bet.status})`);
      return { status: "disagree", ourOutcome: undefined };
    }

    // Load Merkle tree
    const tree = loadMerkleTree(proposal.betId);
    if (!tree) {
      console.error(`[SettlementCoordinator] No Merkle tree for bet ${proposal.betId}`);
      return { status: "disagree", ourOutcome: undefined };
    }

    // Compute our outcome
    const tickers = tree.trades.map(t => t.ticker);
    const exitPriceResult = await fetchExitPricesCached(
      proposal.betId,
      tree.snapshotId,
      tickers,
      this.config.backendUrl,
    );

    // Validate exit prices completeness
    const priceValidation = validateExitPricesComplete(exitPriceResult.prices, tree.trades.length);
    if (!priceValidation.complete) {
      console.error(`[SettlementCoordinator] Missing exit prices: ${priceValidation.missingIndices.join(", ")}`);
      return { status: "disagree", ourOutcome: undefined };
    }

    // If proposer provided exitPricesHash, verify we have the same prices
    if (proposal.exitPricesHash) {
      const ourPricesHash = computeExitPricesHash(exitPriceResult.prices, tree.trades.length);
      if (ourPricesHash !== proposal.exitPricesHash) {
        console.warn(`[SettlementCoordinator] Exit prices hash mismatch!`);
        console.warn(`  Theirs: ${proposal.exitPricesHash}`);
        console.warn(`  Ours: ${ourPricesHash}`);
        // Continue to compute and compare outcomes anyway
      }
    }

    const ourOutcome = computeOutcome(
      tree,
      exitPriceResult.prices,
      bet.creator,
      bet.filler,
    );

    // Compare outcomes
    if (
      ourOutcome.winner.toLowerCase() === proposal.winner.toLowerCase() &&
      ourOutcome.winsCount === proposal.winsCount &&
      ourOutcome.validTrades === proposal.validTrades &&
      ourOutcome.isTie === proposal.isTie
    ) {
      // Agreement! Sign the settlement using the SAME nonce from the proposal
      console.log(`[SettlementCoordinator] Agreement on bet ${proposal.betId} outcome`);
      console.log(`[SettlementCoordinator] Signing with nonce: ${proposal.settlementNonce}`);

      const signedAgreement = await this.chainClient.signSettlementAgreement(
        proposal.betId,
        proposal.winner,
        proposal.settlementNonce, // Use the proposer's nonce for synchronization
      );

      return {
        status: "agree",
        signature: signedAgreement.signature,
      };
    }

    // Disagreement
    console.log(`[SettlementCoordinator] Disagreement on bet ${proposal.betId}`);
    console.log(`  Their: winner=${proposal.winner}, wins=${proposal.winsCount}/${proposal.validTrades}`);
    console.log(`  Ours: winner=${ourOutcome.winner}, wins=${ourOutcome.winsCount}/${ourOutcome.validTrades}`);

    return {
      status: "disagree",
      ourOutcome: {
        winner: ourOutcome.winner,
        winsCount: ourOutcome.winsCount,
        validTrades: ourOutcome.validTrades,
      },
    };
  }

  /**
   * Execute settlement on-chain
   *
   * Story 2-4 Task 6.6: executeSettlement implementation
   *
   * @param betId - The bet ID to settle
   * @param winner - The agreed winner
   * @param counterpartySig - Counterparty's signature
   * @param settlementNonce - The agreed nonce (CRITICAL: both parties must use same nonce)
   * @returns Transaction result
   */
  async executeSettlement(
    betId: number,
    winner: string,
    counterpartySig: string,
    settlementNonce: bigint,
  ): Promise<SettlementResult> {
    const bet = await this.chainClient.getBetFromVault(betId);
    if (!bet) {
      return { success: false, error: "Bet not found" };
    }

    const myAddress = this.chainClient.getAddress();
    const isCreator = bet.creator.toLowerCase() === myAddress.toLowerCase();

    // Sign our part of the agreement using the SAME nonce as counterparty
    // CRITICAL: Both signatures must use the same nonce for contract verification
    const signedAgreement = await this.chainClient.signSettlementAgreement(
      betId,
      winner,
      settlementNonce, // Use the agreed nonce from the proposal
    );

    // Determine which signature is creator's and which is filler's
    const creatorSig = isCreator ? signedAgreement.signature : counterpartySig;
    const fillerSig = isCreator ? counterpartySig : signedAgreement.signature;

    console.log(`[SettlementCoordinator] Executing settlement for bet ${betId}`);
    console.log(`  Winner: ${winner}`);
    console.log(`  Nonce: ${settlementNonce}`);
    console.log(`  IsCreator: ${isCreator}`);

    // Execute on-chain
    const result = await this.chainClient.settleByAgreementOnChain(
      signedAgreement.agreement,
      creatorSig,
      fillerSig,
    );

    if (result.success) {
      console.log(`[SettlementCoordinator] Bet ${betId} settled! TX: ${result.txHash}`);
      return { success: true, txHash: result.txHash, settlementType: "agreement" };
    }

    return { success: false, error: result.error };
  }

  /**
   * Execute custom payout on-chain
   *
   * Story 2-4 Task 6.7: executeCustomPayout implementation
   *
   * @param betId - The bet ID to settle
   * @param creatorPayout - Amount for creator
   * @param fillerPayout - Amount for filler
   * @param counterpartySig - Counterparty's signature
   * @returns Transaction result
   */
  async executeCustomPayout(
    betId: number,
    creatorPayout: bigint,
    fillerPayout: bigint,
    counterpartySig: string,
  ): Promise<SettlementResult> {
    const bet = await this.chainClient.getBetFromVault(betId);
    if (!bet) {
      return { success: false, error: "Bet not found" };
    }

    const myAddress = this.chainClient.getAddress();
    const isCreator = bet.creator.toLowerCase() === myAddress.toLowerCase();

    // Sign our part of the custom payout
    const signedPayout = await this.chainClient.signCustomPayout(
      betId,
      creatorPayout,
      fillerPayout,
    );

    // Determine which signature is creator's and which is filler's
    const creatorSig = isCreator ? signedPayout.signature : counterpartySig;
    const fillerSig = isCreator ? counterpartySig : signedPayout.signature;

    // Execute on-chain
    const result = await this.chainClient.customPayoutOnChain(
      signedPayout.proposal,
      creatorSig,
      fillerSig,
    );

    if (result.success) {
      console.log(`[SettlementCoordinator] Custom payout for bet ${betId} executed! TX: ${result.txHash}`);
      return { success: true, txHash: result.txHash, settlementType: "customPayout" };
    }

    return { success: false, error: result.error };
  }

  /**
   * Escalate to arbitration when settlement fails
   *
   * Story 2-4 Task 6.8: escalateToArbitration implementation
   *
   * @param betId - The bet ID to escalate
   * @returns Transaction result
   */
  async escalateToArbitration(betId: number): Promise<SettlementResult> {
    console.log(`[SettlementCoordinator] Escalating bet ${betId} to arbitration`);

    const result = await this.chainClient.requestArbitrationOnChain(betId);

    if (result.success) {
      console.log(`[SettlementCoordinator] Arbitration requested for bet ${betId}! TX: ${result.txHash}`);
      return { success: true, txHash: result.txHash, settlementType: "arbitration" };
    }

    return { success: false, error: result.error };
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Create a signed settlement proposal
   *
   * @param betId - The bet ID
   * @param outcome - Computed outcome
   * @param settlementNonce - The nonce both parties should use for on-chain settlement
   * @param exitPricesHash - Hash of exit prices for validation (optional)
   */
  private async createSettlementProposal(
    betId: number,
    outcome: OutcomeResult,
    settlementNonce: bigint,
    exitPricesHash?: string | null,
  ): Promise<SettlementProposal> {
    const expiry = Math.floor(Date.now() / 1000) + this.config.proposalExpirySeconds;

    // Sign the proposal using EIP-712 (P2P domain)
    const value = {
      betId: BigInt(betId),
      winner: outcome.winner,
      winsCount: BigInt(outcome.winsCount),
      validTrades: BigInt(outcome.validTrades),
      isTie: outcome.isTie,
      expiry,
      settlementNonce,
    };

    const signature = await this.chainClient.getWallet().signTypedData(
      P2P_DOMAIN,
      SETTLEMENT_PROPOSAL_TYPES,
      value,
    );

    return {
      betId,
      winner: outcome.winner,
      winsCount: outcome.winsCount,
      validTrades: outcome.validTrades,
      isTie: outcome.isTie,
      proposer: this.chainClient.getAddress(),
      signature,
      expiry,
      settlementNonce,
      exitPricesHash: exitPricesHash ?? undefined,
    };
  }

  /**
   * Handle response to our settlement proposal
   */
  private async handleProposalResponse(
    betId: number,
    ourOutcome: OutcomeResult,
    response: SettlementProposalResponse,
    creator: string,
    filler: string,
    settlementNonce: bigint,
  ): Promise<SettlementResult> {
    switch (response.status) {
      case "agree":
        // Counterparty agreed! Execute settlement
        if (!response.signature) {
          return { success: false, error: "Counterparty agreed but no signature provided" };
        }
        return this.executeSettlement(betId, ourOutcome.winner, response.signature, settlementNonce);

      case "counter":
        // Counterparty proposed custom payout
        if (!response.counterProposal) {
          return { success: false, error: "Counter proposal received but no payout details" };
        }
        // Log the counter proposal details for manual review
        console.log(`[SettlementCoordinator] Counter proposal received for bet ${betId}:`);
        console.log(`  Creator payout: ${response.counterProposal.creatorPayout}`);
        console.log(`  Filler payout: ${response.counterProposal.fillerPayout}`);
        console.log(`  Our outcome: winner=${ourOutcome.winner}`);
        // TODO: In a more sophisticated implementation, the bot could evaluate the counter
        // For now, escalate to arbitration as we can't auto-evaluate fairness
        console.log(`[SettlementCoordinator] Auto-accepting counter proposals not implemented, escalating to arbitration`);
        return this.escalateToArbitration(betId);

      case "disagree":
      default:
        // Disagreement - escalate to arbitration
        if (response.ourOutcome) {
          console.log(`[SettlementCoordinator] Counterparty disagreed on bet ${betId}:`);
          console.log(`  Their computed winner: ${response.ourOutcome.winner}`);
          console.log(`  Their wins: ${response.ourOutcome.winsCount}/${response.ourOutcome.validTrades}`);
          console.log(`  Our computed winner: ${ourOutcome.winner}`);
          console.log(`  Our wins: ${ourOutcome.winsCount}/${ourOutcome.validTrades}`);
        } else {
          console.log(`[SettlementCoordinator] Counterparty disagreed on bet ${betId} (no outcome provided)`);
        }
        return this.escalateToArbitration(betId);
    }
  }

  /**
   * Get counterparty's P2P endpoint from BotRegistry
   *
   * Story 2-4 Task 6.9: Timeout handling - get endpoint for counterparty
   */
  private async getCounterpartyEndpoint(address: string): Promise<string | null> {
    try {
      // Get all active bots from registry
      const [addresses, endpoints] = await this.chainClient.getAllActiveBots();

      // Find the counterparty
      const index = addresses.findIndex(
        a => a.toLowerCase() === address.toLowerCase()
      );

      if (index === -1) {
        console.warn(`[SettlementCoordinator] Counterparty ${address} not found in BotRegistry`);
        return null;
      }

      return endpoints[index];
    } catch (error) {
      console.error(`[SettlementCoordinator] Failed to get counterparty endpoint: ${(error as Error).message}`);
      return null;
    }
  }
}

/**
 * Create settlement coordinator from environment
 */
export function createSettlementCoordinatorFromEnv(
  chainClient: ChainClient,
): SettlementCoordinator {
  const config: SettlementCoordinatorConfig = {
    maxRetries: parseInt(process.env.SETTLEMENT_MAX_RETRIES || "3", 10),
    p2pTimeoutMs: parseInt(process.env.SETTLEMENT_P2P_TIMEOUT_MS || "30000", 10),
    arbitrationTimeoutMs: parseInt(process.env.SETTLEMENT_ARBITRATION_TIMEOUT_MS || "300000", 10),
    backendUrl: process.env.BACKEND_URL || "http://localhost:3001",
    proposalExpirySeconds: parseInt(process.env.SETTLEMENT_PROPOSAL_EXPIRY_SECONDS || "3600", 10),
  };

  return new SettlementCoordinator(chainClient, undefined, config);
}
