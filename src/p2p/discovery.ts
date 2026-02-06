/**
 * P2P Peer Discovery Module
 *
 * Story 2-2: P2P Server & Discovery
 * Task 2: Create P2P Discovery module
 *
 * Discovers peers via BotRegistry.getAllActiveBots() on-chain:
 * - Caches peer list with 60s TTL to reduce RPC calls
 * - Health checks peers via /p2p/health endpoint
 * - Filters to only healthy, reachable peers
 */

import { ChainClient } from "../chain-client";
import {
  type PeerInfo,
  type P2PHealthResponse,
  type P2PDiscoveryConfig,
  DEFAULT_DISCOVERY_CONFIG,
} from "./types";

/**
 * P2P Peer Discovery Service
 *
 * Fetches active bots from BotRegistry and maintains a health-checked peer list.
 */
export class PeerDiscovery {
  private peers: Map<string, PeerInfo> = new Map();
  private lastRefresh: number = 0;
  private readonly cacheTtlMs: number;
  private readonly healthCheckTimeoutMs: number;
  private readonly maxConcurrentHealthChecks: number;
  private readonly chainClient: ChainClient;
  private readonly selfAddress: string;

  /**
   * Create a new PeerDiscovery instance
   *
   * @param chainClient - ChainClient with BotRegistry configured
   * @param selfAddress - This bot's address (to exclude from peers)
   * @param config - Optional discovery configuration
   */
  constructor(
    chainClient: ChainClient,
    selfAddress: string,
    config?: P2PDiscoveryConfig
  ) {
    this.chainClient = chainClient;
    this.selfAddress = selfAddress.toLowerCase();
    this.cacheTtlMs = config?.cacheTtlMs ?? DEFAULT_DISCOVERY_CONFIG.cacheTtlMs;
    this.healthCheckTimeoutMs = config?.healthCheckTimeoutMs ?? DEFAULT_DISCOVERY_CONFIG.healthCheckTimeoutMs;
    this.maxConcurrentHealthChecks = config?.maxConcurrentHealthChecks ?? DEFAULT_DISCOVERY_CONFIG.maxConcurrentHealthChecks;
  }

  /**
   * Fetch peers from BotRegistry.
   * Uses cached data if within TTL, otherwise fetches fresh from chain.
   *
   * @returns Array of all known peers (may include unhealthy ones)
   */
  async fetchPeersFromRegistry(): Promise<PeerInfo[]> {
    const now = Date.now();

    // Check cache validity
    if (now - this.lastRefresh < this.cacheTtlMs && this.peers.size > 0) {
      return Array.from(this.peers.values());
    }

    try {
      // Fetch from BotRegistry
      const [addresses, endpoints] = await this.chainClient.getAllActiveBots();

      // Update cache with new peers
      const seenAddresses = new Set<string>();

      for (let i = 0; i < addresses.length; i++) {
        const address = addresses[i].toLowerCase();
        seenAddresses.add(address);

        // Skip self
        if (address === this.selfAddress) {
          continue;
        }

        // Check if we already have this peer
        const existing = this.peers.get(address);
        if (existing) {
          // Update endpoint if changed
          if (existing.endpoint !== endpoints[i]) {
            existing.endpoint = endpoints[i];
            existing.isHealthy = false; // Reset health since endpoint changed
            existing.lastChecked = 0;
          }
        } else {
          // New peer
          this.peers.set(address, {
            address,
            endpoint: endpoints[i],
            pubkeyHash: '', // Will be populated on health check
            isHealthy: false,
            lastChecked: 0,
          });
        }
      }

      // Remove peers that are no longer in the registry
      for (const address of this.peers.keys()) {
        if (!seenAddresses.has(address)) {
          this.peers.delete(address);
        }
      }

      this.lastRefresh = now;
      console.log(`[PeerDiscovery] Refreshed peer list: ${this.peers.size} peers`);

      return Array.from(this.peers.values());
    } catch (error) {
      console.error('[PeerDiscovery] Failed to fetch peers from registry:', error);
      // Return cached peers on error
      return Array.from(this.peers.values());
    }
  }

