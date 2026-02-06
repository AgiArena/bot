/**
 * Bilateral P2P Trading Bot Entry Point
 *
 * Story 4-3: New entry point for bilateral custody system.
 * Updated: Auto-trading implementation for maker/taker roles.
 *
 * The bilateral system uses:
 * - CollateralVault for P2P bilateral bets (2-tx flow: commit → settle)
 * - BotRegistry for peer discovery
 * - Direct P2P communication between bots
 * - Keeper arbitration only on disputes
 */

import { startP2PServer, createP2PServerConfigFromEnv } from "./p2p/server";
import { PeerDiscovery, createPeerDiscoveryFromEnv } from "./p2p/discovery";
import { BetCoordinator, createBetCoordinatorFromEnv } from "./p2p/bet-coordinator";
import { SettlementCoordinator } from "./p2p/settlement-coordinator";
import { createChainClientFromEnv, type ChainClient } from "./chain-client";
import { DataNodeClient } from "./data-node-client";
import { buildBilateralMerkleTree, type MerkleTree, type Trade } from "./merkle-tree";
import { signBetCommitment, type BetCommitmentData } from "./p2p/commitment";
import { computeOutcome } from "./p2p/outcome-computer";
import { storeMerkleTree, storeResolution } from "./p2p/trade-storage";
import {
  compressTrades,
  decompressTrades,
  compressionRatio,
} from "./p2p/compression";
import { buildSimplifiedTrades, type SimplifiedTradesData, type CompactTradeData } from "./p2p/fast-hash";
import { logger } from "./logger";
import type { TradeProposal, CompressedTradesPayload } from "./p2p/types";

// Threshold for using fast hash vs merkle tree
const FAST_HASH_THRESHOLD = 1000;

// ============================================================================
// Configuration
// ============================================================================

interface BilateralBotConfig {
  /** P2P server port */
  p2pPort: number;
  /** How often to discover new peers (ms) */
  discoveryIntervalMs: number;
  /** How often to check for settlement opportunities (ms) */
  settlementCheckIntervalMs: number;
  /** Enable trading (vs just serving as P2P node) */
  tradingEnabled: boolean;
  /** Bot role: maker creates proposals, taker accepts them */
  role: "maker" | "taker";
  /** Default method for trades (maker only) */
  defaultMethod: string;
  /** Stake amount in wei */
  stakeAmount: bigint;
  /** Number of assets to include in portfolio */
  numAssets: number;
  /** Data source from Data Node */
  dataSource: string;
  /** Trading interval in ms (maker only) */
  tradingIntervalMs: number;
  /** Deadline offset in seconds */
  deadlineOffsetSecs: number;
  /** Maximum memory usage in GB before throttling */
  maxMemoryGb: number;
  /** Maximum number of active bets tracked in memory */
  maxActiveBets: number;
  /** TTL for pending proposals before eviction (ms) */
  pendingProposalTtlMs: number;
}

function loadConfigFromEnv(): BilateralBotConfig {
  // Check if using mock data - if so, use MOCK_ASSET_COUNT for numAssets
  const useMockData = process.env.USE_MOCK_DATA === "true";
  const mockAssetCount = parseInt(process.env.MOCK_ASSET_COUNT || "0", 10);
  const defaultNumAssets = useMockData && mockAssetCount > 0 ? mockAssetCount : parseInt(process.env.NUM_ASSETS || "50", 10);

  return {
    p2pPort: parseInt(process.env.P2P_PORT || "8080", 10),
    discoveryIntervalMs: parseInt(process.env.DISCOVERY_INTERVAL_MS || "60000", 10),
    settlementCheckIntervalMs: parseInt(process.env.SETTLEMENT_CHECK_INTERVAL_MS || "30000", 10),
    tradingEnabled: process.env.TRADING_ENABLED !== "false",
    role: (process.env.BOT_ROLE || (process.env.DEFAULT_METHOD ? "maker" : "taker")) as "maker" | "taker",
    defaultMethod: process.env.DEFAULT_METHOD || "up:0",
    stakeAmount: BigInt(process.env.STAKE_AMOUNT || "100000000000000000"), // 0.1 WIND default
    numAssets: defaultNumAssets,
    dataSource: process.env.DATA_SOURCE || "defi",
    tradingIntervalMs: parseInt(process.env.TRADING_INTERVAL_MS || "120000", 10), // 2 minutes
    deadlineOffsetSecs: parseInt(process.env.DEADLINE_OFFSET_SECS || "30", 10),
    maxMemoryGb: parseFloat(process.env.MAX_MEMORY_GB || "4"),
    maxActiveBets: parseInt(process.env.MAX_ACTIVE_BETS || "5", 10),
    pendingProposalTtlMs: parseInt(process.env.PENDING_PROPOSAL_TTL_MS || "60000", 10),
  };
}

