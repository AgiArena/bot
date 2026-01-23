import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { generatePrompt, getBetSizeRange, writePromptFile } from "../src/prompt";

// Test directory for isolated testing
const TEST_DIR = join(import.meta.dir, "..", "test-tmp-prompt");
const TEST_AGENT_DIR = join(TEST_DIR, "agent");

describe("Prompt Generation", () => {
  beforeEach(() => {
    // Clean up and create test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_AGENT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("should generate prompt with all template variables replaced", () => {
    const config = {
      walletAddress: "0x1234567890123456789012345678901234567890",
      privateKey: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      capital: 5000,
      riskProfile: "balanced" as const,
      researchTerminals: 5,
      researchInterval: 30,
      claudeSubscription: "pro" as const
    };

    const prompt = generatePrompt(config);

    // Check wallet address is included
    expect(prompt).toContain("0x1234567890123456789012345678901234567890");

    // Check capital is included
    expect(prompt).toContain("5000");

    // Check bet size range is calculated (balanced = 3-5%)
    expect(prompt).toContain("3-5%");

    // Check risk profile is included
    expect(prompt).toContain("balanced");

    // Check research terminals is included
    expect(prompt).toContain("5");

    // Check no unreplaced template variables remain
    expect(prompt).not.toContain("{walletAddress}");
    expect(prompt).not.toContain("{totalCapital}");
    expect(prompt).not.toContain("{betSizeMin}");
    expect(prompt).not.toContain("{betSizeMax}");
    expect(prompt).not.toContain("{riskProfile}");
    expect(prompt).not.toContain("{researchTerminals}");
  });

  it("should include all required prompt sections", () => {
    const config = {
      walletAddress: "0x1234567890123456789012345678901234567890",
      privateKey: "0xabcdef",
      capital: 1000,
      riskProfile: "conservative" as const,
      researchTerminals: 3,
      researchInterval: 60,
      claudeSubscription: "free" as const
    };

    const prompt = generatePrompt(config);

    // Check for required sections from AC #1
    expect(prompt).toContain("Portfolio Betting Coordinator");
    expect(prompt).toContain("Your Configuration");
    expect(prompt).toContain("Your Objective");
    expect(prompt).toContain("Your Tools");
    expect(prompt).toContain("Your Workflow");
    expect(prompt).toContain("Phase 1: Market Scoring");
    expect(prompt).toContain("Phase 2: Bet Evaluation");
    expect(prompt).toContain("Phase 3: Execution");
    expect(prompt).toContain("Critical Rules");
    expect(prompt).toContain("Recovery Protocol");
    expect(prompt).toContain("Getting Started");
    expect(prompt).toContain("start-research.sh");
  });

  it("should write prompt file to specified path", async () => {
    const promptContent = "# Test Prompt\n\nThis is test content.";
    const promptPath = join(TEST_AGENT_DIR, "prompt.md");

    const success = await writePromptFile(promptPath, promptContent);

    expect(success).toBe(true);
    expect(existsSync(promptPath)).toBe(true);
    const content = readFileSync(promptPath, "utf-8");
    expect(content).toBe(promptContent);
  });

  it("should overwrite existing prompt file", async () => {
    const promptPath = join(TEST_AGENT_DIR, "prompt.md");

    // Write first version
    await writePromptFile(promptPath, "Version 1");
    expect(readFileSync(promptPath, "utf-8")).toBe("Version 1");

    // Overwrite with second version
    await writePromptFile(promptPath, "Version 2");
    expect(readFileSync(promptPath, "utf-8")).toBe("Version 2");
  });

  it("should return false on write failure without throwing", async () => {
    // Try to write to a path where mkdir will fail (permissions issue)
    const invalidPath = "/root/restricted-path-12345/prompt.md";
    const success = await writePromptFile(invalidPath, "test content");

    // Should return false instead of throwing
    expect(success).toBe(false);
  });

  it("should include dollar sign before capital amount", () => {
    const config = {
      walletAddress: "0x1234567890123456789012345678901234567890",
      privateKey: "0xabcdef",
      capital: 5000,
      riskProfile: "balanced" as const,
      researchTerminals: 5,
      researchInterval: 30,
      claudeSubscription: "pro" as const
    };

    const prompt = generatePrompt(config);

    // Check that capital has dollar sign prefix
    expect(prompt).toContain("$5000 USDC");
  });
});

describe("Bet Size Calculation", () => {
  it("should return 1-3% for conservative risk profile", () => {
    const range = getBetSizeRange("conservative");

    expect(range.min).toBe(1);
    expect(range.max).toBe(3);
  });

  it("should return 3-5% for balanced risk profile", () => {
    const range = getBetSizeRange("balanced");

    expect(range.min).toBe(3);
    expect(range.max).toBe(5);
  });

  it("should return 5-10% for aggressive risk profile", () => {
    const range = getBetSizeRange("aggressive");

    expect(range.min).toBe(5);
    expect(range.max).toBe(10);
  });

  it("should default to balanced for unknown risk profile", () => {
    // Cast to any to test fallback behavior
    const range = getBetSizeRange("unknown" as any);

    expect(range.min).toBe(3);
    expect(range.max).toBe(5);
  });
});

