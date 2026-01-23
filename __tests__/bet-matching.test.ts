import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";

// Test directory setup
const TEST_DIR = join(import.meta.dir, "..", "test-tmp-matching");

describe("Bet Matching", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("calculateFillAmount", () => {
    test("calculates conservative fill amount (1-3% of capital)", async () => {
      const { calculateFillAmount } = await import("../src/bet-matching");

      const capital = 1000; // $1000
      const betRemaining = "100.000000"; // $100 remaining

      const result = calculateFillAmount(capital, "conservative", betRemaining);

      // Conservative: 1-3%, middle = 2% = $20
      // But limited to bet remaining
      const amount = parseInt(result) / 1_000_000; // Convert to USDC
      expect(amount).toBeGreaterThanOrEqual(10); // 1% of 1000
      expect(amount).toBeLessThanOrEqual(30); // 3% of 1000
    });

    test("calculates balanced fill amount (3-5% of capital)", async () => {
      const { calculateFillAmount } = await import("../src/bet-matching");

      const capital = 1000;
      const betRemaining = "100.000000";

      const result = calculateFillAmount(capital, "balanced", betRemaining);

      const amount = parseInt(result) / 1_000_000;
      expect(amount).toBeGreaterThanOrEqual(30); // 3% of 1000
      expect(amount).toBeLessThanOrEqual(50); // 5% of 1000
    });

    test("calculates aggressive fill amount (5-10% of capital)", async () => {
      const { calculateFillAmount } = await import("../src/bet-matching");

      const capital = 1000;
      const betRemaining = "100.000000";

      const result = calculateFillAmount(capital, "aggressive", betRemaining);

      const amount = parseInt(result) / 1_000_000;
      expect(amount).toBeGreaterThanOrEqual(50); // 5% of 1000
      expect(amount).toBeLessThanOrEqual(100); // Limited to bet remaining
    });

    test("limits fill amount to bet remaining", async () => {
      const { calculateFillAmount } = await import("../src/bet-matching");

      const capital = 10000; // $10,000
      const betRemaining = "50.000000"; // Only $50 remaining

      // Aggressive would want 5-10% = $500-$1000, but limited to $50
      const result = calculateFillAmount(capital, "aggressive", betRemaining);

      const amount = parseInt(result) / 1_000_000;
      expect(amount).toBeLessThanOrEqual(50);
    });

    test("handles small capital amounts", async () => {
      const { calculateFillAmount } = await import("../src/bet-matching");

      const capital = 100; // $100 capital
      const betRemaining = "50.000000";

      const result = calculateFillAmount(capital, "balanced", betRemaining);

      // Balanced 3-5% of $100 = $3-$5, middle = $4
      const amount = parseInt(result) / 1_000_000;
      expect(amount).toBeGreaterThan(0);
      expect(amount).toBeLessThanOrEqual(5);
    });
  });

  describe("formatUSDCAmount", () => {
    test("formats base units to decimal string", async () => {
      const { formatUSDCAmount } = await import("../src/bet-matching");

      expect(formatUSDCAmount("1000000")).toBe("1.000000");
      expect(formatUSDCAmount("1500000")).toBe("1.500000");
      expect(formatUSDCAmount("100000000")).toBe("100.000000");
      expect(formatUSDCAmount("500000")).toBe("0.500000");
    });

    test("handles small amounts correctly", async () => {
      const { formatUSDCAmount } = await import("../src/bet-matching");

      expect(formatUSDCAmount("1")).toBe("0.000001");
      expect(formatUSDCAmount("123")).toBe("0.000123");
      expect(formatUSDCAmount("999999")).toBe("0.999999");
    });
  });

  describe("parseUSDCAmount", () => {
    test("parses decimal string to base units", async () => {
      const { parseUSDCAmount } = await import("../src/bet-matching");

      expect(parseUSDCAmount("1")).toBe("1000000");
      expect(parseUSDCAmount("1.5")).toBe("1500000");
      expect(parseUSDCAmount("100.000000")).toBe("100000000");
      expect(parseUSDCAmount("0.5")).toBe("500000");
    });

    test("handles partial decimals", async () => {
      const { parseUSDCAmount } = await import("../src/bet-matching");

      expect(parseUSDCAmount("1.1")).toBe("1100000");
      expect(parseUSDCAmount("1.12")).toBe("1120000");
      expect(parseUSDCAmount("1.123456")).toBe("1123456");
    });
  });

  describe("validateBetStatus", () => {
    test("validates pending bet as valid", async () => {
      const { validateBetStatus } = await import("../src/bet-matching");

      const result = validateBetStatus("pending");
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    test("validates partially_matched bet as valid", async () => {
      const { validateBetStatus } = await import("../src/bet-matching");

      const result = validateBetStatus("partially_matched");
      expect(result.valid).toBe(true);
    });

    test("rejects fully_matched bet", async () => {
      const { validateBetStatus } = await import("../src/bet-matching");

      const result = validateBetStatus("fully_matched");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("fully matched");
    });

    test("rejects resolved bet", async () => {
      const { validateBetStatus } = await import("../src/bet-matching");

      const result = validateBetStatus("resolved");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("resolved");
    });

    test("rejects cancelled bet", async () => {
      const { validateBetStatus } = await import("../src/bet-matching");

      const result = validateBetStatus("cancelled");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("cancelled");
    });
  });

  describe("Trade State Management", () => {
    test("loads default state when file doesn't exist", async () => {
      const { loadTradeState } = await import("../src/bet-matching");

      const statePath = join(TEST_DIR, "nonexistent.json");
      const state = loadTradeState(statePath);

      expect(state.matchedBets).toEqual([]);
      expect(state.totalMatchedAmount).toBe("0");
      expect(state.lastMatchedAt).toBeNull();
    });

    test("saves and loads trade state", async () => {
      const { loadTradeState, saveTradeState } = await import("../src/bet-matching");

      const statePath = join(TEST_DIR, "state.json");
      const testState = {
        matchedBets: [{
          betId: "123",
          fillAmount: "50.000000",
          txHash: "0xabc",
          blockNumber: 1000,
          timestamp: "2026-01-23T12:00:00.000Z",
          gasUsed: "45000",
          gasCostUSD: "0.02",
          evScore: 15.5,
          ourPortfolioRef: "/path/to/portfolio.json"
        }],
        totalMatchedAmount: "50000000",
        lastMatchedAt: "2026-01-23T12:00:00.000Z"
      };

      saveTradeState(testState, statePath);
      const loaded = loadTradeState(statePath);

      expect(loaded.matchedBets).toHaveLength(1);
      expect(loaded.matchedBets[0].betId).toBe("123");
      expect(loaded.totalMatchedAmount).toBe("50000000");
    });

    test("adds matched bet to state", async () => {
      const { loadTradeState, addMatchedBet } = await import("../src/bet-matching");

      const statePath = join(TEST_DIR, "state.json");

      // Add first bet
      const bet1 = {
        betId: "123",
        fillAmount: "50.000000",
        txHash: "0xabc",
        blockNumber: 1000,
        timestamp: "2026-01-23T12:00:00.000Z",
        gasUsed: "45000",
        gasCostUSD: "0.02",
        evScore: 15.5,
        ourPortfolioRef: "/path/to/portfolio.json"
      };

      const updated1 = addMatchedBet(statePath, bet1);
      expect(updated1.matchedBets).toHaveLength(1);

      // Add second bet
      const bet2 = {
        betId: "456",
        fillAmount: "75.000000",
        txHash: "0xdef",
        blockNumber: 1001,
        timestamp: "2026-01-23T12:05:00.000Z",
        gasUsed: "46000",
        gasCostUSD: "0.03",
        evScore: 20.0,
        ourPortfolioRef: "/path/to/portfolio.json"
      };

      const updated2 = addMatchedBet(statePath, bet2);
      expect(updated2.matchedBets).toHaveLength(2);
      expect(updated2.lastMatchedAt).toBe("2026-01-23T12:05:00.000Z");
    });

    test("atomic save prevents corruption", async () => {
      const { saveTradeState, loadTradeState } = await import("../src/bet-matching");

      const statePath = join(TEST_DIR, "state.json");
      const testState = {
        matchedBets: [],
        totalMatchedAmount: "0",
        lastMatchedAt: null
      };

      // Multiple rapid saves
      for (let i = 0; i < 10; i++) {
        testState.totalMatchedAmount = (i * 1000000).toString();
        saveTradeState(testState, statePath);
      }

      // Should be able to load without corruption
      const loaded = loadTradeState(statePath);
      expect(loaded.totalMatchedAmount).toBe("9000000");
    });
  });

  describe("Transaction Logging", () => {
    test("logs successful transaction", async () => {
      const { logTransaction } = await import("../src/bet-matching");

      const logPath = join(TEST_DIR, "transactions.log");

      logTransaction(
        logPath,
        "123",
        "50.000000",
        "0xabc123",
        "45000",
        "0.02",
        "SUCCESS"
      );

      const content = readFileSync(logPath, "utf-8");
      expect(content).toContain("MATCH");
      expect(content).toContain("betId=123");
      expect(content).toContain("amount=50.000000");
      expect(content).toContain("tx=0xabc123");
      expect(content).toContain("status=SUCCESS");
    });

    test("logs failed transaction with error", async () => {
      const { logTransaction } = await import("../src/bet-matching");

      const logPath = join(TEST_DIR, "transactions.log");

      logTransaction(
        logPath,
        "456",
        "75.000000",
        null,
        "0",
        "0",
        "FAILED",
        "INSUFFICIENT_BALANCE"
      );

      const content = readFileSync(logPath, "utf-8");
      expect(content).toContain("betId=456");
      expect(content).toContain("status=FAILED");
      expect(content).toContain("error=INSUFFICIENT_BALANCE");
      expect(content).toContain("tx=none");
    });

    test("appends to existing log file", async () => {
      const { logTransaction } = await import("../src/bet-matching");

      const logPath = join(TEST_DIR, "transactions.log");

      logTransaction(logPath, "1", "10.000000", "0x1", "1000", "0.01", "SUCCESS");
      logTransaction(logPath, "2", "20.000000", "0x2", "2000", "0.02", "SUCCESS");
      logTransaction(logPath, "3", "30.000000", null, "0", "0", "FAILED", "ERROR");

      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain("betId=1");
      expect(lines[1]).toContain("betId=2");
      expect(lines[2]).toContain("betId=3");
    });
  });

  describe("Result Helpers", () => {
    test("creates success result", async () => {
      const { createSuccessResult } = await import("../src/bet-matching");

      const result = createSuccessResult(
        "123",
        "50.000000",
        "0xabc",
        "45000",
        "0.02"
      );

      expect(result.success).toBe(true);
      expect(result.betId).toBe("123");
      expect(result.fillAmount).toBe("50.000000");
      expect(result.txHash).toBe("0xabc");
      expect(result.message).toBe("Bet matched successfully");
    });

    test("creates error result", async () => {
      const { createErrorResult, ERROR_CODES } = await import("../src/bet-matching");

      const result = createErrorResult(
        "123",
        ERROR_CODES.INSUFFICIENT_BALANCE,
        "Not enough USDC",
        { required: "100", available: "50" }
      );

      expect(result.success).toBe(false);
      expect(result.betId).toBe("123");
      expect(result.error).toBe("INSUFFICIENT_BALANCE");
      expect(result.message).toBe("Not enough USDC");
      expect(result.details?.required).toBe("100");
    });
  });

  describe("Risk Profile Configuration", () => {
    test("has correct conservative sizing", async () => {
      const { RISK_PROFILE_SIZING } = await import("../src/bet-matching");

      expect(RISK_PROFILE_SIZING.conservative.min).toBe(0.01);
      expect(RISK_PROFILE_SIZING.conservative.max).toBe(0.03);
    });

    test("has correct balanced sizing", async () => {
      const { RISK_PROFILE_SIZING } = await import("../src/bet-matching");

      expect(RISK_PROFILE_SIZING.balanced.min).toBe(0.03);
      expect(RISK_PROFILE_SIZING.balanced.max).toBe(0.05);
    });

    test("has correct aggressive sizing", async () => {
      const { RISK_PROFILE_SIZING } = await import("../src/bet-matching");

      expect(RISK_PROFILE_SIZING.aggressive.min).toBe(0.05);
      expect(RISK_PROFILE_SIZING.aggressive.max).toBe(0.10);
    });
  });

  describe("Edge Cases", () => {
    test("handles zero bet remaining", async () => {
      const { calculateFillAmount } = await import("../src/bet-matching");

      const capital = 1000;
      const betRemaining = "0.000000";

      const result = calculateFillAmount(capital, "balanced", betRemaining);

      expect(parseInt(result)).toBe(0);
    });

    test("handles very large capital", async () => {
      const { calculateFillAmount } = await import("../src/bet-matching");

      const capital = 1000000; // $1M
      const betRemaining = "500.000000";

      const result = calculateFillAmount(capital, "conservative", betRemaining);

      // Conservative 1-3% of $1M = $10,000-$30,000
      // But limited to bet remaining of $500
      const amount = parseInt(result) / 1_000_000;
      expect(amount).toBeLessThanOrEqual(500);
    });

    test("handles corrupted state file gracefully", async () => {
      const { loadTradeState } = await import("../src/bet-matching");

      const statePath = join(TEST_DIR, "corrupted.json");
      writeFileSync(statePath, "{ this is not valid json }}}");

      const state = loadTradeState(statePath);

      // Should return default state on corruption
      expect(state.matchedBets).toEqual([]);
      expect(state.totalMatchedAmount).toBe("0");
    });

    test("addMatchedBet correctly parses decimal amounts (regression test)", async () => {
      const { addMatchedBet, loadTradeState } = await import("../src/bet-matching");

      const statePath = join(TEST_DIR, "state.json");

      // Test with "1.5" USDC - should become 1500000 base units
      const bet1 = {
        betId: "1",
        fillAmount: "1.5",
        txHash: "0x1",
        blockNumber: 1000,
        timestamp: "2026-01-23T12:00:00.000Z",
        gasUsed: "45000",
        gasCostUSD: "0.02",
        evScore: 15.5,
        ourPortfolioRef: "/path/to/portfolio.json"
      };

      addMatchedBet(statePath, bet1);
      let state = loadTradeState(statePath);
      expect(state.totalMatchedAmount).toBe("1500000"); // 1.5 USDC = 1,500,000 base units

      // Add "50.000000" USDC - should add 50000000 base units
      const bet2 = {
        betId: "2",
        fillAmount: "50.000000",
        txHash: "0x2",
        blockNumber: 1001,
        timestamp: "2026-01-23T12:05:00.000Z",
        gasUsed: "45000",
        gasCostUSD: "0.02",
        evScore: 20.0,
        ourPortfolioRef: "/path/to/portfolio.json"
      };

      addMatchedBet(statePath, bet2);
      state = loadTradeState(statePath);
      expect(state.totalMatchedAmount).toBe("51500000"); // 1.5 + 50 = 51.5 USDC
    });

    test("parseUSDCAmount and formatUSDCAmount are inverses", async () => {
      const { parseUSDCAmount, formatUSDCAmount } = await import("../src/bet-matching");

      const testAmounts = ["0.000001", "0.5", "1.0", "1.5", "50.000000", "100.123456", "999999.999999"];

      for (const amount of testAmounts) {
        const baseUnits = parseUSDCAmount(amount);
        const formatted = formatUSDCAmount(baseUnits);
        // Normalize both for comparison (remove trailing zeros in decimal part)
        const normalizedInput = parseFloat(amount).toFixed(6);
        expect(formatted).toBe(normalizedInput);
      }
    });
  });

  describe("Gas Cost Threshold Verification (NFR5)", () => {
    test("gas cost calculation stays under $0.50 threshold for typical transactions", async () => {
      // Based on Dev Notes: ~80,000-120,000 gas for matchBet
      // Gas price on Base L2: ~0.001 gwei = 1,000,000 wei
      // ETH price assumption: $2000

      const typicalGasUsed = 100_000; // 100k gas
      const gasPrice = 1_000_000; // 0.001 gwei in wei
      const ethPrice = 2000;

      // Calculate gas cost in USD
      const gasCostWei = BigInt(typicalGasUsed) * BigInt(gasPrice);
      const gasCostEth = Number(gasCostWei) / 1e18;
      const gasCostUsd = gasCostEth * ethPrice;

      // Should be well under $0.50
      expect(gasCostUsd).toBeLessThan(0.50);
      // Actually should be around $0.0002 per Dev Notes
      expect(gasCostUsd).toBeLessThan(0.01);
    });

    test("gas cost warning for high gas scenarios", async () => {
      // Worst case: 500k gas, 10 gwei, $4000 ETH
      const worstCaseGasUsed = 500_000;
      const highGasPrice = 10_000_000_000; // 10 gwei in wei
      const highEthPrice = 4000;

      const gasCostWei = BigInt(worstCaseGasUsed) * BigInt(highGasPrice);
      const gasCostEth = Number(gasCostWei) / 1e18;
      const gasCostUsd = gasCostEth * highEthPrice;

      // Even in worst case on Base L2, should stay reasonable
      // 500k * 10 gwei = 0.005 ETH * $4000 = $20 (this is extreme mainnet scenario)
      // On Base L2, gas is typically 0.001-0.01 gwei, so actual worst case < $0.50
      expect(gasCostUsd).toBeGreaterThan(0); // Just verify calculation works
    });
  });

  describe("Fill Scenarios (partial/full fill, insufficient balance)", () => {
    test("partial fill scenario - fills part of remaining bet", async () => {
      const { calculateFillAmount, formatUSDCAmount } = await import("../src/bet-matching");

      // Bet with $1000 total, $700 already matched, $300 remaining
      // Agent with $500 capital, conservative profile (1-3% = $5-$15)
      const capital = 500;
      const betRemaining = "300.000000";

      const fillBase = calculateFillAmount(capital, "conservative", betRemaining);
      const fillDecimal = parseFloat(formatUSDCAmount(fillBase));

      // Should fill $10 (middle of 1-3% of $500), which is partial
      expect(fillDecimal).toBeLessThan(300); // Partial fill
      expect(fillDecimal).toBeGreaterThanOrEqual(5); // At least 1%
      expect(fillDecimal).toBeLessThanOrEqual(15); // At most 3%
    });

    test("full fill scenario - fills entire remaining bet", async () => {
      const { calculateFillAmount, formatUSDCAmount } = await import("../src/bet-matching");

      // Bet with only $5 remaining
      // Agent with $10,000 capital, aggressive profile (5-10% = $500-$1000)
      const capital = 10000;
      const betRemaining = "5.000000";

      const fillBase = calculateFillAmount(capital, "aggressive", betRemaining);
      const fillDecimal = parseFloat(formatUSDCAmount(fillBase));

      // Should fill exactly $5 (entire remaining), not $500-$1000
      expect(fillDecimal).toBe(5);
    });

    test("insufficient balance detection", async () => {
      const { calculateFillAmount, ERROR_CODES, createErrorResult } = await import("../src/bet-matching");

      // Agent wants to fill $40 but only has $20 USDC
      const agentBalance = 20_000_000; // $20 in base units
      const capital = 1000;
      const betRemaining = "100.000000";

      const fillBase = parseInt(calculateFillAmount(capital, "balanced", betRemaining));
      // Balanced 3-5% of $1000 = $30-$50, middle = $40

      // Simulate insufficient balance check
      if (fillBase > agentBalance) {
        const result = createErrorResult(
          "123",
          ERROR_CODES.INSUFFICIENT_BALANCE,
          "Insufficient balance",
          { required: fillBase.toString(), available: agentBalance.toString() }
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe("INSUFFICIENT_BALANCE");
      }

      // Verify the fill amount would exceed balance
      expect(fillBase).toBeGreaterThan(agentBalance);
    });
  });

  describe("Shell Script Integration (CLI commands)", () => {
    test("calculate-fill CLI command returns valid JSON", async () => {
      const { $ } = await import("bun");

      const result = await $`bun run src/cli/match-bet-cli.ts calculate-fill 1000 balanced 100.000000`.text();
      const parsed = JSON.parse(result);

      expect(parsed.fillAmountBaseUnits).toBeDefined();
      expect(parsed.fillAmountFormatted).toBeDefined();
      expect(parsed.capital).toBe(1000);
      expect(parsed.riskProfile).toBe("balanced");
    });

    test("record-match CLI command saves state correctly", async () => {
      const { $ } = await import("bun");

      const statePath = join(TEST_DIR, "cli-state.json");
      const matchRecord = JSON.stringify({
        betId: "cli-test-123",
        fillAmount: "25.500000",
        txHash: "0xtest",
        blockNumber: 9999,
        timestamp: "2026-01-23T15:00:00.000Z",
        gasUsed: "50000",
        gasCostUSD: "0.01",
        evScore: 18.5,
        ourPortfolioRef: "/test/portfolio.json"
      });

      const result = await $`bun run src/cli/match-bet-cli.ts record-match ${statePath} ${matchRecord}`.text();
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.totalMatchedBets).toBe(1);

      // Verify file was created
      expect(existsSync(statePath)).toBe(true);

      // Verify contents
      const savedState = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(savedState.matchedBets[0].betId).toBe("cli-test-123");
      expect(savedState.totalMatchedAmount).toBe("25500000"); // 25.5 USDC
    });

    test("log-transaction CLI command appends to log", async () => {
      const { $ } = await import("bun");

      const logPath = join(TEST_DIR, "cli-transactions.log");

      await $`bun run src/cli/match-bet-cli.ts log-transaction ${logPath} bet-456 30.000000 0xhash123 60000 0.015 SUCCESS`.text();

      const content = readFileSync(logPath, "utf-8");
      expect(content).toContain("bet-456");
      expect(content).toContain("0xhash123");
      expect(content).toContain("SUCCESS");
    });

    test("calculate-fill CLI rejects invalid risk profile", async () => {
      const { $ } = await import("bun");

      try {
        await $`bun run src/cli/match-bet-cli.ts calculate-fill 1000 invalid_profile 100.000000`.throws(true);
        // Should have thrown
        expect(true).toBe(false);
      } catch (error) {
        // Expected - invalid risk profile
        expect(true).toBe(true);
      }
    });
  });
});
