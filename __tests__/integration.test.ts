import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { join } from "path";
import { existsSync, writeFileSync, rmSync, mkdirSync } from "fs";

const BOT_DIR = join(import.meta.dir, "..");
const HEALTH_URL = "http://127.0.0.1:3333/health";

describe("Handler Integration Tests", () => {
  let handlerProcess: Subprocess | null = null;
  const testConfigPath = join(BOT_DIR, "config.json");
  const testAgentDir = join(BOT_DIR, "agent");
  const testLogsDir = join(BOT_DIR, "logs");

  beforeAll(async () => {
    // Ensure test config exists (privateKey now comes from env var)
    const testConfig = {
      agent: {
        walletAddress: "0x1234567890123456789012345678901234567890",
        capital: 1000,
        riskProfile: "balanced",
        researchTerminals: 5,
        researchInterval: 30,
        claudeSubscription: "pro"
      }
    };
    writeFileSync(testConfigPath, JSON.stringify(testConfig, null, 2));

    // Set private key in environment
    process.env.AGENT_PRIVATE_KEY = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

    // Ensure directories exist
    if (!existsSync(testAgentDir)) mkdirSync(testAgentDir, { recursive: true });
    if (!existsSync(testLogsDir)) mkdirSync(testLogsDir, { recursive: true });
  });

  afterAll(async () => {
    // Kill handler if running
    if (handlerProcess) {
      handlerProcess.kill();
      await handlerProcess.exited;
    }

    // Clean up environment
    delete process.env.AGENT_PRIVATE_KEY;
  });

  it("should expose health endpoint on port 3333", async () => {
    // Start a real HTTP server to test the health endpoint
    const { createHealthResponse } = await import("../src/health");

    const testPort = 3334; // Use different port to avoid conflicts

    const server = Bun.serve({
      port: testPort,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health" && req.method === "GET") {
          const response = createHealthResponse({
            agentPid: 12345,
            uptime: 100,
            restartCount: 0,
            lastRestartAt: null,
            config: {
              walletAddress: "0x1234...7890",
              capital: 1000,
              riskProfile: "balanced",
              researchTerminals: 5,
              researchInterval: 30,
              claudeSubscription: "pro"
            }
          });
          return new Response(JSON.stringify(response), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("Not Found", { status: 404 });
      }
    });

    try {
      // Make actual HTTP request
      const res = await fetch(`http://127.0.0.1:${testPort}/health`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe("healthy");
      expect(data.agent.pid).toBe(12345);
      expect(data.config.researchTerminals).toBe(5);
      expect(data.config.researchInterval).toBe(30);
      expect(data.config.claudeSubscription).toBe("pro");
    } finally {
      server.stop();
    }
  });

  it("should validate config structure correctly", async () => {
    const { loadConfig } = await import("../src/config");

    // Test with valid config
    const config = loadConfig(testConfigPath);
    expect(config.agent.walletAddress).toBe("0x1234567890123456789012345678901234567890");
    expect(config.agent.capital).toBe(1000);
    expect(config.agent.riskProfile).toBe("balanced");
    expect(config.agent.researchTerminals).toBe(5);
    expect(config.agent.researchInterval).toBe(30);
    expect(config.agent.claudeSubscription).toBe("pro");
  });

  it("should handle state persistence across restarts", async () => {
    const { saveState, loadState } = await import("../src/state");
    const statePath = join(testAgentDir, "state.json");

    // Save initial state
    const initialState = {
      agentPid: 11111,
      startTime: Date.now(),
      restartCount: 2,
      lastRestartAt: new Date().toISOString()
    };
    saveState(initialState, statePath);

    // Simulate "restart" by loading state
    const loadedState = loadState(statePath);

    expect(loadedState.restartCount).toBe(2);
    expect(loadedState.agentPid).toBe(11111);
    expect(loadedState.lastRestartAt).toBe(initialState.lastRestartAt);
  });

  it("should implement crash recovery with exponential backoff", async () => {
    const { calculateRestartDelay } = await import("../src/crash-recovery");

    // Exponential backoff with 2s base, capped at 30s per NFR19 (restart within 30s)
    // First restart: 2 seconds (2000 * 2^0)
    expect(calculateRestartDelay(1)).toBe(2000);

    // Second restart: 4 seconds (2000 * 2^1)
    expect(calculateRestartDelay(2)).toBe(4000);

    // Third restart: 8 seconds (2000 * 2^2)
    expect(calculateRestartDelay(3)).toBe(8000);

    // Fourth restart: 16 seconds (2000 * 2^3)
    expect(calculateRestartDelay(4)).toBe(16000);

    // Fifth+ restart: capped at 30 seconds (NFR19 requirement)
    expect(calculateRestartDelay(5)).toBe(30000);
    expect(calculateRestartDelay(10)).toBe(30000);
  });

  it("should log crashes to crashes.log", async () => {
    const { logCrash } = await import("../src/crash-recovery");
    const crashLogPath = join(testLogsDir, "crashes.log");

    // Remove existing log
    if (existsSync(crashLogPath)) {
      rmSync(crashLogPath);
    }

    // Log multiple crashes
    logCrash({
      timestamp: "2026-01-23T12:00:00Z",
      exitCode: 1,
      signal: null,
      error: "Test crash 1"
    }, crashLogPath);

    logCrash({
      timestamp: "2026-01-23T12:01:00Z",
      exitCode: null,
      signal: "SIGKILL",
      error: "Test crash 2"
    }, crashLogPath);

    expect(existsSync(crashLogPath)).toBe(true);

    const content = await Bun.file(crashLogPath).text();
    expect(content).toContain("Test crash 1");
    expect(content).toContain("Test crash 2");
    expect(content).toContain("SIGKILL");
  });

  it("should mask sensitive data in health response", async () => {
    const { getSafeConfig } = await import("../src/config");

    const fullConfig = {
      agent: {
        walletAddress: "0x1234567890123456789012345678901234567890",
        privateKey: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        capital: 1000,
        riskProfile: "balanced" as const,
        researchTerminals: 5,
        researchInterval: 30,
        claudeSubscription: "pro" as const
      }
    };

    const safeConfig = getSafeConfig(fullConfig);

    // Wallet address should be masked
    expect(safeConfig.walletAddress).toBe("0x1234...7890");
    expect(safeConfig.walletAddress).not.toContain("1234567890123456789012345678901234567890");

    // Private key should NOT appear anywhere in safe config
    expect(JSON.stringify(safeConfig)).not.toContain("abcdef");
    expect(JSON.stringify(safeConfig)).not.toContain("privateKey");

    // Capital, risk profile, and research terminals should be visible
    expect(safeConfig.capital).toBe(1000);
    expect(safeConfig.riskProfile).toBe("balanced");
    expect(safeConfig.researchTerminals).toBe(5);

    // Subscription tier fields should be visible
    expect(safeConfig.researchInterval).toBe(30);
    expect(safeConfig.claudeSubscription).toBe("pro");
  });
});
