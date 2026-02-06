/**
 * P2P HTTP Server Module
 *
 * Story 2-2: P2P Server & Discovery
 * Task 1: Create P2P HTTP Server module
 *
 * Implements P2P endpoints using Bun's native HTTP server:
 * - GET /p2p/info - Returns bot address, endpoint, pubkey, version
 * - GET /p2p/health - Returns health status and uptime
 * - POST /p2p/propose - Receive and validate signed trade proposals
 * - POST /p2p/accept - Receive and validate signed acceptances
 *
 * Features:
 * - EIP-712 signature validation for all signed messages
 * - IP-based rate limiting (configurable, default 10 req/s)
 */

import { serve, type Server } from "bun";
import { ethers } from "ethers";
import {
  type TradeProposal,
  type TradeAcceptance,
  type P2PServerConfig,
  type P2PServerHandle,
  type P2PInfoResponse,
  type P2PHealthResponse,
  type ProposeResponse,
  type AcceptResponse,
  type P2PErrorResponse,
  type P2PHandlers,
  type CommitmentSignRequest,
  type CommitmentSignResponse,
  type TradesStoreRequest,
  type TradesStoreResponse,
  type TradesFetchResponse,
  type SettlementProposal,
  type SettlementProposalResponse,
  type SettlementProposalHandler,
  type BilateralTradeProposal,
  type BilateralProposalResponse,
  type BetCommittedNotification,
  P2P_DOMAIN,
  TRADE_PROPOSAL_TYPES,
  TRADE_ACCEPTANCE_TYPES,
  SETTLEMENT_PROPOSAL_TYPES,
} from "./types";
import { loadMerkleTree, storeMerkleTree } from "./trade-storage";
import { generateProof, deserializeTree } from "../merkle-tree";

/** P2P protocol version */
const P2P_VERSION = "1.0.0";

/** Default rate limit: requests per second per IP */
const DEFAULT_RATE_LIMIT_PER_SECOND = 10;

/**
 * Simple in-memory rate limiter using sliding window
 */
class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequestsPerSecond: number) {
    this.maxRequests = maxRequestsPerSecond;
    this.windowMs = 1000; // 1 second window
  }

  /**
   * Check if request is allowed and record it
   * @param ip - Client IP address
   * @returns true if allowed, false if rate limited
   */
  isAllowed(ip: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Get or create request history for this IP
    let history = this.requests.get(ip);
    if (!history) {
      history = [];
      this.requests.set(ip, history);
    }

    // Remove old requests outside the window
    const filtered = history.filter(ts => ts > windowStart);
    this.requests.set(ip, filtered);

    // Check if under limit
    if (filtered.length >= this.maxRequests) {
      return false;
    }

    // Record this request
    filtered.push(now);
    return true;
  }

  /**
   * Clean up old entries periodically
   */
  cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    for (const [ip, history] of this.requests.entries()) {
      const filtered = history.filter(ts => ts > windowStart);
      if (filtered.length === 0) {
        this.requests.delete(ip);
      } else {
        this.requests.set(ip, filtered);
      }
    }
  }
}

/**
 * Validate EIP-712 signature for a TradeProposal
 * @returns Recovered signer address or null if invalid
 */
function validateProposalSignature(proposal: TradeProposal): string | null {
  try {
    const { signature, ...proposalData } = proposal;

    // Reconstruct the data to sign
    const value = {
      creator: proposalData.creator,
      tradesHash: proposalData.tradesHash,
      snapshotId: proposalData.snapshotId,
      creatorStake: proposalData.creatorStake,
      oddsBps: proposalData.oddsBps,
      resolutionDeadline: proposalData.resolutionDeadline,
      nonce: proposalData.nonce,
      expiry: proposalData.expiry,
    };

    // Recover signer
    const recoveredAddress = ethers.verifyTypedData(
      P2P_DOMAIN,
      TRADE_PROPOSAL_TYPES,
      value,
      signature
    );

    return recoveredAddress;
  } catch (error) {
    console.error("[P2P Server] Signature validation error:", error);
    return null;
  }
}

/**
 * Validate EIP-712 signature for a TradeAcceptance
 * @returns Recovered signer address or null if invalid
 */