// ============================================================================
// Active Bets Tracking
// ============================================================================

interface ActiveBet {
  betId: number;
  tree: MerkleTree;
  commitment: BetCommitmentData;
  counterparty: string;
  deadline: number;
  status: "pending" | "committed" | "settling" | "settled";
}

const activeBets: Map<number, ActiveBet> = new Map();
const pendingProposals: Map<string, { proposal: TradeProposal; tree: MerkleTree; from: string; createdAt: number }> = new Map();
let tradingInProgress = false;

// Metrics
const metrics = {
  totalBetsCreated: 0,
  totalBetsSettled: 0,
  totalErrors: 0,
  peakHeapMb: 0,
  peakRssMb: 0,
  startedAt: Date.now(),
};

// ============================================================================
// Memory Management
// ============================================================================

function checkMemory(maxGb: number): { heapMb: number; rssMb: number; pressure: boolean } {
  const mem = process.memoryUsage();
  const heapMb = mem.heapUsed / 1024 / 1024;
  const rssMb = mem.rss / 1024 / 1024;
  const maxMb = maxGb * 1024;
  const pressure = rssMb > maxMb * 0.85;

  if (heapMb > metrics.peakHeapMb) metrics.peakHeapMb = heapMb;
  if (rssMb > metrics.peakRssMb) metrics.peakRssMb = rssMb;

  return { heapMb, rssMb, pressure };
}

function cleanupSettledBets(): number {
  let removed = 0;
  for (const [betId, bet] of activeBets) {
    if (bet.status === "settled") {
      activeBets.delete(betId);
      removed++;
    }
  }
  return removed;
}

function cleanupExpiredProposals(ttlMs: number): number {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of pendingProposals) {
    if (now - entry.createdAt > ttlMs) {
      pendingProposals.delete(key);
      removed++;
    }
  }
  return removed;
}

function evictOldestBets(max: number): number {
  if (activeBets.size <= max) return 0;
  const sorted = [...activeBets.entries()].sort((a, b) => a[1].deadline - b[1].deadline);
  let evicted = 0;
  while (activeBets.size > max && sorted.length > 0) {
    const [betId] = sorted.shift()!;
    activeBets.delete(betId);
    evicted++;
  }
  return evicted;
}

// ============================================================================
// Auto-Trading Logic
// ============================================================================

