import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

// Test directory for isolated testing
const TEST_DIR = join(import.meta.dir, "..", "test-tmp");
const TEST_CONFIG_PATH = join(TEST_DIR, "config.json");
const TEST_STATE_PATH = join(TEST_DIR, "agent", "state.json");
const TEST_LOGS_DIR = join(TEST_DIR, "logs");

describe("Handler Configuration", () => {
  beforeEach(() => {
    // Clean up and create test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, "agent"), { recursive: true });
    mkdirSync(TEST_LOGS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("should load valid config.json", async () => {
    const validConfig = {
      agent: {
        walletAddress: "0x1234567890123456789012345678901234567890",
        capital: 1000,
        riskProfile: "balanced",
        researchTerminals: 5
      }
    };
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify(validConfig, null, 2));

    // Private key now comes from environment variable
    process.env.AGENT_PRIVATE_KEY = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

    const { loadConfig } = await import("../src/config");
    const config = loadConfig(TEST_CONFIG_PATH);

    expect(config.agent.walletAddress).toBe(validConfig.agent.walletAddress);
    expect(config.agent.capital).toBe(1000);
    expect(config.agent.riskProfile).toBe("balanced");
    expect(config.agent.privateKey).toBe(process.env.AGENT_PRIVATE_KEY);

    delete process.env.AGENT_PRIVATE_KEY;
  });

  it("should throw error for missing required fields", async () => {
    const invalidConfig = {
      agent: {
        walletAddress: "0x1234567890123456789012345678901234567890", // Valid address but missing capital
        riskProfile: "balanced"
      }
    };
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify(invalidConfig, null, 2));

    // Set env var for private key
    process.env.AGENT_PRIVATE_KEY = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig(TEST_CONFIG_PATH)).toThrow();

    delete process.env.AGENT_PRIVATE_KEY;
  });

  it("should throw error for invalid riskProfile", async () => {
    const invalidConfig = {
      agent: {
        walletAddress: "0x1234567890123456789012345678901234567890",
        capital: 1000,
        riskProfile: "yolo" // Invalid - should be conservative, balanced, or aggressive
      }
    };
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify(invalidConfig, null, 2));

    process.env.AGENT_PRIVATE_KEY = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig(TEST_CONFIG_PATH)).toThrow("riskProfile must be one of");

    delete process.env.AGENT_PRIVATE_KEY;
  });

  it("should throw error for invalid wallet address format", async () => {
    const invalidConfig = {
      agent: {
        walletAddress: "not-an-address",
        capital: 1000,
        riskProfile: "balanced"
      }
    };
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify(invalidConfig, null, 2));

    process.env.AGENT_PRIVATE_KEY = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

    const { loadConfig } = await import("../src/config");

    expect(() => loadConfig(TEST_CONFIG_PATH)).toThrow("valid Ethereum address");

    delete process.env.AGENT_PRIVATE_KEY;
  });

  it("should create default config if not found", async () => {
    const { loadConfig, createDefaultConfig } = await import("../src/config");

    createDefaultConfig(TEST_CONFIG_PATH);

    expect(existsSync(TEST_CONFIG_PATH)).toBe(true);
    const content = JSON.parse(readFileSync(TEST_CONFIG_PATH, "utf-8"));
    expect(content.agent).toBeDefined();
    expect(content.agent.walletAddress).toBeDefined();
  });
});

describe("State Persistence", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, "agent"), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("should save state atomically", async () => {
    const { saveState } = await import("../src/state");
    const testState = {
      agentPid: 12345,
      startTime: Date.now(),
      restartCount: 0
    };

    saveState(testState, TEST_STATE_PATH);

    expect(existsSync(TEST_STATE_PATH)).toBe(true);
    const savedState = JSON.parse(readFileSync(TEST_STATE_PATH, "utf-8"));
    expect(savedState.agentPid).toBe(12345);
  });

  it("should load existing state on startup", async () => {
    const existingState = {
      agentPid: 99999,
      startTime: Date.now() - 10000,
      restartCount: 3
    };
    writeFileSync(TEST_STATE_PATH, JSON.stringify(existingState));

    const { loadState } = await import("../src/state");
    const state = loadState(TEST_STATE_PATH);

    expect(state.restartCount).toBe(3);
  });

  it("should return default state if file not found", async () => {
    const { loadState } = await import("../src/state");
    const state = loadState(TEST_STATE_PATH);

    expect(state.restartCount).toBe(0);
    expect(state.agentPid).toBeNull();
  });
});

