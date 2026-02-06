/**
 * Register Bot Script
 *
 * Registers the bot with BotRegistry using environment variables.
 */

import { createChainClientFromEnv } from "./chain-client";

async function main() {
  const chainClient = createChainClientFromEnv();
  if (!chainClient) {
    console.error("Failed to create chain client. Check AGENT_PRIVATE_KEY.");
    process.exit(1);
  }

  const address = chainClient.getAddress();
  const endpoint = process.env.P2P_ENDPOINT;
  const pubkeyHash = process.env.BOT_PUBKEY_HASH;

  console.log(`Bot address: ${address}`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Pubkey hash: ${pubkeyHash}`);

  if (!endpoint || !pubkeyHash) {
    console.error("Missing P2P_ENDPOINT or BOT_PUBKEY_HASH");
    process.exit(1);
  }

  // Check if already registered
  const isRegistered = await chainClient.isBotRegistered(address);
  if (isRegistered) {
    console.log("Bot is already registered!");
    const botInfo = await chainClient.getBotInfo(address);
    console.log(`  Endpoint: ${botInfo?.endpoint}`);
    console.log(`  Staked: ${botInfo?.stakedAmount.toString()}`);
    process.exit(0);
  }

  // Check WIND balance
  const balance = await chainClient.getCollateralBalance();
  console.log(`WIND balance: ${balance.toString()}`);

  // Register
  console.log("Registering bot...");
  const result = await chainClient.registerBot(endpoint, pubkeyHash);

  if (result.success) {
    console.log(`Registration successful! TX: ${result.txHash}`);
  } else {
    console.error(`Registration failed: ${result.error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
