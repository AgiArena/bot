/**
 * Claude Code subscription tier type
 */
export type ClaudeSubscriptionTier = "free" | "pro" | "team";

/**
 * Request limit configuration per subscription tier
 */
export interface RequestLimit {
  maxRequestsPer5Min: number;
  recommendedAgents: number;
  researchTerminals: number;
  researchInterval: number;
}

/**
 * Tier configuration with request limits and optional warning
 */
export interface TierConfig {
  requestLimit: RequestLimit;
  warningMessage: string | null;
}

/**
 * Agent configuration from config.json
 */
export interface AgentConfig {
  walletAddress: string;
  privateKey: string;
  capital: number;
  riskProfile: "conservative" | "balanced" | "aggressive";
  researchTerminals: number;
  researchInterval: number;
  claudeSubscription: ClaudeSubscriptionTier;
  // Epic 8: Category-based betting configuration
  tradeCategories?: string[];      // Categories to bet on (default: ['crypto'])
  tradeListSize?: '1K' | '10K' | '100K';  // List size (default: '10K')
}

/**
 * Init configuration from CLI setup wizard
 * Maps to backend API registration format
 */
export interface InitConfig {
  walletAddress: string;
  privateKey: string;
  capital: number;
  betSizeMin: number;
  betSizeMax: number;
  riskProfile: "risk_averse" | "balanced" | "risk_seeking";
  claudeSubscription: ClaudeSubscriptionTier;
}

/**
 * Root configuration structure
 */
export interface Config {
  agent: AgentConfig;
}

/**
 * Handler state persisted to state.json
 */
export interface HandlerState {
  agentPid: number | null;
  startTime: number | null;
  restartCount: number;
  lastRestartAt: string | null;
}

/**
 * Crash log entry
 */
export interface CrashLogEntry {
  timestamp: string;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
}

/**
 * Health check response
 */
export interface HealthResponse {
  status: "healthy" | "unhealthy" | "restarting";
  agent: {
    pid: number | null;
    uptime: number;
    restartCount: number;
    lastRestartAt: string | null;
  };
  config: {
    walletAddress: string;
    capital: number;
    riskProfile: string;
    researchTerminals: number;
    researchInterval: number;
    claudeSubscription: ClaudeSubscriptionTier;
  };
}

/**
 * Parameters for creating health response
 */
export interface HealthParams {
  agentPid: number | null;
  uptime: number;
  restartCount: number;
  lastRestartAt: string | null;
  config: {
    walletAddress: string;
    capital: number;
    riskProfile: string;
    researchTerminals: number;
    researchInterval: number;
    claudeSubscription: ClaudeSubscriptionTier;
  };
}

/**
 * Agent workflow phase
 */
export type AgentPhase = "research" | "evaluation" | "execution" | "idle";

/**
 * Matched bet record for tracking trading activity
 */
export interface MatchedBet {
  betId: string;
  amount: string; // USDC amount as string for precision
  evScore: number; // Expected value score when matched
  matchedAt: number; // Unix timestamp
  status: "matched" | "won" | "lost" | "pending";
  txHash: string; // Transaction hash on Base
}

/**
 * Agent trading state persisted to agent/state.json
 * Separate from HandlerState which tracks handler-level concerns
 */
export interface AgentState {
  agentAddress: string;
  totalCapital: number;
  currentBalance: number;
  matchedBets: MatchedBet[];
  lastResearchAt: number | null;
  researchJobId: string | null;
  phase: AgentPhase;
}

// Note: Resilience types removed in simplification.
// See unified-state.ts for the new simplified state management.

// ============================================================================
// Epic 8: Category-based Betting Types
// ============================================================================

/**
 * Valid list sizes for category betting
 */
export type TradeListSize = '1K' | '10K' | '100K' | 'ALL';

/**
 * Snapshot from backend API
 * Represents a point-in-time capture of market rankings
 */
export interface Snapshot {
  id: string;               // "crypto-2026-01-26-12-30"
  categoryId: string;
  createdAt: string;        // ISO timestamp
  expiresAt: string;        // ISO timestamp
  isCurrent: boolean;
}

/**
 * Trade position from a snapshot trade list
 */
export interface Trade {
  id: string;               // "BTC/coingecko/price"
  ticker: string;
  source: string;           // 'coingecko' | 'polymarket' | 'gamma'
  method: string;           // 'price' | 'outcome'
  position: 'LONG' | 'SHORT' | 'YES' | 'NO';
  entryPrice: number;
}

/**
 * A complete trade list from a snapshot
 */
export interface TradeList {
  snapshotId: string;
  categoryId: string;
  size: TradeListSize;
  trades: Trade[];
  tradesHash: string;       // keccak256 of trades JSON
}