describe("Crash Recovery", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_LOGS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("should log crash to crashes.log", async () => {
    const { logCrash } = await import("../src/crash-recovery");
    const crashLogPath = join(TEST_LOGS_DIR, "crashes.log");

    logCrash({
      timestamp: new Date().toISOString(),
      exitCode: 1,
      signal: null,
      error: "Test crash"
    }, crashLogPath);

    expect(existsSync(crashLogPath)).toBe(true);
    const content = readFileSync(crashLogPath, "utf-8");
    expect(content).toContain("Test crash");
  });

  it("should track crash count in rolling window", async () => {
    const { CrashTracker } = await import("../src/crash-recovery");
    const tracker = new CrashTracker(5, 300000); // 5 crashes in 5 minutes

    // Simulate 4 crashes - should not trigger pause
    for (let i = 0; i < 4; i++) {
      tracker.recordCrash();
    }
    expect(tracker.shouldPause()).toBe(false);

    // 5th crash should trigger pause
    tracker.recordCrash();
    expect(tracker.shouldPause()).toBe(true);
  });
});

describe("Health Check Server", () => {
  it("should return health status on GET /health", async () => {
    // This test will be verified with the actual server running
    // For now, we test the response structure
    const { createHealthResponse } = await import("../src/health");

    const response = createHealthResponse({
      agentPid: 12345,
      uptime: 3600,
      restartCount: 0,
      lastRestartAt: null,
      config: {
        walletAddress: "0x123...789",
        capital: 1000,
        riskProfile: "balanced",
        researchTerminals: 5,
        researchInterval: 30,
        claudeSubscription: "pro"
      }
    });

    expect(response.status).toBe("healthy");
    expect(response.agent.pid).toBe(12345);
    expect(response.agent.uptime).toBe(3600);
    expect(response.config.capital).toBe(1000);
  });

  it("should return unhealthy status when agent is not running", async () => {
    const { createHealthResponse } = await import("../src/health");

    const response = createHealthResponse({
      agentPid: null,
      uptime: 0,
      restartCount: 0,
      lastRestartAt: null,
      config: {
        walletAddress: "0x123...789",
        capital: 1000,
        riskProfile: "balanced",
        researchTerminals: 5,
        researchInterval: 30,
        claudeSubscription: "pro"
      }
    });

    expect(response.status).toBe("unhealthy");
  });

  it("should include subscription tier fields in health response", async () => {
    const { createHealthResponse } = await import("../src/health");

    const response = createHealthResponse({
      agentPid: 12345,
      uptime: 100,
      restartCount: 0,
      lastRestartAt: null,
      config: {
        walletAddress: "0x123...789",
        capital: 2000,
        riskProfile: "aggressive",
        researchTerminals: 8,
        researchInterval: 30,
        claudeSubscription: "team"
      }
    });

    expect(response.config.researchTerminals).toBe(8);
    expect(response.config.researchInterval).toBe(30);
    expect(response.config.claudeSubscription).toBe("team");
  });

  it("should include free tier config in health response", async () => {
    const { createHealthResponse } = await import("../src/health");

    const response = createHealthResponse({
      agentPid: 99999,
      uptime: 60,
      restartCount: 1,
      lastRestartAt: "2026-01-23T10:00:00.000Z",
      config: {
        walletAddress: "0xabc...def",
        capital: 500,
        riskProfile: "conservative",
        researchTerminals: 2,
        researchInterval: 60,
        claudeSubscription: "free"
      }
    });

    expect(response.config.researchTerminals).toBe(2);
    expect(response.config.researchInterval).toBe(60);
    expect(response.config.claudeSubscription).toBe("free");
  });
});
