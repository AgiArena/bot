import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { Config, AgentConfig, ClaudeSubscriptionTier } from "./types";
import { loadRateLimitsFromEnv, type RateLimits, DEFAULT_RATE_LIMITS } from "./rate-limiter";
import { loadCancellationConfigFromEnv, type CancellationConfig, DEFAULT_CANCELLATION_CONFIG } from "./cancellation";

/**
 * Extended configuration including rate limits and cancellation settings
 */
export interface ExtendedConfig extends Config {
  rateLimits: RateLimits;
  cancellation: CancellationConfig;
}

/**
 * Load extended configuration including env-based rate limits and cancellation
 */
export function loadExtendedConfig(configPath: string): ExtendedConfig {
  const baseConfig = loadConfig(configPath);
  return {
    ...baseConfig,
    rateLimits: loadRateLimitsFromEnv(),
    cancellation: loadCancellationConfigFromEnv(),
  };
}

/**
 * Get safe extended config for logging (without sensitive data)
 */
export function getSafeExtendedConfig(config: ExtendedConfig): {
  walletAddress: string;
  capital: number;
  riskProfile: string;
  rateLimits: RateLimits;
  cancellation: CancellationConfig;
} {
  return {
    walletAddress: `${config.agent.walletAddress.slice(0, 6)}...${config.agent.walletAddress.slice(-4)}`,
    capital: config.agent.capital,
    riskProfile: config.agent.riskProfile,
    rateLimits: config.rateLimits,
    cancellation: config.cancellation,
  };
}

/**
 * Validates an Ethereum address format
 */
function isValidEthereumAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Validates the agent configuration has all required fields
 */
function validateConfig(config: unknown): config is Config {
  if (!config || typeof config !== "object") {
    return false;
  }

  const c = config as Record<string, unknown>;
  if (!c.agent || typeof c.agent !== "object") {
    return false;
  }

  const agent = c.agent as Record<string, unknown>;

  // Required fields
  if (typeof agent.walletAddress !== "string" || !agent.walletAddress) {
    throw new Error("Config validation failed: walletAddress is required");
  }
  if (!isValidEthereumAddress(agent.walletAddress)) {
    throw new Error("Config validation failed: walletAddress must be a valid Ethereum address (0x + 40 hex chars)");
  }
  if (typeof agent.capital !== "number" || agent.capital <= 0) {
    throw new Error("Config validation failed: capital must be a positive number");
  }

  // Optional fields with defaults
  if (agent.riskProfile !== undefined) {
    const validProfiles = ["conservative", "balanced", "aggressive"];
    if (!validProfiles.includes(agent.riskProfile as string)) {
      throw new Error(`Config validation failed: riskProfile must be one of ${validProfiles.join(", ")}`);
    }
  }

  if (agent.researchTerminals !== undefined && typeof agent.researchTerminals !== "number") {
    throw new Error("Config validation failed: researchTerminals must be a number");
  }

  if (agent.researchInterval !== undefined && typeof agent.researchInterval !== "number") {
    throw new Error("Config validation failed: researchInterval must be a number");
  }

  if (agent.claudeSubscription !== undefined) {
    const validTiers = ["free", "pro", "team"];
    if (!validTiers.includes(agent.claudeSubscription as string)) {
      throw new Error(`Config validation failed: claudeSubscription must be one of ${validTiers.join(", ")}`);
    }
  }

  return true;
}

/**
 * Gets private key from environment variable (secure)
 */
function getPrivateKey(): string {
  const privateKey = process.env.AGENT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("Config validation failed: AGENT_PRIVATE_KEY environment variable is required");
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error("Config validation failed: AGENT_PRIVATE_KEY must be a valid private key (0x + 64 hex chars)");
  }
  return privateKey;
}

/**
 * Load and validate configuration from config.json
 */
export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}. Run createDefaultConfig() first.`);
  }

  const content = readFileSync(configPath, "utf-8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in config file: ${configPath}`);
  }

  if (!validateConfig(parsed)) {
    throw new Error(`Invalid config structure in: ${configPath}`);
  }

  // Get private key from environment variable (secure)
  const privateKey = getPrivateKey();

  // Epic 8: Load category betting config from env vars
  const tradeCategories = process.env.TRADE_CATEGORIES?.split(',').filter(c => c.trim()) || ['crypto'];
  const tradeListSize = (process.env.TRADE_LIST_SIZE || '10K') as '1K' | '10K' | '100K';

  // Apply defaults for optional fields (Pro tier defaults for backward compatibility)
  const config: Config = {
    agent: {
      walletAddress: (parsed.agent as AgentConfig).walletAddress,
      privateKey,
      capital: (parsed.agent as AgentConfig).capital,
      riskProfile: (parsed.agent as AgentConfig).riskProfile || "balanced",
      researchTerminals: (parsed.agent as AgentConfig).researchTerminals || 5,
      researchInterval: (parsed.agent as AgentConfig).researchInterval || 30,
      claudeSubscription: (parsed.agent as AgentConfig).claudeSubscription || "pro",
      tradeCategories,
      tradeListSize,
    }
  };

  return config;
}

/**
 * Config file structure (privateKey comes from env var, not file)
 */
interface ConfigFile {
  agent: Omit<AgentConfig, "privateKey">;
}

/**
 * Create a default config file with placeholder values
 * Note: privateKey should be set via AGENT_PRIVATE_KEY env var, not in this file
 */
export function createDefaultConfig(configPath: string): void {
  const defaultConfig: ConfigFile = {
    agent: {
      walletAddress: "0x0000000000000000000000000000000000000000",
      capital: 1000,
      riskProfile: "balanced",
      researchTerminals: 5,
      researchInterval: 30,
      claudeSubscription: "pro"
    }
  };

  // Ensure directory exists
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
}

/**
 * Get a safe version of config for logging (without sensitive data)
 */
export function getSafeConfig(config: Config): {
  walletAddress: string;
  capital: number;
  riskProfile: string;
  researchTerminals: number;
  researchInterval: number;
  claudeSubscription: ClaudeSubscriptionTier;
} {
  return {
    walletAddress: `${config.agent.walletAddress.slice(0, 6)}...${config.agent.walletAddress.slice(-4)}`,
    capital: config.agent.capital,
    riskProfile: config.agent.riskProfile,
    researchTerminals: config.agent.researchTerminals,
    researchInterval: config.agent.researchInterval,
    claudeSubscription: config.agent.claudeSubscription
  };
}
