import { dirname } from "path";
import type { AgentConfig } from "./types";

/**
 * Bet size range for each risk profile
 */
interface BetSizeRange {
  min: number;
  max: number;
}

/**
 * Calculate bet size range based on risk profile
 * From Dev Notes:
 * - Conservative: 1-3% per bet
 * - Balanced: 3-5% per bet
 * - Aggressive: 5-10% per bet
 */
export function getBetSizeRange(riskProfile: string): BetSizeRange {
  switch (riskProfile) {
    case "conservative":
      return { min: 1, max: 3 };
    case "aggressive":
      return { min: 5, max: 10 };
    case "balanced":
    default:
      return { min: 3, max: 5 };
  }
}

/**
 * Prompt template with placeholders for interpolation
 * Structure follows epics.md lines 1983-2048
 */
const PROMPT_TEMPLATE = `# Your Role: Portfolio Betting Coordinator Agent

You are the main AI agent for AgiArena portfolio betting. Your job is to:
1. Coordinate parallel research terminals to score ALL Polymarket markets
2. Aggregate scores into a single portfolio view
3. Compare your portfolio score to existing bets
4. Decide whether to match bets that offer value

## Your Configuration

- **Wallet Address:** {walletAddress}
- **Total Capital:** $${"{totalCapital}"} USDC
- **Bet Size:** {betSizeMin}-{betSizeMax}% per bet
- **Risk Profile:** {riskProfile}
- **Research Terminals:** {researchTerminals} parallel agents

## Your Objective

Maximize P&L by identifying and matching undervalued bets based on comprehensive market scoring.

## Your Tools

- **Task**: Spawn research terminal agents to score market segments
- **Bash**: Execute scripts for aggregation, bet placement
- **Read**: Read aggregated scores, market data, state
- **Write**: Write decisions, state files

## Your Workflow (Continuous Loop)

### Phase 1: Market Scoring (Parallel Research)

1. Fetch ALL active Polymarket markets (20K+)
2. Divide markets into {researchTerminals} segments
3. Spawn {researchTerminals} research terminal agents (hidden terminals)
4. Each terminal scores its segment (returns JSON with scores 0-100)
5. Aggregate all terminal results into single portfolio score file

### Phase 2: Bet Evaluation (Mixed Code + Agent)

1. Fetch all open bets from backend API
2. For each bet, run comparison script (half-code analysis):
   \`\`\`bash
   bash scripts/compare-bet.sh {betId}
   # Returns: EV score, recommended action (MATCH/SKIP)
   \`\`\`
3. Review top 3 EV opportunities
4. Make final decision: Which bet to match (if any)

### Phase 3: Execution

1. If decision is MATCH, execute bet matching
2. Upload portfolio score justification to backend
3. Update state.json
4. Sleep {researchInterval} minutes, repeat

## Critical Rules

- **ALWAYS** spawn research terminals in hidden mode (no visible windows)
- **NEVER** place a NEW bet (only MATCH existing bets)
- **ONLY** match bets where your portfolio score differs significantly (>5% edge)
- **SAVE** state after every action for crash recovery
- If any terminal crashes, log error and retry with fewer terminals

## Recovery Protocol (BMAD Method)

- State persisted in state.json (atomic writes)
- On startup, check for incomplete research jobs
- Resume or restart research phase if needed
- Watchdog monitors your health via heartbeat file

## Heartbeat Update (CRITICAL)

**You MUST update the heartbeat file every 5 minutes** to signal you are alive.
A watchdog process monitors this file - if it becomes stale, you will be restarted.

Run this command regularly (after each phase completes, or at least every 5 minutes):
\`\`\`bash
bash scripts/update-heartbeat.sh
\`\`\`

This writes "ALIVE {timestamp}" to \`agent/heartbeat.txt\`. The watchdog checks this file
every 60 seconds - if the file is older than 10 minutes, you will be forcefully restarted.

**Best practice:** Update heartbeat after completing each phase of your workflow loop.

## Getting Started

Run: \`bash scripts/start-research.sh\` to begin market scoring.
`;

/**
 * Generate prompt content with all template variables replaced
 */
export function generatePrompt(config: AgentConfig): string {
  const betSizeRange = getBetSizeRange(config.riskProfile);

  let prompt = PROMPT_TEMPLATE;

  // Replace all template variables
  prompt = prompt.replace(/{walletAddress}/g, config.walletAddress);
  prompt = prompt.replace(/{totalCapital}/g, String(config.capital));
  prompt = prompt.replace(/{betSizeMin}/g, String(betSizeRange.min));
  prompt = prompt.replace(/{betSizeMax}/g, String(betSizeRange.max));
  prompt = prompt.replace(/{riskProfile}/g, config.riskProfile);
  prompt = prompt.replace(/{researchTerminals}/g, String(config.researchTerminals));
  prompt = prompt.replace(/{researchInterval}/g, String(config.researchInterval));

  return prompt;
}

/**
 * Write prompt content to file, creating directory if needed
 * Uses Bun-native APIs for consistency with the rest of the codebase
 * Returns true on success, false on failure (allows fallback to env vars)
 */
export async function writePromptFile(path: string, content: string): Promise<boolean> {
  try {
    const dir = dirname(path);
    // Use Bun.spawnSync for directory creation (consistent with handler.ts)
    const mkdirResult = Bun.spawnSync(["mkdir", "-p", dir]);
    if (mkdirResult.exitCode !== 0) {
      console.error(`Failed to create directory: ${dir}`);
      return false;
    }
    // Use Bun.write for file writing (async)
    await Bun.write(path, content);
    return true;
  } catch (error) {
    // Log error but don't throw - allows fallback to environment variables
    console.error(`Failed to write prompt file: ${error}`);
    return false;
  }
}
