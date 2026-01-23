/**
 * Telegram Bot Service for AgiArena
 *
 * Story 6-3: Implements Telegram bot commands:
 * - /start - Generate verification link for wallet linking
 * - /status - Show agent P&L and rank
 * - /bets - List active bets
 * - /unlink - Remove Telegram subscription
 *
 * Run with: bun run telegram-bot
 */

import { Telegraf, Context } from 'telegraf';

// Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN environment variable is required');
  process.exit(1);
}

// Initialize Telegraf bot
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ============================================================================
// Rate Limiting (AC8: max 30 messages/second globally)
// ============================================================================

let messageCount = 0;
let lastSecond = Date.now();

/**
 * Rate-limited message sender
 * Respects Telegram API limits of 30 messages/second globally
 */
export async function rateLimitedSend(
  chatId: number,
  text: string,
  options?: Parameters<typeof bot.telegram.sendMessage>[2]
): Promise<void> {
  const now = Date.now();

  // Reset counter every second
  if (now - lastSecond > 1000) {
    messageCount = 0;
    lastSecond = now;
  }

  // Wait if we've hit the limit
  if (messageCount >= 30) {
    await new Promise(resolve => setTimeout(resolve, 1000 - (now - lastSecond)));
    messageCount = 0;
    lastSecond = Date.now();
  }

  messageCount++;
  await bot.telegram.sendMessage(chatId, text, options);
}

// ============================================================================
// Command Handlers
// ============================================================================

/**
 * /start command - Generate verification code and send linking instructions
 */
bot.start(async (ctx: Context) => {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) {
    return ctx.reply('Error: Could not identify your Telegram account.');
  }

  try {
    // Generate verification code via backend API
    const res = await fetch(`${BACKEND_URL}/api/telegram/generate-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramUserId }),
    });

    if (!res.ok) {
      const error = await res.text();
      console.error('Failed to generate code:', error);
      return ctx.reply('Sorry, there was an error generating your verification code. Please try again later.');
    }

    const { code } = await res.json();

    const verificationUrl = `${FRONTEND_URL}/telegram/verify?code=${code}`;

    await ctx.reply(
      `Welcome to AgiArena! 🤖\n\n` +
      `To link your wallet and receive notifications, follow these steps:\n\n` +
      `1️⃣ Visit this link:\n${verificationUrl}\n\n` +
      `2️⃣ Connect your wallet\n\n` +
      `3️⃣ Sign the verification message\n\n` +
      `Your verification code: \`${code}\`\n\n` +
      `Once linked, you'll receive notifications for:\n` +
      `• Bet matches\n` +
      `• Bet settlements (wins/losses)\n` +
      `• Rank changes`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Error in /start command:', error);
    return ctx.reply('Sorry, there was an error. Please try again later.');
  }
});

/**
 * /status command - Show agent P&L and rank
 */
bot.command('status', async (ctx: Context) => {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) {
    return ctx.reply('Error: Could not identify your Telegram account.');
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/telegram/user/${telegramUserId}/status`);

    if (!res.ok) {
      if (res.status === 404) {
        return ctx.reply(
          '❌ No wallet linked.\n\n' +
          'Send /start to link your wallet and start receiving notifications.'
        );
      }
      const error = await res.text();
      console.error('Failed to fetch status:', error);
      return ctx.reply('Sorry, there was an error fetching your status. Please try again later.');
    }

    const { rank, pnl, winRate, walletAddress } = await res.json();

    // Format P&L with + or - sign
    const pnlNum = parseFloat(pnl);
    const pnlFormatted = pnlNum >= 0 ? `+$${pnl}` : `-$${Math.abs(pnlNum).toFixed(2)}`;

    await ctx.reply(
      `📊 *Your Agent Stats*\n\n` +
      `🏆 Rank: #${rank}\n` +
      `💰 P&L: ${pnlFormatted}\n` +
      `📈 Win Rate: ${winRate}%\n\n` +
      `Wallet: \`${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}\``,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Error in /status command:', error);
    return ctx.reply('Sorry, there was an error. Please try again later.');
  }
});

/**
 * /bets command - List active bets
 */
bot.command('bets', async (ctx: Context) => {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) {
    return ctx.reply('Error: Could not identify your Telegram account.');
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/telegram/user/${telegramUserId}/bets`);

    if (!res.ok) {
      if (res.status === 404) {
        return ctx.reply(
          '❌ No wallet linked.\n\n' +
          'Send /start to link your wallet and start receiving notifications.'
        );
      }
      const error = await res.text();
      console.error('Failed to fetch bets:', error);
      return ctx.reply('Sorry, there was an error fetching your bets. Please try again later.');
    }

    const { bets } = await res.json();

    if (!bets || bets.length === 0) {
      return ctx.reply(
        '📋 *Active Bets*\n\n' +
        'No active bets found.\n\n' +
        'Create a new bet at agiarena.xyz',
        { parse_mode: 'Markdown' }
      );
    }

    const betList = bets.map((b: { portfolioSize: number; amount: string; status: string }) =>
      `• ${b.portfolioSize} markets | $${b.amount} | ${b.status}`
    ).join('\n');

    await ctx.reply(
      `📋 *Active Bets*\n\n${betList}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Error in /bets command:', error);
    return ctx.reply('Sorry, there was an error. Please try again later.');
  }
});

/**
 * /unlink command - Remove Telegram subscription
 */
bot.command('unlink', async (ctx: Context) => {
  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) {
    return ctx.reply('Error: Could not identify your Telegram account.');
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/telegram/user/${telegramUserId}`, {
      method: 'DELETE',
    });

    if (res.ok) {
      await ctx.reply(
        '✅ *Telegram notifications disconnected*\n\n' +
        'You will no longer receive bet notifications.\n\n' +
        'Send /start to reconnect.',
        { parse_mode: 'Markdown' }
      );
    } else if (res.status === 404) {
      await ctx.reply(
        '❌ No wallet linked to disconnect.\n\n' +
        'Send /start to link your wallet.'
      );
    } else {
      const error = await res.text();
      console.error('Failed to unlink:', error);
      await ctx.reply('Sorry, there was an error. Please try again later.');
    }
  } catch (error) {
    console.error('Error in /unlink command:', error);
    return ctx.reply('Sorry, there was an error. Please try again later.');
  }
});

/**
 * /help command - Show available commands
 */
bot.help((ctx: Context) => {
  return ctx.reply(
    `🤖 *AgiArena Bot Commands*\n\n` +
    `/start - Link your wallet to receive notifications\n` +
    `/status - View your agent's P&L and rank\n` +
    `/bets - List your active bets\n` +
    `/unlink - Stop receiving notifications\n` +
    `/help - Show this help message\n\n` +
    `Visit agiarena.xyz to manage your portfolio bets.`,
    { parse_mode: 'Markdown' }
  );
});

// ============================================================================
// Bot Lifecycle
// ============================================================================

// Launch the bot
bot.launch();
console.log('🤖 AgiArena Telegram bot started');
console.log(`   Backend URL: ${BACKEND_URL}`);
console.log(`   Frontend URL: ${FRONTEND_URL}`);

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  bot.stop('SIGTERM');
});

// Export for use by telegram-notifier
export { bot };
