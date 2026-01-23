/**
 * Unit tests for agent initialization CLI
 * Tests input parsing and validation functions
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { validatePrivateKey, parseCapital, deriveWalletAddress, createAgentFiles, updateMainConfig, createSignature } from "../src/init";
import type { InitConfig } from "../src/types";
import { existsSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

describe("validatePrivateKey", () => {
  test("accepts valid 66-character private key with 0x prefix", () => {
    const validKey = "0x" + "a".repeat(64);
    const result = validatePrivateKey(validKey);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("accepts valid private key with mixed case hex", () => {
    const validKey = "0xABCDEF0123456789abcdef0123456789ABCDef0123456789abcdef0123456789";
    const result = validatePrivateKey(validKey);
    expect(result.valid).toBe(true);
  });

  test("rejects empty string", () => {
    const result = validatePrivateKey("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("required");
  });

  test("rejects key without 0x prefix", () => {
    const invalidKey = "a".repeat(64);
    const result = validatePrivateKey(invalidKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("0x");
  });

  test("rejects key that is too short", () => {
    const shortKey = "0x" + "a".repeat(32);
    const result = validatePrivateKey(shortKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("66 characters");
  });

  test("rejects key that is too long", () => {
    const longKey = "0x" + "a".repeat(70);
    const result = validatePrivateKey(longKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("66 characters");
  });

  test("rejects key with invalid hex characters", () => {
    const invalidKey = "0x" + "g".repeat(64);
    const result = validatePrivateKey(invalidKey);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("hex");
  });

  test("rejects key with spaces", () => {
    const keyWithSpaces = "0x" + "a ".repeat(32);
    const result = validatePrivateKey(keyWithSpaces);
    expect(result.valid).toBe(false);
  });
});

describe("deriveWalletAddress", () => {
  test("derives correct lowercase address from private key", () => {
    // Well-known test private key
    const privateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const address = deriveWalletAddress(privateKey);

    // Hardhat account #0 address
    expect(address).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    expect(address).toBe(address.toLowerCase());
  });

  test("returns address with 0x prefix", () => {
    const privateKey = "0x" + "1".repeat(64);
    const address = deriveWalletAddress(privateKey);
    expect(address.startsWith("0x")).toBe(true);
  });

  test("returns 42-character address", () => {
    const privateKey = "0x" + "2".repeat(64);
    const address = deriveWalletAddress(privateKey);
    expect(address.length).toBe(42);
  });
});

describe("parseCapital", () => {
  test("parses simple number", () => {
    const result = parseCapital("1000");
    expect(result.valid).toBe(true);
    expect(result.amount).toBe(1000);
  });

  test("parses number with $ prefix", () => {
    const result = parseCapital("$1000");
    expect(result.valid).toBe(true);
    expect(result.amount).toBe(1000);
  });

  test("parses number with commas", () => {
    const result = parseCapital("1,000");
    expect(result.valid).toBe(true);
    expect(result.amount).toBe(1000);
  });

  test("parses number with $ and commas", () => {
    const result = parseCapital("$1,000,000");
    expect(result.valid).toBe(true);
    expect(result.amount).toBe(1000000);
  });

  test("parses lowercase k suffix (thousands)", () => {
    const result = parseCapital("1k");
    expect(result.valid).toBe(true);
    expect(result.amount).toBe(1000);
  });

  test("parses uppercase K suffix", () => {
    const result = parseCapital("10K");
    expect(result.valid).toBe(true);
    expect(result.amount).toBe(10000);
  });

  test("parses decimal with k suffix", () => {
    const result = parseCapital("1.5k");
    expect(result.valid).toBe(true);
    expect(result.amount).toBe(1500);
  });

  test("parses $ with k suffix", () => {
    const result = parseCapital("$2.5k");
    expect(result.valid).toBe(true);
    expect(result.amount).toBe(2500);
  });

  test("parses with leading/trailing whitespace", () => {
    const result = parseCapital("  1000  ");
    expect(result.valid).toBe(true);
    expect(result.amount).toBe(1000);
  });

  test("rejects empty string", () => {
    const result = parseCapital("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("required");
  });

  test("rejects zero", () => {
    const result = parseCapital("0");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("greater than 0");
  });

  test("rejects negative number", () => {
    const result = parseCapital("-100");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("greater than 0");
  });

  test("rejects non-numeric input", () => {
    const result = parseCapital("abc");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid");
  });

  test("handles floating point numbers", () => {
    const result = parseCapital("1000.50");
    expect(result.valid).toBe(true);
    expect(result.amount).toBe(1000.5);
  });
});

describe("createAgentFiles", () => {
  const testDir = join(import.meta.dir, "..", ".test-agents");

  beforeEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  test("creates agent directory structure", () => {
    const config: InitConfig = {
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      privateKey: "0x" + "a".repeat(64),
      capital: 1000,
      betSizeMin: 1,
      betSizeMax: 2,
      riskProfile: "balanced",
      claudeSubscription: "pro",
    };

    createAgentFiles(testDir, "agent-test1234", config);

    // Check directory was created
    expect(existsSync(join(testDir, "agents", "agent-test1234"))).toBe(true);

    // Check config file was created
    const configPath = join(testDir, "agents", "agent-test1234", "config.json");
    expect(existsSync(configPath)).toBe(true);

    // Check config content
    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(savedConfig.walletAddress).toBe(config.walletAddress);
    expect(savedConfig.capital).toBe(config.capital);
    expect(savedConfig.betSizeMin).toBe(config.betSizeMin);
    expect(savedConfig.betSizeMax).toBe(config.betSizeMax);
    expect(savedConfig.riskProfile).toBe(config.riskProfile);
    // Private key should NOT be in the saved config
    expect(savedConfig.privateKey).toBeUndefined();
  });

  test("includes requestLimit object with tier configuration", () => {
    const config: InitConfig = {
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      privateKey: "0x" + "a".repeat(64),
      capital: 1000,
      betSizeMin: 1,
      betSizeMax: 2,
      riskProfile: "balanced",
      claudeSubscription: "pro",
    };

    createAgentFiles(testDir, "agent-tier-test", config);

    const configPath = join(testDir, "agents", "agent-tier-test", "config.json");
    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    // Verify requestLimit object is present with Pro tier values
    expect(savedConfig.requestLimit).toBeDefined();
    expect(savedConfig.requestLimit.maxRequestsPer5Min).toBe(150);
    expect(savedConfig.requestLimit.recommendedAgents).toBe(2);
    expect(savedConfig.requestLimit.researchTerminals).toBe(5);
    expect(savedConfig.requestLimit.researchInterval).toBe(30);
    expect(savedConfig.claudeSubscription).toBe("pro");
  });

  test("includes free tier configuration with correct values", () => {
    const config: InitConfig = {
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      privateKey: "0x" + "a".repeat(64),
      capital: 500,
      betSizeMin: 1,
      betSizeMax: 2,
      riskProfile: "risk_averse",
      claudeSubscription: "free",
    };

    createAgentFiles(testDir, "agent-free-tier", config);

    const configPath = join(testDir, "agents", "agent-free-tier", "config.json");
    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(savedConfig.requestLimit.maxRequestsPer5Min).toBe(30);
    expect(savedConfig.requestLimit.recommendedAgents).toBe(1);
    expect(savedConfig.requestLimit.researchTerminals).toBe(2);
    expect(savedConfig.requestLimit.researchInterval).toBe(60);
    expect(savedConfig.claudeSubscription).toBe("free");
  });

  test("includes team tier configuration with correct values", () => {
    const config: InitConfig = {
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      privateKey: "0x" + "a".repeat(64),
      capital: 10000,
      betSizeMin: 5,
      betSizeMax: 10,
      riskProfile: "risk_seeking",
      claudeSubscription: "team",
    };

    createAgentFiles(testDir, "agent-team-tier", config);

    const configPath = join(testDir, "agents", "agent-team-tier", "config.json");
    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(savedConfig.requestLimit.maxRequestsPer5Min).toBe(300);
    expect(savedConfig.requestLimit.recommendedAgents).toBe(5);
    expect(savedConfig.requestLimit.researchTerminals).toBe(8);
    expect(savedConfig.requestLimit.researchInterval).toBe(30);
    expect(savedConfig.claudeSubscription).toBe("team");
  });
});

describe("updateMainConfig", () => {
  const testDir = join(import.meta.dir, "..", ".test-main-config");

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  test("creates main config with agent reference", () => {
    const config: InitConfig = {
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      privateKey: "0x" + "a".repeat(64),
      capital: 5000,
      betSizeMin: 3,
      betSizeMax: 5,
      riskProfile: "risk_averse",
      claudeSubscription: "pro",
    };

    updateMainConfig(testDir, "agent-test5678", config);

    const configPath = join(testDir, "config.json");
    expect(existsSync(configPath)).toBe(true);

    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(savedConfig.agent.walletAddress).toBe(config.walletAddress);
    expect(savedConfig.agent.capital).toBe(config.capital);
    // risk_averse maps to conservative for handler
    expect(savedConfig.agent.riskProfile).toBe("conservative");
    expect(savedConfig.activeAgent).toBe("agent-test5678");
  });

  test("includes researchTerminals and researchInterval from tier", () => {
    const config: InitConfig = {
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      privateKey: "0x" + "a".repeat(64),
      capital: 5000,
      betSizeMin: 3,
      betSizeMax: 5,
      riskProfile: "balanced",
      claudeSubscription: "pro",
    };

    updateMainConfig(testDir, "agent-tier-test", config);

    const configPath = join(testDir, "config.json");
    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    // Pro tier values
    expect(savedConfig.agent.researchTerminals).toBe(5);
    expect(savedConfig.agent.researchInterval).toBe(30);
    expect(savedConfig.agent.claudeSubscription).toBe("pro");
  });

  test("includes free tier researchTerminals and researchInterval", () => {
    const config: InitConfig = {
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      privateKey: "0x" + "a".repeat(64),
      capital: 500,
      betSizeMin: 1,
      betSizeMax: 2,
      riskProfile: "balanced",
      claudeSubscription: "free",
    };

    updateMainConfig(testDir, "agent-free-test", config);

    const configPath = join(testDir, "config.json");
    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    // Free tier values
    expect(savedConfig.agent.researchTerminals).toBe(2);
    expect(savedConfig.agent.researchInterval).toBe(60);
    expect(savedConfig.agent.claudeSubscription).toBe("free");
  });

  test("includes requestLimit object in main config", () => {
    const config: InitConfig = {
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      privateKey: "0x" + "a".repeat(64),
      capital: 5000,
      betSizeMin: 3,
      betSizeMax: 5,
      riskProfile: "balanced",
      claudeSubscription: "team",
    };

    updateMainConfig(testDir, "agent-requestlimit-test", config);

    const configPath = join(testDir, "config.json");
    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    // Team tier requestLimit values
    expect(savedConfig.requestLimit).toBeDefined();
    expect(savedConfig.requestLimit.maxRequestsPer5Min).toBe(300);
    expect(savedConfig.requestLimit.recommendedAgents).toBe(5);
    expect(savedConfig.requestLimit.researchTerminals).toBe(8);
    expect(savedConfig.requestLimit.researchInterval).toBe(30);
  });

  test("maps risk_seeking to aggressive for handler", () => {
    const config: InitConfig = {
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      privateKey: "0x" + "a".repeat(64),
      capital: 10000,
      betSizeMin: 5,
      betSizeMax: 10,
      riskProfile: "risk_seeking",
      claudeSubscription: "pro",
    };

    updateMainConfig(testDir, "agent-aggressive", config);

    const configPath = join(testDir, "config.json");
    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(savedConfig.agent.riskProfile).toBe("aggressive");
  });

  test("maps balanced to balanced for handler", () => {
    const config: InitConfig = {
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      privateKey: "0x" + "a".repeat(64),
      capital: 2000,
      betSizeMin: 3,
      betSizeMax: 5,
      riskProfile: "balanced",
      claudeSubscription: "pro",
    };

    updateMainConfig(testDir, "agent-balanced", config);

    const configPath = join(testDir, "config.json");
    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(savedConfig.agent.riskProfile).toBe("balanced");
  });

  test("merges with existing config instead of overwriting", () => {
    // Create existing config with another agent
    const existingConfig = {
      agent: {
        walletAddress: "0xoldwallet00000000000000000000000000000000",
        capital: 500,
        riskProfile: "conservative",
        researchTerminals: 3,
      },
      activeAgent: "agent-old12345",
      agents: {
        "agent-old12345": {
          walletAddress: "0xoldwallet00000000000000000000000000000000",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      customSetting: "preserve-this",
    };
    const configPath = join(testDir, "config.json");
    writeFileSync(configPath, JSON.stringify(existingConfig, null, 2));

    // Add new agent
    const newConfig: InitConfig = {
      walletAddress: "0xnewwallet00000000000000000000000000000000",
      privateKey: "0x" + "b".repeat(64),
      capital: 2000,
      betSizeMin: 1,
      betSizeMax: 2,
      riskProfile: "balanced",
      claudeSubscription: "pro",
    };

    updateMainConfig(testDir, "agent-new67890", newConfig);

    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    // New agent should be active
    expect(savedConfig.activeAgent).toBe("agent-new67890");
    expect(savedConfig.agent.walletAddress).toBe(newConfig.walletAddress);

    // Old agent should still be in agents list
    expect(savedConfig.agents["agent-old12345"]).toBeDefined();
    expect(savedConfig.agents["agent-old12345"].walletAddress).toBe("0xoldwallet00000000000000000000000000000000");

    // New agent should be in agents list
    expect(savedConfig.agents["agent-new67890"]).toBeDefined();
    expect(savedConfig.agents["agent-new67890"].walletAddress).toBe(newConfig.walletAddress);

    // Custom settings should be preserved
    expect(savedConfig.customSetting).toBe("preserve-this");
  });
});

describe("SUBSCRIPTION_TIER_OPTIONS", () => {
  // Import tier configs from init module - will be added in Task 2
  // These tests verify the tier configuration mapping (Story 4.2b)

  test("free tier has 30 requests per 5 minutes", async () => {
    const { SUBSCRIPTION_TIER_OPTIONS } = await import("../src/init");
    expect(SUBSCRIPTION_TIER_OPTIONS.free.config.maxRequestsPer5Min).toBe(30);
    expect(SUBSCRIPTION_TIER_OPTIONS.free.config.researchTerminals).toBe(2);
    expect(SUBSCRIPTION_TIER_OPTIONS.free.config.researchInterval).toBe(60);
    expect(SUBSCRIPTION_TIER_OPTIONS.free.config.recommendedAgents).toBe(1);
  });

  test("pro tier has 150 requests per 5 minutes", async () => {
    const { SUBSCRIPTION_TIER_OPTIONS } = await import("../src/init");
    expect(SUBSCRIPTION_TIER_OPTIONS.pro.config.maxRequestsPer5Min).toBe(150);
    expect(SUBSCRIPTION_TIER_OPTIONS.pro.config.researchTerminals).toBe(5);
    expect(SUBSCRIPTION_TIER_OPTIONS.pro.config.researchInterval).toBe(30);
    expect(SUBSCRIPTION_TIER_OPTIONS.pro.config.recommendedAgents).toBe(2);
  });

  test("team tier has 300 requests per 5 minutes", async () => {
    const { SUBSCRIPTION_TIER_OPTIONS } = await import("../src/init");
    expect(SUBSCRIPTION_TIER_OPTIONS.team.config.maxRequestsPer5Min).toBe(300);
    expect(SUBSCRIPTION_TIER_OPTIONS.team.config.researchTerminals).toBe(8);
    expect(SUBSCRIPTION_TIER_OPTIONS.team.config.researchInterval).toBe(30);
    expect(SUBSCRIPTION_TIER_OPTIONS.team.config.recommendedAgents).toBe(5);
  });

  test("free tier has warning message", async () => {
    const { SUBSCRIPTION_TIER_OPTIONS } = await import("../src/init");
    expect(SUBSCRIPTION_TIER_OPTIONS.free.warningMessage).toBeTruthy();
    expect(SUBSCRIPTION_TIER_OPTIONS.free.warningMessage).toContain("Free tier");
  });

  test("pro tier has no warning message", async () => {
    const { SUBSCRIPTION_TIER_OPTIONS } = await import("../src/init");
    expect(SUBSCRIPTION_TIER_OPTIONS.pro.warningMessage).toBeNull();
  });

  test("team tier has no warning message", async () => {
    const { SUBSCRIPTION_TIER_OPTIONS } = await import("../src/init");
    expect(SUBSCRIPTION_TIER_OPTIONS.team.warningMessage).toBeNull();
  });
});

describe("getTierConfig", () => {
  test("returns correct config for free tier", async () => {
    const { getTierConfig } = await import("../src/init");
    const config = getTierConfig("free");
    expect(config.requestLimit.maxRequestsPer5Min).toBe(30);
    expect(config.requestLimit.researchTerminals).toBe(2);
    expect(config.warningMessage).toBeTruthy();
  });

  test("returns correct config for pro tier", async () => {
    const { getTierConfig } = await import("../src/init");
    const config = getTierConfig("pro");
    expect(config.requestLimit.maxRequestsPer5Min).toBe(150);
    expect(config.requestLimit.researchTerminals).toBe(5);
    expect(config.warningMessage).toBeNull();
  });

  test("returns correct config for team tier", async () => {
    const { getTierConfig } = await import("../src/init");
    const config = getTierConfig("team");
    expect(config.requestLimit.maxRequestsPer5Min).toBe(300);
    expect(config.requestLimit.researchTerminals).toBe(8);
    expect(config.warningMessage).toBeNull();
  });
});

describe("createSignature (Story 4.3)", () => {
  const testPrivateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const testWalletAddress = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

  test("generates correct message format for AgiArena registration", async () => {
    const { signature, message, timestamp } = await createSignature(testPrivateKey, testWalletAddress);

    // Verify message format matches backend expectations
    expect(message).toMatch(/^AgiArena Agent Registration: 0x[a-f0-9]{40} at \d+$/);
    expect(message).toContain(testWalletAddress.toLowerCase());
    expect(message).toContain(timestamp.toString());
  });

  test("returns signature starting with 0x", async () => {
    const { signature } = await createSignature(testPrivateKey, testWalletAddress);

    expect(signature).toMatch(/^0x[a-f0-9]+$/);
    // Ethereum signatures are 65 bytes = 130 hex chars + 0x prefix = 132 chars
    expect(signature.length).toBe(132);
  });

  test("returns valid timestamp in milliseconds", async () => {
    const before = Date.now();
    const { timestamp } = await createSignature(testPrivateKey, testWalletAddress);
    const after = Date.now();

    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  test("normalizes wallet address to lowercase in message", async () => {
    const mixedCaseAddress = "0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const { message } = await createSignature(testPrivateKey, mixedCaseAddress);

    expect(message).toContain(mixedCaseAddress.toLowerCase());
    expect(message).not.toContain("F39");  // Should not have uppercase
  });

  test("includes all required fields in return object", async () => {
    const result = await createSignature(testPrivateKey, testWalletAddress);

    expect(result).toHaveProperty("signature");
    expect(result).toHaveProperty("message");
    expect(result).toHaveProperty("timestamp");
    expect(typeof result.signature).toBe("string");
    expect(typeof result.message).toBe("string");
    expect(typeof result.timestamp).toBe("number");
  });
});

describe("createAgentFiles with registration", () => {
  const testDir = join(import.meta.dir, "..", ".test-agents-registration");

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  test("stores successful registration info with message and agentId", () => {
    const config: InitConfig = {
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      privateKey: "0x" + "a".repeat(64),
      capital: 1000,
      betSizeMin: 1,
      betSizeMax: 2,
      riskProfile: "balanced",
      claudeSubscription: "pro",
    };

    const registration = {
      signature: "0xsignature123",
      message: "AgiArena Agent Registration: 0x1234567890abcdef1234567890abcdef12345678 at 1706000000000",
      timestamp: 1706000000000,
      agentId: 42,
      success: true,
    };

    createAgentFiles(testDir, "agent-reg-test", config, registration);

    const configPath = join(testDir, "agents", "agent-reg-test", "config.json");
    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(savedConfig.registration).toBeDefined();
    expect(savedConfig.registration.signature).toBe("0xsignature123");
    expect(savedConfig.registration.message).toBe("AgiArena Agent Registration: 0x1234567890abcdef1234567890abcdef12345678 at 1706000000000");
    expect(savedConfig.registration.timestamp).toBe(1706000000000);
    expect(savedConfig.registration.agentId).toBe(42);
    expect(savedConfig.registration.status).toBe("success");
    expect(savedConfig.registration.error).toBeUndefined();
  });

  test("stores failed registration info with error message", () => {
    const config: InitConfig = {
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      privateKey: "0x" + "a".repeat(64),
      capital: 1000,
      betSizeMin: 1,
      betSizeMax: 2,
      riskProfile: "balanced",
      claudeSubscription: "pro",
    };

    const registration = {
      signature: "0xsignature456",
      message: "AgiArena Agent Registration: 0x1234567890abcdef1234567890abcdef12345678 at 1706000000000",
      timestamp: 1706000000000,
      success: false,
      error: "Connection refused",
    };

    createAgentFiles(testDir, "agent-fail-test", config, registration);

    const configPath = join(testDir, "agents", "agent-fail-test", "config.json");
    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(savedConfig.registration).toBeDefined();
    expect(savedConfig.registration.status).toBe("failed");
    expect(savedConfig.registration.error).toBe("Connection refused");
    expect(savedConfig.registration.signature).toBe("0xsignature456");
    expect(savedConfig.registration.message).toBe("AgiArena Agent Registration: 0x1234567890abcdef1234567890abcdef12345678 at 1706000000000");
  });

  test("verifies agents parent directory is created", () => {
    const config: InitConfig = {
      walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      privateKey: "0x" + "a".repeat(64),
      capital: 1000,
      betSizeMin: 1,
      betSizeMax: 2,
      riskProfile: "balanced",
      claudeSubscription: "pro",
    };

    createAgentFiles(testDir, "agent-dir-test", config);

    // Verify agents parent directory exists
    expect(existsSync(join(testDir, "agents"))).toBe(true);

    // Verify agent subdirectory exists
    expect(existsSync(join(testDir, "agents", "agent-dir-test"))).toBe(true);

    // Verify config file exists with valid createdAt timestamp
    const configPath = join(testDir, "agents", "agent-dir-test", "config.json");
    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));

    // Verify createdAt is valid ISO timestamp
    const createdAt = new Date(savedConfig.createdAt);
    expect(createdAt.getTime()).not.toBeNaN();
    expect(savedConfig.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
