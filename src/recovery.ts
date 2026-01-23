import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { ethers } from "ethers";
import { loadAgentState, saveAgentState, updateAgentState } from "./agent-state";
import type { AgentState } from "./types";

// Base mainnet USDC contract address
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Minimal ERC20 ABI for balanceOf
const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)"
];

export interface RecoveryResult {
  success: boolean;
  state: AgentState | null;
  message: string;
  details: {
    researchRecovered: boolean;
    balanceReconciled: boolean;
    phaseReset: boolean;
    discrepancies: string[];
  };
}

/**
 * Check if research terminals completed by looking for status files
 */
function checkResearchTerminalStatus(agentDir: string, jobId: string): {
  complete: boolean;
  terminals: { id: string; complete: boolean }[];
} {
  const terminals: { id: string; complete: boolean }[] = [];

  try {
    const entries = readdirSync(agentDir);
    const terminalDirs = entries.filter((e) => e.startsWith("terminal-"));

    for (const termDir of terminalDirs) {
      const outputLogPath = join(agentDir, termDir, "output.log");
      const statusTxtPath = join(agentDir, termDir, "status.txt");

      // Check if terminal has status.txt or output.log
      const hasOutput = existsSync(outputLogPath);
      const hasStatus = existsSync(statusTxtPath);

      let complete = false;
      if (hasStatus) {
        try {
          const status = readFileSync(statusTxtPath, "utf-8").trim();
          complete = status === "complete" || status === "done";
        } catch {
          complete = false;
        }
      } else if (hasOutput) {
        // If no status file but output exists, check output size
        try {
          const content = readFileSync(outputLogPath, "utf-8");
          complete = content.length > 100; // Assume complete if has substantial output
        } catch {
          complete = false;
        }
      }

      terminals.push({ id: termDir, complete });
    }
  } catch {
    // Directory might not exist
  }

  const allComplete = terminals.length > 0 && terminals.every((t) => t.complete);

  return { complete: allComplete, terminals };
}

/**
 * Fetch current USDC balance from chain
 */
async function fetchOnChainBalance(
  agentAddress: string,
  rpcUrl: string
): Promise<number | null> {
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const balance = await usdcContract.balanceOf(agentAddress);

    // Convert from 6 decimals to number
    return Number(balance) / 1_000_000;
  } catch (error) {
    console.error("[recovery] Failed to fetch on-chain balance:", error);
    return null;
  }
}

/**
 * Main recovery function - executes crash recovery protocol
 */
export async function recoverAgent(
  statePath: string,
  agentDir: string,
  rpcUrl?: string
): Promise<RecoveryResult> {
  const startTime = Date.now();
  const discrepancies: string[] = [];

  // Step 1: Check for state.json existence
  const state = loadAgentState(statePath);

  if (!state) {
    return {
      success: false,
      state: null,
      message: "No state file found - fresh agent startup",
      details: {
        researchRecovered: false,
        balanceReconciled: false,
        phaseReset: false,
        discrepancies: []
      }
    };
  }

  console.log(`[recovery] Starting recovery for agent: ${state.agentAddress}`);
  console.log(`[recovery] Current phase: ${state.phase}`);

  let researchRecovered = false;
  let balanceReconciled = false;
  let phaseReset = false;

  // Step 2: Check research job status
  if (state.researchJobId && state.phase === "research") {
    console.log(`[recovery] Found incomplete research job: ${state.researchJobId}`);

    const terminalStatus = checkResearchTerminalStatus(agentDir, state.researchJobId);

    if (terminalStatus.complete) {
      // Research terminals completed but not aggregated
      console.log("[recovery] Research terminals complete, clearing job ID");
      state.researchJobId = null;
      state.phase = "idle";
      researchRecovered = true;
    } else {
      // Research incomplete - will need to resume or restart
      console.log("[recovery] Research terminals incomplete:");
      terminalStatus.terminals.forEach((t) => {
        console.log(`  - ${t.id}: ${t.complete ? "complete" : "incomplete"}`);
      });

      // Clear the incomplete job and reset phase
      state.researchJobId = null;
      state.phase = "idle";
      researchRecovered = true;
      discrepancies.push(
        `Research job ${state.researchJobId} was incomplete, reset to idle`
      );
    }
  }

  // Step 3: Handle evaluation or execution phase
  if (state.phase === "evaluation" || state.phase === "execution") {
    console.log(`[recovery] Resuming from ${state.phase} phase`);
    // Keep the phase - agent will pick up from checkpoint
  }

  // Step 4: Validate on-chain state (balance, matched bets)
  if (!rpcUrl) {
    console.warn("[recovery] BASE_RPC_URL not set - skipping on-chain validation (AC3 Step 4 incomplete)");
    discrepancies.push("On-chain validation skipped: BASE_RPC_URL not configured");
  }

  if (rpcUrl && state.agentAddress) {
    const onChainBalance = await fetchOnChainBalance(state.agentAddress, rpcUrl);

    if (onChainBalance !== null) {
      const difference = Math.abs(onChainBalance - state.currentBalance);

      if (difference > 0.01) {
        // More than 1 cent difference
        discrepancies.push(
          `Balance discrepancy: local=${state.currentBalance}, chain=${onChainBalance}`
        );
        console.warn("[recovery] Balance discrepancy detected", {
          onChain: onChainBalance,
          local: state.currentBalance
        });

        // Update to on-chain truth
        state.currentBalance = onChainBalance;
        balanceReconciled = true;
      }
    }
  }

  // Step 5: Reset phase if needed (for clean restart)
  if (state.phase !== "idle" && !state.researchJobId) {
    // If in research phase with no job, or stuck in evaluation/execution
    // Reset to idle for fresh start
    if (state.phase === "research") {
      state.phase = "idle";
      phaseReset = true;
      console.log("[recovery] Reset orphaned research phase to idle");
    }
  }

  // Save recovered state
  saveAgentState(state, statePath);

  const elapsed = Date.now() - startTime;
  const RECOVERY_TIMEOUT_MS = 10000; // NFR7: Recovery must complete within 10 seconds

  if (elapsed > RECOVERY_TIMEOUT_MS) {
    console.warn(`[recovery] Recovery exceeded NFR7 limit: ${elapsed}ms > ${RECOVERY_TIMEOUT_MS}ms`);
    discrepancies.push(`Recovery took ${elapsed}ms (exceeds 10s NFR7 requirement)`);
  }

  console.log(`[recovery] Recovery completed in ${elapsed}ms`);

  return {
    success: true,
    state,
    message: `✓ Recovered: ${state.matchedBets.length} matched bets, $${state.currentBalance.toFixed(2)} balance, ready to resume`,
    details: {
      researchRecovered,
      balanceReconciled,
      phaseReset,
      discrepancies
    }
  };
}

/**
 * Check if recovery is needed based on state
 */
export function needsRecovery(statePath: string): boolean {
  const state = loadAgentState(statePath);
  if (!state) return false;

  // Recovery needed if:
  // 1. Research job is in progress but no jobId (orphaned)
  // 2. Phase is not idle but no active work tracked
  // 3. Phase is research with a jobId (might be interrupted)
  return (
    (state.phase === "research" && state.researchJobId !== null) ||
    (state.phase !== "idle" && state.researchJobId === null)
  );
}
