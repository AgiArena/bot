/**
 * On-chain transaction client for AgiArena - Bilateral Custody Architecture
 *
 * Story 4-3: Removed legacy AgiArenaCore and ResolutionDAO.
 * Now uses bilateral custody contracts: BotRegistry, CollateralVault, KeeperRegistry.
 *
 * Handles all blockchain interactions:
 * - Collateral token approval
 * - BotRegistry operations (peer discovery)
 * - CollateralVault operations (bilateral bets)
 *
 * Uses ethers.js for contract interactions.
 */

import { ethers, Contract, Wallet, JsonRpcProvider } from "ethers";
import { keccak256, toUtf8Bytes, solidityPackedKeccak256 } from "ethers";
import type { Portfolio } from "./trading-strategy";
import { fetchWithTls } from "./fetch-utils";

// Default contract addresses for Index L3 (Orbit)
const DEFAULT_COLLATERAL_ADDRESS = "0x6Ef9653b34C2A0d91219466b029428ff4F49D651";

// @deprecated Story 4-3: Legacy AgiArenaCore - kept for historical reference only
const DEFAULT_CONTRACT_ADDRESS = "0x873256196B70c5a7fC08A820089293302F492d08";
// @deprecated Story 4-3: Legacy ResolutionDAO - kept for historical reference only
const DEFAULT_RESOLUTION_DAO_ADDRESS = "0x1B1157f2C4E8821B4172dDA17730E9807aceEe88";

// Bilateral custody contracts (deployed in Epic 1) - THE ACTIVE SYSTEM
const DEFAULT_BOT_REGISTRY_ADDRESS = "0x57e58aE95daEebA34E9f51740B1efE7a1B6d3571";
const DEFAULT_COLLATERAL_VAULT_ADDRESS = "0x443CB2e7BcB98A6C17b039eD7FC417Aada9C7562";
const DEFAULT_KEEPER_REGISTRY_ADDRESS = "0x989cdF6812745fC82aF14Ce51c1a27E13dAe7BC6";

// RPC endpoint for Index L3
const DEFAULT_RPC_URL = "https://index.rpc.zeeve.net";

// @deprecated Story 4-3: Legacy AgiArenaCore ABI - DO NOT USE
// Kept temporarily for compile compatibility. Remove all usages.
const AGIARENA_ABI: string[] = [];

// @deprecated Story 4-3: Legacy ResolutionDAO ABI - DO NOT USE
// Kept temporarily for compile compatibility. Remove all usages.
const RESOLUTION_DAO_ABI: string[] = [];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

// BotRegistry ABI fragments (Story 2-1)
const BOT_REGISTRY_ABI = [
  "function registerBot(string calldata endpoint, bytes32 pubkeyHash) external",
  "function updateEndpoint(string calldata newEndpoint) external",
  "function deregisterBot() external",
  "function isActive(address bot) external view returns (bool)",
  "function getBot(address bot) external view returns (string memory endpoint, bytes32 pubkeyHash, uint256 stakedAmount, uint256 registeredAt, bool isActive)",
  "function getAllActiveBots() external view returns (address[] memory, string[] memory)",
  "function MIN_STAKE() external view returns (uint256)",
  "event BotRegistered(address indexed bot, string endpoint, bytes32 pubkeyHash, uint256 stake)",
  "event BotDeregistered(address indexed bot, uint256 stakeReturned)",
];

// CollateralVault ABI fragments (Story 2-1, extended Story 2-3, Story 2-4)
const COLLATERAL_VAULT_ABI = [
  // Story 2-1: Deposit/Withdraw
  "function deposit(uint256 amount) external",
  "function withdraw(uint256 amount) external",
  "function getAvailableBalance(address user) external view returns (uint256)",
  "function getTotalBalance(address user) external view returns (uint256)",
  "function lockedBalance(address user) external view returns (uint256)",
  "event Deposit(address indexed user, uint256 amount, uint256 newAvailableBalance)",
  "event Withdraw(address indexed user, uint256 amount, uint256 newAvailableBalance)",
  // Story 2-3: Bilateral Bet Commitment
  "function commitBet(tuple(bytes32 tradesRoot, address creator, address filler, uint256 creatorAmount, uint256 fillerAmount, uint256 deadline, uint256 nonce, uint256 expiry) commitment, bytes creatorSig, bytes fillerSig) external returns (uint256 betId)",
  "function nonces(address) external view returns (uint256)",
  "function DOMAIN_SEPARATOR() external view returns (bytes32)",
  "event BetCommitted(uint256 indexed betId, address indexed creator, address indexed filler, bytes32 tradesRoot, uint256 creatorAmount, uint256 fillerAmount, uint256 deadline)",
  "event CollateralLocked(address indexed user, uint256 indexed betId, uint256 amount)",
  // Story 2-4: Settlement Functions
  "function settleByAgreement(tuple(uint256 betId, address winner, uint256 nonce, uint256 expiry) agreement, bytes creatorSig, bytes fillerSig) external",
  "function customPayout(tuple(uint256 betId, uint256 creatorPayout, uint256 fillerPayout, uint256 nonce, uint256 expiry) proposal, bytes creatorSig, bytes fillerSig) external",
  "function requestArbitration(uint256 betId) external",
  "function bets(uint256) external view returns (bytes32 tradesRoot, address creator, address filler, uint256 creatorAmount, uint256 fillerAmount, uint256 deadline, uint256 createdAt, uint8 status)",
  "event BetSettled(uint256 indexed betId, address indexed winner, uint256 payout)",
  "event CustomPayoutExecuted(uint256 indexed betId, uint256 creatorPayout, uint256 fillerPayout)",
  "event ArbitrationRequested(uint256 indexed betId, address indexed requestedBy, uint256 timestamp)",
];

/**
 * Configuration for chain client
 */
export interface ChainClientConfig {
  privateKey: string;
  contractAddress?: string;
  collateralAddress?: string;
  resolutionDaoAddress?: string;
  botRegistryAddress?: string;      // Story 2-1: BotRegistry contract
  collateralVaultAddress?: string;  // Story 2-1: CollateralVault contract
  rpcUrl?: string;
  rpcFallback?: string;
  chainId?: number;
  backendUrl?: string;
}

/**
 * Bot information from BotRegistry (Story 2-1)
 */
export interface BotInfo {
  endpoint: string;
  pubkeyHash: string;
  stakedAmount: bigint;
  registeredAt: bigint;
  isActive: boolean;
}

/**
 * Vault balance information (Story 2-1)
 */