describe("Prompt Integration with Handler", () => {
  it("should generate prompt with correct format for claude-code --prompt-file", () => {
    const config = {
      walletAddress: "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
      privateKey: "0x1234",
      capital: 10000,
      riskProfile: "aggressive" as const,
      researchTerminals: 8,
      researchInterval: 15,
      claudeSubscription: "team" as const
    };

    const prompt = generatePrompt(config);

    // Prompt should be valid markdown
    expect(prompt.startsWith("#")).toBe(true);

    // Should contain the getting started command
    expect(prompt).toContain("bash scripts/start-research.sh");

    // Should include aggressive bet size range (5-10%)
    expect(prompt).toContain("5-10%");

    // Should have 8 research terminals
    expect(prompt).toContain("8");
  });

  it("should include researchInterval in Phase 3", () => {
    const config = {
      walletAddress: "0x1234567890123456789012345678901234567890",
      privateKey: "0xabcd",
      capital: 2000,
      riskProfile: "balanced" as const,
      researchTerminals: 5,
      researchInterval: 45,
      claudeSubscription: "pro" as const
    };

    const prompt = generatePrompt(config);

    // Should include research interval in workflow description
    expect(prompt).toContain("45");
    expect(prompt).toContain("minutes");
  });

  it("should include all bet evaluation scripts in Phase 2", () => {
    const config = {
      walletAddress: "0x1234567890123456789012345678901234567890",
      privateKey: "0xabcd",
      capital: 1000,
      riskProfile: "conservative" as const,
      researchTerminals: 3,
      researchInterval: 60,
      claudeSubscription: "free" as const
    };

    const prompt = generatePrompt(config);

    // Should include compare-bet.sh script reference
    expect(prompt).toContain("compare-bet.sh");
  });

  it("should preserve all critical rules in prompt", () => {
    const config = {
      walletAddress: "0x1234567890123456789012345678901234567890",
      privateKey: "0xabcd",
      capital: 1000,
      riskProfile: "balanced" as const,
      researchTerminals: 5,
      researchInterval: 30,
      claudeSubscription: "pro" as const
    };

    const prompt = generatePrompt(config);

    // Check for critical rules from AC #1
    expect(prompt).toContain("hidden"); // spawn terminals in hidden mode
    expect(prompt).toContain("NEVER"); // never place new bet
    expect(prompt).toContain("MATCH"); // only match existing bets
    expect(prompt).toContain("5%"); // 5% edge requirement
    expect(prompt).toContain("state"); // save state for crash recovery
  });

  it("should include BMAD recovery protocol", () => {
    const config = {
      walletAddress: "0x1234567890123456789012345678901234567890",
      privateKey: "0xabcd",
      capital: 1000,
      riskProfile: "balanced" as const,
      researchTerminals: 5,
      researchInterval: 30,
      claudeSubscription: "pro" as const
    };

    const prompt = generatePrompt(config);

    // Check for recovery protocol elements
    expect(prompt).toContain("Recovery Protocol");
    expect(prompt).toContain("state.json");
    expect(prompt).toContain("atomic");
    expect(prompt).toContain("heartbeat");
    expect(prompt).toContain("5 minutes");
  });

  it("should write prompt file to correct path during handler integration", async () => {
    // This tests the full integration: generate + write to handler's expected path
    const config = {
      walletAddress: "0x1234567890123456789012345678901234567890",
      privateKey: "0xabcd",
      capital: 5000,
      riskProfile: "balanced" as const,
      researchTerminals: 5,
      researchInterval: 30,
      claudeSubscription: "pro" as const
    };

    const promptPath = join(TEST_AGENT_DIR, "prompt.md");
    const promptContent = generatePrompt(config);
    const success = await writePromptFile(promptPath, promptContent);

    // Verify the complete handler flow
    expect(success).toBe(true);
    expect(existsSync(promptPath)).toBe(true);

    // Verify content was written correctly with all interpolated values
    const writtenContent = readFileSync(promptPath, "utf-8");
    expect(writtenContent).toContain("0x1234567890123456789012345678901234567890");
    expect(writtenContent).toContain("$5000 USDC");
    expect(writtenContent).toContain("3-5%");
    expect(writtenContent).toContain("balanced");
    expect(writtenContent).toContain("5 parallel agents");

    // Verify no unreplaced template variables
    expect(writtenContent).not.toContain("{walletAddress}");
    expect(writtenContent).not.toContain("{totalCapital}");
    expect(writtenContent).not.toContain("{riskProfile}");
  });

  it("should create parent directories for prompt file", async () => {
    // Test that writePromptFile creates nested directories
    const nestedPath = join(TEST_DIR, "deep", "nested", "agent", "prompt.md");
    const success = await writePromptFile(nestedPath, "# Test Prompt");

    expect(success).toBe(true);
    expect(existsSync(nestedPath)).toBe(true);
  });
});