function validateAcceptanceSignature(acceptance: TradeAcceptance): string | null {
  try {
    const { signature, ...acceptanceData } = acceptance;

    // Reconstruct the data to sign
    const value = {
      proposalHash: acceptanceData.proposalHash,
      filler: acceptanceData.filler,
      fillAmount: acceptanceData.fillAmount,
      nonce: acceptanceData.nonce,
      expiry: acceptanceData.expiry,
    };

    // Recover signer
    const recoveredAddress = ethers.verifyTypedData(
      P2P_DOMAIN,
      TRADE_ACCEPTANCE_TYPES,
      value,
      signature
    );

    return recoveredAddress;
  } catch (error) {
    console.error("[P2P Server] Acceptance signature validation error:", error);
    return null;
  }
}

/**
 * Compute hash of a proposal for tracking
 */
function computeProposalHash(proposal: TradeProposal): string {
  const encoded = ethers.solidityPackedKeccak256(
    ['address', 'bytes32', 'string', 'uint256', 'uint32', 'uint256', 'uint256', 'uint256'],
    [
      proposal.creator,
      proposal.tradesHash,
      proposal.snapshotId,
      proposal.creatorStake,
      proposal.oddsBps,
      proposal.resolutionDeadline,
      proposal.nonce,
      proposal.expiry,
    ]
  );
  return encoded;
}

/**
 * Compute hash of an acceptance for tracking
 */
function computeAcceptanceHash(acceptance: TradeAcceptance): string {
  const encoded = ethers.solidityPackedKeccak256(
    ['bytes32', 'address', 'uint256', 'uint256', 'uint256'],
    [
      acceptance.proposalHash,
      acceptance.filler,
      acceptance.fillAmount,
      acceptance.nonce,
      acceptance.expiry,
    ]
  );
  return encoded;
}

/**
 * Parse JSON body from request
 */
async function parseJsonBody<T>(req: Request): Promise<T | null> {
  try {
    const text = await req.text();
    return JSON.parse(text, (key, value) => {
      // Convert string numbers to bigint for stake/amount/nonce fields
      if (
        (key === 'creatorStake' || key === 'fillAmount' || key === 'nonce' || key === 'settlementNonce') &&
        typeof value === 'string'
      ) {
        return BigInt(value);
      }
      return value;
    }) as T;
  } catch {
    return null;
  }
}

/**
 * Get client IP from request
 */
function getClientIp(req: Request): string {
  // Try X-Forwarded-For header first (for proxied requests)
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  // Try X-Real-IP header
  const realIp = req.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }

  // Default to 'local' for direct connections
  // Note: In Bun, we can't easily get the socket IP from the fetch handler
  return 'local';
}

/**
 * Create JSON response with proper headers
 */