export interface VaultBalance {
  available: bigint;
  locked: bigint;
  total: bigint;
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
  snapshotId?: string; // The snapshot ID used for bitmap hash (Story 9.2)
  positionBitmap?: Uint8Array; // The bitmap bytes sent to contract (Story 9.2)
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

// ============================================================================
// EIP-712 Constants (Story 14-1)
// ============================================================================

const DEFAULT_CHAIN_ID = 111222333;
const DEFAULT_BACKEND_URL = "http://localhost:3001";

/** EIP-712 domain for AgiArenaCore */
function getEip712Domain(chainId: number, verifyingContract: string) {
  return {
    name: "AgiArenaCore",
    version: "2",
    chainId,
    verifyingContract,
  };
}

/** EIP-712 types for BetProposition */
const BET_PROPOSITION_TYPES = {
  BetProposition: [
    { name: "creator", type: "address" },
    { name: "tradesHash", type: "bytes32" },
    { name: "snapshotId", type: "string" },
    { name: "jsonStorageRef", type: "string" },
    { name: "creatorStake", type: "uint256" },
    { name: "oddsBps", type: "uint32" },
    { name: "resolutionDeadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
};

/** EIP-712 types for MatchAcceptance */
const MATCH_ACCEPTANCE_TYPES = {
  MatchAcceptance: [
    { name: "propositionHash", type: "bytes32" },
    { name: "filler", type: "address" },
    { name: "fillAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
};

/** EIP-712 types for EarlyExit */
const EARLY_EXIT_TYPES = {
  EarlyExit: [
    { name: "betId", type: "uint256" },
    { name: "creatorAmount", type: "uint256" },
    { name: "fillerAmount", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
};

/** EIP-712 types for P2PResolution (Story 15-1) */
const P2P_RESOLUTION_TYPES = {
  P2PResolution: [
    { name: "betId", type: "uint256" },
    { name: "tradesRoot", type: "bytes32" },
    { name: "winsCount", type: "uint256" },
    { name: "validTrades", type: "uint256" },
    { name: "creatorWins", type: "bool" },
    { name: "isTie", type: "bool" },
    { name: "expiry", type: "uint256" },
  ],
};

// ============================================================================
// Proposition Types (Story 14-1)
// ============================================================================

/** Data for a BetProposition to sign */
export interface BetPropositionParams {
  tradesHash: string;
  snapshotId: string;
  jsonStorageRef?: string;
  creatorStake: bigint;
  oddsBps: number;
  resolutionDeadline: number;
  nonce?: bigint;
  expiry?: number;
}

/** Result of signing a bet proposition */
export interface SignedProposition {
  signature: string;
  creator: string;
  tradesHash: string;
  snapshotId: string;
  jsonStorageRef: string;
  creatorStake: bigint;
  requiredMatch: bigint;
  oddsBps: number;
  resolutionDeadline: number;
  nonce: bigint;
  expiry: number;
  positionBitmap?: string; // Hex-encoded position bitmap for trade verification
}

/** Result of signing a match acceptance */
export interface SignedMatchAcceptance {
  signature: string;
  propositionHash: string;
  filler: string;
  fillAmount: bigint;
  nonce: bigint;
  expiry: number;
}

/** Parameters for P2P resolution (Story 15-1) */
export interface P2PResolutionParams {
  betId: number;
  tradesRoot: string;  // Merkle root of resolved trades
  winsCount: number;   // Number of trades won by creator
  validTrades: number; // Total valid trades (excluding cancelled)
  creatorWins: boolean;
  isTie: boolean;
  expiry?: number;
}

/** Result of signing a P2P resolution */
export interface SignedP2PResolution {
  signature: string;
  betId: number;
  tradesRoot: string;
  winsCount: number;
  validTrades: number;
  creatorWins: boolean;
  isTie: boolean;
  expiry: number;
}

/** Proposition from backend API */
export interface BackendProposition {
  propositionHash: string;
  creator: string;
  tradesHash: string;
  snapshotId: string;
  categoryId?: string;
  listSize?: string;
  creatorStake: string;
  requiredMatch: string;
  oddsBps: number;
  oddsDisplay: string;
  resolutionDeadline: string;
  expiry: string;
  status: string;
  matchedBy?: string;
  matchedAt?: string;
  createdAt: string;
}

/** Result of submitting a proposition to backend */
export interface PropositionSubmitResult {
  success: boolean;
  propositionHash?: string;
  error?: string;
}

/** Result of submitting a match to backend */
export interface MatchSubmitResult {
  success: boolean;
  propositionHash?: string;
  status?: string;
  error?: string;
}

/**
 * Format a wei amount to a decimal string (for backend API)
 */
function bigintPow10(n: number): bigint {
  let result = BigInt(1);
  for (let i = 0; i < n; i++) result *= BigInt(10);
  return result;
}

function formatWeiToDecimal(wei: bigint, decimals: number): string {
  const divisor = bigintPow10(decimals);
  const whole = wei / divisor;
  const fraction = (wei < BigInt(0) ? -wei : wei) % divisor;
  const fractionStr = fraction.toString().padStart(decimals, "0");
  return `${whole}.${fractionStr}`;
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
  private botRegistry: Contract | null = null;      // Story 2-1
  private collateralVault: Contract | null = null;  // Story 2-1
  private contractAddress: string;
  private collateralAddress: string;
  private resolutionDaoAddress: string;
  private botRegistryAddress: string;               // Story 2-1
  private collateralVaultAddress: string;           // Story 2-1
  private chainId: number;
  private backendUrl: string;

  constructor(config: ChainClientConfig) {
    const rpcUrl = config.rpcUrl || process.env.RPC_URL || DEFAULT_RPC_URL;
    this.contractAddress = config.contractAddress || process.env.CONTRACT_ADDRESS || DEFAULT_CONTRACT_ADDRESS;
    this.collateralAddress = config.collateralAddress || process.env.COLLATERAL_ADDRESS || DEFAULT_COLLATERAL_ADDRESS;
    this.resolutionDaoAddress = config.resolutionDaoAddress || process.env.RESOLUTION_DAO_ADDRESS || DEFAULT_RESOLUTION_DAO_ADDRESS;
    this.botRegistryAddress = config.botRegistryAddress || process.env.BOT_REGISTRY_ADDRESS || DEFAULT_BOT_REGISTRY_ADDRESS;
    this.collateralVaultAddress = config.collateralVaultAddress || process.env.COLLATERAL_VAULT_ADDRESS || DEFAULT_COLLATERAL_VAULT_ADDRESS;
    this.chainId = config.chainId || parseInt(process.env.CHAIN_ID || "") || DEFAULT_CHAIN_ID;
    this.backendUrl = config.backendUrl || process.env.BACKEND_URL || DEFAULT_BACKEND_URL;

    // Create provider with fallback
    this.provider = new JsonRpcProvider(rpcUrl);

    // Create wallet
    this.wallet = new Wallet(config.privateKey, this.provider);

    // Create contract instances
    this.contract = new Contract(this.contractAddress, AGIARENA_ABI, this.wallet);
    this.collateral = new Contract(this.collateralAddress, ERC20_ABI, this.wallet);
    this.resolutionDao = new Contract(this.resolutionDaoAddress, RESOLUTION_DAO_ABI, this.wallet);

    // Story 2-1: Initialize BotRegistry and CollateralVault contracts if addresses provided
    if (this.botRegistryAddress) {
      this.botRegistry = new Contract(this.botRegistryAddress, BOT_REGISTRY_ABI, this.wallet);
    }
    if (this.collateralVaultAddress) {
      this.collateralVault = new Contract(this.collateralVaultAddress, COLLATERAL_VAULT_ABI, this.wallet);
    }
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
      // Bitmap encoding: bit i = 1 if position[i] is LONG/YES, 0 if SHORT/NO
      // This MUST match the backend verification logic and the upload bitmap
      let bitmapBytes: Uint8Array;
      if (positionBitmap) {
        bitmapBytes = positionBitmap;
      } else {
        // Generate bitmap from portfolio positions - SEQUENTIAL encoding
        // Bit 0 = position[0], bit 1 = position[1], etc.
        // This matches encodePositionBitmap() in bitmap-utils.ts
        const bitmapSize = Math.ceil(portfolio.positions.length / 8);
        bitmapBytes = new Uint8Array(bitmapSize);
        for (let i = 0; i < portfolio.positions.length; i++) {
          const pos = portfolio.positions[i];
          // LONG/YES = 1, SHORT/NO = 0
          const isLong = pos.position === 'YES' || pos.position === 'LONG';
          if (isLong) {
            const byteIndex = Math.floor(i / 8);
            const bitIndex = i % 8;
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
        snapshotId: snapshotIdStr, // Story 9.2: Return snapshotId for bitmap upload
        positionBitmap: bitmapBytes, // Story 9.2: Return bitmap for backend upload
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

  // ============================================================================
  // BLS Aggregated Resolution (Story 14.3)
  // ============================================================================

  /**
   * Submit aggregated BLS resolution to the contract
   *
   * Story 14.3, Task 4: Submit aggregated resolution on-chain
   *
   * @param payload - Resolution payload with bet outcome data
   * @param sigX - Aggregated signature X coordinate
   * @param sigY - Aggregated signature Y coordinate
   * @param signers - Array of keeper addresses who signed
   */
  async submitAggregatedResolution(
    payload: {
      betId: number;
      tradesHash: string;
      packedOutcomes: string;
      winsCount: number;
      validTrades: number;
      creatorWins: boolean;
      isTie: boolean;
      isCancelled: boolean;
      cancelReason: string;
      nonce: bigint;
      expiry: number;
    },
    sigX: string,
    sigY: string,
    signers: string[],
  ): Promise<TransactionResult> {
    try {
      console.log(`[ChainClient] Submitting aggregated resolution for bet ${payload.betId}`);
      console.log(`[ChainClient] Signers: ${signers.length}, Required: 51%`);

      // Build payload tuple for contract
      const payloadTuple = [
        payload.betId,
        payload.tradesHash,
        payload.packedOutcomes,
        payload.winsCount,
        payload.validTrades,
        payload.creatorWins,
        payload.isTie,
        payload.isCancelled,
        payload.cancelReason,
        payload.nonce,
        payload.expiry,
      ];

      // Submit to contract
      const tx = await this.resolutionDao.submitAggregatedResolution(
        payloadTuple,
        BigInt(sigX),
        BigInt(sigY),
        signers,
      );
      const receipt = await tx.wait();

      // Check for BetResolutionSubmittedBLS event
      let signersCount = 0;
      for (const log of receipt.logs) {
        try {
          const parsed = this.resolutionDao.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed && parsed.name === "BetResolutionSubmittedBLS") {
            signersCount = Number(parsed.args[2]);
            break;
          }
        } catch {
          // Not our event
        }
      }

      console.log(`[ChainClient] Resolution submitted! TX: ${receipt.hash}, signers: ${signersCount}`);

      return {
        success: true,
        txHash: receipt.hash,
        betId: payload.betId.toString(),
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      // Parse common errors
      if (errorMsg.includes("BetAlreadyResolved")) {
        return { success: false, error: "Bet already resolved" };
      }
      if (errorMsg.includes("InsufficientBLSSigners")) {
        return { success: false, error: "Not enough BLS signers (need >50%)" };
      }
      if (errorMsg.includes("BLSSignatureVerificationFailed")) {
        return { success: false, error: "BLS signature verification failed" };
      }
      if (errorMsg.includes("SignerNotKeeper")) {
        return { success: false, error: "One or more signers is not a registered keeper" };
      }
      if (errorMsg.includes("BLSPayloadExpired")) {
        return { success: false, error: "Resolution payload has expired" };
      }
      if (errorMsg.includes("InvalidBLSNonce")) {
        return { success: false, error: "Invalid nonce (possible replay attack)" };
      }

      return {
        success: false,
        error: `submitAggregatedResolution failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Get the number of required BLS signers (>50% of keepers)
   */
  async getRequiredBLSSigners(): Promise<number> {
    const required = await this.resolutionDao.getRequiredBLSSigners();
    return Number(required);
  }

  /**
   * Get the current BLS nonce for a bet (for replay protection)
   */
  async getBLSNonce(betId: number): Promise<bigint> {
    return await this.resolutionDao.getBLSNonce(betId);
  }

  // ============================================================================
  // EIP-712 Off-Chain Betting (Story 14-1)
  // ============================================================================

  /**
   * Get the chain ID
   */
  getChainId(): number {
    return this.chainId;
  }

  /**
   * Get the backend URL
   */
  getBackendUrl(): string {
    return this.backendUrl;
  }

  /**
   * Compute tradesHash from snapshotId and positionBitmap
   * Matches contract: keccak256(abi.encodePacked(snapshotId, positionBitmap))
   */
  static computeTradesHash(snapshotId: string, positionBitmap: Uint8Array): string {
    return solidityPackedKeccak256(
      ['string', 'bytes'],
      [snapshotId, ethers.hexlify(positionBitmap)]
    );
  }

  /**
   * Get the current nonce for an address from the contract
   */
  async getNonce(address?: string): Promise<bigint> {
    const addr = address || this.wallet.address;
    return await this.contract.nonces(addr);
  }

  /**
   * Increment the caller's nonce (invalidates all pending propositions)
   */
  async incrementNonce(): Promise<TransactionResult> {
    try {
      console.log(`[ChainClient] Incrementing nonce`);
      const tx = await this.contract.incrementNonce();
      const receipt = await tx.wait();
      return {
        success: true,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      return {
        success: false,
        error: `incrementNonce failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Sign a BetProposition using EIP-712
   *
   * @param params - Proposition parameters to sign
   * @returns Signed proposition data ready for backend submission
   */
  async signBetProposition(params: BetPropositionParams): Promise<SignedProposition> {
    // Auto-fetch nonce if not provided
    const nonce = params.nonce ?? await this.getNonce();

    // Default expiry: 1 hour from now
    const expiry = params.expiry ?? Math.floor(Date.now() / 1000) + 3600;

    const domain = getEip712Domain(this.chainId, this.contractAddress);
    const value = {
      creator: this.wallet.address,
      tradesHash: params.tradesHash,
      snapshotId: params.snapshotId,
      jsonStorageRef: params.jsonStorageRef || "",
      creatorStake: params.creatorStake,
      oddsBps: params.oddsBps,
      resolutionDeadline: params.resolutionDeadline,
      nonce,
      expiry,
    };

    const signature = await this.wallet.signTypedData(
      domain,
      BET_PROPOSITION_TYPES,
      value
    );

    // Compute required match: creatorStake * 10000 / oddsBps
    // Example: at 2.30x odds (23000 bps), if creator stakes 0.03, matcher needs 0.013
    const requiredMatch = (params.creatorStake * BigInt(10000)) / BigInt(params.oddsBps);

    return {
      signature,
      creator: this.wallet.address,
      tradesHash: params.tradesHash,
      snapshotId: params.snapshotId,
      jsonStorageRef: params.jsonStorageRef || "",
      creatorStake: params.creatorStake,
      requiredMatch,
      oddsBps: params.oddsBps,
      resolutionDeadline: params.resolutionDeadline,
      nonce,
      expiry,
    };
  }

  /**
   * Sign a MatchAcceptance using EIP-712
   *
   * @param propositionHash - Hash of the proposition to match
   * @param fillAmount - Exact fill amount (must equal required_match)
   * @param nonce - Nonce for replay protection (auto-fetched if not provided)
   * @param expiry - Signature expiry (default: 1 hour from now)
   */
  async signMatchAcceptance(
    propositionHash: string,
    fillAmount: bigint,
    nonce?: bigint,
    expiry?: number,
  ): Promise<SignedMatchAcceptance> {
    const actualNonce = nonce ?? await this.getNonce();
    const actualExpiry = expiry ?? Math.floor(Date.now() / 1000) + 3600;

    const domain = getEip712Domain(this.chainId, this.contractAddress);
    const value = {
      propositionHash,
      filler: this.wallet.address,
      fillAmount,
      nonce: actualNonce,
      expiry: actualExpiry,
    };

    const signature = await this.wallet.signTypedData(
      domain,
      MATCH_ACCEPTANCE_TYPES,
      value
    );

    return {
      signature,
      propositionHash,
      filler: this.wallet.address,
      fillAmount,
      nonce: actualNonce,
      expiry: actualExpiry,
    };
  }

  /**
   * Submit a signed proposition to the backend
   */
  async submitProposition(
    signed: SignedProposition,
    options?: {
      categoryId?: string;
      listSize?: string;
    }
  ): Promise<PropositionSubmitResult> {
    try {
      const creatorStakeDecimal = formatWeiToDecimal(signed.creatorStake, 18);
      const requiredMatchDecimal = formatWeiToDecimal(signed.requiredMatch, 18);

      const body = {
        creator: signed.creator,
        tradesHash: signed.tradesHash,
        snapshotId: signed.snapshotId,
        jsonStorageRef: signed.jsonStorageRef || undefined,
        categoryId: options?.categoryId,
        listSize: options?.listSize,
        creatorStake: creatorStakeDecimal,
        requiredMatch: requiredMatchDecimal,
        oddsBps: signed.oddsBps,
        resolutionDeadline: signed.resolutionDeadline,
        nonce: Number(signed.nonce),
        expiry: signed.expiry,
        signature: signed.signature,
        positionBitmap: signed.positionBitmap, // Include bitmap for trade verification
      };

      const response = await fetchWithTls(`${this.backendUrl}/api/propositions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await response.json() as any;

      if (!response.ok) {
        return {
          success: false,
          error: data.error || `HTTP ${response.status}`,
        };
      }

      return {
        success: true,
        propositionHash: data.propositionHash,
      };
    } catch (error) {
      return {
        success: false,
        error: `submitProposition failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Submit a signed match acceptance to the backend
   */
  async submitMatch(
    signed: SignedMatchAcceptance,
  ): Promise<MatchSubmitResult> {
    try {
      const fillAmountDecimal = formatWeiToDecimal(signed.fillAmount, 18);

      const body = {
        filler: signed.filler,
        fillAmount: fillAmountDecimal,
        nonce: Number(signed.nonce),
        expiry: signed.expiry,
        signature: signed.signature,
      };

      const response = await fetchWithTls(
        `${this.backendUrl}/api/propositions/${signed.propositionHash}/match`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      const data = await response.json() as any;

      if (!response.ok) {
        return {
          success: false,
          error: data.error || `HTTP ${response.status}`,
        };
      }

      return {
        success: true,
        propositionHash: data.propositionHash,
        status: data.status,
      };
    } catch (error) {
      return {
        success: false,
        error: `submitMatch failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Execute a fully-matched proposition on-chain
   * Both creator and filler signatures must be available.
   */
  async executeSignedBetOnChain(
    proposition: {
      creator: string;
      tradesHash: string;
      snapshotId: string;
      jsonStorageRef: string;
      creatorStake: bigint;
      oddsBps: number;
      resolutionDeadline: number;
      nonce: bigint;
      expiry: number;
    },
    creatorSig: string,
    acceptance: {
      propositionHash: string;
      filler: string;
      fillAmount: bigint;
      nonce: bigint;
      expiry: number;
    },
    fillerSig: string,
  ): Promise<TransactionResult> {
    try {
      // Ensure approval for filler stake
      const approvalResult = await this.ensureApproval(acceptance.fillAmount);
      if (!approvalResult.success) {
        return approvalResult;
      }

      const propTuple = [
        proposition.creator,
        proposition.tradesHash,
        proposition.snapshotId,
        proposition.jsonStorageRef,
        proposition.creatorStake,
        proposition.oddsBps,
        proposition.resolutionDeadline,
        proposition.nonce,
        proposition.expiry,
      ];

      const accTuple = [
        acceptance.propositionHash,
        acceptance.filler,
        acceptance.fillAmount,
        acceptance.nonce,
        acceptance.expiry,
      ];

      console.log(`[ChainClient] Executing signed bet on-chain`);
      const tx = await this.contract.executeSignedBet(
        propTuple,
        creatorSig,
        accTuple,
        fillerSig
      );
      const receipt = await tx.wait();

      // Extract betId from BetExecuted event
      let betId: string | undefined;
      for (const log of receipt.logs) {
        try {
          const parsed = this.contract.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed && parsed.name === "BetExecuted") {
            betId = parsed.args[0].toString();
            break;
          }
        } catch {
          // Not our event
        }
      }

      return {
        success: true,
        txHash: receipt.hash,
        betId,
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      return {
        success: false,
        error: `executeSignedBet failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Fetch open propositions from the backend
   */
  async fetchOpenPropositions(options?: {
    categoryId?: string;
    snapshotId?: string;
    excludeCreator?: string;
    limit?: number;
  }): Promise<BackendProposition[]> {
    try {
      const url = new URL("/api/propositions", this.backendUrl);
      url.searchParams.set("status", "open");
      if (options?.categoryId) url.searchParams.set("category_id", options.categoryId);
      if (options?.snapshotId) url.searchParams.set("snapshot_id", options.snapshotId);
      if (options?.limit) url.searchParams.set("limit", options.limit.toString());

      const response = await fetchWithTls(url.toString(), {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        console.error(`[ChainClient] Failed to fetch propositions: ${response.status}`);
        return [];
      }

      const data = await response.json() as { propositions: BackendProposition[] };
      let propositions = data.propositions || [];

      // Filter out own propositions
      if (options?.excludeCreator) {
        const exclude = options.excludeCreator.toLowerCase();
        propositions = propositions.filter(
          p => p.creator.toLowerCase() !== exclude
        );
      }

      return propositions;
    } catch (error) {
      console.error(`[ChainClient] fetchOpenPropositions error: ${(error as Error).message}`);
      return [];
    }
  }

  // ============================================================================
  // Early Exit (Story 14-1, Task 15)
  // ============================================================================

  /**
   * Sign an EarlyExit using EIP-712
   *
   * @param betId - The bet ID to exit
   * @param creatorAmount - Amount returned to creator (wei)
   * @param fillerAmount - Amount returned to filler (wei)
   * @param expiry - Signature expiry (Unix timestamp, default: 1 hour)
   */
  async signEarlyExit(
    betId: number | bigint,
    creatorAmount: bigint,
    fillerAmount: bigint,
    expiry?: number,
  ): Promise<{ signature: string; betId: bigint; creatorAmount: bigint; fillerAmount: bigint; expiry: number }> {
    const actualExpiry = expiry ?? Math.floor(Date.now() / 1000) + 3600;

    const domain = getEip712Domain(this.chainId, this.contractAddress);
    const value = {
      betId: BigInt(betId),
      creatorAmount,
      fillerAmount,
      expiry: actualExpiry,
    };

    const signature = await this.wallet.signTypedData(
      domain,
      EARLY_EXIT_TYPES,
      value
    );

    return {
      signature,
      betId: BigInt(betId),
      creatorAmount,
      fillerAmount,
      expiry: actualExpiry,
    };
  }

  /**
   * Propose an early exit to the backend
   */
  async proposeEarlyExit(
    betId: number,
    creatorAmount: bigint,
    fillerAmount: bigint,
    feeAmount: bigint,
    expiry?: number,
  ): Promise<{ success: boolean; exitId?: number; error?: string }> {
    try {
      const signed = await this.signEarlyExit(betId, creatorAmount, fillerAmount, expiry);

      const body = {
        creatorAmount: formatWeiToDecimal(creatorAmount, 18),
        fillerAmount: formatWeiToDecimal(fillerAmount, 18),
        feeAmount: formatWeiToDecimal(feeAmount, 18),
        expiry: signed.expiry,
        proposedBy: this.wallet.address,
        signature: signed.signature,
      };

      const response = await fetchWithTls(
        `${this.backendUrl}/api/bets/${betId}/exit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      const data = await response.json() as any;

      if (!response.ok) {
        return { success: false, error: data.error || `HTTP ${response.status}` };
      }

      return { success: true, exitId: data.exitId };
    } catch (error) {
      return { success: false, error: `proposeEarlyExit failed: ${(error as Error).message}` };
    }
  }

  /**
   * Accept (counter-sign) an early exit proposal
   */
  async acceptEarlyExit(
    betId: number,
    creatorAmount: bigint,
    fillerAmount: bigint,
    expiry: number,
  ): Promise<{ success: boolean; status?: string; error?: string }> {
    try {
      const signed = await this.signEarlyExit(betId, creatorAmount, fillerAmount, expiry);

      const body = {
        signer: this.wallet.address,
        signature: signed.signature,
      };

      const response = await fetchWithTls(
        `${this.backendUrl}/api/bets/${betId}/exit/accept`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      const data = await response.json() as any;

      if (!response.ok) {
        return { success: false, error: data.error || `HTTP ${response.status}` };
      }

      return { success: true, status: data.status };
    } catch (error) {
      return { success: false, error: `acceptEarlyExit failed: ${(error as Error).message}` };
    }
  }

  /**
   * Get early exit status from backend
   */
  async getEarlyExitStatus(betId: number): Promise<{
    exitId: number;
    creatorAmount: string;
    fillerAmount: string;
    feeAmount: string;
    expiry: string;
    proposedBy: string;
    creatorSignature: string | null;
    fillerSignature: string | null;
    status: string;
    executedTxHash: string | null;
  } | null> {
    try {
      const response = await fetchWithTls(
        `${this.backendUrl}/api/bets/${betId}/exit`,
        { method: "GET", headers: { "Content-Type": "application/json" } }
      );

      if (!response.ok) return null;

      return await response.json() as any;
    } catch {
      return null;
    }
  }

  /**
   * Execute an early exit on-chain (requires both signatures)
   */
  async executeEarlyExitOnChain(
    betId: number | bigint,
    creatorAmount: bigint,
    fillerAmount: bigint,
    expiry: number,
    creatorSig: string,
    fillerSig: string,
  ): Promise<TransactionResult> {
    try {
      const exitTuple = [BigInt(betId), creatorAmount, fillerAmount, expiry];

      console.log(`[ChainClient] Executing early exit for bet ${betId}`);
      const tx = await this.contract.executeEarlyExit(exitTuple, creatorSig, fillerSig);
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        betId: betId.toString(),
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      return {
        success: false,
        error: `executeEarlyExit failed: ${(error as Error).message}`,
      };
    }
  }

  // ============================================================================
  // P2P Resolution (Story 15-1)
  // ============================================================================

  /**
   * Sign a P2P resolution using EIP-712
   *
   * Both creator and filler must sign the same resolution data.
   * This allows bots to settle bets directly without keeper involvement.
   *
   * @param params - P2P resolution parameters
   * @returns Signed resolution data
   */
  async signP2PResolution(params: P2PResolutionParams): Promise<SignedP2PResolution> {
    // Default expiry: 1 hour from now
    const expiry = params.expiry ?? Math.floor(Date.now() / 1000) + 3600;

    const domain = getEip712Domain(this.chainId, this.contractAddress);
    const value = {
      betId: BigInt(params.betId),
      tradesRoot: params.tradesRoot,
      winsCount: BigInt(params.winsCount),
      validTrades: BigInt(params.validTrades),
      creatorWins: params.creatorWins,
      isTie: params.isTie,
      expiry,
    };

    const signature = await this.wallet.signTypedData(
      domain,
      P2P_RESOLUTION_TYPES,
      value
    );

    return {
      signature,
      betId: params.betId,
      tradesRoot: params.tradesRoot,
      winsCount: params.winsCount,
      validTrades: params.validTrades,
      creatorWins: params.creatorWins,
      isTie: params.isTie,
      expiry,
    };
  }

  /**
   * Execute P2P resolution on-chain (requires both creator and filler signatures)
   *
   * @param resolution - The resolution parameters both parties agreed on
   * @param creatorSig - Creator's EIP-712 signature
   * @param fillerSig - Filler's EIP-712 signature
   */
  async executeP2PResolutionOnChain(
    resolution: {
      betId: number;
      tradesRoot: string;
      winsCount: number;
      validTrades: number;
      creatorWins: boolean;
      isTie: boolean;
      expiry: number;
    },
    creatorSig: string,
    fillerSig: string,
  ): Promise<TransactionResult> {
    try {
      const resolutionTuple = [
        BigInt(resolution.betId),
        resolution.tradesRoot,
        BigInt(resolution.winsCount),
        BigInt(resolution.validTrades),
        resolution.creatorWins,
        resolution.isTie,
        resolution.expiry,
      ];

      console.log(`[ChainClient] Executing P2P resolution for bet ${resolution.betId}`);
      console.log(`[ChainClient] CreatorWins: ${resolution.creatorWins}, IsTie: ${resolution.isTie}`);

      const tx = await this.contract.executeP2PResolution(
        resolutionTuple,
        creatorSig,
        fillerSig
      );
      const receipt = await tx.wait();

      // Extract event data
      let winner: string | undefined;
      for (const log of receipt.logs) {
        try {
          const parsed = this.contract.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed && parsed.name === "BetP2PResolved") {
            winner = parsed.args[1]; // indexed winner
            break;
          }
        } catch {
          // Not our event
        }
      }

      return {
        success: true,
        txHash: receipt.hash,
        betId: resolution.betId.toString(),
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      // Parse common errors
      if (errorMsg.includes("BetNotFound")) {
        return { success: false, error: "Bet not found" };
      }
      if (errorMsg.includes("BetNotInMatchedState")) {
        return { success: false, error: "Bet not in matched state (already settled?)" };
      }
      if (errorMsg.includes("SignatureExpired")) {
        return { success: false, error: "Resolution signature has expired" };
      }
      if (errorMsg.includes("InvalidSignature")) {
        return { success: false, error: "Invalid signature (not from creator or filler)" };
      }
      if (errorMsg.includes("P2PResolutionTieConditionMismatch")) {
        return { success: false, error: "Tie condition doesn't match winsCount/validTrades" };
      }
      if (errorMsg.includes("P2PResolutionCreatorWinsMismatch")) {
        return { success: false, error: "CreatorWins doesn't match winsCount/validTrades" };
      }

      return {
        success: false,
        error: `executeP2PResolution failed: ${errorMsg}`,
      };
    }
  }

  // ============================================================================
  // BotRegistry Methods (Story 2-1)
  // ============================================================================

  /**
   * Check if BotRegistry contract is configured
   * @returns True if BOT_REGISTRY_ADDRESS is set
   */
  isBotRegistryConfigured(): boolean {
    return this.botRegistry !== null;
  }

  /**
   * Check if a bot is registered on BotRegistry
   * @param address - Address to check (defaults to wallet address)
   * @returns True if the bot is registered and active
   * @throws Error if BotRegistry is not configured (use isBotRegistryConfigured() to check first)
   */
  async isBotRegistered(address?: string): Promise<boolean> {
    if (!this.botRegistry) {
      throw new Error("BotRegistry not configured - BOT_REGISTRY_ADDRESS not set");
    }

    const addr = address || this.wallet.address;
    try {
      return await this.botRegistry.isActive(addr);
    } catch (error) {
      console.error(`[ChainClient] Failed to check bot registration: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Register this bot on BotRegistry with stake
   * Requires 100 WIND stake and approval
   * @param endpoint - P2P HTTP endpoint URL (e.g., "https://bot1.example.com:8080")
   * @param pubkeyHash - keccak256 hash of bot's signing public key
   * @returns Transaction result
   */
  async registerBot(endpoint: string, pubkeyHash: string): Promise<TransactionResult> {
    if (!this.botRegistry) {
      return { success: false, error: "BotRegistry not configured - BOT_REGISTRY_ADDRESS not set" };
    }

    try {
      // Check if already registered
      const isRegistered = await this.isBotRegistered();
      if (isRegistered) {
        return { success: true, txHash: "already-registered" };
      }

      // Get MIN_STAKE from contract
      const minStake = await this.botRegistry.MIN_STAKE();

      // Check current WIND balance for stake
      const balance = await this.getCollateralBalance();
      if (balance < minStake) {
        return {
          success: false,
          error: `Insufficient WIND for stake. Need ${minStake.toString()}, have ${balance.toString()}`,
        };
      }

      // Approve BotRegistry to spend WIND for stake
      const currentAllowance = await this.collateral.allowance(this.wallet.address, this.botRegistryAddress);
      if (currentAllowance < minStake) {
        console.log(`[ChainClient] Approving BotRegistry for stake...`);
        const approveTx = await this.collateral.approve(this.botRegistryAddress, minStake);
        await approveTx.wait();
      }

      // Convert pubkeyHash to bytes32 if needed
      const pubkeyBytes32 = pubkeyHash.startsWith("0x") ? pubkeyHash : `0x${pubkeyHash}`;

      console.log(`[ChainClient] Registering bot with endpoint: ${endpoint}`);
      const tx = await this.botRegistry.registerBot(endpoint, pubkeyBytes32);
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      // Parse common errors
      if (errorMsg.includes("AlreadyRegistered")) {
        return { success: true, txHash: "already-registered" };
      }
      if (errorMsg.includes("InsufficientStake")) {
        return { success: false, error: "Insufficient WIND for 100 token stake" };
      }
      if (errorMsg.includes("EmptyEndpoint")) {
        return { success: false, error: "Endpoint cannot be empty" };
      }
      if (errorMsg.includes("ZeroPubkeyHash")) {
        return { success: false, error: "Pubkey hash cannot be zero" };
      }

      return {
        success: false,
        error: `Bot registration failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Deregister this bot and return stake
   * @returns Transaction result with stake returned
   */
  async deregisterBot(): Promise<TransactionResult> {
    if (!this.botRegistry) {
      return { success: false, error: "BotRegistry not configured - BOT_REGISTRY_ADDRESS not set" };
    }

    try {
      console.log(`[ChainClient] Deregistering bot...`);
      const tx = await this.botRegistry.deregisterBot();
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      if (errorMsg.includes("NotRegistered")) {
        return { success: false, error: "Bot is not registered" };
      }

      return {
        success: false,
        error: `Bot deregistration failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Get bot info from BotRegistry
   * @param address - Address to query (defaults to wallet address)
   * @returns Bot info or null if not found
   */
  async getBotInfo(address?: string): Promise<BotInfo | null> {
    if (!this.botRegistry) {
      console.warn("[ChainClient] BotRegistry not configured - BOT_REGISTRY_ADDRESS not set");
      return null;
    }

    const addr = address || this.wallet.address;
    try {
      const result = await this.botRegistry.getBot(addr);
      return {
        endpoint: result[0],
        pubkeyHash: result[1],
        stakedAmount: result[2],
        registeredAt: result[3],
        isActive: result[4],
      };
    } catch (error) {
      console.error(`[ChainClient] Failed to get bot info: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Get all active bots from BotRegistry
   * Story 2-2: P2P Server & Discovery (Task 4.2)
   *
   * @returns Tuple of [addresses, endpoints] for all active bots
   */
  async getAllActiveBots(): Promise<[string[], string[]]> {
    if (!this.botRegistry) {
      console.warn("[ChainClient] BotRegistry not configured - BOT_REGISTRY_ADDRESS not set");
      return [[], []];
    }

    try {
      const [addresses, endpoints] = await this.botRegistry.getAllActiveBots();
      return [addresses, endpoints];
    } catch (error) {
      console.error(`[ChainClient] Failed to get active bots: ${(error as Error).message}`);
      return [[], []];
    }
  }

  // ============================================================================
  // CollateralVault Methods (Story 2-1)
  // ============================================================================

  /**
   * Check if CollateralVault contract is configured
   * @returns True if COLLATERAL_VAULT_ADDRESS is set
   */
  isCollateralVaultConfigured(): boolean {
    return this.collateralVault !== null;
  }

  /**
   * Deposit WIND tokens to CollateralVault
   * @param amount - Amount in base units (18 decimals for WIND)
   * @returns Transaction result
   */
  async depositToVault(amount: bigint): Promise<TransactionResult> {
    if (!this.collateralVault) {
      return { success: false, error: "CollateralVault not configured - COLLATERAL_VAULT_ADDRESS not set" };
    }

    try {
      // Check WIND balance
      const balance = await this.getCollateralBalance();
      if (balance < amount) {
        return {
          success: false,
          error: `Insufficient WIND. Need ${amount.toString()}, have ${balance.toString()}`,
        };
      }

      // Approve CollateralVault to spend WIND
      const currentAllowance = await this.collateral.allowance(this.wallet.address, this.collateralVaultAddress);
      if (currentAllowance < amount) {
        console.log(`[ChainClient] Approving CollateralVault for deposit...`);
        const approveTx = await this.collateral.approve(this.collateralVaultAddress, amount);
        await approveTx.wait();
      }

      console.log(`[ChainClient] Depositing ${amount.toString()} to CollateralVault...`);
      const tx = await this.collateralVault.deposit(amount);
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      if (errorMsg.includes("ZeroAmount")) {
        return { success: false, error: "Deposit amount cannot be zero" };
      }

      return {
        success: false,
        error: `Vault deposit failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Withdraw available WIND tokens from CollateralVault
   * @param amount - Amount to withdraw in base units (18 decimals)
   * @returns Transaction result
   */
  async withdrawFromVault(amount: bigint): Promise<TransactionResult> {
    if (!this.collateralVault) {
      return { success: false, error: "CollateralVault not configured - COLLATERAL_VAULT_ADDRESS not set" };
    }

    try {
      const { available } = await this.getVaultBalance();
      if (available < amount) {
        return {
          success: false,
          error: `Insufficient available balance. Have ${available.toString()}, requested ${amount.toString()}`,
        };
      }

      console.log(`[ChainClient] Withdrawing ${amount.toString()} from CollateralVault...`);
      const tx = await this.collateralVault.withdraw(amount);
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      if (errorMsg.includes("InsufficientBalance")) {
        return { success: false, error: "Insufficient available balance in vault" };
      }
      if (errorMsg.includes("ZeroAmount")) {
        return { success: false, error: "Withdrawal amount cannot be zero" };
      }

      return {
        success: false,
        error: `Vault withdrawal failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Get vault balance breakdown for an address
   * @param address - Address to query (defaults to wallet address)
   * @returns Vault balance with available, locked, and total
   */
  async getVaultBalance(address?: string): Promise<VaultBalance> {
    if (!this.collateralVault) {
      return { available: BigInt(0), locked: BigInt(0), total: BigInt(0) };
    }

    const addr = address || this.wallet.address;
    try {
      const available = await this.collateralVault.getAvailableBalance(addr);
      const total = await this.collateralVault.getTotalBalance(addr);
      const locked = total - available;
      return { available, locked, total };
    } catch (error) {
      console.error(`[ChainClient] Failed to get vault balance: ${(error as Error).message}`);
      return { available: BigInt(0), locked: BigInt(0), total: BigInt(0) };
    }
  }

  /**
   * Ensure CollateralVault has approval to spend WIND tokens
   * @param amount - Amount to approve
   * @returns Transaction result
   */
  async ensureVaultApproval(amount: bigint): Promise<TransactionResult> {
    if (!this.collateralVault) {
      return { success: false, error: "CollateralVault not configured - COLLATERAL_VAULT_ADDRESS not set" };
    }

    try {
      const currentAllowance = await this.collateral.allowance(this.wallet.address, this.collateralVaultAddress);
      if (currentAllowance >= amount) {
        return { success: true, txHash: "already-approved" };
      }

      // Approve max uint256 for convenience
      const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

      console.log(`[ChainClient] Approving CollateralVault for spending...`);
      const tx = await this.collateral.approve(this.collateralVaultAddress, maxApproval);
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      return {
        success: false,
        error: `Vault approval failed: ${(error as Error).message}`,
      };
    }
  }

  // ============================================================================
  // CollateralVault Bilateral Bet Methods (Story 2-3)
  // ============================================================================

  /**
   * Get nonce from CollateralVault for a user
   * Used for EIP-712 commitment signing
   *
   * Story 2-3 Task 3.3: getVaultNonce implementation
   *
   * @param address - Address to query (defaults to wallet address)
   * @returns Current nonce for the address
   */
  async getVaultNonce(address?: string): Promise<bigint> {
    if (!this.collateralVault) {
      throw new Error("CollateralVault not configured - COLLATERAL_VAULT_ADDRESS not set");
    }
    const addr = address || this.wallet.address;
    return await this.collateralVault.nonces(addr);
  }

  /**
   * Get domain separator from CollateralVault
   * Used for EIP-712 signature verification
   *
   * Story 2-3 Task 3.4: getVaultDomainSeparator implementation
   *
   * @returns Domain separator bytes32
   */
  async getVaultDomainSeparator(): Promise<string> {
    if (!this.collateralVault) {
      throw new Error("CollateralVault not configured - COLLATERAL_VAULT_ADDRESS not set");
    }
    return await this.collateralVault.DOMAIN_SEPARATOR();
  }

  /**
   * Commit a bilateral bet on CollateralVault
   * Both creator and filler must have signed the commitment
   *
   * Story 2-3 Task 3.2: commitBilateralBet implementation
   *
   * @param commitment - The bet commitment data
   * @param creatorSig - Creator's EIP-712 signature
   * @param fillerSig - Filler's EIP-712 signature
   * @returns Transaction result with betId
   */
  async commitBilateralBet(
    commitment: {
      tradesRoot: string;
      creator: string;
      filler: string;
      creatorAmount: bigint;
      fillerAmount: bigint;
      deadline: number;
      nonce: bigint;
      expiry: number;
    },
    creatorSig: string,
    fillerSig: string,
  ): Promise<TransactionResult> {
    if (!this.collateralVault) {
      return { success: false, error: "CollateralVault not configured - COLLATERAL_VAULT_ADDRESS not set" };
    }

    try {
      // Build commitment tuple matching contract struct order
      const commitmentTuple = [
        commitment.tradesRoot,
        commitment.creator,
        commitment.filler,
        commitment.creatorAmount,
        commitment.fillerAmount,
        commitment.deadline,
        commitment.nonce,
        commitment.expiry,
      ];

      console.log(`[ChainClient] Committing bilateral bet: creator=${commitment.creator}, filler=${commitment.filler}`);
      console.log(`[ChainClient] Amounts: creator=${commitment.creatorAmount}, filler=${commitment.fillerAmount}`);

      const tx = await this.collateralVault.commitBet(
        commitmentTuple,
        creatorSig,
        fillerSig
      );
      const receipt = await tx.wait();

      // Extract betId from BetCommitted event
      let betId: string | undefined;
      for (const log of receipt.logs) {
        try {
          const parsed = this.collateralVault!.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed && parsed.name === "BetCommitted") {
            betId = parsed.args[0].toString();
            console.log(`[ChainClient] Bet committed! betId=${betId}`);
            break;
          }
        } catch {
          // Not our event
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

      // Parse common errors from CollateralVault
      if (errorMsg.includes("InvalidSignature")) {
        return { success: false, error: "Invalid signature - check EIP-712 domain and types" };
      }
      if (errorMsg.includes("SignatureExpired")) {
        return { success: false, error: "Commitment signatures have expired" };
      }
      if (errorMsg.includes("InvalidNonce")) {
        return { success: false, error: "Nonce mismatch - refetch nonces and try again" };
      }
      if (errorMsg.includes("InsufficientBalance")) {
        return { success: false, error: "Insufficient available balance in vault" };
      }
      if (errorMsg.includes("SelfBetNotAllowed")) {
        return { success: false, error: "Cannot bet with yourself" };
      }
      if (errorMsg.includes("DeadlineInPast")) {
        return { success: false, error: "Deadline must be in the future" };
      }
      if (errorMsg.includes("ZeroAmount")) {
        return { success: false, error: "Bet amounts cannot be zero" };
      }
      if (errorMsg.includes("ZeroAddress")) {
        return { success: false, error: "Creator or filler address cannot be zero" };
      }

      return {
        success: false,
        error: `commitBilateralBet failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Get the CollateralVault contract address
   */
  getCollateralVaultAddress(): string {
    return this.collateralVaultAddress;
  }

  /**
   * Get the wallet for signing operations
   */
  getWallet(): ethers.Wallet {
    return this.wallet;
  }

  // ============================================================================
  // CollateralVault Settlement Methods (Story 2-4)
  // ============================================================================

  /**
   * Sign a SettlementAgreement using EIP-712
   *
   * Story 2-4 Task 5.2: signSettlementAgreement implementation
   *
   * @param betId - The bet ID to settle
   * @param winner - Address of the winner
   * @param nonce - Nonce for replay protection (auto-fetched if not provided)
   * @param expiry - Signature expiry (default: 1 hour from now)
   * @returns Signed settlement agreement
   */
  async signSettlementAgreement(
    betId: number,
    winner: string,
    nonce?: bigint,
    expiry?: number,
  ): Promise<{ agreement: { betId: number; winner: string; nonce: bigint; expiry: number }; signature: string }> {
    if (!this.collateralVault) {
      throw new Error("CollateralVault not configured - COLLATERAL_VAULT_ADDRESS not set");
    }

    const actualNonce = nonce ?? await this.getVaultNonce();
    const actualExpiry = expiry ?? Math.floor(Date.now() / 1000) + 3600;

    // EIP-712 domain for CollateralVault (different from P2P domain!)
    const domain = {
      name: "CollateralVault",
      version: "1",
      chainId: this.chainId,
      verifyingContract: this.collateralVaultAddress,
    };

    const types = {
      SettlementAgreement: [
        { name: "betId", type: "uint256" },
        { name: "winner", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    };

    const value = {
      betId: BigInt(betId),
      winner,
      nonce: actualNonce,
      expiry: actualExpiry,
    };

    const signature = await this.wallet.signTypedData(domain, types, value);

    return {
      agreement: { betId, winner, nonce: actualNonce, expiry: actualExpiry },
      signature,
    };
  }

  /**
   * Sign a CustomPayoutProposal using EIP-712
   *
   * Story 2-4 Task 5.3: signCustomPayout implementation
   *
   * @param betId - The bet ID to settle
   * @param creatorPayout - Amount to pay creator
   * @param fillerPayout - Amount to pay filler
   * @param nonce - Nonce for replay protection (auto-fetched if not provided)
   * @param expiry - Signature expiry (default: 1 hour from now)
   * @returns Signed custom payout proposal
   */
  async signCustomPayout(
    betId: number,
    creatorPayout: bigint,
    fillerPayout: bigint,
    nonce?: bigint,
    expiry?: number,
  ): Promise<{ proposal: { betId: number; creatorPayout: bigint; fillerPayout: bigint; nonce: bigint; expiry: number }; signature: string }> {
    if (!this.collateralVault) {
      throw new Error("CollateralVault not configured - COLLATERAL_VAULT_ADDRESS not set");
    }

    const actualNonce = nonce ?? await this.getVaultNonce();
    const actualExpiry = expiry ?? Math.floor(Date.now() / 1000) + 3600;

    // EIP-712 domain for CollateralVault
    const domain = {
      name: "CollateralVault",
      version: "1",
      chainId: this.chainId,
      verifyingContract: this.collateralVaultAddress,
    };

    const types = {
      CustomPayoutProposal: [
        { name: "betId", type: "uint256" },
        { name: "creatorPayout", type: "uint256" },
        { name: "fillerPayout", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    };

    const value = {
      betId: BigInt(betId),
      creatorPayout,
      fillerPayout,
      nonce: actualNonce,
      expiry: actualExpiry,
    };

    const signature = await this.wallet.signTypedData(domain, types, value);

    return {
      proposal: { betId, creatorPayout, fillerPayout, nonce: actualNonce, expiry: actualExpiry },
      signature,
    };
  }

  /**
   * Execute settleByAgreement on CollateralVault
   *
   * Story 2-4 Task 5.4: settleByAgreement implementation
   *
   * @param agreement - The settlement agreement
   * @param creatorSig - Creator's EIP-712 signature
   * @param fillerSig - Filler's EIP-712 signature
   * @returns Transaction result
   */
  async settleByAgreementOnChain(
    agreement: { betId: number; winner: string; nonce: bigint; expiry: number },
    creatorSig: string,
    fillerSig: string,
  ): Promise<TransactionResult> {
    if (!this.collateralVault) {
      return { success: false, error: "CollateralVault not configured - COLLATERAL_VAULT_ADDRESS not set" };
    }

    try {
      const agreementTuple = [
        BigInt(agreement.betId),
        agreement.winner,
        agreement.nonce,
        agreement.expiry,
      ];

      console.log(`[ChainClient] Settling bet ${agreement.betId} by agreement, winner: ${agreement.winner}`);

      const tx = await this.collateralVault.settleByAgreement(agreementTuple, creatorSig, fillerSig);
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        betId: agreement.betId.toString(),
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      // Parse common errors
      if (errorMsg.includes("BetNotFound")) {
        return { success: false, error: "Bet not found" };
      }
      if (errorMsg.includes("BetNotActive")) {
        return { success: false, error: "Bet is not active (already settled or in arbitration)" };
      }
      if (errorMsg.includes("DeadlineNotPassed")) {
        return { success: false, error: "Cannot settle before deadline" };
      }
      if (errorMsg.includes("InvalidWinner")) {
        return { success: false, error: "Winner must be creator or filler" };
      }
      if (errorMsg.includes("SignatureExpired")) {
        return { success: false, error: "Signature has expired" };
      }
      if (errorMsg.includes("InvalidNonce")) {
        return { success: false, error: "Invalid nonce - refetch nonces and try again" };
      }
      if (errorMsg.includes("InvalidSignature")) {
        return { success: false, error: "Invalid signature" };
      }

      return {
        success: false,
        error: `settleByAgreement failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Execute customPayout on CollateralVault
   *
   * Story 2-4 Task 5.5: customPayout implementation
   *
   * @param proposal - The custom payout proposal
   * @param creatorSig - Creator's EIP-712 signature
   * @param fillerSig - Filler's EIP-712 signature
   * @returns Transaction result
   */
  async customPayoutOnChain(
    proposal: { betId: number; creatorPayout: bigint; fillerPayout: bigint; nonce: bigint; expiry: number },
    creatorSig: string,
    fillerSig: string,
  ): Promise<TransactionResult> {
    if (!this.collateralVault) {
      return { success: false, error: "CollateralVault not configured - COLLATERAL_VAULT_ADDRESS not set" };
    }

    try {
      const proposalTuple = [
        BigInt(proposal.betId),
        proposal.creatorPayout,
        proposal.fillerPayout,
        proposal.nonce,
        proposal.expiry,
      ];

      console.log(`[ChainClient] Executing custom payout for bet ${proposal.betId}`);
      console.log(`[ChainClient] Creator: ${proposal.creatorPayout}, Filler: ${proposal.fillerPayout}`);

      const tx = await this.collateralVault.customPayout(proposalTuple, creatorSig, fillerSig);
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        betId: proposal.betId.toString(),
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      // Parse common errors
      if (errorMsg.includes("BetNotFound")) {
        return { success: false, error: "Bet not found" };
      }
      if (errorMsg.includes("BetNotActive")) {
        return { success: false, error: "Bet is not active" };
      }
      if (errorMsg.includes("DeadlineNotPassed")) {
        return { success: false, error: "Cannot settle before deadline" };
      }
      if (errorMsg.includes("PayoutMismatch")) {
        return { success: false, error: "Payout amounts must sum to total locked amount" };
      }
      if (errorMsg.includes("SignatureExpired")) {
        return { success: false, error: "Signature has expired" };
      }
      if (errorMsg.includes("InvalidNonce")) {
        return { success: false, error: "Invalid nonce" };
      }
      if (errorMsg.includes("InvalidSignature")) {
        return { success: false, error: "Invalid signature" };
      }

      return {
        success: false,
        error: `customPayout failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Request arbitration for a disputed bet
   *
   * Story 2-4 Task 5.6: requestArbitration implementation
   *
   * @param betId - The bet ID to send to arbitration
   * @returns Transaction result
   */
  async requestArbitrationOnChain(betId: number): Promise<TransactionResult> {
    if (!this.collateralVault) {
      return { success: false, error: "CollateralVault not configured - COLLATERAL_VAULT_ADDRESS not set" };
    }

    try {
      console.log(`[ChainClient] Requesting arbitration for bet ${betId}`);

      const tx = await this.collateralVault.requestArbitration(betId);
      const receipt = await tx.wait();

      return {
        success: true,
        txHash: receipt.hash,
        betId: betId.toString(),
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error) {
      const errorMsg = (error as Error).message;

      if (errorMsg.includes("BetNotFound")) {
        return { success: false, error: "Bet not found" };
      }
      if (errorMsg.includes("BetNotActive")) {
        return { success: false, error: "Bet is not active" };
      }
      if (errorMsg.includes("DeadlineNotPassed")) {
        return { success: false, error: "Cannot request arbitration before deadline" };
      }
      if (errorMsg.includes("NotPartyToBet")) {
        return { success: false, error: "Only creator or filler can request arbitration" };
      }

      return {
        success: false,
        error: `requestArbitration failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Get bet details from CollateralVault
   *
   * @param betId - The bet ID to fetch
   * @returns Bet data or null if not found
   */
  async getBetFromVault(betId: number): Promise<{
    tradesRoot: string;
    creator: string;
    filler: string;
    creatorAmount: bigint;
    fillerAmount: bigint;
    deadline: number;
    createdAt: number;
    status: number;
  } | null> {
    if (!this.collateralVault) {
      return null;
    }

    try {
      const result = await this.collateralVault.bets(betId);
      return {
        tradesRoot: result[0],
        creator: result[1],
        filler: result[2],
        creatorAmount: result[3],
        fillerAmount: result[4],
        deadline: Number(result[5]),
        createdAt: Number(result[6]),
        status: Number(result[7]),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get bet status from CollateralVault
   *
   * @param betId - The bet ID to check
   * @returns Bet status (0=None, 1=Active, 2=Settled, 3=CustomPayout, 4=InArbitration, 5=ArbitrationSettled)
   */
  async getBetStatusFromVault(betId: number): Promise<number> {
    const bet = await this.getBetFromVault(betId);
    return bet?.status ?? 0;
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
    botRegistryAddress: process.env.BOT_REGISTRY_ADDRESS,           // Story 2-1
    collateralVaultAddress: process.env.COLLATERAL_VAULT_ADDRESS,   // Story 2-1
    rpcUrl: process.env.RPC_URL,
    chainId: parseInt(process.env.CHAIN_ID || "") || undefined,
    backendUrl: process.env.BACKEND_URL,
  });
}
