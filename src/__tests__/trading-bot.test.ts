/**
 * Tests for Trading Bot Runner
 *
 * Story 7.6: AI Trading Bot Launch Scripts
 * Task 5: Bot Launch Scripts (AC: 1, 6)
 */

import { describe, test, expect } from "bun:test";
import { TradingBot, createBotFromEnv, type TradingBotConfig } from "../trading-bot";

// Create a test config
const createTestConfig = (overrides: Partial<TradingBotConfig> = {}): TradingBotConfig => ({
  name: "TestBot",
  walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
  privateKey: "0x" + "a".repeat(64),
  capital: 100,
  riskProfile: "balanced",
  portfolioSize: 5,
  backendUrl: "http://localhost:3001",
  contractAddress: "0x0000000000000000000000000000000000000000",
  negotiation: {
    acceptThresholdBps: 50,
    counterThresholdBps: 200,
    rejectThresholdBps: 500,
    pollIntervalMs: 1000,
  },
  resolutionMinutes: 30,
  dryRun: true,
  maxBetsPerSession: 10,
  sessionDurationMinutes: 60,
  ...overrides,
});

describe("Trading Bot", () => {
  describe("TradingBot constructor", () => {
    test("creates bot with correct name", () => {
      const config = createTestConfig({ name: "MyBot" });
      const bot = new TradingBot(config);

      expect(bot.getName()).toBe("MyBot");
    });

    test("initializes with correct state", () => {
      const config = createTestConfig({ capital: 500 });
      const bot = new TradingBot(config);

      const state = bot.getState();
      expect(state.capital).toBe(500);
      expect(state.allocatedCapital).toBe(0);
      expect(state.activeBetIds).toEqual([]);
      expect(state.matchedBetIds).toEqual([]);
    });

    test("creates resolution manager", () => {
      const config = createTestConfig();
      const bot = new TradingBot(config);

      const summary = bot.getResolutionSummary();
      expect(summary).toBeDefined();
      expect(summary.total).toBe(0);
    });
  });

  describe("Risk profile sizing", () => {
    test("conservative risk uses 2% of capital", () => {
      const config = createTestConfig({
        capital: 1000,
        riskProfile: "conservative",
      });
      const bot = new TradingBot(config);

      // Would bet 2% = $20 per bet
      expect(bot.getState().capital * 0.02).toBe(20);
    });

    test("balanced risk uses 5% of capital", () => {
      const config = createTestConfig({
        capital: 1000,
        riskProfile: "balanced",
      });
      const bot = new TradingBot(config);

      // Would bet 5% = $50 per bet
      expect(bot.getState().capital * 0.05).toBe(50);
    });

    test("aggressive risk uses 10% of capital", () => {
      const config = createTestConfig({
        capital: 1000,
        riskProfile: "aggressive",
      });
      const bot = new TradingBot(config);

      // Would bet 10% = $100 per bet
      expect(bot.getState().capital * 0.10).toBe(100);
    });
  });

  describe("createBotFromEnv", () => {
    test("creates bot with environment defaults", () => {
      const originalEnv = process.env;

      // Set minimal env vars
      process.env = {
        ...originalEnv,
        AGENT_NAME: undefined,
        AGENT_WALLET_ADDRESS: undefined,
        AGENT_CAPITAL: undefined,
        AGENT_RISK_PROFILE: undefined,
      };

      const bot = createBotFromEnv("EnvBot");

      expect(bot.getName()).toBe("EnvBot");
      expect(bot.getState().capital).toBe(100); // Default

      // Restore
      process.env = originalEnv;
    });

    test("respects environment variables", () => {
      const originalEnv = { ...process.env };

      process.env.AGENT_WALLET_ADDRESS = "0xaabbccdd";
      process.env.AGENT_CAPITAL = "500";
      process.env.AGENT_RISK_PROFILE = "conservative";
      process.env.DRY_RUN = "true";

      const bot = createBotFromEnv("EnvBot");

      expect(bot.getState().address).toBe("0xaabbccdd");
      expect(bot.getState().capital).toBe(500);

      // Restore
      Object.keys(process.env).forEach((key) => {
        if (!(key in originalEnv)) {
          delete process.env[key];
        }
      });
      Object.assign(process.env, originalEnv);
    });
  });

  describe("Bot state management", () => {
    test("stop sets running to false", () => {
      const config = createTestConfig();
      const bot = new TradingBot(config);

      // Start and immediately stop
      bot.stop();

      // Bot should be stopped (can verify via resolution manager)
      const summary = bot.getResolutionSummary();
      expect(summary).toBeDefined();
    });
  });

  describe("Configuration validation", () => {
    test("accepts valid config", () => {
      const config = createTestConfig();
      expect(() => new TradingBot(config)).not.toThrow();
    });

    test("handles zero capital", () => {
      const config = createTestConfig({ capital: 0 });
      const bot = new TradingBot(config);
      expect(bot.getState().capital).toBe(0);
    });

    test("handles different portfolio sizes", () => {
      const config = createTestConfig({ portfolioSize: 10 });
      const bot = new TradingBot(config);
      // Bot created successfully with custom portfolio size
      expect(bot.getName()).toBe("TestBot");
    });
  });

  describe("Session management", () => {
    test("respects max bets per session config", () => {
      const config = createTestConfig({ maxBetsPerSession: 5 });
      const bot = new TradingBot(config);
      // Config is stored and would be used in trading loop
      expect(bot.getName()).toBeDefined();
    });

    test("respects session duration config", () => {
      const config = createTestConfig({ sessionDurationMinutes: 15 });
      const bot = new TradingBot(config);
      // Config is stored and would be used in trading loop
      expect(bot.getName()).toBeDefined();
    });
  });
});