function jsonResponse<T extends object>(data: T, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

/**
 * Create error response
 */
function errorResponse(message: string, status = 400, code?: string): Response {
  const body: P2PErrorResponse = { error: true, message };
  if (code) body.code = code;
  return jsonResponse(body, status);
}

/**
 * Start P2P HTTP server
 *
 * @param config - Server configuration
 * @param handlers - Optional handlers for proposals and acceptances
 * @returns Server handle for stopping
 */
export function startP2PServer(
  config: P2PServerConfig,
  handlers?: P2PHandlers
): P2PServerHandle {
  const startTime = config.startTime ?? Date.now();
  const rateLimiter = new RateLimiter(config.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT_PER_SECOND);

  // Cleanup rate limiter every 10 seconds
  const cleanupInterval = setInterval(() => rateLimiter.cleanup(), 10_000);

  const server = serve({
    port: config.port,
    fetch: async (req) => {
      const url = new URL(req.url);
      const clientIp = getClientIp(req);

      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      }

      // Rate limiting check
      if (!rateLimiter.isAllowed(clientIp)) {
        return errorResponse('Rate limit exceeded', 429, 'RATE_LIMIT');
      }

      // ================================================================
      // GET /p2p/info
      // ================================================================
      if (url.pathname === '/p2p/info' && req.method === 'GET') {
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const response: P2PInfoResponse = {
          address: config.address,
          endpoint: config.endpoint,
          pubkeyHash: config.pubkeyHash,
          version: P2P_VERSION,
          uptime,
        };
        return jsonResponse(response);
      }

      // ================================================================
      // GET /p2p/health
      // ================================================================
      if (url.pathname === '/p2p/health' && req.method === 'GET') {
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const response: P2PHealthResponse = {
          status: 'healthy',
          timestamp: Math.floor(Date.now() / 1000),
          uptime,
        };
        return jsonResponse(response);
      }

      // ================================================================
      // POST /p2p/propose
      // ================================================================
      if (url.pathname === '/p2p/propose' && req.method === 'POST') {
        // Parse body
        const proposal = await parseJsonBody<TradeProposal>(req);
        if (!proposal) {
          return errorResponse('Invalid JSON body', 400, 'INVALID_JSON');
        }

        // Validate required fields
        if (!proposal.creator || !proposal.tradesHash || !proposal.signature) {
          return errorResponse('Missing required fields', 400, 'MISSING_FIELDS');
        }

        // Check expiry
        const now = Math.floor(Date.now() / 1000);
        if (proposal.expiry <= now) {
          return errorResponse('Proposal has expired', 400, 'EXPIRED');
        }

        // Validate signature
        const recoveredSigner = validateProposalSignature(proposal);
        if (!recoveredSigner) {
          return errorResponse('Invalid signature', 401, 'INVALID_SIGNATURE');
        }

        // Verify signer matches creator
        if (recoveredSigner.toLowerCase() !== proposal.creator.toLowerCase()) {
          return errorResponse(
            'Signature does not match creator',
            401,
            'SIGNER_MISMATCH'
          );
        }

        // Compute proposal hash
        const proposalHash = computeProposalHash(proposal);

        // Call handler if provided
        if (handlers?.onProposal) {
          try {
            await handlers.onProposal(proposal);
          } catch (error) {
            console.error('[P2P Server] Proposal handler error:', error);
            // Continue - handler errors shouldn't fail the response
          }
        }

        const response: ProposeResponse = {
          received: true,
          proposalHash,
          message: 'Proposal received and validated',
        };
        return jsonResponse(response);
      }

      // ================================================================
      // POST /p2p/proposal - Bilateral trade proposal (Story 4-3)
      // ================================================================
      if (url.pathname === '/p2p/proposal' && req.method === 'POST') {
        // Parse body - bilateral proposals use different format
        const proposal = await parseJsonBody<BilateralTradeProposal>(req);
        if (!proposal) {
          return errorResponse('Invalid JSON body', 400, 'INVALID_JSON');
        }

        // Validate required fields
        if (!proposal.creator || !proposal.tradesRoot || !proposal.creatorSignature) {
          return errorResponse('Missing required fields', 400, 'MISSING_FIELDS');
        }

        // Check expiry
        const now = Math.floor(Date.now() / 1000);
        if (proposal.expiry <= now) {
          return errorResponse('Proposal has expired', 400, 'EXPIRED');
        }

        // Get sender address from proposal (we trust the creator field)
        const from = proposal.creator.toLowerCase();

        // Call handler if provided
        if (handlers?.onBilateralProposal) {
          try {
            const result = await handlers.onBilateralProposal(proposal, from);
            return jsonResponse<BilateralProposalResponse>(result);
          } catch (error) {
            console.error('[P2P Server] Bilateral proposal handler error:', error);
            return jsonResponse<BilateralProposalResponse>({
              accepted: false,
              reason: 'Internal error processing proposal',
            });
          }
        }

        // No handler - reject by default
        return jsonResponse<BilateralProposalResponse>({
          accepted: false,
          reason: 'No bilateral proposal handler configured',
        });
      }

      // ================================================================
      // POST /p2p/bet-committed - Notification that bet was committed (Story 4-3)
      // ================================================================
      if (url.pathname === '/p2p/bet-committed' && req.method === 'POST') {
        const notification = await parseJsonBody<BetCommittedNotification>(req);
        if (!notification) {
          return errorResponse('Invalid JSON body', 400, 'INVALID_JSON');
        }

        if (!notification.betId || !notification.tradesRoot || !notification.creator || !notification.filler) {
          return errorResponse('Missing required fields', 400, 'MISSING_FIELDS');
        }

        // Call handler if provided
        if (handlers?.onBetCommitted) {
          try {
            const result = await handlers.onBetCommitted(notification);
            return jsonResponse(result);
          } catch (error) {
            console.error('[P2P Server] Bet committed handler error:', error);
            return jsonResponse({ acknowledged: false });
          }
        }

        // No handler - acknowledge anyway
        return jsonResponse({ acknowledged: true });
      }

      // ================================================================
      // POST /p2p/accept
      // ================================================================
      if (url.pathname === '/p2p/accept' && req.method === 'POST') {
        // Parse body
        const acceptance = await parseJsonBody<TradeAcceptance>(req);
        if (!acceptance) {
          return errorResponse('Invalid JSON body', 400, 'INVALID_JSON');
        }

        // Validate required fields
        if (!acceptance.proposalHash || !acceptance.filler || !acceptance.signature) {
          return errorResponse('Missing required fields', 400, 'MISSING_FIELDS');
        }

        // Check expiry
        const now = Math.floor(Date.now() / 1000);
        if (acceptance.expiry <= now) {
          return errorResponse('Acceptance has expired', 400, 'EXPIRED');
        }

        // Validate signature
        const recoveredSigner = validateAcceptanceSignature(acceptance);
        if (!recoveredSigner) {
          return errorResponse('Invalid signature', 401, 'INVALID_SIGNATURE');
        }

        // Verify signer matches filler
        if (recoveredSigner.toLowerCase() !== acceptance.filler.toLowerCase()) {
          return errorResponse(
            'Signature does not match filler',
            401,
            'SIGNER_MISMATCH'
          );
        }

        // Compute acceptance hash
        const acceptanceHash = computeAcceptanceHash(acceptance);

        // Call handler if provided
        if (handlers?.onAcceptance) {
          try {
            await handlers.onAcceptance(acceptance);
          } catch (error) {
            console.error('[P2P Server] Acceptance handler error:', error);
            // Continue - handler errors shouldn't fail the response
          }
        }

        const response: AcceptResponse = {
          received: true,
          acceptanceHash,
          message: 'Acceptance received and validated',
        };
        return jsonResponse(response);
      }

      // ================================================================
      // POST /p2p/trades - Store trades from counterparty (Story 2-3 Task 4.1)
      // ================================================================
      if (url.pathname === '/p2p/trades' && req.method === 'POST') {
        const body = await parseJsonBody<TradesStoreRequest>(req);
        if (!body) {
          return errorResponse('Invalid JSON body', 400, 'INVALID_JSON');
        }

        if (!body.betId || !body.tree || !body.signature || !body.signer) {
          return errorResponse('Missing required fields: betId, tree, signature, signer', 400, 'MISSING_FIELDS');
        }

        // Verify EIP-712 signature proves signer authorized this trade share
        // Signature is over: keccak256(betId, treeRoot)
        try {
          const tree = deserializeTree(body.tree);
          const messageHash = ethers.solidityPackedKeccak256(
            ['uint256', 'bytes32'],
            [body.betId, tree.root]
          );

          // Recover signer from signature
          const recoveredSigner = ethers.verifyMessage(
            ethers.getBytes(messageHash),
            body.signature
          );

          if (recoveredSigner.toLowerCase() !== body.signer.toLowerCase()) {
            return errorResponse('Invalid signature - signer mismatch', 401, 'INVALID_SIGNATURE');
          }

          // Store the tree
          storeMerkleTree(body.betId, tree);

          // Call handler if provided
          if (handlers?.onTradesReceived) {
            try {
              await handlers.onTradesReceived(body.betId, body.tree, body.signer);
            } catch (error) {
              console.error('[P2P Server] Trades received handler error:', error);
            }
          }

          const response: TradesStoreResponse = {
            received: true,
            betId: body.betId,
          };
          return jsonResponse(response);
        } catch (error) {
          return errorResponse(`Failed to store trades: ${(error as Error).message}`, 500, 'STORAGE_ERROR');
        }
      }

      // ================================================================
      // GET /p2p/trades/:betId - Request trade data with proofs (Story 2-3 Task 4.2)
      // Requires authentication: X-Signature header with signed betId
      // ================================================================
      if (url.pathname.startsWith('/p2p/trades/') && req.method === 'GET') {
        const betIdStr = url.pathname.split('/').pop();
        if (!betIdStr) {
          return errorResponse('Missing betId', 400, 'MISSING_BET_ID');
        }

        const betId = parseInt(betIdStr, 10);
        if (isNaN(betId)) {
          return errorResponse('Invalid betId', 400, 'INVALID_BET_ID');
        }

        // Require signature authentication
        const signature = req.headers.get('x-signature');
        const requestor = req.headers.get('x-requestor');
        const timestamp = req.headers.get('x-timestamp');

        if (!signature || !requestor || !timestamp) {
          return errorResponse('Missing authentication headers: X-Signature, X-Requestor, X-Timestamp', 401, 'MISSING_AUTH');
        }

        // Check timestamp is recent (within 5 minutes)
        const ts = parseInt(timestamp, 10);
        const now = Math.floor(Date.now() / 1000);
        if (isNaN(ts) || Math.abs(now - ts) > 300) {
          return errorResponse('Timestamp expired or invalid', 401, 'TIMESTAMP_EXPIRED');
        }

        // Verify signature: signed message is keccak256(betId, timestamp)
        try {
          const messageHash = ethers.solidityPackedKeccak256(
            ['uint256', 'uint256'],
            [betId, ts]
          );
          const recoveredSigner = ethers.verifyMessage(
            ethers.getBytes(messageHash),
            signature
          );

          if (recoveredSigner.toLowerCase() !== requestor.toLowerCase()) {
            return errorResponse('Invalid signature', 401, 'INVALID_SIGNATURE');
          }
        } catch {
          return errorResponse('Signature verification failed', 401, 'SIGNATURE_ERROR');
        }

        const tree = loadMerkleTree(betId);
        if (!tree) {
          return errorResponse('Trades not found for this bet', 404, 'NOT_FOUND');
        }

        // Generate proofs for all trades
        const tradesWithProofs = tree.trades.map((trade, i) => {
          const proof = generateProof(tree.leaves, i);
          return {
            tradeId: trade.tradeId,
            ticker: trade.ticker,
            source: trade.source,
            method: trade.method,
            entryPrice: trade.entryPrice,
            exitPrice: trade.exitPrice,
            won: trade.won,
            cancelled: trade.cancelled,
            proof: {
              index: proof.index,
              siblings: proof.siblings,
            },
          };
        });

        const response: TradesFetchResponse = {
          betId,
          snapshotId: tree.snapshotId,
          root: tree.root,
          trades: tradesWithProofs,
        };

        // Serialize with BigInt support
        return new Response(
          JSON.stringify(response, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
          ),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          }
        );
      }

      // ================================================================
      // POST /p2p/commitment/sign - Request counterparty signature (Story 2-3 Task 4.4)
      // ================================================================
      if (url.pathname === '/p2p/commitment/sign' && req.method === 'POST') {
        const body = await parseJsonBody<CommitmentSignRequest>(req);
        if (!body) {
          return errorResponse('Invalid JSON body', 400, 'INVALID_JSON');
        }

        if (!body.commitment || !body.requesterSignature || !body.expiry) {
          return errorResponse('Missing required fields', 400, 'MISSING_FIELDS');
        }

        // Check expiry
        const now = Math.floor(Date.now() / 1000);
        if (body.expiry <= now) {
          return errorResponse('Request has expired', 400, 'EXPIRED');
        }

        // Call handler if provided
        if (handlers?.onCommitmentSignRequest) {
          try {
            const result = await handlers.onCommitmentSignRequest(body);
            return jsonResponse<CommitmentSignResponse>(result);
          } catch (error) {
            console.error('[P2P Server] Commitment sign handler error:', error);
            return jsonResponse<CommitmentSignResponse>({
              accepted: false,
              reason: 'Internal error processing request',
            });
          }
        }

        // No handler - reject by default
        return jsonResponse<CommitmentSignResponse>({
          accepted: false,
          reason: 'No commitment sign handler configured',
        });
      }

      // ================================================================
      // POST /p2p/propose-settlement - Receive settlement proposal (Story 2-4 Task 3.1)
      // ================================================================
      if (url.pathname === '/p2p/propose-settlement' && req.method === 'POST') {
        // Task 3.1: Add POST /p2p/propose-settlement endpoint
        const proposal = await parseJsonBody<SettlementProposal>(req);
        if (!proposal) {
          return errorResponse('Invalid JSON body', 400, 'INVALID_JSON');
        }

        // Task 3.2: Validate incoming proposals
        if (!proposal.betId || !proposal.winner || !proposal.proposer || !proposal.signature) {
          return errorResponse('Missing required fields: betId, winner, proposer, signature', 400, 'MISSING_FIELDS');
        }

        // Validate settlementNonce is present (required for nonce synchronization)
        if (proposal.settlementNonce === undefined || proposal.settlementNonce === null) {
          return errorResponse('Missing required field: settlementNonce', 400, 'MISSING_NONCE');
        }

        // Check expiry
        const now = Math.floor(Date.now() / 1000);
        if (proposal.expiry <= now) {
          return errorResponse('Settlement proposal has expired', 400, 'EXPIRED');
        }

        // Validate signature using EIP-712
        try {
          const value = {
            betId: BigInt(proposal.betId),
            winner: proposal.winner,
            winsCount: BigInt(proposal.winsCount),
            validTrades: BigInt(proposal.validTrades),
            isTie: proposal.isTie,
            expiry: proposal.expiry,
            settlementNonce: BigInt(proposal.settlementNonce),
          };

          const recoveredAddress = ethers.verifyTypedData(
            P2P_DOMAIN,
            SETTLEMENT_PROPOSAL_TYPES,
            value,
            proposal.signature
          );

          if (recoveredAddress.toLowerCase() !== proposal.proposer.toLowerCase()) {
            return errorResponse('Signature does not match proposer', 401, 'SIGNER_MISMATCH');
          }
        } catch (error) {
          return errorResponse('Invalid signature', 401, 'INVALID_SIGNATURE');
        }

        // Task 3.5: Integrate with proposal handler callback
        if (handlers?.onSettlementProposal) {
          try {
            const response = await handlers.onSettlementProposal(proposal);
            return jsonResponse<SettlementProposalResponse>(response);
          } catch (error) {
            console.error('[P2P Server] Settlement proposal handler error:', error);
            return jsonResponse<SettlementProposalResponse>({
              status: 'disagree',
              ourOutcome: undefined,
            });
          }
        }

        // No handler configured - return disagree by default
        return jsonResponse<SettlementProposalResponse>({
          status: 'disagree',
          ourOutcome: undefined,
        });
      }

      // ================================================================
      // GET /p2p/settlement/:betId - Get pending settlement status (Story 2-4 Task 3.3)
      // ================================================================
      if (url.pathname.startsWith('/p2p/settlement/') && req.method === 'GET') {
        // Task 3.3: Add GET /p2p/settlement/:betId endpoint
        const betIdStr = url.pathname.split('/').pop();
        if (!betIdStr) {
          return errorResponse('Missing betId', 400, 'MISSING_BET_ID');
        }

        const betId = parseInt(betIdStr, 10);
        if (isNaN(betId)) {
          return errorResponse('Invalid betId', 400, 'INVALID_BET_ID');
        }

        // Load the Merkle tree for this bet
        const tree = loadMerkleTree(betId);
        if (!tree) {
          return errorResponse('No settlement data for this bet', 404, 'NOT_FOUND');
        }

        // Task 3.4: Return current bot's computed outcome if asked
        // The actual outcome computation requires exit prices which the handler would provide
        // For now, return basic info about the bet's trade data
        const response = {
          betId,
          snapshotId: tree.snapshotId,
          tradesCount: tree.trades.length,
          tradesRoot: tree.root,
          hasLocalData: true,
        };

        return jsonResponse(response);
      }

      // ================================================================
      // Not Found
      // ================================================================
      return errorResponse('Not Found', 404, 'NOT_FOUND');
    },
  });

  console.log(`[P2P Server] Started on port ${config.port}`);
  console.log(`[P2P Server] Address: ${config.address}`);
  console.log(`[P2P Server] Endpoint: ${config.endpoint}`);

  return {
    stop: () => {
      clearInterval(cleanupInterval);
      server.stop();
      console.log('[P2P Server] Stopped');
    },
    port: server.port,
    hostname: server.hostname,
  };
}

/**
 * Create P2P server config from environment variables
 */
export function createP2PServerConfigFromEnv(): P2PServerConfig | null {
  const port = parseInt(process.env.P2P_PORT || '8080', 10);
  const endpoint = process.env.P2P_ENDPOINT;
  const address = process.env.BOT_ADDRESS;
  const pubkeyHash = process.env.BOT_PUBKEY_HASH;
  const rateLimitPerSecond = parseInt(process.env.P2P_RATE_LIMIT || '10', 10);

  if (!endpoint || !address || !pubkeyHash) {
    console.error('[P2P Server] Missing required env vars: P2P_ENDPOINT, BOT_ADDRESS, BOT_PUBKEY_HASH');
    return null;
  }

  return {
    port,
    endpoint,
    address,
    pubkeyHash,
    rateLimitPerSecond,
    startTime: Date.now(),
  };
}

// Export validation functions for testing
export { validateProposalSignature, validateAcceptanceSignature, computeProposalHash, computeAcceptanceHash };
