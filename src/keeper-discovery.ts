/**
 * Keeper Discovery Module for BLS Gasless Resolution
 *
 * Story 14.3, Task 1: Discover active keepers from on-chain registry
 * - Fetches keeper list from ResolutionDAO contract
 * - Retrieves BLS public keys for each keeper
 * - Caches keeper list with configurable refresh interval
 */

import { Contract, JsonRpcProvider } from "ethers";

// ============================================================================
// Types
// ============================================================================

/**
 * Keeper information from on-chain registry
 */
export interface KeeperInfo {
  /** Ethereum address of the keeper */
  address: string;
  /** HTTP endpoint URL for the keeper's API */
  endpoint: string;
  /** BLS public key (x coordinate as hex) */
  blsPubkeyX: string;
  /** BLS public key (y coordinate as hex) */
  blsPubkeyY: string;
  /** Whether the keeper is active */
  isActive: boolean;
  /** Whether the keeper has a BLS public key registered */
  hasBLSPubkey: boolean;
}

/**
 * Cached keeper list with timestamp
 */
interface KeeperCache {
  keepers: KeeperInfo[];
  fetchedAt: number;
}

// ============================================================================
// ABI Fragments for ResolutionDAO
// ============================================================================

const RESOLUTION_DAO_ABI = [
  // Keeper count and iteration
  "function getKeeperCount() external view returns (uint256)",
  "function getKeeperAtIndex(uint256 index) external view returns (address)",
  "function isKeeper(address) external view returns (bool)",
  // Keeper IP registry
  "function keeperIPs(address) external view returns (string)",
  // BLS public key functions
  "function hasBLSPubkey(address) external view returns (bool)",
  "function getKeeperBLSPubkey(address) external view returns (uint256 pubkeyX, uint256 pubkeyY)",
  "function getActiveKeeperBLSPubkeys() external view returns (address[] memory addresses, uint256[] memory pubkeysX, uint256[] memory pubkeysY)",
  // BLS resolution helpers
  "function getRequiredBLSSigners() external view returns (uint256)",
  "function canParticipateInBLSResolution(address) external view returns (bool)",
  "function getBLSNonce(uint256 betId) external view returns (uint256)",
];

// ============================================================================
// Default Configuration
// ============================================================================

/** Default cache TTL: 5 minutes */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/** Default RPC URL */
const DEFAULT_RPC_URL = "https://index.rpc.zeeve.net";

/** Default ResolutionDAO address */
const DEFAULT_RESOLUTION_DAO_ADDRESS = "0x1B1157f2C4E8821B4172dDA17730E9807aceEe88";

// ============================================================================
// KeeperDiscovery Class
// ============================================================================

/**
 * Keeper discovery service for BLS gasless resolution
 *
 * Discovers active keepers from the on-chain registry and caches the results.
 * Use this to find keepers for signature collection.
 */
export class KeeperDiscovery {
  private provider: JsonRpcProvider;
  private resolutionDao: Contract;
  private cache: KeeperCache | null = null;
  private cacheTtlMs: number;

  constructor(options?: {
    rpcUrl?: string;
    resolutionDaoAddress?: string;
    cacheTtlMs?: number;
  }) {
    const rpcUrl = options?.rpcUrl || process.env.RPC_URL || DEFAULT_RPC_URL;
    const daoAddress = options?.resolutionDaoAddress || process.env.RESOLUTION_DAO_ADDRESS || DEFAULT_RESOLUTION_DAO_ADDRESS;
    this.cacheTtlMs = options?.cacheTtlMs || DEFAULT_CACHE_TTL_MS;

    this.provider = new JsonRpcProvider(rpcUrl);
    this.resolutionDao = new Contract(daoAddress, RESOLUTION_DAO_ABI, this.provider);
  }

  /**
   * Discover all active keepers with BLS public keys
   *
   * Returns cached keepers if cache is still valid, otherwise fetches fresh data.
   *
   * @returns Array of keeper info with BLS keys
   */
  async discoverKeepers(): Promise<KeeperInfo[]> {
    // Check cache validity
    if (this.cache && Date.now() - this.cache.fetchedAt < this.cacheTtlMs) {
      return this.cache.keepers;
    }

    // Fetch fresh keeper list
    const keepers = await this.fetchKeepersFromChain();

    // Update cache
    this.cache = {
      keepers,
      fetchedAt: Date.now(),
    };

    return keepers;
  }

  /**
   * Get keepers with registered BLS public keys (for signature collection)
   *
   * Filters the keeper list to only include those that can participate
   * in BLS resolution (have registered BLS public keys).
   *
   * @returns Array of keepers that can sign BLS resolutions
   */
  async discoverBLSKeepers(): Promise<KeeperInfo[]> {
    const allKeepers = await this.discoverKeepers();
    return allKeepers.filter(k => k.hasBLSPubkey);
  }

