/**
 * Prompt Evolution System
 *
 * Adaptive prompt modifications based on performance:
 * - Tool call efficiency < 60% → Add more specific decision instructions
 * - Failed research cycles > 5 → Simplify instructions and reduce segment size
 *
 * Changes are logged and reversible. Never modifies core instructions.
 *
 * AC: #10
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";

// ============================================================================
// Types
// ============================================================================

export interface PromptChanges {
  additions?: string[];
  simplifications?: string[];
  removals?: string[];
}

export interface PromptVersion {
  version: number;
  timestamp: number;
  changes: PromptChanges;
  reason: string;
  content: string;
}

export interface PromptEvolutionState {
  currentVersion: number;
  versions: PromptVersion[];
  basePrompt: string;
  currentHints: string[];
}

export interface PerformanceMetrics {
  toolCallSuccessRate: number;
  failedResearchCycles: number;
  winRate: number;
}

// ============================================================================
// Constants
// ============================================================================

const TOOL_CALL_THRESHOLD = 0.6;
const FAILED_RESEARCH_THRESHOLD = 5;
const MAX_VERSIONS = 10;

// ============================================================================
// Decision Hints
// ============================================================================

const DECISION_HINTS = {
  lowToolCallEfficiency: [
    "When evaluating tools, prefer simpler queries over complex ones.",
    "Break down research into smaller, more focused steps.",
    "Verify data availability before requesting it.",
    "Use cached results when available instead of re-fetching."
  ],
  highFailedResearch: [
    "Reduce the scope of each research query.",
    "Focus on top markets by volume rather than breadth.",
    "Use shorter time windows for data analysis.",
    "Prioritize quality over quantity in market evaluation."
  ],
  lowWinRate: [
    "Be more conservative in bet selection.",
    "Require higher expected value thresholds.",
    "Focus on markets with clearer outcomes.",
    "Consider liquidity and market efficiency more carefully."
  ]
};

// ============================================================================
// State Persistence
// ============================================================================

/**
 * Get default prompt evolution state
 */
export function getDefaultPromptEvolutionState(basePrompt: string): PromptEvolutionState {
  return {
    currentVersion: 0,
    versions: [{
      version: 0,
      timestamp: Date.now(),
      changes: {},
      reason: "Initial prompt",
      content: basePrompt
    }],
    basePrompt,
    currentHints: []
  };
}

/**
 * Load prompt evolution state from disk
 */
export function loadPromptEvolutionState(statePath: string, basePrompt: string): PromptEvolutionState {
  if (!existsSync(statePath)) {
    return getDefaultPromptEvolutionState(basePrompt);
  }

  try {
    const content = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(content) as PromptEvolutionState;

    return {
      currentVersion: parsed.currentVersion ?? 0,
      versions: Array.isArray(parsed.versions) ? parsed.versions : [],
      basePrompt: parsed.basePrompt || basePrompt,
      currentHints: Array.isArray(parsed.currentHints) ? parsed.currentHints : []
    };
  } catch {
    return getDefaultPromptEvolutionState(basePrompt);
  }
}

/**
 * Save prompt evolution state atomically
 */
export function savePromptEvolutionState(state: PromptEvolutionState, statePath: string): void {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${statePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state, null, 2));
  renameSync(tempPath, statePath);
}

// ============================================================================
// Prompt Evolution Class
// ============================================================================

export interface PromptEvolutionConfig {
  statePath: string;
  basePrompt: string;
}

export class PromptEvolution {
  private readonly config: PromptEvolutionConfig;
  private state: PromptEvolutionState;
  private onPromptChanged: ((newPrompt: string, reason: string) => void) | null = null;

  constructor(config: PromptEvolutionConfig) {
    this.config = config;
    this.state = loadPromptEvolutionState(config.statePath, config.basePrompt);
  }

  /**
   * Set callback for prompt changes
   */
  setOnPromptChanged(callback: (newPrompt: string, reason: string) => void): void {
    this.onPromptChanged = callback;
  }

  /**
   * Analyze prompt effectiveness and determine if changes are needed
   */
  analyzePromptEffectiveness(metrics: PerformanceMetrics): {
    needsChange: boolean;
    suggestedChanges: PromptChanges;
    reasons: string[];
  } {
    const suggestedChanges: PromptChanges = {
      additions: [],
      simplifications: [],
      removals: []
    };
    const reasons: string[] = [];

    // Check tool call efficiency
    if (metrics.toolCallSuccessRate < TOOL_CALL_THRESHOLD) {
      const hints = DECISION_HINTS.lowToolCallEfficiency.filter(
        h => !this.state.currentHints.includes(h)
      );
      if (hints.length > 0) {
        suggestedChanges.additions!.push(...hints.slice(0, 2));
        reasons.push(`Tool call efficiency below ${TOOL_CALL_THRESHOLD * 100}%`);
      }
    }

    // Check failed research cycles
    if (metrics.failedResearchCycles > FAILED_RESEARCH_THRESHOLD) {
      const hints = DECISION_HINTS.highFailedResearch.filter(
        h => !this.state.currentHints.includes(h)
      );
      if (hints.length > 0) {
        suggestedChanges.additions!.push(...hints.slice(0, 2));
        suggestedChanges.simplifications!.push("Reduced complexity in research instructions");
        reasons.push(`Failed research cycles exceeds ${FAILED_RESEARCH_THRESHOLD}`);
      }
    }

    // Check win rate (optional, less aggressive)
    if (metrics.winRate < 0.35) {
      const hints = DECISION_HINTS.lowWinRate.filter(
        h => !this.state.currentHints.includes(h)
      );
      if (hints.length > 0) {
        suggestedChanges.additions!.push(...hints.slice(0, 1));
        reasons.push("Win rate below 35%");
      }
    }

    const needsChange =
      (suggestedChanges.additions?.length || 0) > 0 ||
      (suggestedChanges.simplifications?.length || 0) > 0 ||
      (suggestedChanges.removals?.length || 0) > 0;

    return { needsChange, suggestedChanges, reasons };
  }

