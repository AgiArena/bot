#!/usr/bin/env bun
/**
 * Agent initialization CLI
 * Run: npx agiarena init OR bun run src/init.ts init
 *
 * Guides users through 4 questions to set up a new agent:
 * 1. Private key
 * 2. Capital amount
 * 3. Bet sizing strategy
 * 4. Risk profile
 */

import { Wallet } from "ethers";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import * as readline from "readline";
import type { InitConfig, TierConfig, ClaudeSubscriptionTier } from "./types";

// Bet sizing options
const BET_SIZING_OPTIONS = {
  conservative: { min: 1, max: 2, label: "Conservative: 1-2% of capital per bet" },
  moderate: { min: 3, max: 5, label: "Moderate: 3-5% of capital per bet" },
  aggressive: { min: 5, max: 10, label: "Aggressive: 5-10% of capital per bet" },
} as const;

// Risk profile options
const RISK_PROFILE_OPTIONS = {
  risk_averse: { label: "Risk-Averse: Focus on high-probability markets" },
  balanced: { label: "Balanced: Mix of safe and opportunistic" },
  risk_seeking: { label: "Risk-Seeking: Aggressive on high-upside opportunities" },
} as const;

// Subscription tier options (Story 4.2b)
export const SUBSCRIPTION_TIER_OPTIONS = {
  free: {
    label: "Free: 30 requests/5 min (personal testing only)",
    config: {
      maxRequestsPer5Min: 30,
      recommendedAgents: 1,
      researchTerminals: 2,
      researchInterval: 60,
    },
    warningMessage: "Free tier: Only deploy 1 agent. Multiple agents will exhaust limits quickly.",
  },
  pro: {
    label: "Pro: 150 requests/5 min (1-2 agents recommended)",
    config: {
      maxRequestsPer5Min: 150,
      recommendedAgents: 2,
      researchTerminals: 5,
      researchInterval: 30,
    },
    warningMessage: null,
  },
  team: {
    label: "Team/Enterprise: 300+ requests/5 min (3-5 agents recommended)",
    config: {
      maxRequestsPer5Min: 300,
      recommendedAgents: 5,
      researchTerminals: 8,
      researchInterval: 30,
    },
    warningMessage: null,
  },
} as const;

/**
 * Get tier configuration for a subscription tier
 */
export function getTierConfig(tier: ClaudeSubscriptionTier): TierConfig {
  const tierOption = SUBSCRIPTION_TIER_OPTIONS[tier];
  return {
    requestLimit: { ...tierOption.config },
    warningMessage: tierOption.warningMessage,
  };
}

/**
 * Create a readline interface for user input
 */
function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Prompt the user with a question and return their answer
 */
function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for masked input (shows asterisks) - for private keys
 */
