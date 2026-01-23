import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import {
  loadAgentState,
  saveAgentState,
  updateAgentState,
  getDefaultAgentState,
  setAgentPhase,
  startResearchJob,
  completeResearchJob,
  addMatchedBet,
  updateBalance
} from "../src/agent-state";
import type { AgentState, MatchedBet } from "../src/types";

const TEST_DIR = join(import.meta.dir, "__test_agent_state__");
const TEST_STATE_PATH = join(TEST_DIR, "state.json");

describe("Agent State Management", () => {
  beforeEach(() => {
    // Clean up test directory
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

  describe("getDefaultAgentState", () => {
    test("creates default state with correct structure", () => {
      const state = getDefaultAgentState("0x1234567890abcdef", 1000);

      expect(state.agentAddress).toBe("0x1234567890abcdef");
      expect(state.totalCapital).toBe(1000);
      expect(state.currentBalance).toBe(1000);
      expect(state.matchedBets).toEqual([]);
      expect(state.lastResearchAt).toBeNull();
      expect(state.researchJobId).toBeNull();
      expect(state.phase).toBe("idle");
    });
  });

  describe("saveAgentState", () => {
    test("saves state to file as JSON", () => {
      const state = getDefaultAgentState("0xtest", 500);
      saveAgentState(state, TEST_STATE_PATH);

      expect(existsSync(TEST_STATE_PATH)).toBe(true);
      const content = readFileSync(TEST_STATE_PATH, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.agentAddress).toBe("0xtest");
      expect(parsed.totalCapital).toBe(500);
    });

    test("creates directory if it does not exist", () => {
      const nestedPath = join(TEST_DIR, "nested", "deep", "state.json");
      const state = getDefaultAgentState("0xtest", 100);

      saveAgentState(state, nestedPath);

      expect(existsSync(nestedPath)).toBe(true);
    });

    test("uses atomic write pattern (temp file)", () => {
      const state = getDefaultAgentState("0xatomic", 1000);
      saveAgentState(state, TEST_STATE_PATH);

      // After save, temp file should not exist
      expect(existsSync(`${TEST_STATE_PATH}.tmp`)).toBe(false);
      expect(existsSync(TEST_STATE_PATH)).toBe(true);
    });
  });

  describe("loadAgentState", () => {
    test("loads existing state file", () => {
      const original = getDefaultAgentState("0xload", 750);
      original.phase = "research";
      saveAgentState(original, TEST_STATE_PATH);

      const loaded = loadAgentState(TEST_STATE_PATH);

      expect(loaded).not.toBeNull();
      expect(loaded!.agentAddress).toBe("0xload");
      expect(loaded!.totalCapital).toBe(750);
      expect(loaded!.phase).toBe("research");
    });

    test("returns null for non-existent file", () => {
      const result = loadAgentState("/nonexistent/path/state.json");
      expect(result).toBeNull();
    });

    test("returns null for invalid JSON", () => {
      writeFileSync(TEST_STATE_PATH, "not valid json {{{");
      const result = loadAgentState(TEST_STATE_PATH);
      expect(result).toBeNull();
    });

    test("returns null for invalid state structure", () => {
      writeFileSync(TEST_STATE_PATH, JSON.stringify({ invalid: "structure" }));
      const result = loadAgentState(TEST_STATE_PATH);
      expect(result).toBeNull();
    });

    test("validates phase field values", () => {
      const invalidState = {
        agentAddress: "0x123",
        totalCapital: 100,
        currentBalance: 100,
        matchedBets: [],
        lastResearchAt: null,
        researchJobId: null,
        phase: "invalid_phase"
      };
      writeFileSync(TEST_STATE_PATH, JSON.stringify(invalidState));
      const result = loadAgentState(TEST_STATE_PATH);
      expect(result).toBeNull();
    });
  });

  describe("updateAgentState", () => {
    test("updates specific fields", () => {
      const initial = getDefaultAgentState("0xupdate", 1000);
      saveAgentState(initial, TEST_STATE_PATH);

      const updated = updateAgentState(TEST_STATE_PATH, {
        currentBalance: 900,
        phase: "execution"
      });

      expect(updated).not.toBeNull();
      expect(updated!.currentBalance).toBe(900);
      expect(updated!.phase).toBe("execution");
      expect(updated!.agentAddress).toBe("0xupdate"); // unchanged
    });

    test("returns null if no existing state", () => {
      const result = updateAgentState("/nonexistent/state.json", {
        currentBalance: 500
      });
      expect(result).toBeNull();
    });
  });

  describe("setAgentPhase", () => {
    test("transitions phase correctly", () => {
      saveAgentState(getDefaultAgentState("0xphase", 100), TEST_STATE_PATH);

      const result = setAgentPhase(TEST_STATE_PATH, "research");

      expect(result!.phase).toBe("research");
    });
  });

  describe("startResearchJob", () => {
    test("records research job start", () => {
      saveAgentState(getDefaultAgentState("0xresearch", 500), TEST_STATE_PATH);

      const result = startResearchJob(TEST_STATE_PATH, "job-123");

      expect(result!.researchJobId).toBe("job-123");
      expect(result!.phase).toBe("research");
      expect(result!.lastResearchAt).toBeGreaterThan(0);
    });
  });

  describe("completeResearchJob", () => {
    test("clears research job on completion", () => {
      const state = getDefaultAgentState("0xcomplete", 500);
      state.researchJobId = "job-456";
      state.phase = "research";
      saveAgentState(state, TEST_STATE_PATH);

      const result = completeResearchJob(TEST_STATE_PATH);

      expect(result!.researchJobId).toBeNull();
      expect(result!.phase).toBe("idle");
    });
  });

  describe("addMatchedBet", () => {
    test("adds bet to matchedBets array", () => {
      saveAgentState(getDefaultAgentState("0xbet", 1000), TEST_STATE_PATH);

      const bet: MatchedBet = {
        betId: "bet-001",
        amount: "100.00",
        evScore: 15.5,
        matchedAt: Date.now(),
        status: "matched",
        txHash: "0xabc123"
      };

      const result = addMatchedBet(TEST_STATE_PATH, bet);

      expect(result!.matchedBets).toHaveLength(1);
      expect(result!.matchedBets[0].betId).toBe("bet-001");
      expect(result!.matchedBets[0].amount).toBe("100.00");
    });

    test("preserves existing bets when adding new", () => {
      const state = getDefaultAgentState("0xmulti", 1000);
      state.matchedBets = [
        {
          betId: "existing-bet",
          amount: "50.00",
          evScore: 10,
          matchedAt: 1000,
          status: "matched",
          txHash: "0x111"
        }
      ];
      saveAgentState(state, TEST_STATE_PATH);

      const newBet: MatchedBet = {
        betId: "new-bet",
        amount: "75.00",
        evScore: 12,
        matchedAt: 2000,
        status: "matched",
        txHash: "0x222"
      };

      const result = addMatchedBet(TEST_STATE_PATH, newBet);

      expect(result!.matchedBets).toHaveLength(2);
      expect(result!.matchedBets[0].betId).toBe("existing-bet");
      expect(result!.matchedBets[1].betId).toBe("new-bet");
    });
  });

  describe("updateBalance", () => {
    test("updates currentBalance", () => {
      saveAgentState(getDefaultAgentState("0xbalance", 1000), TEST_STATE_PATH);

      const result = updateBalance(TEST_STATE_PATH, 850);

      expect(result!.currentBalance).toBe(850);
      expect(result!.totalCapital).toBe(1000); // unchanged
    });
  });

  describe("State File Integrity (AC7)", () => {
    test("state file is valid JSON after save", () => {
      const state = getDefaultAgentState("0xintegrity", 500);
      state.matchedBets = [
        { betId: "b1", amount: "100", evScore: 10, matchedAt: 1000, status: "matched", txHash: "0x1" },
        { betId: "b2", amount: "200", evScore: 12, matchedAt: 2000, status: "won", txHash: "0x2" }
      ];

      saveAgentState(state, TEST_STATE_PATH);

      const content = readFileSync(TEST_STATE_PATH, "utf-8");
      expect(() => JSON.parse(content)).not.toThrow();
    });

    test("concurrent saves don't corrupt file (simulated)", () => {
      saveAgentState(getDefaultAgentState("0xconcurrent", 1000), TEST_STATE_PATH);

      // Simulate rapid updates
      for (let i = 0; i < 10; i++) {
        updateBalance(TEST_STATE_PATH, 1000 - i * 10);
      }

      const final = loadAgentState(TEST_STATE_PATH);
      expect(final).not.toBeNull();
      expect(final!.currentBalance).toBe(910);
    });
  });
});
