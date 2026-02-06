/**
 * P2P Module - Bot-to-Bot Communication Layer
 *
 * Story 2-2: P2P Server & Discovery
 * Story 2-3: Merkle Tree & Bet Commitment
 *
 * Re-exports all P2P components:
 * - Types and EIP-712 schemas
 * - HTTP Server for inbound requests
 * - Discovery for peer enumeration
 * - Transport for outbound requests
 * - Commitment signing and verification (Story 2-3)
 * - Trade storage and sharing (Story 2-3)
 * - Bet coordination (Story 2-3)
 */

// Types and constants
export {
  // EIP-712 constants
  P2P_CHAIN_ID,
  P2P_DOMAIN,
  TRADE_PROPOSAL_TYPES,
  TRADE_ACCEPTANCE_TYPES,
  COMMITMENT_SIGN_REQUEST_TYPES,

  // Types
  type TradeProposal,
  type TradeProposalData,
  type TradeAcceptance,
  type TradeAcceptanceData,
  type PeerInfo,
  type P2PHealthResponse,
  type P2PInfoResponse,
  type ProposeResponse,
  type AcceptResponse,
  type P2PErrorResponse,
  type P2PServerConfig,
  type P2PServerHandle,
  type P2PTransportConfig,
  type P2PDiscoveryConfig,
  type ProposalHandler,
  type AcceptanceHandler,
  type P2PHandlers,

  // Story 2-3 types
  type CommitmentSignRequest,
  type CommitmentSignResponse,
  type CommitmentSignHandler,
  type BetCommitmentForRequest,
  type TradesStoreRequest,
  type TradesStoreResponse,
  type TradesFetchResponse,
  type TradeWithProof,
  type TradesReceivedHandler,

  // Utilities
  computeRequiredMatch,
  DEFAULT_TRANSPORT_CONFIG,
  DEFAULT_DISCOVERY_CONFIG,
} from "./types";

// Server
export {
  startP2PServer,
  createP2PServerConfigFromEnv,
  validateProposalSignature,
  validateAcceptanceSignature,
  computeProposalHash,
  computeAcceptanceHash,
} from "./server";

// Discovery
export {
  PeerDiscovery,
  createPeerDiscoveryFromEnv,
} from "./discovery";

// Transport
export {
  P2PTransport,
  P2PTransportError,
  type TransportResult,
  createDefaultTransport,
  createTransportFromEnv,
} from "./transport";

// Story 2-3: Trade Storage
export {
  storeMerkleTree,
  loadMerkleTree,
  hasMerkleTree,
  deleteMerkleTree,
  listStoredBets,
  // Async versions (preferred for production)
  storeMerkleTreeAsync,
  loadMerkleTreeAsync,
  deleteMerkleTreeAsync,
  // Cleanup utilities
  cleanupOldTrees,
  getStorageStats,
} from "./trade-storage";

// Story 2-3: Commitment Module
export {
  createBetCommitment,
  createBetCommitmentDirect,
  signBetCommitment,
  verifyBetCommitmentSignature,
  recoverCommitmentSigner,
  computeCommitmentHash,
  isCommitmentExpired,
  isDeadlineInPast,
  BilateralBetBuilder,
  getCollateralVaultDomain,
  BET_COMMITMENT_TYPES,
  type BetCommitmentData,
  type SignedBetCommitment,
  type CreateCommitmentParams,
} from "./commitment";

// Story 2-3: Bet Coordinator
export {
  BetCoordinator,
  createBetCoordinatorFromEnv,
  type CommitmentResult,
  type BetCommittedEvent,
  type BetCommittedHandler,
} from "./bet-coordinator";
