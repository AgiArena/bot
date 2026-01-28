/**
 * AgiArena Trading Bot - Entry Point
 *
 * Simplified bot infrastructure with:
 * - Rate limiting
 * - Cancellation logic
 * - Unified state management
 *
 * Run with: bun run start
 */

export { TradingBot, createBotFromEnv, type TradingBotConfig } from "./trading-bot";
export { startNotifier, stopNotifier } from "./notifier";
export { checkRateLimits, loadRateLimitsFromEnv, type RateLimits } from "./rate-limiter";
export { evaluateCancellation, loadCancellationConfigFromEnv, type CancellationConfig } from "./cancellation";
export { loadOrCreateState, saveState, type BotState } from "./unified-state";
export { ChainClient, createChainClientFromEnv } from "./chain-client";
export { CircuitBreaker, polymarketBreaker, baseRpcBreaker, backendBreaker } from "./circuit-breaker";
export { Logger } from "./logger";

console.log("AgiArena Bot - Simplified Infrastructure v0.2.0");
