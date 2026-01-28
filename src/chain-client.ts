/**
 * On-chain transaction client for AgiArena
 *
 * Handles all blockchain interactions:
 * - Collateral token approval
 * - placeBet transactions
 * - matchBet transactions
 *
 * Uses ethers.js for contract interactions.
 */

import { ethers, Contract, Wallet, JsonRpcProvider } from "ethers";
import { keccak256, toUtf8Bytes } from "ethers";
import type { Portfolio } from "./trading-strategy";

// Default contract addresses for Index L3 (Orbit)
const DEFAULT_CONTRACT_ADDRESS = "0xE44c20fbac58Eb1ca4115AC7890F28271aD94364";
const DEFAULT_COLLATERAL_ADDRESS = "0x6Ef9653b34C2A0d91219466b029428ff4F49D651";
const DEFAULT_RESOLUTION_DAO_ADDRESS = "0x8F5f869fE4B880fda148DEE5E81e6893Df243693";

// RPC endpoint for Index L3
const DEFAULT_RPC_URL = "https://index.rpc.zeeve.net";

// ABI fragments for the functions we need
// Contract uses 6-param placeBet with string snapshotId, bytes positionBitmap
const AGIARENA_ABI = [
  "function placeBet(string calldata snapshotId, bytes calldata positionBitmap, string calldata jsonStorageRef, uint256 creatorStake, uint32 oddsBps, uint256 resolutionDeadline) external returns (uint256 betId)",
  "function matchBet(uint256 betId, uint256 fillAmount) external",
  "function cancelBet(uint256 betId) external",
  "function bets(uint256) external view returns (bytes32 tradesHash, string snapshotId, string jsonStorageRef, uint256 creatorStake, uint256 requiredMatch, uint256 matchedAmount, uint32 oddsBps, address creator, uint8 status, uint256 createdAt, uint256 resolutionDeadline)",
  "function getBetDeadline(uint256 betId) external view returns (uint256)",
  "function settleBet(uint256 betId, bool creatorWins) external",
  "event BetPlaced(uint256 indexed betId, address indexed creator, bytes32 tradesHash, string snapshotId, string jsonStorageRef, uint256 creatorStake, uint256 requiredMatch, uint32 oddsBps, uint256 resolutionDeadline)",
  "event BetCancelled(uint256 indexed betId, address indexed creator, uint256 refundAmount)",
];

