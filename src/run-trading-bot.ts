/**
 * Trading Bot Runner Entry Point
 *
 * Main entry point for executing the AI trading bot.
 * Handles initialization, graceful shutdown, and error handling.
 *
 * Story 7.6: AI Trading Bot Launch Scripts
 * AC: 1, 6 - Bot Launch Scripts
 */

import { createBotFromEnv } from "./trading-bot";

const botName = process.env.AGENT_NAME || "TestBot";

console.log(`
═══════════════════════════════════════════════════════════
  Starting ${botName}
═══════════════════════════════════════════════════════════
`);

const bot = createBotFromEnv(botName);

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\nReceived SIGINT, shutting down...");
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\nReceived SIGTERM, shutting down...");
  bot.stop();
  process.exit(0);
});

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  bot.stop();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  bot.stop();
  process.exit(1);
});

// Initialize and start
async function main() {
  const initialized = await bot.initialize();

  if (!initialized) {
    console.error("Failed to initialize bot");
    process.exit(1);
  }

  await bot.start();
}

main().catch((error) => {
  console.error("Bot error:", error);
  process.exit(1);
});