async function fetchPricesFromDataNode(
  client: DataNodeClient,
  source: string,
  limit: number
): Promise<{ prices: Map<string, bigint>; tickers: string[] }> {
  const prices = new Map<string, bigint>();
  const tickers: string[] = [];

  // Check if we should use mock data for stress testing
  const useMockData = process.env.USE_MOCK_DATA === "true";
  const mockAssetCount = parseInt(process.env.MOCK_ASSET_COUNT || "0", 10);

  if (useMockData && mockAssetCount > 0) {
    logger.info("[AutoTrading] Generating mock data", { count: mockAssetCount });
    const startTime = Date.now();

    for (let i = 0; i < mockAssetCount; i++) {
      const ticker = `MOCK-${i.toString().padStart(7, "0")}`;
      // Random price between $0.01 and $10,000
      const priceUsd = Math.random() * 10000 + 0.01;
      const priceInWei = BigInt(Math.floor(priceUsd * 1e18));
      prices.set(ticker, priceInWei);
      tickers.push(ticker);
    }

    const elapsed = Date.now() - startTime;
    logger.info("[AutoTrading] Mock data generated", {
      count: mockAssetCount,
      timeMs: elapsed,
    });

    return { prices, tickers };
  }

  // Normal flow - fetch from Data Node
  try {
    if (source === "all") {
      // Fetch all prices across all sources via snapshot endpoint
      const startTime = Date.now();
      const snapshot = await client.getSnapshot();

      for (const asset of snapshot.prices) {
        const priceInWei = BigInt(Math.floor(Number(asset.value) * 1e18));
        if (priceInWei > 0n) {
          prices.set(asset.assetId, priceInWei);
          tickers.push(asset.assetId);
        }
      }

      logger.info("[AutoTrading] Fetched all-source snapshot", {
        total: snapshot.total,
        withPrice: prices.size,
        timeMs: Date.now() - startTime,
      });
    } else {
      const response = await client.getPrices(source, { limit });

      for (const asset of response.prices.slice(0, limit)) {
        const priceInWei = BigInt(Math.floor(Number(asset.value) * 1e18));
        prices.set(asset.assetId, priceInWei);
        tickers.push(asset.assetId);
      }
    }
  } catch (error) {
    logger.error("[AutoTrading] Failed to fetch prices from Data Node", {
      error: (error as Error).message,
    });
  }

  return { prices, tickers };
}

