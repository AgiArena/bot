/**
 * Self-Diagnostic and Remediation System
 *
 * Implements hourly self-diagnostic routines that check:
 * - Memory leak detection (growth rate > 1.5x triggers RESTART_AGENT)
 * - Tool call efficiency (< 50% success rate triggers REVIEW_PROMPT)
 * - Decision quality (win rate < 40% triggers ADJUST_STRATEGY)
 * - External service health (unhealthy triggers ENABLE_FALLBACKS)
 * - Disk space management (< 1000MB triggers CLEANUP_OLD_DATA)
 *
 * AC: #1, #2, #3
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";
import type { AgentState } from "./types";

// ============================================================================
// Types
// ============================================================================

export type DiagnosticStatus = "PASS" | "FAIL" | "WARN";

export type RemediationAction =
  | "NONE"
  | "CLEANUP_OLD_DATA"
  | "ADJUST_STRATEGY"
  | "RESTART_AGENT"
  | "ENABLE_FALLBACKS"
  | "REVIEW_PROMPT";

export interface DiagnosticCheck {
  name: string;
  status: DiagnosticStatus;
  detail: string;
  action: RemediationAction;
}

export interface DiagnosticReport {
  timestamp: number;
  checks: DiagnosticCheck[];
  overallStatus: "HEALTHY" | "DEGRADED" | "CRITICAL";
  actionsExecuted: string[];
}

// ============================================================================
// Memory Trend Detection
// ============================================================================

interface MemorySample {
  timestamp: number;
  heapUsed: number;
}

// In-memory storage for memory samples
const memorySamples: MemorySample[] = [];
let memorySampleInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Record current memory usage sample
 */
export function recordMemorySample(): void {
  const mem = process.memoryUsage();
  memorySamples.push({
    timestamp: Date.now(),
    heapUsed: mem.heapUsed
  });

  // Keep only last hour of samples
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  while (memorySamples.length > 0 && memorySamples[0].timestamp < oneHourAgo) {
    memorySamples.shift();
  }
}

/**
 * Start memory sampling at 5-minute intervals
 */
export function startMemorySampling(): void {
  if (memorySampleInterval) return;

  // Take initial sample
  recordMemorySample();

  // Sample every 5 minutes
  memorySampleInterval = setInterval(recordMemorySample, 5 * 60 * 1000);
}

/**
 * Stop memory sampling
 */
export function stopMemorySampling(): void {
  if (memorySampleInterval) {
    clearInterval(memorySampleInterval);
    memorySampleInterval = null;
  }
}

/**
 * Calculate memory growth rate over the past hour
 * @returns Growth rate (1.0 = no growth, 1.5 = 50% increase)
 */
export function checkMemoryTrend(): number {
  if (memorySamples.length < 2) return 1.0;

  const first = memorySamples[0].heapUsed;
  const last = memorySamples[memorySamples.length - 1].heapUsed;

  // Prevent division by zero
  if (first === 0) return 1.0;

  return last / first;
}

// ============================================================================
// Tool Call Efficiency Analysis
// ============================================================================

/**
 * Parse agent log for tool call patterns and compute success rate
 * @param logPath Path to agent.log file
 * @returns Success rate (0.0 to 1.0)
 */
export function analyzeToolCalls(logPath: string): number {
  if (!existsSync(logPath)) return 1.0; // Assume healthy if no log

  try {
    const content = readFileSync(logPath, "utf-8");

    // Look for tool call result patterns (based on Claude Code output patterns)
    const successPattern = /\[TOOL_RESULT\].*success|tool_result.*"success"|✓|completed successfully/gi;
    const failurePattern = /\[TOOL_RESULT\].*failed|tool_result.*"error"|error|timeout|failed to/gi;

    const successes = (content.match(successPattern) || []).length;
    const failures = (content.match(failurePattern) || []).length;
    const total = successes + failures;

    if (total === 0) return 1.0; // No data, assume healthy
    return successes / total;
  } catch {
    return 1.0; // Can't read log, assume healthy
  }
}

// ============================================================================
// Bet Performance Analysis
// ============================================================================

/**
 * Analyze bet performance from agent state
 * @param state Agent state with matched bets
 * @returns Win rate (0.0 to 1.0)
 */
export function analyzeBetPerformance(state: AgentState | null): number {
  if (!state || !state.matchedBets || state.matchedBets.length === 0) {
    return 1.0; // No data, assume healthy
  }

  const resolvedBets = state.matchedBets.filter(
    bet => bet.status === "won" || bet.status === "lost"
  );

  if (resolvedBets.length === 0) return 1.0; // No resolved bets

  const wins = resolvedBets.filter(bet => bet.status === "won").length;
  return wins / resolvedBets.length;
}

