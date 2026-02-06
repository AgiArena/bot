/**
 * P2P HTTP Transport Module
 *
 * Story 2-2: P2P Server & Discovery
 * Task 3: Create P2P Transport module
 *
 * Handles outbound HTTP calls to peer P2P endpoints:
 * - sendProposal(peer, proposal) - POST to /p2p/propose
 * - sendAcceptance(peer, acceptance) - POST to /p2p/accept
 * - checkPeerHealth(peer) - GET /p2p/health
 *
 * Features:
 * - Retry with exponential backoff (3 retries, 200ms base)
 * - Connection timeout (5s default)
 */

import {
  type TradeProposal,
  type TradeAcceptance,
  type PeerInfo,
  type P2PHealthResponse,
  type P2PInfoResponse,
  type ProposeResponse,
  type AcceptResponse,
  type P2PTransportConfig,
  type CommitmentSignRequest,
  type CommitmentSignResponse,
  type TradesStoreRequest,
  type TradesStoreResponse,
  type TradesFetchResponse,
  type BetCommitmentForRequest,
  type SettlementProposal,
  type SettlementProposalResponse,
  DEFAULT_TRANSPORT_CONFIG,
} from "./types";

/**
 * Transport error with detailed information
 */
export class P2PTransportError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly retryable: boolean = true
  ) {
    super(message);
    this.name = 'P2PTransportError';
  }
}

/**
 * Result type for transport operations
 */
export type TransportResult<T> =
  | { success: true; data: T }
  | { success: false; error: P2PTransportError };

/**
 * Sleep helper for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Serialize BigInt values to strings for JSON
 */
function serializeForJson(obj: object): string {
  return JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
}

/**
 * Send HTTP request with retry and timeout
 *
 * @param url - Full URL to request
 * @param options - Fetch options (method, body, headers)
 * @param config - Transport configuration
 * @returns Response data or throws P2PTransportError
 */