async function promptMasked(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();

    let input = "";

    const onData = (char: Buffer) => {
      const c = char.toString();

      if (c === "\n" || c === "\r") {
        stdin.removeListener("data", onData);
        if (stdin.isTTY) {
          stdin.setRawMode(wasRaw || false);
        }
        process.stdout.write("\n");
        resolve(input);
      } else if (c === "\u0003") {
        // Ctrl+C
        process.exit(0);
      } else if (c === "\u007F" || c === "\b") {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else {
        input += c;
        process.stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

/**
 * Validate private key format (66 chars, 0x prefix, valid hex)
 */
export function validatePrivateKey(key: string): { valid: boolean; error?: string } {
  if (!key) {
    return { valid: false, error: "Private key is required" };
  }

  if (!key.startsWith("0x")) {
    return { valid: false, error: "Private key must start with 0x" };
  }

  if (key.length !== 66) {
    return { valid: false, error: `Private key must be 66 characters (got ${key.length})` };
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) {
    return { valid: false, error: "Private key must contain only hex characters (0-9, a-f, A-F)" };
  }

  // Try to derive an address to verify the key is valid
  try {
    new Wallet(key);
    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid private key - could not derive wallet address" };
  }
}

/**
 * Derive wallet address from private key
 */
export function deriveWalletAddress(privateKey: string): string {
  const wallet = new Wallet(privateKey);
  return wallet.address.toLowerCase();
}

/**
 * Parse capital input in various formats
 * Supports: "$1000", "1000", "1k", "1.5k", "10K", "1,000"
 */
export function parseCapital(input: string): { valid: boolean; amount?: number; error?: string } {
  if (!input) {
    return { valid: false, error: "Capital amount is required" };
  }

  // Remove $ prefix, commas, and whitespace
  let cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "").toLowerCase();

  // Handle k/K suffix (thousands)
  let multiplier = 1;
  if (cleaned.endsWith("k")) {
    multiplier = 1000;
    cleaned = cleaned.slice(0, -1);
  }

  // Parse the number
  const amount = parseFloat(cleaned) * multiplier;

  if (isNaN(amount)) {
    return { valid: false, error: 'Invalid capital amount. Enter a positive number (e.g., "$1000", "1k")' };
  }

  if (amount <= 0) {
    return { valid: false, error: "Capital must be greater than 0" };
  }

  return { valid: true, amount };
}

/**
 * Format address for display (0x1234...5678)
 */
function formatAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Format USD amount with commas
 */
function formatUSD(amount: number): string {
  return `$${amount.toLocaleString()}`;
}

/**
 * Generate agent name from wallet address
 */
function generateAgentName(address: string): string {
  // Use last 8 chars of address for uniqueness
  const suffix = address.slice(-8).toLowerCase();
  return `agent-${suffix}`;
}

/**
 * Create wallet verification signature
 * @returns Object containing signature, message, and timestamp for storage
 *
 * CRITICAL: Message format must match backend expectations:
 * "AgiArena Agent Registration: {walletAddress} at {timestamp}"
 */
async function createSignature(privateKey: string, walletAddress: string): Promise<{ signature: string; message: string; timestamp: number }> {
  const wallet = new Wallet(privateKey);
  const timestamp = Date.now();
  // CRITICAL: This message format MUST match backend validation in agents.rs
  const message = `AgiArena Agent Registration: ${walletAddress.toLowerCase()} at ${timestamp}`;
  const signature = await wallet.signMessage(message);
  return { signature, message, timestamp };
}

/**
 * Register agent with backend API
 *
 * Sends registration request with wallet signature verification.
 * Handles response codes:
 * - 201: Success
 * - 400: Invalid signature
 * - 409: Wallet already registered
 * - 422: Malformed request
 */
async function registerWithBackend(
  config: InitConfig,
  signature: string,
  message: string
): Promise<{ success: boolean; agentId?: number; error?: string }> {
  const apiUrl = process.env.BACKEND_API_URL || "http://localhost:3001";

  try {
    const response = await fetch(`${apiUrl}/api/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        walletAddress: config.walletAddress,
        signature,
        message,
        totalCapital: config.capital,
        riskProfile: config.riskProfile,
        betSizeMin: config.betSizeMin,
        betSizeMax: config.betSizeMax,
      }),
    });

    if (!response.ok) {
      // Handle specific error codes
      if (response.status === 409) {
        return { success: false, error: "Wallet already registered" };
      }
      if (response.status === 400) {
        return { success: false, error: "Invalid signature" };
      }
      if (response.status === 422) {
        const errorData = await response.json().catch(() => ({})) as { error?: string };
        return { success: false, error: errorData.error || "Malformed request" };
      }
      const errorText = await response.text();
      return { success: false, error: `Backend returned ${response.status}: ${errorText}` };
    }

    // Parse successful response
    const data = await response.json() as { agentId?: number };
    return { success: true, agentId: data.agentId };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: errorMessage };
  }
}

/**
 * Agent config file structure (stored in agent directory)
 */
interface AgentConfigFile {
  walletAddress: string;
  capital: number;
  betSizeMin: number;
  betSizeMax: number;
  riskProfile: string;
  claudeSubscription: ClaudeSubscriptionTier;
  requestLimit: {
    maxRequestsPer5Min: number;
    recommendedAgents: number;
    researchTerminals: number;
    researchInterval: number;
  };
  createdAt: string;
  registration?: {
    signature: string;
    message: string;
    timestamp: number;
    agentId?: number;
    status: "success" | "failed" | "pending";
    error?: string;
  };
}

/**
 * Create agent directory and config files
 */
function createAgentFiles(
  botDir: string,
  agentName: string,
  config: InitConfig,
  registration?: { signature: string; message: string; timestamp: number; agentId?: number; success: boolean; error?: string }
): void {
  // Create agents directory if it doesn't exist
  const agentsDir = join(botDir, "agents");
  if (!existsSync(agentsDir)) {
    mkdirSync(agentsDir, { recursive: true });
  }

  // Create agent-specific directory
  const agentDir = join(agentsDir, agentName);
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true });
  }

  // Get tier configuration
  const tierConfig = getTierConfig(config.claudeSubscription);

  // Create agent config.json (without private key - stored in env)
  const agentConfig: AgentConfigFile = {
    walletAddress: config.walletAddress,
    capital: config.capital,
    betSizeMin: config.betSizeMin,
    betSizeMax: config.betSizeMax,
    riskProfile: config.riskProfile,
    claudeSubscription: config.claudeSubscription,
    requestLimit: tierConfig.requestLimit,
    createdAt: new Date().toISOString(),
  };

  // Store registration info if provided
  if (registration) {
    agentConfig.registration = {
      signature: registration.signature,
      message: registration.message,
      timestamp: registration.timestamp,
      ...(registration.agentId !== undefined && { agentId: registration.agentId }),
      status: registration.success ? "success" : "failed",
      ...(registration.error && { error: registration.error }),
    };
  }

  writeFileSync(join(agentDir, "config.json"), JSON.stringify(agentConfig, null, 2));
}

/**
 * Update main bot config.json with agent reference
 * Merges with existing config to preserve other agents
 */
function updateMainConfig(botDir: string, agentName: string, config: InitConfig): void {
  const configPath = join(botDir, "config.json");

  // Map risk profile for handler compatibility
  const handlerRiskProfile: "conservative" | "balanced" | "aggressive" =
    config.riskProfile === "risk_averse"
      ? "conservative"
      : config.riskProfile === "risk_seeking"
        ? "aggressive"
        : "balanced";

  // Load existing config if it exists
  let existingConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const content = require("fs").readFileSync(configPath, "utf-8");
      existingConfig = JSON.parse(content);
    } catch {
      // If parsing fails, start fresh
      existingConfig = {};
    }
  }

  // Get tier configuration
  const tierConfig = getTierConfig(config.claudeSubscription);

  // Merge with new agent config
  const mainConfig = {
    ...existingConfig,
    agent: {
      walletAddress: config.walletAddress,
      capital: config.capital,
      riskProfile: handlerRiskProfile,
      researchTerminals: tierConfig.requestLimit.researchTerminals,
      researchInterval: tierConfig.requestLimit.researchInterval,
      claudeSubscription: config.claudeSubscription,
    },
    requestLimit: tierConfig.requestLimit,
    activeAgent: agentName,
    // Preserve or initialize agents list
    agents: {
      ...(existingConfig.agents as Record<string, unknown> || {}),
      [agentName]: {
        walletAddress: config.walletAddress,
        createdAt: new Date().toISOString(),
      },
    },
  };

  writeFileSync(configPath, JSON.stringify(mainConfig, null, 2));
}

/**
 * Display menu and get selection
 */
async function selectOption(
  rl: readline.Interface,
  prompt: string,
  options: string[]
): Promise<number> {
  console.log(`\n${prompt}`);
  options.forEach((opt, i) => {
    console.log(`  ${i + 1}. ${opt}`);
  });

  while (true) {
    const answer = await promptFn(rl, "\nEnter choice (1-" + options.length + "): ");
    const choice = parseInt(answer, 10);

    if (choice >= 1 && choice <= options.length) {
      return choice - 1;
    }

    console.log(`Invalid choice. Please enter a number between 1 and ${options.length}`);
  }
}

// Reference to prompt function for use in selectOption
const promptFn = prompt;

/**
 * Main initialization flow
 */
async function runInit(): Promise<void> {
  const botDir = dirname(dirname(import.meta.path));
  const rl = createReadline();

  console.log("\n=== AgiArena Agent Setup ===\n");
  console.log("This wizard will configure a new agent in 5 questions.\n");

  try {
    // Question 1: Private Key
    console.log("Question 1 of 5: Private Key");
    let privateKey: string;
    let walletAddress: string;

    while (true) {
      privateKey = await promptMasked(rl, "What's your agent's wallet private key? (0x...): ");

      const validation = validatePrivateKey(privateKey);
      if (!validation.valid) {
        console.log(`\nError: ${validation.error}`);
        console.log("Private key must be 66 characters: 0x followed by 64 hex characters.\n");
        continue;
      }

      walletAddress = deriveWalletAddress(privateKey);
      console.log(`\nWallet: ${formatAddress(walletAddress)}`);
      break;
    }

    // Question 2: Capital
    console.log("\nQuestion 2 of 5: Capital");
    let capital: number;

    while (true) {
      const capitalInput = await prompt(rl, 'What\'s your total capital for betting? (e.g., "$1000", "1k"): ');

      const parsed = parseCapital(capitalInput);
      if (!parsed.valid) {
        console.log(`\nError: ${parsed.error}\n`);
        continue;
      }

      capital = parsed.amount!;
      console.log(`\nCapital: ${formatUSD(capital)} USDC`);
      break;
    }

    // Question 3: Bet Sizing
    console.log("\nQuestion 3 of 5: Bet Sizing Strategy");
    const betSizingOptions = Object.values(BET_SIZING_OPTIONS).map((o) => o.label);
    const betSizingChoice = await selectOption(rl, "What's your bet sizing strategy?", betSizingOptions);

    const betSizingKey = Object.keys(BET_SIZING_OPTIONS)[betSizingChoice] as keyof typeof BET_SIZING_OPTIONS;
    const betSizing = BET_SIZING_OPTIONS[betSizingKey];

    console.log(`\nBet size: ${betSizing.min}-${betSizing.max}% per bet`);

    // Question 4: Risk Profile
    console.log("\nQuestion 4 of 5: Risk Profile");
    const riskOptions = Object.values(RISK_PROFILE_OPTIONS).map((o) => o.label);
    const riskChoice = await selectOption(rl, "What's your risk profile?", riskOptions);

    const riskProfile = Object.keys(RISK_PROFILE_OPTIONS)[riskChoice] as InitConfig["riskProfile"];
    console.log(`\nRisk: ${RISK_PROFILE_OPTIONS[riskProfile].label}`);

    // Question 5: Claude Code Subscription Tier
    console.log("\nQuestion 5 of 5: Claude Code Subscription Tier");
    const subscriptionOptions = Object.values(SUBSCRIPTION_TIER_OPTIONS).map((o) => o.label);
    const subscriptionChoice = await selectOption(rl, "What's your Claude Code subscription tier?", subscriptionOptions);

    const claudeSubscription = Object.keys(SUBSCRIPTION_TIER_OPTIONS)[subscriptionChoice] as ClaudeSubscriptionTier;
    const tierConfig = getTierConfig(claudeSubscription);
    console.log(`\nSubscription: ${SUBSCRIPTION_TIER_OPTIONS[claudeSubscription].label}`);

    // Display warning for free tier
    if (tierConfig.warningMessage) {
      console.log(`\n${tierConfig.warningMessage}`);
    }

    // Build configuration
    const config: InitConfig = {
      walletAddress,
      privateKey,
      capital,
      betSizeMin: betSizing.min,
      betSizeMax: betSizing.max,
      riskProfile,
      claudeSubscription,
    };

    // Generate agent name
    const agentName = generateAgentName(walletAddress);

    console.log("\n=== Creating Agent Configuration ===\n");

    // Create signature and register with backend first
    console.log("Creating wallet signature...");
    const { signature, message, timestamp } = await createSignature(privateKey, walletAddress);

    console.log("Registering with backend...");
    const registration = await registerWithBackend(config, signature, message);

    // Store registration result for agent config
    const registrationInfo = {
      signature,
      message,
      timestamp,
      success: registration.success,
      agentId: registration.agentId,
      error: registration.error,
    };

    if (registration.success) {
      console.log(`  Registered with backend successfully (Agent ID: ${registration.agentId})`);
    } else if (registration.error === "Wallet already registered") {
      console.log("  Wallet already registered with backend - using existing registration.");
    } else {
      console.log(`  Warning: Could not register with backend. ${registration.error}`);
      console.log("  Agent will work locally but won't appear on leaderboard.");
      console.log("  Registration signature saved - you can retry later.");
    }

    // Create agent files (with registration info)
    console.log("Creating agent directory...");
    createAgentFiles(botDir, agentName, config, registrationInfo);
    console.log(`  Created: bot/agents/${agentName}/config.json`);

    // Update main config (merges with existing)
    console.log("Updating main config...");
    updateMainConfig(botDir, agentName, config);
    console.log("  Updated: bot/config.json");

    // Display final confirmation
    const betMinDollars = Math.floor((capital * betSizing.min) / 100);
    const betMaxDollars = Math.floor((capital * betSizing.max) / 100);

    console.log("\n=== Agent Configured! ===\n");
    console.log(`Name: ${agentName}`);
    console.log(`Wallet: ${formatAddress(walletAddress)}`);
    console.log(`Capital: ${formatUSD(capital)} USDC`);
    console.log(`Bet size: ${betSizing.min}-${betSizing.max}% (${formatUSD(betMinDollars)}-${formatUSD(betMaxDollars)} per bet)`);
    console.log(`Risk: ${riskProfile.replace("_", "-").replace(/\b\w/g, (c) => c.toUpperCase())}`);

    // Display subscription tier configuration (Story 4.2b)
    const tierLabel = claudeSubscription.charAt(0).toUpperCase() + claudeSubscription.slice(1);
    console.log(`\nClaude Code Subscription: ${tierLabel}`);
    console.log(`Research Terminals: ${tierConfig.requestLimit.researchTerminals} (optimal for ${tierLabel} tier)`);
    console.log(`Research Interval: ${tierConfig.requestLimit.researchInterval} minutes`);
    console.log(`Recommended Agents: 1-${tierConfig.requestLimit.recommendedAgents} agents max for your subscription`);

    // Display warning for free tier
    if (tierConfig.warningMessage) {
      console.log(`\n${tierConfig.warningMessage}`);
    }

    console.log("\nIMPORTANT: Set the private key as an environment variable:");
    console.log("  export AGENT_PRIVATE_KEY=\"<your-private-key>\"");
    console.log("  (Use the same private key you entered above)");

    console.log("\nRun: bun run handler");
    console.log("");

    rl.close();
  } catch (error) {
    rl.close();
    throw error;
  }
}

/**
 * CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "init" || !command) {
    await runInit();
  } else {
    console.log("Usage: agiarena init");
    console.log("");
    console.log("Commands:");
    console.log("  init    Configure a new agent through guided prompts");
    process.exit(1);
  }
}

// Run if executed directly
main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});

export { runInit, createAgentFiles, updateMainConfig, registerWithBackend, createSignature };