async function runMakerTradingLoop(
  config: BilateralBotConfig,
  chainClient: ChainClient,
  dataClient: DataNodeClient,
  discovery: PeerDiscovery | null
) {
  const myAddress = chainClient.getAddress();
  const vaultAddress = process.env.COLLATERAL_VAULT_ADDRESS!;
  const chainId = parseInt(process.env.CHAIN_ID || "111222333", 10);

  logger.info("[Maker] Starting trading loop", {
    interval: config.tradingIntervalMs,
    stakeAmount: config.stakeAmount.toString(),
    numAssets: config.numAssets,
  });

  const trade = async () => {
    if (tradingInProgress) {
      logger.warn("[Maker] Trade already in progress, skipping");
      return;
    }

    const mem = checkMemory(config.maxMemoryGb);
    if (mem.pressure) {
      logger.warn("[Maker] Memory pressure, skipping trade cycle", {
        rssMb: mem.rssMb.toFixed(0),
        maxGb: config.maxMemoryGb,
      });
      return;
    }

    tradingInProgress = true;
    try {
      // Check balance
      const balance = await chainClient.getVaultBalance();
      if (balance.available < config.stakeAmount) {
        logger.warn("[Maker] Insufficient balance for trading", {
          available: balance.available.toString(),
          required: config.stakeAmount.toString(),
        });
        return;
      }

      // Find a peer to trade with
      if (!discovery) {
        logger.warn("[Maker] No peer discovery configured");
        return;
      }

      const peers = await discovery.getHealthyPeers();
      if (peers.length === 0) {
        logger.warn("[Maker] No healthy peers available");
        return;
      }

      const peer = peers[0]; // Take first healthy peer
      logger.info("[Maker] Found peer", { peer: peer.address, endpoint: peer.endpoint });

      // Fetch prices from Data Node
      const { prices, tickers } = await fetchPricesFromDataNode(dataClient, config.dataSource, config.numAssets);
      if (prices.size === 0) {
        logger.warn("[Maker] No prices fetched from Data Node");
        return;
      }

      logger.info("[Maker] Fetched prices", { count: prices.size });

      // Build methods and price map
      const methods = tickers.map(() => config.defaultMethod);
      const entryPriceMap = new Map<number, bigint>();
      tickers.forEach((ticker, i) => {
        entryPriceMap.set(i, prices.get(ticker)!);
      });

      const snapshotId = `bilateral-${Date.now()}`;
      const useFastHash = tickers.length >= FAST_HASH_THRESHOLD;

      let tradesRoot: string;
      let treeTrades: Trade[];

      if (useFastHash) {
        // Use ultra-fast hash for large portfolios
        const startTime = Date.now();
        const simplified = buildSimplifiedTrades(snapshotId, tickers, methods, entryPriceMap);
        logger.info("[Maker] Built fast hash", {
          trades: tickers.length,
          timeMs: Date.now() - startTime,
        });
        tradesRoot = simplified.tradesHash;
        // Convert compact trades to full Trade format
        treeTrades = simplified.trades.map((t, i) => ({
          tradeId: `0x${i.toString(16).padStart(64, "0")}` as `0x${string}`,
          ticker: t.ticker,
          source: snapshotId,
          method: t.method,
          entryPrice: t.entryPrice,
          exitPrice: 0n,
          won: false,
          cancelled: false,
        }));
        logger.info("[Maker] Built fast hash", {
          hash: tradesRoot.slice(0, 20) + "...",
          trades: treeTrades.length,
          timeMs: Date.now() - startTime,
        });
      } else {
        // Use merkle tree for small portfolios (better for disputes)
        const tree = buildBilateralMerkleTree(snapshotId, methods, entryPriceMap, tickers);
        tradesRoot = tree.root;
        treeTrades = tree.trades;
        logger.info("[Maker] Built merkle tree", { root: tree.root, trades: tree.trades.length });
      }

      // Wrap in MerkleTree-like structure for compatibility
      const tree: MerkleTree = {
        snapshotId,
        root: tradesRoot as `0x${string}`,
        trades: treeTrades,
        leaves: [],
      };

      // Create commitment
      const deadline = Math.floor(Date.now() / 1000) + config.deadlineOffsetSecs;
      const expiry = Math.floor(Date.now() / 1000) + 300; // 5 min expiry for signatures
      const nonce = await chainClient.getVaultNonce();

      const commitment: BetCommitmentData = {
        tradesRoot: tree.root,
        creator: myAddress,
        filler: peer.address,
        creatorAmount: config.stakeAmount,
        fillerAmount: config.stakeAmount,
        deadline,
        nonce,
        expiry,
      };

      // Sign commitment
      const mySignature = await signBetCommitment(chainClient.getWallet(), commitment, vaultAddress, chainId);

      // Compress trades for efficient P2P transfer (JSON + gzip-1)
      const compressStart = Date.now();
      const compressedTrades = compressTrades(tree.trades);
      logger.info("[Maker] Compressed trades", {
        count: compressedTrades.count,
        timeMs: Date.now() - compressStart,
        ratio: compressionRatio(compressedTrades),
      });

      // Create proposal with compressed trades
      const proposal = {
        tradesRoot: tree.root,
        creator: myAddress,
        creatorAmount: config.stakeAmount.toString(),
        fillerAmount: config.stakeAmount.toString(),
        deadline,
        nonce: nonce.toString(),
        expiry,
        creatorSignature: mySignature,
        compressedTrades,
        snapshotId,
      };

      // Send proposal to peer
      const payloadJson = JSON.stringify(proposal);
      logger.info("[Maker] Sending proposal", {
        peer: peer.endpoint,
        payloadBytes: payloadJson.length,
      });

      const response = await fetch(`${peer.endpoint}/p2p/proposal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payloadJson,
      });

      const result = await response.json();

      if (result.accepted) {
        logger.info("[Maker] Proposal accepted!", {
          fillerSignature: result.signature?.slice(0, 20) + "...",
        });

        // Commit bet on-chain
        const commitResult = await chainClient.commitBilateralBet(
          commitment,
          mySignature,
          result.signature
        );

        if (commitResult.success) {
          const betId = parseInt(commitResult.betId!, 10);
          metrics.totalBetsCreated++;
          logger.info("[Maker] Bet committed on-chain!", { betId, txHash: commitResult.txHash });

          // Store locally
          storeMerkleTree(betId, tree);
          activeBets.set(betId, {
            betId,
            tree,
            commitment,
            counterparty: peer.address,
            deadline,
            status: "committed",
          });

          // Notify taker about the committed bet so they can track it for settlement
          try {
            await fetch(`${peer.endpoint}/p2p/bet-committed`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                betId,
                tradesRoot: tree.root,
                creator: myAddress,
                filler: peer.address,
                deadline,
                compressedTrades,
                snapshotId,
              }),
            });
            logger.info("[Maker] Notified taker of committed bet", { betId });
          } catch (error) {
            logger.warn("[Maker] Failed to notify taker", { error: (error as Error).message });
          }
        } else {
          logger.error("[Maker] Failed to commit bet", { error: commitResult.error });
        }
      } else {
        logger.warn("[Maker] Proposal rejected", { reason: result.reason });
      }
    } catch (error) {
      metrics.totalErrors++;
      logger.error("[Maker] Trading loop error", { error: (error as Error).message });
    } finally {
      tradingInProgress = false;
    }
  };

  // Run first trade immediately
  await trade();

  // Then run periodically
  setInterval(trade, config.tradingIntervalMs);
}

async function runSettlementLoop(
  config: BilateralBotConfig,
  chainClient: ChainClient,
  dataClient: DataNodeClient
) {
  const myAddress = chainClient.getAddress();
  const vaultAddress = process.env.COLLATERAL_VAULT_ADDRESS!;
  const chainId = parseInt(process.env.CHAIN_ID || "111222333", 10);

  logger.info("[Settlement] Starting settlement check loop", {
    interval: config.settlementCheckIntervalMs,
  });

  const checkSettlements = async () => {
    const now = Math.floor(Date.now() / 1000);

    for (const [betId, bet] of activeBets) {
      if (bet.status !== "committed") continue;
      if (now < bet.deadline) continue; // Not yet past deadline

      logger.info("[Settlement] Checking bet for settlement", { betId, deadline: bet.deadline });

      try {
        // Fetch exit prices (same as entry for now - real impl would fetch at deadline)
        const { prices } = await fetchPricesFromDataNode(dataClient, config.dataSource, bet.tree.trades.length);

        const exitPriceMap = new Map<number, bigint>();
        bet.tree.trades.forEach((trade, i) => {
          const exitPrice = prices.get(trade.ticker) ?? BigInt(trade.entryPrice);
          exitPriceMap.set(i, exitPrice);
        });

        // Compute outcome - use creator/filler from commitment (not counterparty which is confusing)
        const outcome = computeOutcome(bet.tree, exitPriceMap, bet.commitment.creator, bet.commitment.filler);

        logger.info("[Settlement] Computed outcome", {
          betId,
          makerWins: outcome.makerWins,
          takerWins: outcome.takerWins,
          winner: outcome.winner,
        });

        // Sign settlement
        bet.status = "settling";
        const settlementNonce = await chainClient.getVaultNonce();
        const settlement = await chainClient.signSettlementAgreement(betId, outcome.winner, settlementNonce);

        // Try to get counterparty signature via P2P
        // For now, if we're the winner, try to settle by agreement
        // If that fails, request arbitration

        if (outcome.winner.toLowerCase() === myAddress.toLowerCase()) {
          logger.info("[Settlement] We won! Attempting settlement...");

          // Try to settle by agreement first (would need counterparty sig)
          // For simplicity, request arbitration which keepers will handle
          const arbResult = await chainClient.requestArbitrationOnChain(betId);

          if (arbResult.success) {
            logger.info("[Settlement] Arbitration requested", { betId, txHash: arbResult.txHash });
            bet.status = "settled"; // Keepers will handle it
          } else {
            logger.error("[Settlement] Failed to request arbitration", { error: arbResult.error });
            bet.status = "committed"; // Retry later
          }
        } else {
          logger.info("[Settlement] Counterparty won, waiting for their settlement action");
        }

        // Store resolution
        storeResolution(betId, {
          betId,
          resolvedAt: new Date().toISOString(),
          winner: outcome.winner,
          makerWins: outcome.makerWins ?? 0,
          takerWins: outcome.takerWins ?? 0,
          totalTrades: bet.tree.trades.length,
          exitPrices: Object.fromEntries(Array.from(exitPriceMap.entries()).map(([k, v]) => [k, v.toString()])),
          resolvedTrades: [],
        });

      } catch (error) {
        logger.error("[Settlement] Error processing bet", { betId, error: (error as Error).message });
      }
    }
  };

  setInterval(checkSettlements, config.settlementCheckIntervalMs);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  logger.info("[BilateralBot] Starting bilateral P2P trading bot...");

  // Load configuration
  const config = loadConfigFromEnv();
  logger.info("[BilateralBot] Configuration loaded", {
    role: config.role,
    tradingEnabled: config.tradingEnabled,
    stakeAmount: config.stakeAmount.toString(),
  });

  // Initialize chain client
  const chainClient = createChainClientFromEnv();
  if (!chainClient) {
    logger.error("[BilateralBot] Failed to create chain client. Check AGENT_PRIVATE_KEY env var.");
    process.exit(1);
  }
  const address = chainClient.getAddress();
  logger.info(`[BilateralBot] Wallet address: ${address}`);

  // Initialize data node client
  const dataNodeUrl = process.env.DATA_NODE_URL;
  if (!dataNodeUrl) {
    logger.error("[BilateralBot] DATA_NODE_URL not set");
    process.exit(1);
  }
  const dataClient = new DataNodeClient({
    baseUrl: dataNodeUrl,
    wallet: chainClient.getWallet(),
    chainId: parseInt(process.env.CHAIN_ID || "111222333", 10),
    verifyingContract: process.env.COLLATERAL_ADDRESS || "0x4e5b65FB12d4165E22f5861D97A33BA45c006114",
  });
  logger.info(`[BilateralBot] Data Node: ${dataNodeUrl}`);

  // Check if BotRegistry and CollateralVault are configured
  const botRegistryAddress = process.env.BOT_REGISTRY_ADDRESS;
  const collateralVaultAddress = process.env.COLLATERAL_VAULT_ADDRESS;

  if (!botRegistryAddress || !collateralVaultAddress) {
    logger.error("[BilateralBot] Missing bilateral contract addresses");
    process.exit(1);
  }

  // Check bot registration status
  try {
    const isRegistered = await chainClient.isBotRegistered(address);
    if (!isRegistered) {
      logger.warn("[BilateralBot] Bot is not registered in BotRegistry");
    } else {
      logger.info("[BilateralBot] Bot is registered");
    }
  } catch (error) {
    logger.warn("[BilateralBot] Could not check bot registration", {
      error: (error as Error).message,
    });
  }

  // Start P2P server for incoming requests
  logger.info("[BilateralBot] Starting P2P server...");
  const serverConfig = createP2PServerConfigFromEnv();
  const chainId = parseInt(process.env.CHAIN_ID || "111222333", 10);
  const vaultAddress = collateralVaultAddress;

  const serverHandle = await startP2PServer(serverConfig, {
    // Handle incoming bilateral proposals (taker logic)
    onBilateralProposal: async (proposal, from) => {
      logger.info("[BilateralBot] Received trade proposal", {
        from,
        tradesRoot: proposal.tradesRoot,
        creatorAmount: proposal.creatorAmount.toString(),
      });

      // Auto-accept if we're a taker and trading is enabled
      if (config.role === "taker" && config.tradingEnabled) {
        // Memory pressure check
        const mem = checkMemory(config.maxMemoryGb);
        if (mem.pressure) {
          logger.warn("[Taker] Memory pressure, rejecting proposal", {
            rssMb: mem.rssMb.toFixed(0),
          });
          return { accepted: false, reason: "Memory pressure" };
        }

        // Active bets cap check
        if (activeBets.size >= config.maxActiveBets) {
          logger.warn("[Taker] Active bets cap reached, rejecting proposal", {
            activeBets: activeBets.size,
            max: config.maxActiveBets,
          });
          return { accepted: false, reason: "Active bets cap reached" };
        }

        try {
          // Check balance
          const balance = await chainClient.getVaultBalance();
          const requiredAmount = BigInt(proposal.fillerAmount);

          if (balance.available < requiredAmount) {
            logger.warn("[Taker] Insufficient balance", {
              available: balance.available.toString(),
              required: requiredAmount.toString(),
            });
            return { accepted: false, reason: "Insufficient balance" };
          }

          // Build commitment from proposal
          const commitment: BetCommitmentData = {
            tradesRoot: proposal.tradesRoot,
            creator: proposal.creator,
            filler: address,
            creatorAmount: BigInt(proposal.creatorAmount),
            fillerAmount: BigInt(proposal.fillerAmount),
            deadline: proposal.deadline,
            nonce: BigInt(proposal.nonce),
            expiry: proposal.expiry,
          };

          // Sign the commitment
          const mySignature = await signBetCommitment(
            chainClient.getWallet(),
            commitment,
            vaultAddress,
            chainId
          );

          logger.info("[Taker] Accepting proposal and signing", {
            tradesRoot: proposal.tradesRoot,
          });

          // Build tree from received trades (decompress if compressed)
          let trades: MerkleTree["trades"] = [];
          const snapshotId = proposal.snapshotId || "unknown";

          if (proposal.compressedTrades) {
            trades = decompressTrades(proposal.compressedTrades as CompressedTradesPayload, snapshotId);
            logger.info("[Taker] Decompressed trades", {
              count: trades.length,
              ratio: compressionRatio(proposal.compressedTrades as CompressedTradesPayload),
            });
          } else if (proposal.trades && proposal.trades.length > 0) {
            // Legacy uncompressed format
            trades = proposal.trades.map(t => ({
              ...t,
              entryPrice: BigInt(t.entryPrice),
              exitPrice: 0n,
              won: false,
              cancelled: false,
            }));
          }

          if (trades.length > 0) {
            const tree: MerkleTree = {
              root: proposal.tradesRoot,
              trades,
              leaves: [],
            };

            // Store for later settlement
            pendingProposals.set(proposal.tradesRoot, {
              proposal,
              tree,
              from,
              createdAt: Date.now(),
            });
          }

          return {
            accepted: true,
            signature: mySignature,
            signer: address,
          };
        } catch (error) {
          logger.error("[Taker] Error processing proposal", {
            error: (error as Error).message,
          });
          return { accepted: false, reason: "Internal error" };
        }
      }

      return { accepted: false, reason: "Not accepting proposals" };
    },

    onAcceptance: async (acceptance, from) => {
      logger.info("[BilateralBot] Received trade acceptance", {
        from,
        proposalHash: acceptance.proposalHash,
      });
      return { success: true };
    },

    onCommitmentSign: async (request, from) => {
      logger.info("[BilateralBot] Received commitment sign request", {
        from,
        tradesRoot: request.commitment.tradesRoot,
      });
      return { signature: "", signer: address };
    },

    onTradesReceived: async (request, from) => {
      logger.info("[BilateralBot] Received trades", {
        from,
        betId: request.betId,
        tradesCount: request.trades.length,
      });
      return { stored: true };
    },

    // Handle bet committed notification from maker (taker uses this to track bets)
    onBetCommitted: async (notification) => {
      logger.info("[BilateralBot] Received bet committed notification", {
        betId: notification.betId,
        creator: notification.creator,
        filler: notification.filler,
      });

      // Only track if we're the filler (taker)
      if (notification.filler.toLowerCase() === address.toLowerCase()) {
        // Build tree from notification trades (decompress if compressed)
        let trades: MerkleTree["trades"] = [];
        const snapshotId = notification.snapshotId || "unknown";

        if (notification.compressedTrades) {
          trades = decompressTrades(notification.compressedTrades as CompressedTradesPayload, snapshotId);
          logger.info("[Taker] Decompressed bet trades", {
            betId: notification.betId,
            count: trades.length,
          });
        } else if (notification.trades) {
          // Legacy uncompressed format
          trades = notification.trades.map(t => ({
            ...t,
            entryPrice: BigInt(t.entryPrice),
            exitPrice: 0n,
            won: false,
            cancelled: false,
          }));
        }

        const tree: MerkleTree = {
          root: notification.tradesRoot,
          trades,
          leaves: [],
        };

        // Build commitment data (we are the filler/taker)
        const commitment: BetCommitmentData = {
          tradesRoot: notification.tradesRoot,
          creator: notification.creator,  // The maker
          filler: notification.filler,    // Us (the taker)
          creatorAmount: config.stakeAmount,
          fillerAmount: config.stakeAmount,
          deadline: notification.deadline,
          nonce: BigInt(0), // Not needed for settlement
          expiry: 0,
        };

        // Store in activeBets for settlement tracking
        // counterparty is the maker (who we're betting against)
        // but for outcome computation, we need to pass creator and "our address" correctly
        activeBets.set(notification.betId, {
          betId: notification.betId,
          tree,
          commitment,
          counterparty: notification.creator, // Maker is our counterparty
          deadline: notification.deadline,
          status: "committed",
        });

        storeMerkleTree(notification.betId, tree);
        logger.info("[Taker] Tracking bet for settlement", { betId: notification.betId });
      }

      return { acknowledged: true };
    },
  });

  logger.info(`[BilateralBot] P2P server started on port ${serverConfig?.port || config.p2pPort}`);

  // Start peer discovery
  logger.info("[BilateralBot] Starting peer discovery...");
  const discovery = createPeerDiscoveryFromEnv(chainClient);
  if (!discovery) {
    logger.warn("[BilateralBot] Peer discovery not configured");
  } else {
    const peers = await discovery.getHealthyPeers();
    logger.info(`[BilateralBot] Discovered ${peers.length} active peers`);

    setInterval(async () => {
      try {
        const updatedPeers = await discovery.getHealthyPeers();
        logger.debug(`[BilateralBot] Peer discovery: ${updatedPeers.length} peers`);
      } catch (error) {
        logger.error("[BilateralBot] Peer discovery failed", {
          error: (error as Error).message,
        });
      }
    }, config.discoveryIntervalMs);
  }

  // Start auto-trading if enabled and role is maker
  if (config.tradingEnabled && config.role === "maker") {
    logger.info("[BilateralBot] Starting maker auto-trading loop...");
    runMakerTradingLoop(config, chainClient, dataClient, discovery);
  }

  // Start settlement loop
  runSettlementLoop(config, chainClient, dataClient);

  // Log startup complete
  logger.info("[BilateralBot] Bot started successfully!", {
    role: config.role,
    tradingEnabled: config.tradingEnabled,
    p2pPort: serverConfig?.port || config.p2pPort,
  });

  // Periodic memory manager (every 10s)
  setInterval(() => {
    const settled = cleanupSettledBets();
    const expired = cleanupExpiredProposals(config.pendingProposalTtlMs);
    const evicted = evictOldestBets(config.maxActiveBets);
    const mem = checkMemory(config.maxMemoryGb);

    if (settled > 0 || expired > 0 || evicted > 0 || mem.pressure) {
      logger.info("[MemoryManager] Cleanup", {
        settledRemoved: settled,
        expiredRemoved: expired,
        evicted,
        activeBets: activeBets.size,
        pendingProposals: pendingProposals.size,
        heapMb: mem.heapMb.toFixed(0),
        rssMb: mem.rssMb.toFixed(0),
        pressure: mem.pressure,
      });
    }

    if (mem.pressure) {
      if (typeof global.gc === "function") {
        global.gc();
        logger.info("[MemoryManager] Forced GC");
      }
    }
  }, 10_000);

  // Handle graceful shutdown
  const printMetrics = () => {
    const uptimeS = (Date.now() - metrics.startedAt) / 1000;
    const mem = process.memoryUsage();
    logger.info("[BilateralBot] Session Metrics", {
      uptimeS: uptimeS.toFixed(0),
      totalBetsCreated: metrics.totalBetsCreated,
      totalBetsSettled: metrics.totalBetsSettled,
      totalErrors: metrics.totalErrors,
      peakHeapMb: metrics.peakHeapMb.toFixed(0),
      peakRssMb: metrics.peakRssMb.toFixed(0),
      currentHeapMb: (mem.heapUsed / 1024 / 1024).toFixed(0),
      currentRssMb: (mem.rss / 1024 / 1024).toFixed(0),
      activeBets: activeBets.size,
      pendingProposals: pendingProposals.size,
    });
  };

  process.on("SIGINT", async () => {
    logger.info("[BilateralBot] Shutting down...");
    printMetrics();
    await serverHandle.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.info("[BilateralBot] Received SIGTERM, shutting down...");
    printMetrics();
    await serverHandle.stop();
    process.exit(0);
  });

  // Keep the process alive
  await new Promise(() => {});
}

// Run the bot
main().catch((error) => {
  logger.error("[BilateralBot] Fatal error:", { error: error.message, stack: error.stack });
  process.exit(1);
});