  /**
   * Check health of a single peer
   *
   * @param endpoint - Peer's P2P endpoint
   * @returns True if healthy, false otherwise
   */
  async checkPeerHealth(endpoint: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.healthCheckTimeoutMs);

      const response = await fetch(`${endpoint}/p2p/health`, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as P2PHealthResponse;
      return data.status === 'healthy';
    } catch (error) {
      // Connection timeout, refused, or other error
      return false;
    }
  }

  /**
   * Get healthy peers with up-to-date health checks
   *
   * @returns Array of healthy, reachable peers
   */
  async getHealthyPeers(): Promise<PeerInfo[]> {
    // First, ensure we have a fresh peer list
    const peers = await this.fetchPeersFromRegistry();

    // Health check all peers (with concurrency limit)
    const healthyPeers: PeerInfo[] = [];
    const checkPromises: Promise<void>[] = [];

    for (const peer of peers) {
      const checkPromise = (async () => {
        try {
          const isHealthy = await this.checkPeerHealth(peer.endpoint);
          peer.isHealthy = isHealthy;
          peer.lastChecked = Date.now();

          if (isHealthy) {
            healthyPeers.push(peer);
          }
        } catch {
          peer.isHealthy = false;
          peer.lastChecked = Date.now();
        }
      })();

      checkPromises.push(checkPromise);

      // Enforce concurrency limit
      if (checkPromises.length >= this.maxConcurrentHealthChecks) {
        await Promise.race(checkPromises);
        // Remove completed promises
        const pending: Promise<void>[] = [];
        for (const p of checkPromises) {
          const raceResult = await Promise.race([p.then(() => 'done'), Promise.resolve('pending')]);
          if (raceResult === 'pending') {
            pending.push(p);
          }
        }
        checkPromises.length = 0;
        checkPromises.push(...pending);
      }
    }

    // Wait for remaining checks
    await Promise.all(checkPromises);

    console.log(`[PeerDiscovery] Health check: ${healthyPeers.length}/${peers.length} healthy`);
    return healthyPeers;
  }

  /**
   * Force refresh the peer cache
   * Useful after a registry update
   */
  async refreshPeers(): Promise<PeerInfo[]> {
    this.lastRefresh = 0; // Invalidate cache
    return this.fetchPeersFromRegistry();
  }

  /**
   * Get a specific peer by address
   *
   * @param address - Peer's Ethereum address
   * @returns PeerInfo or undefined if not found
   */
  getPeer(address: string): PeerInfo | undefined {
    return this.peers.get(address.toLowerCase());
  }

  /**
   * Get all known peers (may include unhealthy ones)
   */
  getAllPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  /**
   * Get count of known peers
   */
  getPeerCount(): number {
    return this.peers.size;
  }

  /**
   * Get count of healthy peers (based on last health check)
   */
  getHealthyPeerCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.isHealthy) count++;
    }
    return count;
  }

  /**
   * Clear the peer cache
   */
  clearCache(): void {
    this.peers.clear();
    this.lastRefresh = 0;
  }

  /**
   * Check if cache is stale
   */
  isCacheStale(): boolean {
    return Date.now() - this.lastRefresh > this.cacheTtlMs;
  }

  /**
   * Get time until cache expires (in ms)
   */
  getCacheTtl(): number {
    const remaining = this.cacheTtlMs - (Date.now() - this.lastRefresh);
    return Math.max(0, remaining);
  }
}

/**
 * Create PeerDiscovery from environment variables
 */
export function createPeerDiscoveryFromEnv(chainClient: ChainClient): PeerDiscovery | null {
  const selfAddress = chainClient.getAddress();

  if (!selfAddress) {
    console.error('[PeerDiscovery] ChainClient has no address');
    return null;
  }

  const cacheTtlMs = parseInt(process.env.P2P_DISCOVERY_CACHE_TTL_MS || '60000', 10);
  const healthCheckTimeoutMs = parseInt(process.env.P2P_HEALTH_CHECK_TIMEOUT_MS || '5000', 10);

  return new PeerDiscovery(chainClient, selfAddress, {
    cacheTtlMs,
    healthCheckTimeoutMs,
  });
}