async function fetchWithRetry<T>(
  url: string,
  options: RequestInit,
  config: Required<P2PTransportConfig>
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        // Non-retryable HTTP errors
        if (response.status === 400 || response.status === 401) {
          let errorMessage = `HTTP ${response.status}`;
          try {
            const errorBody = await response.json() as { message?: string; error?: string };
            errorMessage = errorBody.message || errorBody.error || errorMessage;
          } catch {
            // Ignore JSON parse errors
          }
          throw new P2PTransportError(
            errorMessage,
            `HTTP_${response.status}`,
            response.status,
            false // Not retryable
          );
        }

        // Retryable HTTP errors (5xx, etc)
        throw new P2PTransportError(
          `HTTP ${response.status}`,
          `HTTP_${response.status}`,
          response.status,
          true
        );
      }

      return await response.json() as T;
    } catch (error) {
      lastError = error as Error;

      // Don't retry non-retryable errors
      if (error instanceof P2PTransportError && !error.retryable) {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt < config.maxRetries - 1) {
        // Exponential backoff
        const delay = Math.min(
          config.baseDelayMs * Math.pow(2, attempt),
          config.maxDelayMs
        );
        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  throw new P2PTransportError(
    lastError?.message || 'Request failed after retries',
    'RETRY_EXHAUSTED',
    undefined,
    true
  );
}

/**
 * P2P HTTP Transport for outbound peer communication
 */
export class P2PTransport {
  private readonly config: Required<P2PTransportConfig>;

  /**
   * Create a new P2P transport instance
   *
   * @param config - Transport configuration
   */
  constructor(config?: P2PTransportConfig) {
    this.config = {
      maxRetries: config?.maxRetries ?? DEFAULT_TRANSPORT_CONFIG.maxRetries,
      baseDelayMs: config?.baseDelayMs ?? DEFAULT_TRANSPORT_CONFIG.baseDelayMs,
      maxDelayMs: config?.maxDelayMs ?? DEFAULT_TRANSPORT_CONFIG.maxDelayMs,
      timeoutMs: config?.timeoutMs ?? DEFAULT_TRANSPORT_CONFIG.timeoutMs,
    };
  }

  /**
   * Send a trade proposal to a peer
   *
   * @param peer - Peer info or endpoint URL
   * @param proposal - Signed trade proposal
   * @returns Propose response or transport error
   */
  async sendProposal(
    peer: PeerInfo | string,
    proposal: TradeProposal
  ): Promise<TransportResult<ProposeResponse>> {
    const endpoint = typeof peer === 'string' ? peer : peer.endpoint;
    const url = `${endpoint}/p2p/propose`;

    try {
      const data = await fetchWithRetry<ProposeResponse>(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: serializeForJson(proposal),
        },
        this.config
      );

      return { success: true, data };
    } catch (error) {
      if (error instanceof P2PTransportError) {
        return { success: false, error };
      }
      return {
        success: false,
        error: new P2PTransportError(
          (error as Error).message,
          'UNKNOWN_ERROR',
          undefined,
          true
        ),
      };
    }
  }

  /**
   * Send a trade acceptance to a peer
   *
   * @param peer - Peer info or endpoint URL
   * @param acceptance - Signed trade acceptance
   * @returns Accept response or transport error
   */
  async sendAcceptance(
    peer: PeerInfo | string,
    acceptance: TradeAcceptance
  ): Promise<TransportResult<AcceptResponse>> {
    const endpoint = typeof peer === 'string' ? peer : peer.endpoint;
    const url = `${endpoint}/p2p/accept`;

    try {
      const data = await fetchWithRetry<AcceptResponse>(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: serializeForJson(acceptance),
        },
        this.config
      );

      return { success: true, data };
    } catch (error) {
      if (error instanceof P2PTransportError) {
        return { success: false, error };
      }
      return {
        success: false,
        error: new P2PTransportError(
          (error as Error).message,
          'UNKNOWN_ERROR',
          undefined,
          true
        ),
      };
    }
  }

  /**
   * Check health of a peer
   *
   * @param peer - Peer info or endpoint URL
   * @returns Health response or transport error
   */
  async checkPeerHealth(
    peer: PeerInfo | string
  ): Promise<TransportResult<P2PHealthResponse>> {
    const endpoint = typeof peer === 'string' ? peer : peer.endpoint;
    const url = `${endpoint}/p2p/health`;

    try {
      const data = await fetchWithRetry<P2PHealthResponse>(
        url,
        {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        },
        this.config
      );

      return { success: true, data };
    } catch (error) {
      if (error instanceof P2PTransportError) {
        return { success: false, error };
      }
      return {
        success: false,
        error: new P2PTransportError(
          (error as Error).message,
          'UNKNOWN_ERROR',
          undefined,
          true
        ),
      };
    }
  }

  /**
   * Get info from a peer
   *
   * @param peer - Peer info or endpoint URL
   * @returns Info response or transport error
   */
  async getPeerInfo(
    peer: PeerInfo | string
  ): Promise<TransportResult<P2PInfoResponse>> {
    const endpoint = typeof peer === 'string' ? peer : peer.endpoint;
    const url = `${endpoint}/p2p/info`;

    try {
      const data = await fetchWithRetry<P2PInfoResponse>(
        url,
        {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        },
        this.config
      );

      return { success: true, data };
    } catch (error) {
      if (error instanceof P2PTransportError) {
        return { success: false, error };
      }
      return {
        success: false,
        error: new P2PTransportError(
          (error as Error).message,
          'UNKNOWN_ERROR',
          undefined,
          true
        ),
      };
    }
  }

  /**
   * Broadcast a proposal to multiple peers
   *
   * @param peers - Array of peers to send to
   * @param proposal - Signed trade proposal
   * @returns Map of peer address to result
   */
  async broadcastProposal(
    peers: PeerInfo[],
    proposal: TradeProposal
  ): Promise<Map<string, TransportResult<ProposeResponse>>> {
    const results = new Map<string, TransportResult<ProposeResponse>>();

    // Send to all peers in parallel
    await Promise.all(
      peers.map(async (peer) => {
        const result = await this.sendProposal(peer, proposal);
        results.set(peer.address, result);
      })
    );

    return results;
  }

  /**
   * Get transport configuration
   */
  getConfig(): Required<P2PTransportConfig> {
    return { ...this.config };
  }

  // ============================================================================
  // Story 2-3: Bet Commitment Methods
  // ============================================================================

  /**
   * Request counterparty to sign bet commitment
   *
   * Story 2-3 Task 4.3: requestCommitmentSign implementation
   *
   * @param peer - Peer info or endpoint URL
   * @param commitment - The bet commitment data
   * @param requesterSignature - Requester's signature proving commitment authenticity
   * @param expiry - Request expiry timestamp
   * @returns Commitment sign response or transport error
   */
  async requestCommitmentSign(
    peer: PeerInfo | string,
    commitment: BetCommitmentForRequest,
    requesterSignature: string,
    expiry?: number,
  ): Promise<TransportResult<CommitmentSignResponse>> {
    const endpoint = typeof peer === 'string' ? peer : peer.endpoint;
    const url = `${endpoint}/p2p/commitment/sign`;

    const request: CommitmentSignRequest = {
      commitment,
      requesterSignature,
      expiry: expiry ?? Math.floor(Date.now() / 1000) + 60, // 1 minute default
    };

    try {
      const data = await fetchWithRetry<CommitmentSignResponse>(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: serializeForJson(request),
        },
        this.config
      );

      return { success: true, data };
    } catch (error) {
      if (error instanceof P2PTransportError) {
        return { success: false, error };
      }
      return {
        success: false,
        error: new P2PTransportError(
          (error as Error).message,
          'UNKNOWN_ERROR',
          undefined,
          true
        ),
      };
    }
  }

  /**
   * Send trades to counterparty
   *
   * Story 2-3 Task 4.1: Send trades via P2P
   *
   * @param peer - Peer info or endpoint URL
   * @param betId - The bet ID
   * @param tree - Serialized MerkleTree JSON
   * @param signature - Signature from sender
   * @param signer - Signer address
   * @returns Store response or transport error
   */
  async sendTrades(
    peer: PeerInfo | string,
    betId: number,
    tree: string,
    signature: string,
    signer: string,
  ): Promise<TransportResult<TradesStoreResponse>> {
    const endpoint = typeof peer === 'string' ? peer : peer.endpoint;
    const url = `${endpoint}/p2p/trades`;

    const request: TradesStoreRequest = {
      betId,
      tree,
      signature,
      signer,
    };

    try {
      const data = await fetchWithRetry<TradesStoreResponse>(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        this.config
      );

      return { success: true, data };
    } catch (error) {
      if (error instanceof P2PTransportError) {
        return { success: false, error };
      }
      return {
        success: false,
        error: new P2PTransportError(
          (error as Error).message,
          'UNKNOWN_ERROR',
          undefined,
          true
        ),
      };
    }
  }

  /**
   * Request trades from counterparty
   *
   * Story 2-3 Task 4.3: requestTrades implementation
   * Includes authentication headers (X-Signature, X-Requestor, X-Timestamp)
   *
   * @param peer - Peer info or endpoint URL
   * @param betId - The bet ID to fetch trades for
   * @param wallet - Wallet to sign the request (for authentication)
   * @returns Trades with proofs or transport error
   */
  async requestTrades(
    peer: PeerInfo | string,
    betId: number,
    wallet?: { address: string; signMessage: (message: Uint8Array) => Promise<string> },
  ): Promise<TransportResult<TradesFetchResponse>> {
    const endpoint = typeof peer === 'string' ? peer : peer.endpoint;
    const url = `${endpoint}/p2p/trades/${betId}`;

    // Build authentication headers if wallet provided
    const headers: Record<string, string> = { 'Accept': 'application/json' };

    if (wallet) {
      const timestamp = Math.floor(Date.now() / 1000);
      // Import ethers for hashing
      const { ethers } = await import('ethers');
      const messageHash = ethers.solidityPackedKeccak256(
        ['uint256', 'uint256'],
        [betId, timestamp]
      );
      const signature = await wallet.signMessage(ethers.getBytes(messageHash));

      headers['X-Signature'] = signature;
      headers['X-Requestor'] = wallet.address;
      headers['X-Timestamp'] = timestamp.toString();
    }

    try {
      const data = await fetchWithRetry<TradesFetchResponse>(
        url,
        {
          method: 'GET',
          headers,
        },
        this.config
      );

      return { success: true, data };
    } catch (error) {
      if (error instanceof P2PTransportError) {
        return { success: false, error };
      }
      return {
        success: false,
        error: new P2PTransportError(
          (error as Error).message,
          'UNKNOWN_ERROR',
          undefined,
          true
        ),
      };
    }
  }

  // ============================================================================
  // Story 2-4: Settlement Methods
  // ============================================================================

  /**
   * Propose settlement to counterparty
   *
   * Story 2-4 Task 4.1: proposeSettlement implementation
   *
   * @param peer - Peer info or endpoint URL
   * @param proposal - Signed settlement proposal
   * @returns Settlement proposal response or transport error
   */
  async proposeSettlement(
    peer: PeerInfo | string,
    proposal: SettlementProposal,
  ): Promise<TransportResult<SettlementProposalResponse>> {
    const endpoint = typeof peer === 'string' ? peer : peer.endpoint;
    const url = `${endpoint}/p2p/propose-settlement`;

    try {
      const data = await fetchWithRetry<SettlementProposalResponse>(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: serializeForJson(proposal),
        },
        this.config
      );

      return { success: true, data };
    } catch (error) {
      if (error instanceof P2PTransportError) {
        return { success: false, error };
      }
      return {
        success: false,
        error: new P2PTransportError(
          (error as Error).message,
          'UNKNOWN_ERROR',
          undefined,
          true
        ),
      };
    }
  }

  /**
   * Get settlement status from counterparty
   *
   * Story 2-4 Task 4.2: getSettlementStatus implementation
   *
   * @param peer - Peer info or endpoint URL
   * @param betId - The bet ID to check settlement status
   * @returns Settlement status response or transport error
   */
  async getSettlementStatus(
    peer: PeerInfo | string,
    betId: number,
  ): Promise<TransportResult<{ betId: number; snapshotId: string; tradesCount: number; tradesRoot: string; hasLocalData: boolean }>> {
    const endpoint = typeof peer === 'string' ? peer : peer.endpoint;
    const url = `${endpoint}/p2p/settlement/${betId}`;

    try {
      const data = await fetchWithRetry<{ betId: number; snapshotId: string; tradesCount: number; tradesRoot: string; hasLocalData: boolean }>(
        url,
        {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        },
        this.config
      );

      return { success: true, data };
    } catch (error) {
      if (error instanceof P2PTransportError) {
        return { success: false, error };
      }
      return {
        success: false,
        error: new P2PTransportError(
          (error as Error).message,
          'UNKNOWN_ERROR',
          undefined,
          true
        ),
      };
    }
  }

  /**
   * Propose settlement with retry logic
   *
   * Story 2-4 Task 4.3: Handle retry and timeout for settlement proposals
   *
   * @param peer - Peer info or endpoint URL
   * @param proposal - Signed settlement proposal
   * @param maxRetries - Maximum retries (default: config maxRetries)
   * @returns Settlement proposal response or transport error
   */
  async proposeSettlementWithRetry(
    peer: PeerInfo | string,
    proposal: SettlementProposal,
    maxRetries?: number,
  ): Promise<TransportResult<SettlementProposalResponse>> {
    const retries = maxRetries ?? this.config.maxRetries;
    let lastError: P2PTransportError | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      const result = await this.proposeSettlement(peer, proposal);
      if (result.success) {
        return result;
      }

      lastError = result.error;

      // Don't retry non-retryable errors
      if (!result.error.retryable) {
        return result;
      }

      // Wait before retry (exponential backoff)
      if (attempt < retries - 1) {
        const delay = Math.min(
          this.config.baseDelayMs * Math.pow(2, attempt),
          this.config.maxDelayMs
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    return {
      success: false,
      error: lastError ?? new P2PTransportError('Settlement proposal failed after retries', 'RETRY_EXHAUSTED'),
    };
  }
}

/**
 * Create a P2P transport with default configuration
 */
export function createDefaultTransport(): P2PTransport {
  return new P2PTransport();
}

/**
 * Create a P2P transport from environment variables
 */
export function createTransportFromEnv(): P2PTransport {
  const maxRetries = parseInt(process.env.P2P_MAX_RETRIES || '3', 10);
  const baseDelayMs = parseInt(process.env.P2P_BASE_DELAY_MS || '200', 10);
  const maxDelayMs = parseInt(process.env.P2P_MAX_DELAY_MS || '2000', 10);
  const timeoutMs = parseInt(process.env.P2P_TIMEOUT_MS || '5000', 10);

  return new P2PTransport({
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    timeoutMs,
  });
}
