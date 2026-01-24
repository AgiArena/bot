/**
 * On-chain transaction client for AgiArena
 *
 * Handles all blockchain interactions:
 * - USDC approval
 * - placeBet transactions
 * - matchBet transactions
 *
 * Uses ethers.js for contract interactions.
 */

import { ethers, Contract, Wallet, JsonRpcProvider } from "ethers";
import { keccak256, toUtf8Bytes } from "ethers";
import type { Portfolio } from "./trading-strategy";

// Contract addresses (Base mainnet)
const DEFAULT_CONTRACT_ADDRESS = "0x241c5B8860223862d7722edE230C855A905C27eB";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// RPC endpoints
const BASE_RPC_URL = "https://mainnet.base.org";
const BASE_RPC_FALLBACK = "https://base.llamarpc.com";

// ABI fragments for the functions we need
// Note: deployed contract uses 3-param placeBet (without odds/deadline)
const AGIARENA_ABI = [
  "function placeBet(bytes32 betHash, string calldata jsonStorageRef, uint256 creatorStake) external returns (uint256 betId)",
  "function matchBet(uint256 betId, uint256 fillAmount) external",
  "function bets(uint256) external view returns (bytes32 betHash, string jsonStorageRef, uint256 creatorStake, uint256 requiredMatch, uint256 matchedAmount, uint32 oddsBps, address creator, uint8 status, uint256 createdAt, uint256 resolutionDeadline)",
  "function getBetDeadline(uint256 betId) external view returns (uint256)",
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
}

/**
 * Chain client for interacting with AgiArena contracts
 */
export class ChainClient {
  private provider: JsonRpcProvider;
  private wallet: Wallet;
  private contract: Contract;
  private usdc: Contract;
  private contractAddress: string;

  constructor(config: ChainClientConfig) {
    const rpcUrl = config.rpcUrl || process.env.BASE_RPC_URL || BASE_RPC_URL;
    this.contractAddress = config.contractAddress || process.env.CONTRACT_ADDRESS || DEFAULT_CONTRACT_ADDRESS;

    // Create provider with fallback
    this.provider = new JsonRpcProvider(rpcUrl);

    // Create wallet
    this.wallet = new Wallet(config.privateKey, this.provider);

    // Create contract instances
    this.contract = new Contract(this.contractAddress, AGIARENA_ABI, this.wallet);
    this.usdc = new Contract(USDC_ADDRESS, ERC20_ABI, this.wallet);
  }

  /**
   * Get wallet address
   */
  getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Check USDC balance
   */
  async getUSDCBalance(): Promise<bigint> {
    return await this.usdc.balanceOf(this.wallet.address);
  }

  /**
   * Check current USDC allowance for the contract
   */
  async getAllowance(): Promise<bigint> {
    return await this.usdc.allowance(this.wallet.address, this.contractAddress);
  }

  /**
   * Approve USDC spending if needed
   */
  async ensureApproval(amount: bigint): Promise<TransactionResult> {
    try {
      const currentAllowance = await this.getAllowance();

      if (currentAllowance >= amount) {
        return { success: true, txHash: "already-approved" };
      }

      // Approve max uint256 for convenience
      const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

      console.log(`[ChainClient] Approving USDC spending...`);
      const tx = await this.usdc.approve(this.contractAddress, maxApproval);
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
   * @param stakeAmount - Amount in USDC base units (6 decimals)
   * @param oddsBps - Odds in basis points (10000 = 1.00x)
   * @param resolutionDeadline - Unix timestamp when bet can be resolved (default: 24h from now)
   * @param jsonStorageRef - IPFS or other storage reference for portfolio JSON
   */
  async placeBet(
    portfolio: Portfolio,
    stakeAmount: bigint,
    oddsBps: number = 10000,
    resolutionDeadline?: number,
    jsonStorageRef?: string
  ): Promise<TransactionResult> {
    try {
      // Generate portfolio hash
      const portfolioJson = JSON.stringify(portfolio);
      const betHash = keccak256(toUtf8Bytes(portfolioJson));

      // Use provided storage ref or generate placeholder
      const storageRef = jsonStorageRef || `local:${Date.now()}`;

      // Default deadline: 24 hours from now
      const deadline = resolutionDeadline || Math.floor(Date.now() / 1000) + 24 * 60 * 60;

      // Ensure approval
      const approvalResult = await this.ensureApproval(stakeAmount);
      if (!approvalResult.success) {
        return approvalResult;
      }

      console.log(`[ChainClient] Placing bet: stake=${stakeAmount}`);

      // Place the bet (3-param version - odds/deadline handled by contract)
      const tx = await this.contract.placeBet(betHash, storageRef, stakeAmount);
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
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      // Parse common errors
      if (errorMsg.includes("insufficient funds")) {
        return { success: false, error: "Insufficient ETH for gas" };
      }
      if (errorMsg.includes("ERC20: transfer amount exceeds balance")) {
        return { success: false, error: "Insufficient USDC balance" };
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
   * @param fillAmount - Amount to fill in USDC base units (6 decimals)
   */
  async matchBet(betId: string | number, fillAmount: bigint): Promise<TransactionResult> {
    try {
      // Ensure approval
      const approvalResult = await this.ensureApproval(fillAmount);
      if (!approvalResult.success) {
        return approvalResult;
      }

      console.log(`[ChainClient] Matching bet ${betId} with ${fillAmount} USDC`);

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
      if (errorMsg.includes("ERC20: transfer amount exceeds balance")) {
        return { success: false, error: "Insufficient USDC balance" };
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
   * Get bet details from chain
   */
  async getBet(betId: string | number): Promise<{
    betHash: string;
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
        jsonStorageRef: result[1],
        creatorStake: result[2],
        requiredMatch: result[3],
        matchedAmount: result[4],
        oddsBps: Number(result[5]),
        creator: result[6],
        status: Number(result[7]),
        createdAt: result[8],
        resolutionDeadline: result[9],
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
    rpcUrl: process.env.BASE_RPC_URL,
  });
}
