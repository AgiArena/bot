/**
 * Data Node Client
 *
 * TypeScript client for the Data Node API with EIP-712 signed requests.
 */

import { Wallet, TypedDataDomain, TypedDataField } from 'ethers';

// EIP-712 Types for Data Node requests
const DATA_NODE_TYPES: Record<string, TypedDataField[]> = {
  DataNodeRequest: [
    { name: 'method', type: 'string' },
    { name: 'path', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

interface DataNodeRequest {
  method: string;
  path: string;
  timestamp: bigint;
  nonce: bigint;
}

export interface MarketPrice {
  assetId: string;
  source: string;
  symbol: string;
  name: string;
  category?: string;
  value: string;
  prevClose?: string;
  changePct?: string;
  volume24h?: string;
  marketCap?: string;
  fetchedAt: string;
  imageUrl?: string;
}

export interface PricesResponse {
  prices: MarketPrice[];
  total: number;
  page: number;
  limit: number;
}

export interface TradeWithProof {
  leafIndex: number;
  leafHash: string;
  tradeData: unknown;
  merkleProof: string[];
}

export interface TradeUploadResponse {
  tradeListId: number;
  merkleRoot: string;
  treeSize: number;
  trades: TradeWithProof[];
}

export interface TradeList {
  id: number;
  ownerAddress: string;
  merkleRoot: string;
  treeSize: number;
  propositionId?: number;
  referenceId?: string;
  metadata: unknown;
  createdAt: string;
}

export interface DataNodeClientOptions {
  /** Data Node base URL */
  baseUrl: string;
  /** Wallet for signing requests */
  wallet: Wallet;
  /** Chain ID (default: 111222333) */
  chainId?: number;
  /** Verifying contract address (default: WIND address) */
  verifyingContract?: string;
}

export class DataNodeClient {
  private baseUrl: string;
  private wallet: Wallet;
  private domain: TypedDataDomain;
  private nonceCounter: bigint = 0n;

  constructor(options: DataNodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.wallet = options.wallet;
    this.domain = {
      name: 'DataNode',
      version: '1',
      chainId: options.chainId ?? 111222333,
      verifyingContract:
        options.verifyingContract ?? '0x4e5b65FB12d4165E22f5861D97A33BA45c006114', // WIND token
    };
  }

  /**
   * Sign a request and add auth headers
   *
   * IMPORTANT: The path signed must match what the middleware sees, which is
   * the path AFTER the /api prefix is stripped by the router nesting.
   */
  private async signRequest(
    method: string,
    signPath: string  // Path as middleware sees it (without /api prefix)
  ): Promise<Record<string, string>> {
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const nonce = this.nonceCounter++;

    const request: DataNodeRequest = {
      method: method.toUpperCase(),
      path: signPath,  // Sign with the path as middleware sees it
      timestamp,
      nonce,
    };

    const signature = await this.wallet.signTypedData(
      this.domain,
      DATA_NODE_TYPES,
      request
    );

    return {
      'X-Signature': signature,
      'X-Timestamp': timestamp.toString(),
      'X-Nonce': nonce.toString(),
      'X-Address': this.wallet.address,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Make an authenticated request
   *
   * @param method HTTP method
   * @param apiPath Path to request (with /api prefix for the HTTP request)
   */
  private async request<T>(
    method: string,
    apiPath: string,  // Full path like /api/v1/prices/...
    body?: unknown
  ): Promise<T> {
    // Strip /api prefix for signing (middleware sees path without /api)
    let signPath = apiPath.startsWith('/api') ? apiPath.slice(4) : apiPath;
    // Strip query string (middleware only sees path, not query)
    const queryIndex = signPath.indexOf('?');
    if (queryIndex !== -1) {
      signPath = signPath.slice(0, queryIndex);
    }
    const headers = await this.signRequest(method, signPath);

    const response = await fetch(`${this.baseUrl}${apiPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Data Node API error: ${response.status} ${error}`);
    }

    return response.json();
  }

  // ============================================================================
  // Market Data API
  // ============================================================================

  /**
   * Get prices for a source
   */
  async getPrices(
    source: string,
    options?: {
      category?: string;
      symbols?: string[];
      page?: number;
      limit?: number;
    }
  ): Promise<PricesResponse> {
    const params = new URLSearchParams();
    if (options?.category) params.set('category', options.category);
    if (options?.symbols) params.set('symbols', options.symbols.join(','));
    if (options?.page) params.set('page', options.page.toString());
    if (options?.limit) params.set('limit', options.limit.toString());

    const query = params.toString();
    const path = `/api/v1/prices/${source}${query ? `?${query}` : ''}`;

    return this.request<PricesResponse>('GET', path);
  }

  /**
   * Get a single price
   */
  async getPrice(source: string, assetId: string): Promise<MarketPrice> {
    return this.request<MarketPrice>(
      'GET',
      `/api/v1/prices/${source}/${assetId}`
    );
  }

  /**
   * Get price at a specific timestamp
   */
  async getPriceAtTime(
    source: string,
    assetId: string,
    timestamp: Date
  ): Promise<{ assetId: string; source: string; value: string; timestamp: string }> {
    const isoTime = timestamp.toISOString();
    return this.request(
      'GET',
      `/api/v1/prices/${source}/${assetId}/at?timestamp=${isoTime}`
    );
  }

  /**
   * Get price history
   */
  async getPriceHistory(
    source: string,
    assetId: string,
    from: Date,
    to: Date
  ): Promise<{
    assetId: string;
    source: string;
    from: string;
    to: string;
    prices: unknown[];
  }> {
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    return this.request(
      'GET',
      `/api/v1/prices/${source}/${assetId}/history?from=${fromIso}&to=${toIso}`
    );
  }

  // ============================================================================
  // Snapshot API (public, no auth)
  // ============================================================================

  /**
   * Get all prices across all sources via the public /snapshot endpoint.
   * Returns gzip-compressed JSON — Bun's fetch decompresses automatically.
   */
  async getSnapshot(): Promise<PricesResponse> {
    const response = await fetch(`${this.baseUrl}/snapshot`);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Snapshot API error: ${response.status} ${error}`);
    }

    const data = await response.json() as {
      generatedAt: string;
      totalAssets: number;
      prices: MarketPrice[];
    };

    return {
      prices: data.prices,
      total: data.totalAssets,
      page: 1,
      limit: data.totalAssets,
    };
  }

  // ============================================================================
  // Trade Storage API
  // ============================================================================

  /**
   * Upload trades and get merkle tree
   */
  async uploadTrades(
    trades: unknown[],
    options?: {
      propositionId?: number;
      referenceId?: string;
      metadata?: unknown;
    }
  ): Promise<TradeUploadResponse> {
    return this.request<TradeUploadResponse>('POST', '/api/v1/trades', {
      trades,
      propositionId: options?.propositionId,
      referenceId: options?.referenceId,
      metadata: options?.metadata,
    });
  }

  /**
   * List trade lists
   */
  async listTradeLists(options?: {
    propositionId?: number;
    referenceId?: string;
    page?: number;
    limit?: number;
  }): Promise<{ tradeLists: TradeList[]; total: number; page: number; limit: number }> {
    const params = new URLSearchParams();
    if (options?.propositionId)
      params.set('propositionId', options.propositionId.toString());
    if (options?.referenceId) params.set('referenceId', options.referenceId);
    if (options?.page) params.set('page', options.page.toString());
    if (options?.limit) params.set('limit', options.limit.toString());

    const query = params.toString();
    const path = `/api/v1/trades${query ? `?${query}` : ''}`;

    return this.request('GET', path);
  }

  /**
   * Get a trade list by ID
   */
  async getTradeList(id: number): Promise<TradeList> {
    return this.request<TradeList>('GET', `/api/v1/trades/${id}`);
  }

  /**
   * Get a trade list by merkle root
   */
  async getTradeListByRoot(merkleRoot: string): Promise<TradeList> {
    return this.request<TradeList>('GET', `/api/v1/trades/by-root/${merkleRoot}`);
  }

  /**
   * Get all trades in a trade list
   */
  async getTrades(tradeListId: number): Promise<TradeWithProof[]> {
    return this.request<TradeWithProof[]>(
      'GET',
      `/api/v1/trades/${tradeListId}/leaves`
    );
  }

  /**
   * Get a specific trade by index
   */
  async getTrade(tradeListId: number, leafIndex: number): Promise<TradeWithProof> {
    return this.request<TradeWithProof>(
      'GET',
      `/api/v1/trades/${tradeListId}/leaves/${leafIndex}`
    );
  }
}

/**
 * Create a Data Node client from environment variables
 */
export function createDataNodeClient(
  privateKey: string,
  baseUrl?: string
): DataNodeClient {
  const wallet = new Wallet(privateKey);
  return new DataNodeClient({
    baseUrl: baseUrl ?? process.env.DATA_NODE_URL ?? 'http://localhost:4000',
    wallet,
    chainId: parseInt(process.env.CHAIN_ID ?? '111222333'),
    verifyingContract:
      process.env.WIND_ADDRESS ?? '0x4e5b65FB12d4165E22f5861D97A33BA45c006114', // WIND token
  });
}
