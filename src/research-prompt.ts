import { dirname, join } from "path";

/**
 * Market data structure from Polymarket API
 */
export interface MarketData {
  id: string;
  question: string;
  outcomes: string[];
  currentOdds: number[];
}

/**
 * Parameters for generating a research terminal prompt
 */
export interface ResearchPromptParams {
  terminalNum: number;
  segmentFile: string;
  startIdx: number;
  endIdx: number;
  totalMarkets: number;
}

/**
 * Research terminal prompt template
 * From epics.md lines 2084-2107
 */
const RESEARCH_PROMPT_TEMPLATE = `# Research Terminal {terminalNum}

Your job: Score markets {startIdx} to {endIdx} from {segmentFile}

## Total Markets in Segment: {totalMarkets}

## Instructions

For each market in the segment file:

1. **Read market data** (question, outcomes, current odds)
2. **Analyze probability** based on available information
3. **Assign score 0-100** (100 = very bullish on YES outcome, 0 = very bullish on NO)

## Output Format

Write results incrementally to scores using JSON Lines format (one JSON object per line):

\`\`\`json
{"marketId": "0x...", "score": 75, "position": 1, "confidence": 0.85}
{"marketId": "0x...", "score": 30, "position": 0, "confidence": 0.70}
\`\`\`

Where:
- **marketId**: The market's unique identifier from the segment file
- **score**: Your probability assessment 0-100 (100 = YES will happen)
- **position**: 1 for YES (score >= 50), 0 for NO (score < 50)
- **confidence**: How confident you are in this score (0.0 to 1.0)

## Output Files

Save results to: \`research/terminal-{terminalNum}/scores.json\`

**CRITICAL**: Write scores incrementally (every 10-20 markets) for crash resilience.

When done processing ALL markets, write "COMPLETE" to: \`research/terminal-{terminalNum}/status.txt\`

## Scoring Guidelines

- **80-100**: High confidence YES - strong evidence event will occur
- **60-79**: Moderate confidence YES - some evidence favoring YES
- **50-59**: Slight YES lean - marginally favoring YES outcome
- **40-49**: Slight NO lean - marginally favoring NO outcome
- **20-39**: Moderate confidence NO - some evidence favoring NO
- **0-19**: High confidence NO - strong evidence event won't occur

## Important Notes

- Process markets in order as they appear in the segment file
- Skip markets with insufficient data (mark confidence as 0.1)
- Do NOT stop until ALL markets in the segment are scored
- Write progress updates to output.log
`;

/**
 * Divide an array of markets into N segments
 * Handles uneven division by distributing remainder to first segments
 */
export function divideIntoSegments<T>(markets: T[], numSegments: number): T[][] {
  if (markets.length === 0) {
    return [];
  }

  // Don't create more segments than markets
  const actualSegments = Math.min(numSegments, markets.length);

  const segments: T[][] = [];
  const baseSize = Math.floor(markets.length / actualSegments);
  const remainder = markets.length % actualSegments;

  let currentIndex = 0;
  for (let i = 0; i < actualSegments; i++) {
    // First 'remainder' segments get one extra item
    const segmentSize = baseSize + (i < remainder ? 1 : 0);
    segments.push(markets.slice(currentIndex, currentIndex + segmentSize));
    currentIndex += segmentSize;
  }

  return segments;
}

/**
 * Generate research terminal prompt content with all variables replaced
 */
export function generateResearchPrompt(params: ResearchPromptParams): string {
  let prompt = RESEARCH_PROMPT_TEMPLATE;

  prompt = prompt.replace(/{terminalNum}/g, String(params.terminalNum));
  prompt = prompt.replace(/{segmentFile}/g, params.segmentFile);
  prompt = prompt.replace(/{startIdx}/g, String(params.startIdx));
  prompt = prompt.replace(/{endIdx}/g, String(params.endIdx));
  prompt = prompt.replace(/{totalMarkets}/g, String(params.totalMarkets));

  return prompt;
}

/**
 * Write research prompt to terminal directory
 * Creates terminal-N/prompt.md file
 */
export async function writeResearchPrompt(
  researchDir: string,
  terminalNum: number,
  params: ResearchPromptParams
): Promise<boolean> {
  try {
    const terminalDir = join(researchDir, `terminal-${terminalNum}`);
    const promptPath = join(terminalDir, "prompt.md");

    // Create terminal directory
    Bun.spawnSync(["mkdir", "-p", terminalDir]);

    // Generate and write prompt
    const content = generateResearchPrompt(params);
    await Bun.write(promptPath, content);

    return true;
  } catch (error) {
    // Return false to indicate failure - caller should handle logging
    return false;
  }
}