// ============================================================================
// External Service Health Check
// ============================================================================

export interface ServiceHealthResult {
  polymarket: boolean;
  rpc: boolean;
  backend: boolean;
}

/**
 * Check health of external services
 * @returns Object with health status of each service
 */
export async function checkExternalServices(): Promise<ServiceHealthResult> {
  const results: ServiceHealthResult = {
    polymarket: true,
    rpc: true,
    backend: true
  };

  // Check Polymarket API (simple fetch with timeout)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const polyResponse = await fetch("https://clob.polymarket.com/health", {
      signal: controller.signal
    });
    clearTimeout(timeout);

    results.polymarket = polyResponse.ok;
  } catch {
    results.polymarket = false;
  }

  // Check RPC endpoint
  const rpcUrl = process.env.BASE_RPC_URL;
  if (rpcUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const rpcResponse = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_blockNumber",
          params: [],
          id: 1
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      results.rpc = rpcResponse.ok;
    } catch {
      results.rpc = false;
    }
  }

  // Check backend API
  const backendUrl = process.env.BACKEND_URL || "http://localhost:3001";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const backendResponse = await fetch(`${backendUrl}/api/health`, {
      signal: controller.signal
    });
    clearTimeout(timeout);

    results.backend = backendResponse.ok;
  } catch {
    results.backend = false;
  }

  return results;
}

// ============================================================================
// Disk Space Check
// ============================================================================

/**
 * Check available disk space in MB
 * @returns Available disk space in MB, or Infinity if can't check
 */
export function checkDiskSpace(): number {
  try {
    // Get available space in MB using df command
    const result = execSync("df -m . | tail -1 | awk '{print $4}'", { encoding: "utf-8" });
    return parseInt(result.trim(), 10);
  } catch {
    return Infinity; // Can't check, assume OK
  }
}

// ============================================================================
// Remediation Actions
// ============================================================================

/**
 * Clean up old diagnostic reports (older than 7 days)
 * @param diagnosticsDir Path to diagnostics directory
 */
export function cleanupOldReports(diagnosticsDir: string): number {
  if (!existsSync(diagnosticsDir)) return 0;

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  try {
    const files = readdirSync(diagnosticsDir);
    for (const file of files) {
      if (!file.startsWith("report-") || !file.endsWith(".json")) continue;

      const filePath = join(diagnosticsDir, file);
      const stats = statSync(filePath);

      if (stats.mtimeMs < sevenDaysAgo) {
        unlinkSync(filePath);
        deletedCount++;
      }
    }
  } catch {
    // Ignore cleanup errors
  }

  return deletedCount;
}

/**
 * Clean up old research terminal outputs (older than 7 days)
 * @param agentDir Path to agent directory
 */
export function cleanupOldData(agentDir: string): number {
  const researchDir = join(agentDir, "research");
  if (!existsSync(researchDir)) return 0;

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  try {
    const terminals = readdirSync(researchDir);
    for (const terminal of terminals) {
      const terminalPath = join(researchDir, terminal);
      const stats = statSync(terminalPath);

      if (stats.isDirectory() && stats.mtimeMs < sevenDaysAgo) {
        // Use recursive delete
        execSync(`rm -rf "${terminalPath}"`);
        deletedCount++;
      }
    }
  } catch {
    // Ignore cleanup errors
  }

  return deletedCount;
}

// ============================================================================
// Diagnostic Report Management
// ============================================================================

/**
 * Save a diagnostic report to file
 * @param report The diagnostic report
 * @param diagnosticsDir Path to diagnostics directory
 */
export function saveDiagnosticReport(report: DiagnosticReport, diagnosticsDir: string): string {
  // Ensure directory exists
  if (!existsSync(diagnosticsDir)) {
    mkdirSync(diagnosticsDir, { recursive: true });
  }

  const filename = `report-${report.timestamp}.json`;
  const filePath = join(diagnosticsDir, filename);

  writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

/**
 * Load a diagnostic report from file
 * @param filePath Path to report file
 */
export function loadDiagnosticReport(filePath: string): DiagnosticReport | null {
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as DiagnosticReport;
  } catch {
    return null;
  }
}

// ============================================================================
// Main Self-Diagnostics Class
// ============================================================================