  /**
   * Get the number of signatures required for BLS resolution (>50%)
   *
   * @returns Minimum number of signers required
   */
  async getRequiredSigners(): Promise<number> {
    const required = await this.resolutionDao.getRequiredBLSSigners();
    return Number(required);
  }

  /**
   * Get the current nonce for a bet (for replay protection)
   *
   * @param betId - The bet ID
   * @returns Current nonce value
   */
  async getBLSNonce(betId: number): Promise<bigint> {
    return await this.resolutionDao.getBLSNonce(betId);
  }

  /**
   * Force refresh the keeper cache
   */
  async refreshCache(): Promise<KeeperInfo[]> {
    this.cache = null;
    return this.discoverKeepers();
  }

  /**
   * Get cache status for debugging
   */
  getCacheStatus(): { isCached: boolean; ageMs: number | null; keeperCount: number } {
    if (!this.cache) {
      return { isCached: false, ageMs: null, keeperCount: 0 };
    }
    return {
      isCached: true,
      ageMs: Date.now() - this.cache.fetchedAt,
      keeperCount: this.cache.keepers.length,
    };
  }

  /**
   * Fetch keepers from chain using getActiveKeeperBLSPubkeys
   *
   * This is more efficient as it fetches all BLS-enabled keepers in one call.
   */
  private async fetchKeepersFromChain(): Promise<KeeperInfo[]> {
    const keepers: KeeperInfo[] = [];

    try {
      // Use the optimized batch call
      const [addresses, pubkeysX, pubkeysY] = await this.resolutionDao.getActiveKeeperBLSPubkeys();

      // Fetch IP endpoints for each keeper in parallel
      const ipPromises = addresses.map((addr: string) =>
        this.resolutionDao.keeperIPs(addr).catch(() => "")
      );
      const endpoints = await Promise.all(ipPromises);

      for (let i = 0; i < addresses.length; i++) {
        const address = addresses[i];
        const endpoint = endpoints[i] || "";
        const pubkeyX = pubkeysX[i].toString();
        const pubkeyY = pubkeysY[i].toString();

        keepers.push({
          address,
          endpoint,
          blsPubkeyX: pubkeyX,
          blsPubkeyY: pubkeyY,
          isActive: true,
          hasBLSPubkey: true,
        });
      }
    } catch (error) {
      // Fallback: fetch keepers individually
      console.warn(`[KeeperDiscovery] Batch fetch failed, falling back to individual: ${error}`);
      return this.fetchKeepersIndividually();
    }

    return keepers;
  }

  /**
   * Fallback: fetch keepers individually
   *
   * Used when getActiveKeeperBLSPubkeys is not available or fails.
   */
  private async fetchKeepersIndividually(): Promise<KeeperInfo[]> {
    const keepers: KeeperInfo[] = [];

    try {
      const keeperCount = await this.resolutionDao.getKeeperCount();

      for (let i = 0; i < keeperCount; i++) {
        try {
          const address = await this.resolutionDao.getKeeperAtIndex(i);
          const isActive = await this.resolutionDao.isKeeper(address);

          if (!isActive) continue;

          const endpoint = await this.resolutionDao.keeperIPs(address).catch(() => "");
          const hasBLS = await this.resolutionDao.hasBLSPubkey(address).catch(() => false);

          let blsPubkeyX = "";
          let blsPubkeyY = "";

          if (hasBLS) {
            try {
              const [pubkeyX, pubkeyY] = await this.resolutionDao.getKeeperBLSPubkey(address);
              blsPubkeyX = pubkeyX.toString();
              blsPubkeyY = pubkeyY.toString();
            } catch {
              // Keeper doesn't have BLS key registered
            }
          }

          keepers.push({
            address,
            endpoint,
            blsPubkeyX,
            blsPubkeyY,
            isActive: true,
            hasBLSPubkey: hasBLS && blsPubkeyX !== "",
          });
        } catch (error) {
          console.warn(`[KeeperDiscovery] Failed to fetch keeper at index ${i}: ${error}`);
        }
      }
    } catch (error) {
      console.error(`[KeeperDiscovery] Failed to fetch keepers: ${error}`);
    }

    return keepers;
  }
}

/**
 * Create a keeper discovery instance from environment variables
 */
export function createKeeperDiscoveryFromEnv(cacheTtlMs?: number): KeeperDiscovery {
  return new KeeperDiscovery({
    rpcUrl: process.env.RPC_URL,
    resolutionDaoAddress: process.env.RESOLUTION_DAO_ADDRESS,
    cacheTtlMs,
  });
}