// ResolutionDAO ABI fragments
const RESOLUTION_DAO_ABI = [
  "function betResolutions(uint256) external view returns (bytes32 tradesHash, bytes packedOutcomes, uint256 winsCount, uint256 validTrades, bool creatorWins, bool isTie, bool isCancelled, string cancelReason, uint256 resolvedAt, address resolvedBy)",
  "function betSettled(uint256) external view returns (bool)",
  "function betWinner(uint256) external view returns (address)",
  "function winnerPayouts(uint256) external view returns (uint256)",
  "function winningsClaimed(uint256) external view returns (bool)",
  "function settleBet(uint256 betId) external",
  "function claimWinnings(uint256 betId) external",
  "function canSettleBet(uint256 betId) external view returns (bool)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

/**
 * Configuration for chain client
 */
export interface ChainClientConfig {
  privateKey: string;
  contractAddress?: string;
  collateralAddress?: string;
  resolutionDaoAddress?: string;
  rpcUrl?: string;
  rpcFallback?: string;
}

/**
 * Result of a transaction
 */
export interface TransactionResult {
  success: boolean;
  txHash?: string;
  betId?: string;
  gasUsed?: string;
  error?: string;
  portfolioJsonString?: string; // The exact JSON string that was hashed
}

/**
 * Resolution data returned from ResolutionDAO
 */
export interface BetResolution {
  tradesHash: string;
  packedOutcomes: string; // Packed binary outcomes data
  winsCount: bigint;
  validTrades: bigint;
  creatorWins: boolean;
  isTie: boolean;
  isCancelled: boolean;
  cancelReason: string;
  resolvedAt: bigint;
  resolvedBy: string;
}

/**
 * Chain client for interacting with AgiArena contracts
 */
export class ChainClient {
  private provider: JsonRpcProvider;
  private wallet: Wallet;
  private contract: Contract;
  private collateral: Contract;
  private resolutionDao: Contract;
  private contractAddress: string;
  private collateralAddress: string;
  private resolutionDaoAddress: string;

  constructor(config: ChainClientConfig) {
    const rpcUrl = config.rpcUrl || process.env.RPC_URL || DEFAULT_RPC_URL;
    this.contractAddress = config.contractAddress || process.env.CONTRACT_ADDRESS || DEFAULT_CONTRACT_ADDRESS;
    this.collateralAddress = config.collateralAddress || process.env.COLLATERAL_ADDRESS || DEFAULT_COLLATERAL_ADDRESS;
    this.resolutionDaoAddress = config.resolutionDaoAddress || process.env.RESOLUTION_DAO_ADDRESS || DEFAULT_RESOLUTION_DAO_ADDRESS;

    // Create provider with fallback
    this.provider = new JsonRpcProvider(rpcUrl);

    // Create wallet
    this.wallet = new Wallet(config.privateKey, this.provider);

    // Create contract instances
    this.contract = new Contract(this.contractAddress, AGIARENA_ABI, this.wallet);
    this.collateral = new Contract(this.collateralAddress, ERC20_ABI, this.wallet);
    this.resolutionDao = new Contract(this.resolutionDaoAddress, RESOLUTION_DAO_ABI, this.wallet);
  }

  /**
   * Get wallet address
   */
  getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Check collateral token balance
   */
  async getCollateralBalance(): Promise<bigint> {
    return await this.collateral.balanceOf(this.wallet.address);
  }

  /**
   * Check current collateral allowance for the contract
   */
  async getAllowance(): Promise<bigint> {
    return await this.collateral.allowance(this.wallet.address, this.contractAddress);
  }

  /**
   * Approve collateral spending if needed
   */
  async ensureApproval(amount: bigint): Promise<TransactionResult> {
    try {
      const currentAllowance = await this.getAllowance();

      if (currentAllowance >= amount) {
        return { success: true, txHash: "already-approved" };
      }

      // Approve max uint256 for convenience
      const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

      console.log(`[ChainClient] Approving collateral spending...`);
      const tx = await this.collateral.approve(this.contractAddress, maxApproval);
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      return {
        success: false,
        error: `Approval failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Place a new bet on-chain
   *
   * @param portfolio - The portfolio to bet on
   * @param stakeAmount - Amount in base units (18 decimals for WIND)
   * @param oddsBps - Odds in basis points (10000 = 1.00x)
   * @param resolutionDeadline - Unix timestamp when bet can be resolved (default: 24h from now)
   * @param jsonStorageRef - IPFS or other storage reference for portfolio JSON
   * @param snapshotId - The snapshot ID string (e.g., "crypto-2026-01-28-18")
   * @param positionBitmap - The bitmap bytes representing selected positions (optional, will be generated from portfolio)
   */
  async placeBet(
    portfolio: Portfolio,
    stakeAmount: bigint,
    oddsBps: number = 10000,
    resolutionDeadline?: number,
    jsonStorageRef?: string,
    snapshotId?: string,
    tradesHash?: string,
    tradesJsonForHash?: string,
    positionBitmap?: Uint8Array
  ): Promise<TransactionResult> {
    try {
      const portfolioJson = JSON.stringify(portfolio);

      // Use provided snapshot ID or generate a unique one
      const snapshotIdStr = snapshotId || `local:${Date.now()}`;

      // Generate position bitmap from portfolio if not provided
      // Bitmap encodes which trades from the snapshot are selected
      let bitmapBytes: Uint8Array;
      if (positionBitmap) {
        bitmapBytes = positionBitmap;
      } else {
        // Generate bitmap from portfolio positions
        // Each position's rank determines its bit position
        const maxRank = Math.max(...portfolio.positions.map(p => p.rank || 0));
        const bitmapSize = Math.ceil((maxRank + 1) / 8);
        bitmapBytes = new Uint8Array(bitmapSize);
        for (const pos of portfolio.positions) {
          if (pos.rank !== undefined && pos.rank >= 0) {
            const byteIndex = Math.floor(pos.rank / 8);
            const bitIndex = pos.rank % 8;
            bitmapBytes[byteIndex] |= (1 << bitIndex);
          }
        }
      }

      // Use provided storage ref or generate placeholder
      const storageRef = jsonStorageRef || `local:${Date.now()}`;

      // Default deadline: 24 hours from now
      const deadline = resolutionDeadline || Math.floor(Date.now() / 1000) + 24 * 60 * 60;

      // Ensure approval
      const approvalResult = await this.ensureApproval(stakeAmount);
      if (!approvalResult.success) {
        return approvalResult;
      }

      console.log(`[ChainClient] Placing bet: stake=${stakeAmount}, odds=${oddsBps}, deadline=${deadline}`);
      console.log(`[ChainClient] snapshotId=${snapshotIdStr}, bitmapSize=${bitmapBytes.length} bytes`);

      // Place the bet with 6 parameters (new contract ABI)
      const tx = await this.contract.placeBet(
        snapshotIdStr,
        ethers.hexlify(bitmapBytes),
        storageRef,
        stakeAmount,
        oddsBps,
        deadline
      );
      const receipt = await tx.wait();

      // Extract betId from logs
      let betId: string | undefined;
      for (const log of receipt.logs) {
        try {
          const parsed = this.contract.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed && parsed.name === "BetPlaced") {
            betId = parsed.args[0].toString();
            break;
          }
        } catch {
          // Not our event, skip
        }
      }

      return {
        success: true,
        txHash: receipt.hash,
        betId,
        gasUsed: receipt.gasUsed.toString(),
        portfolioJsonString: portfolioJson, // Return exact JSON for backend upload
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      // Parse common errors
      if (errorMsg.includes("insufficient funds")) {
        return { success: false, error: "Insufficient ETH for gas" };
      }
      if (errorMsg.includes("transfer amount exceeds balance")) {
        return { success: false, error: "Insufficient collateral balance" };
      }

      return {
        success: false,
        error: `placeBet failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Match an existing bet on-chain
   *
   * @param betId - The bet ID to match
   * @param fillAmount - Amount to fill in base units (18 decimals for WIND)
   */
  async matchBet(betId: string | number, fillAmount: bigint): Promise<TransactionResult> {
    try {
      // Ensure approval
      const approvalResult = await this.ensureApproval(fillAmount);
      if (!approvalResult.success) {
        return approvalResult;
      }

      console.log(`[ChainClient] Matching bet ${betId} with ${fillAmount}`);

      // Match the bet
      const tx = await this.contract.matchBet(betId, fillAmount);
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        betId: betId.toString(),
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      // Parse common errors
      if (errorMsg.includes("insufficient funds")) {
        return { success: false, error: "Insufficient ETH for gas" };
      }
      if (errorMsg.includes("transfer amount exceeds balance")) {
        return { success: false, error: "Insufficient collateral balance" };
      }
      if (errorMsg.includes("CannotMatchOwnBet")) {
        return { success: false, error: "Cannot match your own bet" };
      }
      if (errorMsg.includes("BetNotOpen")) {
        return { success: false, error: "Bet is not open for matching" };
      }

      return {
        success: false,
        error: `matchBet failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Cancel a bet on-chain (only creator can cancel, and only if not fully matched)
   *
   * @param betId - The bet ID to cancel
   */
  async cancelBet(betId: string | number): Promise<TransactionResult> {
    try {
      console.log(`[ChainClient] Cancelling bet ${betId}`);

      const tx = await this.contract.cancelBet(betId);
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        betId: betId.toString(),
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      // Parse common errors
      if (errorMsg.includes("NotBetCreator")) {
        return { success: false, error: "Only bet creator can cancel" };
      }
      if (errorMsg.includes("BetNotOpen")) {
        return { success: false, error: "Bet is not open for cancellation" };
      }
      if (errorMsg.includes("BetFullyMatched")) {
        return { success: false, error: "Cannot cancel fully matched bet" };
      }

      return {
        success: false,
        error: `cancelBet failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Get bet details from chain
   */
  async getBet(betId: string | number): Promise<{
    betHash: string;
    snapshotId: string;
    listHash: string;
    jsonStorageRef: string;
    creatorStake: bigint;
    requiredMatch: bigint;
    matchedAmount: bigint;
    oddsBps: number;
    creator: string;
    status: number;
    createdAt: bigint;
    resolutionDeadline: bigint;
  } | null> {
    try {
      const result = await this.contract.bets(betId);
      return {
        betHash: result[0],
        snapshotId: result[1],
        listHash: result[2],
        jsonStorageRef: result[3],
        creatorStake: result[4],
        requiredMatch: result[5],
        matchedAmount: result[6],
        oddsBps: Number(result[7]),
        creator: result[8],
        status: Number(result[9]),
        createdAt: result[10],
        resolutionDeadline: result[11],
      };
    } catch {
      return null;
    }
  }

  /**
   * Get bet deadline from chain
   */
  async getBetDeadline(betId: string | number): Promise<bigint | null> {
    try {
      return await this.contract.getBetDeadline(betId);
    } catch {
      return null;
    }
  }

  /**
   * Get resolution data from ResolutionDAO
   *
   * @param betId - The bet ID to check
   * @returns Resolution data or null if not resolved
   */
  async getResolution(betId: string | number): Promise<BetResolution | null> {
    try {
      const result = await this.resolutionDao.betResolutions(betId);
      // Validate result array has expected length
      if (!result || result.length < 10) {
        console.error(`[ChainClient] Invalid resolution data for bet ${betId}: expected 10 fields, got ${result?.length || 0}`);
        return null;
      }
      // Check if bet is resolved (resolvedAt > 0)
      if (result[8] === BigInt(0)) {
        return null;
      }
      return {
        tradesHash: result[0],
        packedOutcomes: result[1], // Include packed outcomes data
        winsCount: result[2],
        validTrades: result[3],
        creatorWins: result[4],
        isTie: result[5],
        isCancelled: result[6],
        cancelReason: result[7],
        resolvedAt: result[8],
        resolvedBy: result[9],
      };
    } catch (error) {
      console.error(`[ChainClient] Failed to get resolution for bet ${betId}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Check if a bet can be settled
   *
   * @param betId - The bet ID to check
   * @returns True if bet can be settled
   */
  async canSettleBet(betId: string | number): Promise<boolean> {
    try {
      return await this.resolutionDao.canSettleBet(betId);
    } catch {
      return false;
    }
  }

  /**
   * Check if a bet has been settled
   *
   * @param betId - The bet ID to check
   * @returns True if bet is settled
   */
  async isBetSettled(betId: string | number): Promise<boolean> {
    try {
      return await this.resolutionDao.betSettled(betId);
    } catch {
      return false;
    }
  }

  /**
   * Get the winner of a settled bet
   *
   * @param betId - The bet ID to check
   * @returns Winner address or null
   */
  async getBetWinner(betId: string | number): Promise<string | null> {
    try {
      const winner = await this.resolutionDao.betWinner(betId);
      if (winner === "0x0000000000000000000000000000000000000000") {
        return null;
      }
      return winner;
    } catch {
      return null;
    }
  }

  /**
   * Get the payout amount for a winner
   *
   * @param betId - The bet ID to check
   * @returns Payout amount in base units
   */
  async getWinnerPayout(betId: string | number): Promise<bigint | null> {
    try {
      return await this.resolutionDao.winnerPayouts(betId);
    } catch {
      return null;
    }
  }

  /**
   * Check if winnings have been claimed
   *
   * @param betId - The bet ID to check
   * @returns True if winnings already claimed
   */
  async areWinningsClaimed(betId: string | number): Promise<boolean> {
    try {
      return await this.resolutionDao.winningsClaimed(betId);
    } catch {
      return false;
    }
  }

  /**
   * Settle a bet via ResolutionDAO (permissionless after resolution)
   *
   * @param betId - The bet ID to settle
   */
  async settleBetViaDao(betId: string | number): Promise<TransactionResult> {
    try {
      console.log(`[ChainClient] Settling bet ${betId} via ResolutionDAO`);

      const tx = await this.resolutionDao.settleBet(betId);
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        betId: betId.toString(),
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      if (errorMsg.includes("BetNotResolved")) {
        return { success: false, error: "Bet has not been resolved yet" };
      }
      if (errorMsg.includes("BetAlreadySettled")) {
        return { success: false, error: "Bet already settled" };
      }
      if (errorMsg.includes("DisputePending")) {
        return { success: false, error: "Bet has pending dispute" };
      }

      return {
        success: false,
        error: `settleBet failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Claim winnings from a settled bet
   *
   * @param betId - The bet ID to claim winnings from
   */
  async claimWinnings(betId: string | number): Promise<TransactionResult> {
    try {
      console.log(`[ChainClient] Claiming winnings for bet ${betId}`);

      const tx = await this.resolutionDao.claimWinnings(betId);
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        betId: betId.toString(),
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      if (errorMsg.includes("InvalidBetStatus")) {
        return { success: false, error: "Bet not settled yet" };
      }
      if (errorMsg.includes("NotWinner")) {
        return { success: false, error: "Caller is not the winner" };
      }
      if (errorMsg.includes("NoWinningsAvailable")) {
        return { success: false, error: "Winnings already claimed or no payout" };
      }

      return {
        success: false,
        error: `claimWinnings failed: ${errorMsg}`,
      };
    }
  }
}

/**
 * Create a chain client from environment variables
 */
export function createChainClientFromEnv(): ChainClient | null {
  const privateKey = process.env.AGENT_PRIVATE_KEY;

  if (!privateKey) {
    console.error("[ChainClient] AGENT_PRIVATE_KEY not set");
    return null;
  }

  return new ChainClient({
    privateKey,
    contractAddress: process.env.CONTRACT_ADDRESS,
    collateralAddress: process.env.COLLATERAL_ADDRESS,
    resolutionDaoAddress: process.env.RESOLUTION_DAO_ADDRESS,
    rpcUrl: process.env.RPC_URL,
  });
}