export interface SelfDiagnosticsConfig {
  agentDir: string;
  logsDir: string;
  agentStatePath: string;
  memoryGrowthThreshold: number; // Default: 1.5
  toolCallSuccessThreshold: number; // Default: 0.5
  winRateThreshold: number; // Default: 0.4
  diskSpaceThreshold: number; // Default: 1000 MB
}

export class SelfDiagnostics {
  private readonly config: SelfDiagnosticsConfig;
  private readonly diagnosticsDir: string;
  private diagnosticInterval: ReturnType<typeof setInterval> | null = null;
  private onRestartRequested: (() => void) | null = null;
  private onFallbacksEnabled: (() => void) | null = null;
  private onStrategyAdjusted: (() => void) | null = null;
  private lastReport: DiagnosticReport | null = null;

  constructor(config: SelfDiagnosticsConfig) {
    this.config = config;
    this.diagnosticsDir = join(config.agentDir, "diagnostics");
  }

  /**
   * Set callback for when restart is recommended
   */
  setOnRestartRequested(callback: () => void): void {
    this.onRestartRequested = callback;
  }

  /**
   * Set callback for when fallbacks should be enabled
   */
  setOnFallbacksEnabled(callback: () => void): void {
    this.onFallbacksEnabled = callback;
  }

  /**
   * Set callback for when strategy should be adjusted
   */
  setOnStrategyAdjusted(callback: () => void): void {
    this.onStrategyAdjusted = callback;
  }

  /**
   * Load current agent state
   */
  private loadAgentState(): AgentState | null {
    if (!existsSync(this.config.agentStatePath)) return null;

    try {
      const content = readFileSync(this.config.agentStatePath, "utf-8");
      return JSON.parse(content) as AgentState;
    } catch {
      return null;
    }
  }