  /**
   * Update prompt with changes (only adds hints, never modifies core)
   */
  updatePrompt(changes: PromptChanges, reason: string): string {
    // Add new hints
    const newHints = [...this.state.currentHints];
    if (changes.additions) {
      for (const hint of changes.additions) {
        if (!newHints.includes(hint)) {
          newHints.push(hint);
        }
      }
    }

    // Build new prompt
    const newPrompt = this.buildPromptWithHints(newHints);

    // Create new version
    const newVersion: PromptVersion = {
      version: this.state.currentVersion + 1,
      timestamp: Date.now(),
      changes,
      reason,
      content: newPrompt
    };

    // Update state
    this.state.versions.push(newVersion);
    this.state.currentVersion = newVersion.version;
    this.state.currentHints = newHints;

    // Trim old versions if needed
    if (this.state.versions.length > MAX_VERSIONS) {
      this.state.versions = this.state.versions.slice(-MAX_VERSIONS);
    }

    this.save();

    if (this.onPromptChanged) {
      this.onPromptChanged(newPrompt, reason);
    }

    return newPrompt;
  }

  /**
   * Rollback to a previous version
   */
  rollbackPrompt(targetVersion?: number): string {
    const target = targetVersion ?? this.state.currentVersion - 1;

    const version = this.state.versions.find(v => v.version === target);
    if (!version) {
      throw new Error(`Version ${target} not found`);
    }

    // Reconstruct hints from version
    this.state.currentVersion = target;
    this.state.currentHints = this.extractHintsFromVersion(version);
    this.save();

    if (this.onPromptChanged) {
      this.onPromptChanged(version.content, `Rolled back to version ${target}`);
    }

    return version.content;
  }

  /**
   * Get current prompt
   */
  getCurrentPrompt(): string {
    return this.buildPromptWithHints(this.state.currentHints);
  }

  /**
   * Get current version number
   */
  getCurrentVersion(): number {
    return this.state.currentVersion;
  }

  /**
   * Get version history
   */
  getVersionHistory(): PromptVersion[] {
    return [...this.state.versions];
  }

  /**
   * Get current hints
   */
  getCurrentHints(): string[] {
    return [...this.state.currentHints];
  }

  /**
   * Clear all hints and reset to base prompt
   */
  resetToBase(): string {
    this.state.currentHints = [];
    this.state.currentVersion = 0;
    this.state.versions = [{
      version: 0,
      timestamp: Date.now(),
      changes: {},
      reason: "Reset to base",
      content: this.state.basePrompt
    }];
    this.save();

    if (this.onPromptChanged) {
      this.onPromptChanged(this.state.basePrompt, "Reset to base prompt");
    }

    return this.state.basePrompt;
  }

  /**
   * Build prompt with decision hints section
   */
  private buildPromptWithHints(hints: string[]): string {
    if (hints.length === 0) {
      return this.state.basePrompt;
    }

    const hintsSection = `
## Adaptive Decision Hints

The following guidance has been added based on performance analysis:

${hints.map(h => `- ${h}`).join("\n")}

`;

    // Append hints section to base prompt
    return this.state.basePrompt + "\n" + hintsSection;
  }

  /**
   * Extract hints from a version
   */
  private extractHintsFromVersion(version: PromptVersion): string[] {
    // Parse hints from version content (simplified extraction)
    const hints: string[] = [];
    const hintsMatch = version.content.match(/## Adaptive Decision Hints[\s\S]*?(?=##|$)/);

    if (hintsMatch) {
      const lines = hintsMatch[0].split("\n");
      for (const line of lines) {
        const match = line.match(/^- (.+)$/);
        if (match) {
          hints.push(match[1]);
        }
      }
    }

    return hints;
  }

  /**
   * Save state to disk
   */
  private save(): void {
    savePromptEvolutionState(this.state, this.config.statePath);
  }
}

/**
 * Get default prompt evolution configuration
 */
export function getDefaultPromptEvolutionConfig(botDir: string, basePrompt: string): PromptEvolutionConfig {
  return {
    statePath: join(botDir, "agent", "prompt-evolution.json"),
    basePrompt
  };
}
