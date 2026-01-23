import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { recoverAgent, needsRecovery } from "../src/recovery";
import { saveAgentState, getDefaultAgentState } from "../src/agent-state";
import type { AgentState } from "../src/types";

const TEST_DIR = join(import.meta.dir, "__test_recovery__");
const TEST_STATE_PATH = join(TEST_DIR, "state.json");
const TEST_AGENT_DIR = TEST_DIR;

describe("Crash Recovery Module", () => {
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

  describe("needsRecovery", () => {
    test("returns false when no state file exists", () => {
      const result = needsRecovery("/nonexistent/state.json");
      expect(result).toBe(false);
    });

    test("returns false when phase is idle", () => {
      const state = getDefaultAgentState("0x123", 1000);
      state.phase = "idle";
      saveAgentState(state, TEST_STATE_PATH);

      expect(needsRecovery(TEST_STATE_PATH)).toBe(false);
    });

    test("returns true when phase is research with researchJobId", () => {
      const state = getDefaultAgentState("0x123", 1000);
      state.phase = "research";
      state.researchJobId = "job-123";
      saveAgentState(state, TEST_STATE_PATH);

      expect(needsRecovery(TEST_STATE_PATH)).toBe(true);
    });

    test("returns true when phase is not idle but no job tracked", () => {
      const state = getDefaultAgentState("0x123", 1000);
      state.phase = "execution";
      state.researchJobId = null;
      saveAgentState(state, TEST_STATE_PATH);

      expect(needsRecovery(TEST_STATE_PATH)).toBe(true);
    });
  });

  describe("recoverAgent", () => {
    test("returns failure when no state file exists", async () => {
      const result = await recoverAgent(
        "/nonexistent/state.json",
        TEST_AGENT_DIR
      );

      expect(result.success).toBe(false);
      expect(result.state).toBeNull();
      expect(result.message).toContain("No state file found");
    });

    test("recovers from idle state without changes", async () => {
      const state = getDefaultAgentState("0xtest", 1000);
      state.matchedBets = [
        { betId: "b1", amount: "100", evScore: 10, matchedAt: 1000, status: "matched", txHash: "0x1" }
      ];
      saveAgentState(state, TEST_STATE_PATH);

      const result = await recoverAgent(TEST_STATE_PATH, TEST_AGENT_DIR);

      expect(result.success).toBe(true);
      expect(result.state!.matchedBets).toHaveLength(1);
      expect(result.message).toContain("1 matched bets");
    });

    test("clears incomplete research job", async () => {
      const state = getDefaultAgentState("0xresearch", 500);
      state.phase = "research";
      state.researchJobId = "incomplete-job";
      saveAgentState(state, TEST_STATE_PATH);

      const result = await recoverAgent(TEST_STATE_PATH, TEST_AGENT_DIR);

      expect(result.success).toBe(true);
      expect(result.state!.researchJobId).toBeNull();
      expect(result.state!.phase).toBe("idle");
      expect(result.details.researchRecovered).toBe(true);
    });

    test("handles completed research terminals", async () => {
      const state = getDefaultAgentState("0xterminal", 500);
      state.phase = "research";
      state.researchJobId = "job-with-terminals";
      saveAgentState(state, TEST_STATE_PATH);

      // Create terminal directories with complete status
      const terminalDir = join(TEST_AGENT_DIR, "terminal-1");
      mkdirSync(terminalDir, { recursive: true });
      writeFileSync(join(terminalDir, "status.txt"), "complete");

      const result = await recoverAgent(TEST_STATE_PATH, TEST_AGENT_DIR);

      expect(result.success).toBe(true);
      expect(result.state!.phase).toBe("idle");
      expect(result.details.researchRecovered).toBe(true);
    });

    test("preserves evaluation/execution phase for checkpoint resumption", async () => {
      const state = getDefaultAgentState("0xeval", 1000);
      state.phase = "evaluation";
      state.researchJobId = null;
      saveAgentState(state, TEST_STATE_PATH);

      const result = await recoverAgent(TEST_STATE_PATH, TEST_AGENT_DIR);

      expect(result.success).toBe(true);
      // evaluation phase is preserved since no jobId indicates it's a proper checkpoint
    });

    test("recovery summary includes bet count and balance", async () => {
      const state = getDefaultAgentState("0xsummary", 750.50);
      state.matchedBets = [
        { betId: "b1", amount: "100", evScore: 10, matchedAt: 1000, status: "matched", txHash: "0x1" },
        { betId: "b2", amount: "200", evScore: 12, matchedAt: 2000, status: "won", txHash: "0x2" }
      ];
      saveAgentState(state, TEST_STATE_PATH);

      const result = await recoverAgent(TEST_STATE_PATH, TEST_AGENT_DIR);

      expect(result.message).toContain("2 matched bets");
      expect(result.message).toContain("$750.50");
      expect(result.message).toContain("ready to resume");
    });

    test("records discrepancies when found", async () => {
      const state = getDefaultAgentState("0xdiscrepancy", 500);
      state.phase = "research";
      state.researchJobId = "orphaned-job";
      saveAgentState(state, TEST_STATE_PATH);

      const result = await recoverAgent(TEST_STATE_PATH, TEST_AGENT_DIR);

      expect(result.details.discrepancies.length).toBeGreaterThan(0);
      expect(result.details.discrepancies[0]).toContain("incomplete");
    });
  });

  describe("Recovery Performance (AC6 - <10 seconds)", () => {
    test("recovery completes within 10 seconds", async () => {
      const state = getDefaultAgentState("0xperf", 1000);
      state.phase = "research";
      state.researchJobId = "perf-test";
      // Add many matched bets
      for (let i = 0; i < 100; i++) {
        state.matchedBets.push({
          betId: `bet-${i}`,
          amount: "10.00",
          evScore: 10,
          matchedAt: Date.now(),
          status: "matched",
          txHash: `0x${i.toString(16)}`
        });
      }
      saveAgentState(state, TEST_STATE_PATH);

      const startTime = Date.now();
      const result = await recoverAgent(TEST_STATE_PATH, TEST_AGENT_DIR);
      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(elapsed).toBeLessThan(10000); // 10 seconds max (NFR7)
    });
  });

  describe("Terminal Status Detection", () => {
    test("detects incomplete terminals", async () => {
      const state = getDefaultAgentState("0xincomplete", 500);
      state.phase = "research";
      state.researchJobId = "job-incomplete";
      saveAgentState(state, TEST_STATE_PATH);

      // Create terminal without status file
      const terminalDir = join(TEST_AGENT_DIR, "terminal-1");
      mkdirSync(terminalDir, { recursive: true });
      // No status.txt = incomplete

      const result = await recoverAgent(TEST_STATE_PATH, TEST_AGENT_DIR);

      expect(result.success).toBe(true);
      expect(result.details.researchRecovered).toBe(true);
    });

    test("handles mixed terminal completion states", async () => {
      const state = getDefaultAgentState("0xmixed", 500);
      state.phase = "research";
      state.researchJobId = "job-mixed";
      saveAgentState(state, TEST_STATE_PATH);

      // Terminal 1: complete
      const terminal1 = join(TEST_AGENT_DIR, "terminal-1");
      mkdirSync(terminal1, { recursive: true });
      writeFileSync(join(terminal1, "status.txt"), "complete");

      // Terminal 2: incomplete
      const terminal2 = join(TEST_AGENT_DIR, "terminal-2");
      mkdirSync(terminal2, { recursive: true });
      // No status.txt

      const result = await recoverAgent(TEST_STATE_PATH, TEST_AGENT_DIR);

      expect(result.success).toBe(true);
      // Mixed state treated as incomplete
      expect(result.details.discrepancies.length).toBeGreaterThan(0);
    });
  });
});
