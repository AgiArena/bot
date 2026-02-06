/**
 * P2P Message Types and EIP-712 Schemas
 *
 * Story 2-2: P2P Server & Discovery
 * Task 5: Create P2P types and EIP-712 schemas
 *
 * Defines message types for bot-to-bot communication:
 * - TradeProposal: Signed proposal from creator to potential filler
 * - TradeAcceptance: Signed acceptance from filler
 * - PeerInfo: Discovered peer metadata from BotRegistry
 */

// ============================================================================
// EIP-712 Domain for P2P Messages
// ============================================================================

/** Chain ID for Index L3 (Orbit) */
export const P2P_CHAIN_ID = 111222333;

/**
 * EIP-712 domain separator for P2P off-chain messages.
 * Note: No verifyingContract since these are purely off-chain messages
 * that don't require contract verification.
 */
export const P2P_DOMAIN = {
  name: "AgiArenaP2P",
  version: "1",
  chainId: P2P_CHAIN_ID,
} as const;

/**
 * EIP-712 type definitions for TradeProposal
 */
export const TRADE_PROPOSAL_TYPES = {
  TradeProposal: [
    { name: "creator", type: "address" },
    { name: "tradesHash", type: "bytes32" },
    { name: "snapshotId", type: "string" },
    { name: "creatorStake", type: "uint256" },
    { name: "oddsBps", type: "uint32" },
    { name: "resolutionDeadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

/**
 * EIP-712 type definitions for TradeAcceptance
 */
export const TRADE_ACCEPTANCE_TYPES = {
  TradeAcceptance: [
    { name: "proposalHash", type: "bytes32" },
    { name: "filler", type: "address" },
    { name: "fillAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

// ============================================================================
// Trade Proposal Types
// ============================================================================

/**
 * Trade proposal from creator to potential filler.
 * Represents an offer to bet on a specific trade set.
 */
export interface TradeProposal {
  /** Proposing bot's address */
  creator: string;
  /** keccak256(snapshotId, positionBitmap) - identifies the trade set */
  tradesHash: string;
  /** Snapshot reference (e.g., "crypto-2026-01-28-18") */
  snapshotId: string;
  /** Creator's stake amount in wei (18 decimals for WIND) */
  creatorStake: bigint;
  /** Odds in basis points (10000 = 1.0x, 20000 = 2.0x) */
  oddsBps: number;
  /** Unix timestamp when bet can be resolved */
  resolutionDeadline: number;
  /** Creator's nonce from BotRegistry for replay protection */
  nonce: bigint;
  /** Signature expiry timestamp (Unix seconds) */
  expiry: number;
  /** EIP-712 signature from creator */
  signature: string;
}

/**
 * Data needed to construct a TradeProposal (before signing)
 */
export interface TradeProposalData {
  creator: string;
  tradesHash: string;
  snapshotId: string;
  creatorStake: bigint;
  oddsBps: number;
  resolutionDeadline: number;
  nonce: bigint;
  expiry: number;
}

/**
 * Computed required match amount based on odds.
 * requiredMatch = (creatorStake * 10000) / oddsBps
 */
export function computeRequiredMatch(creatorStake: bigint, oddsBps: number): bigint {
  return (creatorStake * BigInt(10000)) / BigInt(oddsBps);
}

// ============================================================================
// Trade Acceptance Types
// ============================================================================

/**
 * Trade acceptance from filler.
 * Represents agreement to take the opposite side of a proposal.
 */
export interface TradeAcceptance {
  /** keccak256 hash of the TradeProposal */
  proposalHash: string;
  /** Accepting bot's address */
  filler: string;
  /** Exact fill amount in wei (must equal requiredMatch) */
  fillAmount: bigint;
  /** Filler's nonce for replay protection */
  nonce: bigint;
  /** Signature expiry timestamp */
  expiry: number;
  /** EIP-712 signature from filler */
  signature: string;
}

/**
 * Data needed to construct a TradeAcceptance (before signing)
 */
export interface TradeAcceptanceData {
  proposalHash: string;
  filler: string;
  fillAmount: bigint;
  nonce: bigint;
  expiry: number;
}

// ============================================================================
// Peer Discovery Types
// ============================================================================

/**
 * Peer information from BotRegistry discovery.
 */
export interface PeerInfo {
  /** Bot's Ethereum address */
  address: string;
  /** P2P HTTP endpoint URL (e.g., "http://192.168.1.100:8080") */
  endpoint: string;
  /** keccak256 of bot's signing public key */
  pubkeyHash: string;
  /** Whether the peer is currently reachable */
  isHealthy: boolean;
  /** Timestamp of last health check */
  lastChecked: number;
  /** Staked amount in wei (for ranking peers by commitment) */
  stakedAmount?: bigint;
}

/**
 * Health check response from /p2p/health endpoint
 */
export interface P2PHealthResponse {
  /** Always "healthy" if responding */
  status: "healthy";
  /** Current Unix timestamp */
  timestamp: number;
  /** Server uptime in seconds */
  uptime: number;
}

/**
 * Info response from /p2p/info endpoint
 */
export interface P2PInfoResponse {
  /** Bot's Ethereum address */
  address: string;
  /** Public endpoint URL */
  endpoint: string;
  /** keccak256 of signing public key */
  pubkeyHash: string;
  /** P2P protocol version */
  version: string;
  /** Server uptime in seconds */
  uptime: number;
}

// ============================================================================
// P2P Server Response Types
// ============================================================================

/**
 * Response to /p2p/propose endpoint
 */
export interface ProposeResponse {
  /** Confirmation that proposal was received */
  received: true;
  /** Hash of the received proposal for tracking */
  proposalHash: string;
  /** Human-readable status message */
  message?: string;
}

/**
 * Response to /p2p/accept endpoint
 */
export interface AcceptResponse {
  /** Confirmation that acceptance was received */
  received: true;
  /** Hash of the acceptance for tracking */
  acceptanceHash: string;
  /** Human-readable status message */
  message?: string;
}

/**
 * Error response from P2P endpoints
 */
export interface P2PErrorResponse {
  /** Error indicator */
  error: true;
  /** Error message */
  message: string;
  /** Error code for programmatic handling */
  code?: string;
}

// ============================================================================
// P2P Server Configuration
// ============================================================================

/**
 * Configuration for P2P HTTP server
 */
export interface P2PServerConfig {
  /** Port to listen on */
  port: number;
  /** Public endpoint URL (for advertising to peers) */
  endpoint: string;
  /** Bot's Ethereum address */
  address: string;
  /** keccak256 of signing public key */
  pubkeyHash: string;
  /** Rate limit: max requests per second per IP */
  rateLimitPerSecond?: number;
  /** Server start time for uptime calculation */
  startTime?: number;
}

/**
 * P2P server instance handle
 */
export interface P2PServerHandle {
  /** Stop the server */
  stop: () => void;
  /** Server port */
  port: number;
  /** Server hostname */
  hostname: string;
}

// ============================================================================
// P2P Transport Configuration
// ============================================================================

/**
 * Configuration for P2P HTTP transport (outbound calls)
 */
export interface P2PTransportConfig {
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds */
  maxDelayMs?: number;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Default transport configuration
 */
export const DEFAULT_TRANSPORT_CONFIG: Required<P2PTransportConfig> = {
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 2000,
  timeoutMs: 5000,
};

// ============================================================================
// P2P Discovery Configuration
// ============================================================================

/**
 * Configuration for P2P peer discovery
 */
export interface P2PDiscoveryConfig {
  /** Cache TTL in milliseconds (default: 60000 = 60s) */
  cacheTtlMs?: number;
  /** Health check timeout in milliseconds */
  healthCheckTimeoutMs?: number;
  /** Maximum concurrent health checks */
  maxConcurrentHealthChecks?: number;
}

/**
 * Default discovery configuration
 */
export const DEFAULT_DISCOVERY_CONFIG: Required<P2PDiscoveryConfig> = {
  cacheTtlMs: 60_000, // 60 seconds
  healthCheckTimeoutMs: 5_000, // 5 seconds
  maxConcurrentHealthChecks: 10,
};

// ============================================================================
// Handler Types (for server extensibility)
// ============================================================================

/**
 * Handler for incoming trade proposals
 */
export type ProposalHandler = (proposal: TradeProposal) => Promise<void>;

/**
 * Handler for incoming trade acceptances
 */
export type AcceptanceHandler = (acceptance: TradeAcceptance) => Promise<void>;

/**
 * Handlers collection for P2P server
 */
export interface P2PHandlers {
  /** Called when a valid proposal is received */
  onProposal?: ProposalHandler;
  /** Called when a valid acceptance is received */
  onAcceptance?: AcceptanceHandler;
  /** Called when a commitment sign request is received (Story 2-3) */
  onCommitmentSignRequest?: CommitmentSignHandler;
  /** Called when trades are received (Story 2-3) */
  onTradesReceived?: TradesReceivedHandler;
  /** Called when a settlement proposal is received (Story 2-4) */
  onSettlementProposal?: SettlementProposalHandler;
  /** Called when a bilateral trade proposal is received (Story 4-3) */
  onBilateralProposal?: BilateralProposalHandler;
  /** Called when maker notifies us that a bet was committed on-chain */
  onBetCommitted?: BetCommittedHandler;
}

// ============================================================================
// Story 2-3: Bet Commitment Types
// ============================================================================

/**
 * EIP-712 type definitions for CommitmentSignRequest
 */
export const COMMITMENT_SIGN_REQUEST_TYPES = {
  CommitmentSignRequest: [
    { name: "commitmentHash", type: "bytes32" },
    { name: "requester", type: "address" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

/**
 * Request for counterparty to sign bet commitment
 * Story 2-3 Task 4.4: CommitmentSignRequest type
 */
export interface CommitmentSignRequest {
  /** The commitment data to sign */
  commitment: BetCommitmentForRequest;
  /** Requester's signature (so counterparty knows commitment is genuine) */
  requesterSignature: string;
  /** Expiry for this request (Unix seconds) */
  expiry: number;
}

/**
 * Bet commitment data for P2P request
 */
export interface BetCommitmentForRequest {
  tradesRoot: string;
  creator: string;
  filler: string;
  creatorAmount: bigint;
  fillerAmount: bigint;
  deadline: number;
  nonce: bigint;
  expiry: number;
}

/**
 * Response with commitment signature
 * Story 2-3 Task 4.4: CommitmentSignResponse type
 */
export interface CommitmentSignResponse {
  /** Whether signing was accepted */
  accepted: boolean;
  /** Counterparty's signature (if accepted) */
  signature?: string;
  /** Rejection reason (if not accepted) */
  reason?: string;
}

/**
 * Handler for commitment sign requests
 */
export type CommitmentSignHandler = (
  request: CommitmentSignRequest
) => Promise<CommitmentSignResponse>;

/**
 * Trade data with Merkle proof for P2P sharing
 * Story 2-3 Task 4.2
 */
export interface TradeWithProof {
  tradeId: string;
  ticker: string;
  source: string;
  method: string;
  position: 0 | 1;
  entryPrice: bigint;
  exitPrice: bigint;
  won: boolean;
  cancelled: boolean;
  /** Merkle proof for this trade */
  proof: {
    index: number;
    siblings: string[];
  };
}

/**
 * Request to store trades (POST /p2p/trades)
 * Story 2-3 Task 4.1
 */
export interface TradesStoreRequest {
  /** The bet ID these trades belong to */
  betId: number;
  /** Serialized MerkleTree JSON */
  tree: string;
  /** Signature from bet participant */
  signature: string;
  /** Signer address */
  signer: string;
}

/**
 * Response to trade store request
 */
export interface TradesStoreResponse {
  received: boolean;
  betId: number;
}

/**
 * Response for trade fetch request (GET /p2p/trades/:betId)
 * Story 2-3 Task 4.2
 */
export interface TradesFetchResponse {
  betId: number;
  snapshotId: string;
  root: string;
  trades: TradeWithProof[];
}

/**
 * Handler for trades received
 */
export type TradesReceivedHandler = (
  betId: number,
  tree: string,
  signer: string
) => Promise<void>;

// ============================================================================
// Story 2-4: Settlement Proposal Types
// ============================================================================

/**
 * EIP-712 domain for CollateralVault settlement
 * IMPORTANT: Different from P2P_DOMAIN - uses contract verification
 *
 * Story 2-4 Task 2.3: EIP-712 domain for SettlementAgreement
 */
export function getCollateralVaultDomain(chainId: number, vaultAddress: string) {
  return {
    name: "CollateralVault",
    version: "1",
    chainId,
    verifyingContract: vaultAddress,
  };
}

/**
 * EIP-712 types for SettlementAgreement (matching CollateralVault.sol)
 *
 * Story 2-4 Task 2.3: EIP-712 types for SettlementAgreement
 */
export const SETTLEMENT_AGREEMENT_TYPES = {
  SettlementAgreement: [
    { name: "betId", type: "uint256" },
    { name: "winner", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

/**
 * EIP-712 types for CustomPayoutProposal (matching CollateralVault.sol)
 *
 * Story 2-4 Task 2.4: EIP-712 types for CustomPayoutProposal
 */
export const CUSTOM_PAYOUT_TYPES = {
  CustomPayoutProposal: [
    { name: "betId", type: "uint256" },
    { name: "creatorPayout", type: "uint256" },
    { name: "fillerPayout", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

/**
 * EIP-712 types for SettlementProposal (P2P off-chain)
 *
 * Story 2-4 Task 2.1: SettlementProposal P2P types
 */
export const SETTLEMENT_PROPOSAL_TYPES = {
  SettlementProposal: [
    { name: "betId", type: "uint256" },
    { name: "winner", type: "address" },
    { name: "winsCount", type: "uint256" },
    { name: "validTrades", type: "uint256" },
    { name: "isTie", type: "bool" },
    { name: "expiry", type: "uint256" },
    { name: "settlementNonce", type: "uint256" },
  ],
} as const;

/**
 * Settlement proposal exchanged via P2P
 *
 * Story 2-4 Task 2.1: SettlementProposal interface
 */
export interface SettlementProposal {
  /** The bet being settled */
  betId: number;
  /** Proposed winner address */
  winner: string;
  /** Number of trades won by creator */
  winsCount: number;
  /** Total valid trades (non-cancelled) */
  validTrades: number;
  /** Is this an exact tie? */
  isTie: boolean;
  /** Proposer's address */
  proposer: string;
  /** EIP-712 signature of outcome hash */
  signature: string;
  /** Proposal expiry */
  expiry: number;
  /** Agreed nonce for settlement signing (both parties must use same nonce) */
  settlementNonce: bigint;
  /** Hash of exit prices used (for validation) */
  exitPricesHash?: string;
}

/**
 * Response to settlement proposal
 *
 * Story 2-4 Task 2.2: SettlementProposalResponse interface
 */
export interface SettlementProposalResponse {
  /** Agreement status */
  status: "agree" | "disagree" | "counter";
  /** Our computed outcome (if disagree) */
  ourOutcome?: {
    winner: string;
    winsCount: number;
    validTrades: number;
  };
  /** Counter proposal for custom payout (if counter) */
  counterProposal?: {
    creatorPayout: bigint;
    fillerPayout: bigint;
  };
  /** EIP-712 signature of agreed outcome (if agree) */
  signature?: string;
}

/**
 * Handler for settlement proposals
 *
 * Story 2-4 Task 2.5: SettlementProposalHandler type
 */
export type SettlementProposalHandler = (
  proposal: SettlementProposal
) => Promise<SettlementProposalResponse>;

/**
 * Settlement agreement for on-chain settlement (matches CollateralVault.sol)
 */
export interface SettlementAgreement {
  betId: number;
  winner: string;
  nonce: bigint;
  expiry: number;
}

/**
 * Custom payout proposal for on-chain settlement (matches CollateralVault.sol)
 */
export interface CustomPayoutProposal {
  betId: number;
  creatorPayout: bigint;
  fillerPayout: bigint;
  nonce: bigint;
  expiry: number;
}

/**
 * Signed settlement agreement
 */
export interface SignedSettlementAgreement {
  agreement: SettlementAgreement;
  signature: string;
}

/**
 * Signed custom payout proposal
 */
export interface SignedCustomPayout {
  proposal: CustomPayoutProposal;
  signature: string;
}

/**
 * Vault bet data from CollateralVault
 */
export interface VaultBet {
  tradesRoot: string;
  creator: string;
  filler: string;
  creatorAmount: bigint;
  fillerAmount: bigint;
  deadline: number;
  createdAt: number;
  status: BetStatus;
}

/**
 * Bet status enum matching CollateralVault.sol
 */
export enum BetStatus {
  None = 0,
  Active = 1,
  Settled = 2,
  CustomPayout = 3,
  InArbitration = 4,
  ArbitrationSettled = 5,
}

/**
 * Settlement result
 */
export interface SettlementResult {
  success: boolean;
  txHash?: string;
  error?: string;
  settlementType?: "agreement" | "customPayout" | "arbitration";
}

// ============================================================================
// Bilateral Trading Types (Story 4-3)
// ============================================================================

/**
 * Compressed trades payload for large portfolios
 */
export interface CompressedTradesPayload {
  /** Base64-encoded gzipped compact trades */
  compressed: string;
  /** Original size in bytes */
  originalSize: number;
  /** Compressed size in bytes */
  compressedSize: number;
  /** Number of trades */
  count: number;
}

/**
 * Bilateral trade proposal (simplified format for auto-trading)
 */
export interface BilateralTradeProposal {
  /** Merkle root of trades */
  tradesRoot: string;
  /** Proposing bot's address */
  creator: string;
  /** Creator's stake amount */
  creatorAmount: bigint | string;
  /** Filler's stake amount */
  fillerAmount: bigint | string;
  /** Resolution deadline (Unix timestamp) */
  deadline: number;
  /** Nonce for replay protection */
  nonce: bigint | string;
  /** Signature expiry (Unix timestamp) */
  expiry: number;
  /** Creator's EIP-712 signature on the commitment */
  creatorSignature: string;
  /** Trade details (legacy - uncompressed) */
  trades?: Array<{
    tradeId: string;
    ticker: string;
    source: string;
    method: string;
    position: 0 | 1;
    entryPrice: string;
  }>;
  /** Compressed trades (preferred for large portfolios) */
  compressedTrades?: CompressedTradesPayload;
  /** Snapshot ID reference */
  snapshotId?: string;
}

/**
 * Response to bilateral proposal
 */
export interface BilateralProposalResponse {
  /** Whether the proposal was accepted */
  accepted: boolean;
  /** Filler's signature (if accepted) */
  signature?: string;
  /** Signer address */
  signer?: string;
  /** Rejection reason (if not accepted) */
  reason?: string;
}

/**
 * Handler for bilateral trade proposals
 */
export type BilateralProposalHandler = (
  proposal: BilateralTradeProposal,
  from: string
) => Promise<BilateralProposalResponse>;

/**
 * Notification that a bet was committed on-chain
 */
export interface BetCommittedNotification {
  betId: number;
  tradesRoot: string;
  creator: string;
  filler: string;
  deadline: number;
  /** Trade details (legacy - uncompressed) */
  trades?: Array<{
    tradeId: string;
    ticker: string;
    source: string;
    method: string;
    position: 0 | 1;
    entryPrice: string;
  }>;
  /** Compressed trades (preferred for large portfolios) */
  compressedTrades?: CompressedTradesPayload;
  /** Snapshot ID for decompression */
  snapshotId?: string;
}

/**
 * Handler for bet committed notifications
 */
export type BetCommittedHandler = (
  notification: BetCommittedNotification
) => Promise<{ acknowledged: boolean }>;