  /**
   * Run a single diagnostic check
   */
  async runDiagnostics(): Promise<DiagnosticReport> {
    const checks: DiagnosticCheck[] = [];
    const actionsExecuted: string[] = [];

    // 1. Memory Leak Detection
    const memoryGrowth = checkMemoryTrend();
    const memoryStatus: DiagnosticStatus =
      memoryGrowth > this.config.memoryGrowthThreshold ? "FAIL" :
      memoryGrowth > 1.2 ? "WARN" : "PASS";

    checks.push({
      name: "memory_trend",
      status: memoryStatus,
      detail: `Memory growth rate: ${memoryGrowth.toFixed(2)}x (threshold: ${this.config.memoryGrowthThreshold}x)`,
      action: memoryStatus === "FAIL" ? "RESTART_AGENT" : "NONE"
    });

    // 2. Tool Call Efficiency
    const toolLogPath = join(this.config.logsDir, "agent.log");
    const toolCallRate = analyzeToolCalls(toolLogPath);
    const toolStatus: DiagnosticStatus =
      toolCallRate < this.config.toolCallSuccessThreshold ? "FAIL" :
      toolCallRate < 0.6 ? "WARN" : "PASS";

    checks.push({
      name: "tool_call_efficiency",
      status: toolStatus,
      detail: `Tool call success rate: ${(toolCallRate * 100).toFixed(1)}% (threshold: ${this.config.toolCallSuccessThreshold * 100}%)`,
      action: toolStatus === "FAIL" ? "REVIEW_PROMPT" : "NONE"
    });

    // 3. Decision Quality (Win Rate)
    const agentState = this.loadAgentState();
    const winRate = analyzeBetPerformance(agentState);
    const winStatus: DiagnosticStatus =
      winRate < this.config.winRateThreshold ? "FAIL" :
      winRate < 0.5 ? "WARN" : "PASS";

    checks.push({
      name: "decision_quality",
      status: winStatus,
      detail: `Bet win rate: ${(winRate * 100).toFixed(1)}% (threshold: ${this.config.winRateThreshold * 100}%)`,
      action: winStatus === "FAIL" ? "ADJUST_STRATEGY" : "NONE"
    });

    // 4. External Service Health
    const serviceHealth = await checkExternalServices();
    const anyUnhealthy = !serviceHealth.polymarket || !serviceHealth.rpc || !serviceHealth.backend;
    const serviceStatus: DiagnosticStatus = anyUnhealthy ? "FAIL" : "PASS";

    const unhealthyServices: string[] = [];
    if (!serviceHealth.polymarket) unhealthyServices.push("polymarket");
    if (!serviceHealth.rpc) unhealthyServices.push("rpc");
    if (!serviceHealth.backend) unhealthyServices.push("backend");

    checks.push({
      name: "external_services",
      status: serviceStatus,
      detail: serviceStatus === "PASS"
        ? "All external services healthy"
        : `Unhealthy services: ${unhealthyServices.join(", ")}`,
      action: serviceStatus === "FAIL" ? "ENABLE_FALLBACKS" : "NONE"
    });

    // 5. Disk Space Management
    const diskSpace = checkDiskSpace();
    const diskStatus: DiagnosticStatus =
      diskSpace < this.config.diskSpaceThreshold ? "FAIL" :
      diskSpace < 2000 ? "WARN" : "PASS";

    checks.push({
      name: "disk_space",
      status: diskStatus,
      detail: `Available disk space: ${diskSpace}MB (threshold: ${this.config.diskSpaceThreshold}MB)`,
      action: diskStatus === "FAIL" ? "CLEANUP_OLD_DATA" : "NONE"
    });

    // Determine overall status
    const failCount = checks.filter(c => c.status === "FAIL").length;
    const warnCount = checks.filter(c => c.status === "WARN").length;
    const overallStatus: "HEALTHY" | "DEGRADED" | "CRITICAL" =
      failCount >= 2 ? "CRITICAL" :
      failCount >= 1 ? "DEGRADED" :
      warnCount >= 2 ? "DEGRADED" : "HEALTHY";

    // Execute remediation actions
    for (const check of checks) {
      if (check.action === "NONE") continue;

      switch (check.action) {
        case "CLEANUP_OLD_DATA":
          const deleted = cleanupOldData(this.config.agentDir);
          actionsExecuted.push(`CLEANUP_OLD_DATA: deleted ${deleted} old research directories`);
          break;

        case "ADJUST_STRATEGY":
          actionsExecuted.push("ADJUST_STRATEGY: flagged for conservative mode");
          if (this.onStrategyAdjusted) {
            this.onStrategyAdjusted();
          }
          break;

        case "RESTART_AGENT":
          actionsExecuted.push("RESTART_AGENT: scheduled for low-activity period");
          if (this.onRestartRequested) {
            this.onRestartRequested();
          }
          break;

        case "ENABLE_FALLBACKS":
          actionsExecuted.push(`ENABLE_FALLBACKS: activated for ${unhealthyServices.join(", ")}`);
          if (this.onFallbacksEnabled) {
            this.onFallbacksEnabled();
          }
          break;

        case "REVIEW_PROMPT":
          actionsExecuted.push("REVIEW_PROMPT: logged warning for operator review");
          console.error(`[DIAGNOSTIC ALERT] Tool call efficiency below threshold - operator review recommended`);
          break;
      }
    }

    const report: DiagnosticReport = {
      timestamp: Date.now(),
      checks,
      overallStatus,
      actionsExecuted
    };

    // Save report
    saveDiagnosticReport(report, this.diagnosticsDir);

    // Clean up old reports
    cleanupOldReports(this.diagnosticsDir);

    // Store for getLastReport()
    this.lastReport = report;

    return report;
  }

  /**
   * Get the last diagnostic report
   */
  getLastReport(): DiagnosticReport | null {
    return this.lastReport;
  }

  /**
   * Start hourly diagnostic scheduler
   */
  start(): void {
    if (this.diagnosticInterval) return;

    // Start memory sampling
    startMemorySampling();

    // Run initial diagnostic
    this.runDiagnostics().catch(err => {
      console.error("[self-diagnostics] Initial diagnostic failed:", err);
    });

    // Schedule hourly diagnostics
    this.diagnosticInterval = setInterval(() => {
      this.runDiagnostics().catch(err => {
        console.error("[self-diagnostics] Scheduled diagnostic failed:", err);
      });
    }, 60 * 60 * 1000); // Every hour
  }

  /**
   * Stop diagnostic scheduler
   */
  stop(): void {
    if (this.diagnosticInterval) {
      clearInterval(this.diagnosticInterval);
      this.diagnosticInterval = null;
    }
    stopMemorySampling();
  }

  /**
   * Get the diagnostics directory path
   */
  getDiagnosticsDir(): string {
    return this.diagnosticsDir;
  }
}

/**
 * Get default self-diagnostics configuration
 */
export function getDefaultSelfDiagnosticsConfig(botDir: string): SelfDiagnosticsConfig {
  return {
    agentDir: join(botDir, "agent"),
    logsDir: join(botDir, "logs"),
    agentStatePath: join(botDir, "agent", "agent-state.json"),
    memoryGrowthThreshold: 1.5,
    toolCallSuccessThreshold: 0.5,
    winRateThreshold: 0.4,
    diskSpaceThreshold: 1000
  };
}
