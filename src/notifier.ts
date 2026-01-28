/**
 * Telegram Notifier Service
 *
 * Unified module combining:
 * - Telegram bot commands (/start, /status, /bets, /unlink)
 * - SSE event notifications (bet-matched, bet-settled, rank-change)
 *
 * Run with: bun run notifier
 */

import { Telegraf, Context } from 'telegraf';

// Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Bot instance (null if token not configured)
let bot: Telegraf | null = null;

if (TELEGRAM_BOT_TOKEN) {
  bot = new Telegraf(TELEGRAM_BOT_TOKEN);
}

// ============================================================================
// Rate Limiting (max 30 messages/second globally)
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
  options?: Parameters<Telegraf['telegram']['sendMessage']>[2]
): Promise<void> {
  if (!bot) {
    console.log(`[Notifier] No bot configured, would send to ${chatId}: ${text.slice(0, 50)}...`);
    return;
  }

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
// Telegram User Lookup
// ============================================================================

/**
 * Get Telegram user ID from wallet address
 * Returns null if wallet is not linked to Telegram
 */
async function getTelegramUserId(walletAddress: string): Promise<number | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/telegram/wallet/${walletAddress}`);
    if (!res.ok) {
      return null;
    }
    const { telegramUserId } = await res.json();
    return telegramUserId;
  } catch (error) {
    console.error(`Failed to lookup Telegram user for ${walletAddress}:`, error);
    return null;
  }
}

// ============================================================================
// SSE Event Types
// ============================================================================

interface BetMatchedEvent {
  betId: string;
  matcher: string;
  amount: string;
  timestamp: string;
}

interface BetSettledEvent {
  betId: string;
  winner: string;
  pnl: string;
  portfolioSize: number;
  timestamp: string;
}

interface RankChangeEvent {
  address: string;
  oldRank: number;
  newRank: number;
}

// ============================================================================
// Notification Formatters
// ============================================================================

function formatBetMatchedMessage(data: BetMatchedEvent): string {
  return (
    `\u{1F91D} *Bet Matched!*\n\n` +
    `\u{1F4B0} Amount: $${data.amount}\n` +
    `\u23F1\uFE0F Just now\n\n` +
    `[View Details](${FRONTEND_URL}/bet/${data.betId})`
  );
}

function formatBetWonMessage(data: BetSettledEvent): string {
  return (
    `\u{1F389} *You won!*\n\n` +
    `\u{1F4B0} +$${data.pnl} on ${data.portfolioSize.toLocaleString()} markets\n\n` +
    `[View Details](${FRONTEND_URL}/bet/${data.betId})`
  );
}

function formatBetLostMessage(data: BetSettledEvent): string {
  const pnlNum = parseFloat(data.pnl);
  return (
    `\u{1F4C9} *Bet settled*\n\n` +
    `\u{1F4B8} -$${Math.abs(pnlNum).toFixed(2)} on ${data.portfolioSize.toLocaleString()} markets\n\n` +
    `[View Details](${FRONTEND_URL}/bet/${data.betId})`
  );
}

function formatRankChangeMessage(data: RankChangeEvent): string {
  const delta = data.oldRank - data.newRank;
  if (delta > 0) {
    return `\u{1F4C8} You moved to rank #${data.newRank} (+${delta} positions)`;
  } else {
    return `\u{1F4C9} You dropped to rank #${data.newRank} (${delta} positions)`;
  }
}

// ============================================================================
// SSE Event Handlers
// ============================================================================

async function handleBetMatched(data: BetMatchedEvent): Promise<void> {
  console.log(`Bet matched: ${data.betId} by ${data.matcher}`);

  const telegramId = await getTelegramUserId(data.matcher);
  if (telegramId) {
    const message = formatBetMatchedMessage(data);
    await rateLimitedSend(telegramId, message, { parse_mode: 'Markdown' });
    console.log(`Sent bet-matched notification to Telegram user ${telegramId}`);
  }
}

async function handleBetSettled(data: BetSettledEvent): Promise<void> {
  console.log(`Bet settled: ${data.betId}, winner: ${data.winner}, pnl: ${data.pnl}`);

  const telegramId = await getTelegramUserId(data.winner);
  if (telegramId) {
    const pnlNum = parseFloat(data.pnl);
    const isWin = pnlNum > 0;

    const message = isWin
      ? formatBetWonMessage(data)
      : formatBetLostMessage(data);

    await rateLimitedSend(telegramId, message, { parse_mode: 'Markdown' });
    console.log(`Sent bet-settled notification to Telegram user ${telegramId}`);
  }
}

async function handleRankChange(data: RankChangeEvent): Promise<void> {
  const delta = data.oldRank - data.newRank;

  // Only notify on improvements (moving up)
  if (delta <= 0) {
    return;
  }

  console.log(`Rank change: ${data.address} moved from #${data.oldRank} to #${data.newRank}`);

  const telegramId = await getTelegramUserId(data.address);
  if (telegramId) {
    const message = formatRankChangeMessage(data);
    await rateLimitedSend(telegramId, message, { parse_mode: 'Markdown' });
    console.log(`Sent rank-change notification to Telegram user ${telegramId}`);
  }
}

// ============================================================================
// SSE Connection with Reconnection
// ============================================================================

let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000;

async function connectToSSE(): Promise<void> {
  const sseUrl = `${BACKEND_URL}/api/sse/bets`;
  console.log(`Connecting to SSE: ${sseUrl}`);

  try {
    const response = await fetch(sseUrl, {
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    console.log('Connected to SSE for bet events');
    reconnectAttempts = 0;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        console.log('SSE stream ended');
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();

        if (trimmedLine === '') {
          currentEvent = '';
          continue;
        }

        if (trimmedLine.startsWith('event:')) {
          currentEvent = trimmedLine.slice(6).trim();
          continue;
        }

        if (trimmedLine.startsWith('data:')) {
          const data = trimmedLine.slice(5).trim();

          try {
            const parsed = JSON.parse(data);

            switch (currentEvent) {
              case 'bet-matched':
                handleBetMatched(parsed as BetMatchedEvent).catch(err =>
                  console.error('Error handling bet-matched:', err)
                );
                break;
              case 'bet-settled':
                handleBetSettled(parsed as BetSettledEvent).catch(err =>
                  console.error('Error handling bet-settled:', err)
                );
                break;
              case 'rank-change':
                handleRankChange(parsed as RankChangeEvent).catch(err =>
                  console.error('Error handling rank-change:', err)
                );
                break;
            }
          } catch {
            // Ignore parse errors for non-JSON data (like heartbeats)
          }
        }
      }
    }
  } catch (error) {
    console.error('SSE connection error:', error);
  }

  // Reconnect with exponential backoff
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  console.log(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
  setTimeout(connectToSSE, delay);
}

// ============================================================================
// Bot Commands (only if token is configured)
// ============================================================================

if (bot) {
  // /start command
  bot.start(async (ctx: Context) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) {
      return ctx.reply('Error: Could not identify your Telegram account.');
    }

    try {
      const res = await fetch(`${BACKEND_URL}/api/telegram/generate-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramUserId }),
      });

      if (!res.ok) {
        console.error('Failed to generate code:', await res.text());
        return ctx.reply('Sorry, there was an error generating your verification code. Please try again later.');
      }

      const { code } = await res.json();
      const verificationUrl = `${FRONTEND_URL}/telegram/verify?code=${code}`;

      await ctx.reply(
        `Welcome to AgiArena!\n\n` +
        `To link your wallet and receive notifications:\n\n` +
        `1. Visit: ${verificationUrl}\n` +
        `2. Connect your wallet\n` +
        `3. Sign the verification message\n\n` +
        `Your code: \`${code}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Error in /start command:', error);
      return ctx.reply('Sorry, there was an error. Please try again later.');
    }
  });

  // /status command
  bot.command('status', async (ctx: Context) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) {
      return ctx.reply('Error: Could not identify your Telegram account.');
    }

    try {
      const res = await fetch(`${BACKEND_URL}/api/telegram/user/${telegramUserId}/status`);

      if (!res.ok) {
        if (res.status === 404) {
          return ctx.reply('No wallet linked. Send /start to link your wallet.');
        }
        return ctx.reply('Sorry, there was an error fetching your status.');
      }

      const { rank, pnl, winRate, walletAddress } = await res.json();
      const pnlNum = parseFloat(pnl);
      const pnlFormatted = pnlNum >= 0 ? `+$${pnl}` : `-$${Math.abs(pnlNum).toFixed(2)}`;

      await ctx.reply(
        `*Your Agent Stats*\n\n` +
        `Rank: #${rank}\n` +
        `P&L: ${pnlFormatted}\n` +
        `Win Rate: ${winRate}%\n` +
        `Wallet: \`${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Error in /status command:', error);
      return ctx.reply('Sorry, there was an error. Please try again later.');
    }
  });

  // /bets command
  bot.command('bets', async (ctx: Context) => {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) {
      return ctx.reply('Error: Could not identify your Telegram account.');
    }

    try {
      const res = await fetch(`${BACKEND_URL}/api/telegram/user/${telegramUserId}/bets`);

      if (!res.ok) {
        if (res.status === 404) {
          return ctx.reply('No wallet linked. Send /start to link your wallet.');
        }
        return ctx.reply('Sorry, there was an error fetching your bets.');
      }

      const { bets } = await res.json();

      if (!bets || bets.length === 0) {
        return ctx.reply('*Active Bets*\n\nNo active bets found.', { parse_mode: 'Markdown' });
      }

      const betList = bets.map((b: { portfolioSize: number; amount: string; status: string }) =>
        `- ${b.portfolioSize} markets | $${b.amount} | ${b.status}`
      ).join('\n');

      await ctx.reply(`*Active Bets*\n\n${betList}`, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error in /bets command:', error);
      return ctx.reply('Sorry, there was an error. Please try again later.');
    }
  });

  // /unlink command
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
        await ctx.reply('Telegram notifications disconnected. Send /start to reconnect.');
      } else if (res.status === 404) {
        await ctx.reply('No wallet linked to disconnect. Send /start to link your wallet.');
      } else {
        await ctx.reply('Sorry, there was an error. Please try again later.');
      }
    } catch (error) {
      console.error('Error in /unlink command:', error);
      return ctx.reply('Sorry, there was an error. Please try again later.');
    }
  });

  // /help command
  bot.help((ctx: Context) => {
    return ctx.reply(
      `*AgiArena Bot Commands*\n\n` +
      `/start - Link your wallet\n` +
      `/status - View P&L and rank\n` +
      `/bets - List active bets\n` +
      `/unlink - Stop notifications\n` +
      `/help - Show this message`,
      { parse_mode: 'Markdown' }
    );
  });
}

// ============================================================================
// HTTP Webhook Server for notifications
// ============================================================================

const HTTP_PORT = process.env.NOTIFIER_PORT || 3002;

/**
 * Send wallet linked confirmation message
 */
async function sendWalletLinkedConfirmation(telegramUserId: number, walletAddress: string): Promise<void> {
  if (!bot) {
    console.log(`[Notifier] No bot configured, would send linked confirmation to ${telegramUserId}`);
    return;
  }

  const truncatedWallet = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
  const message =
    `✅ *Wallet Linked Successfully!*\n\n` +
    `Wallet: \`${truncatedWallet}\`\n\n` +
    `You'll now receive notifications for:\n` +
    `• Bet matches\n` +
    `• Settlements & P&L\n` +
    `• Rank changes\n\n` +
    `Use /status to check your stats anytime.`;

  try {
    await rateLimitedSend(telegramUserId, message, { parse_mode: 'Markdown' });
    console.log(`Sent wallet-linked confirmation to Telegram user ${telegramUserId}`);
  } catch (error) {
    console.error(`Failed to send wallet-linked confirmation:`, error);
  }
}

/**
 * Start HTTP server for webhooks
 */
function startHttpServer(): void {
  const server = Bun.serve({
    port: Number(HTTP_PORT),
    async fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /notify/wallet-linked - Send confirmation when wallet is linked
      if (req.method === 'POST' && url.pathname === '/notify/wallet-linked') {
        try {
          const body = await req.json() as { telegramUserId: number; walletAddress: string };

          if (!body.telegramUserId || !body.walletAddress) {
            return new Response(JSON.stringify({ error: 'Missing telegramUserId or walletAddress' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          await sendWalletLinkedConfirmation(body.telegramUserId, body.walletAddress);

          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          console.error('Error handling wallet-linked webhook:', error);
          return new Response(JSON.stringify({ error: 'Internal error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      return new Response('Not found', { status: 404 });
    },
  });

  console.log(`Webhook server started on port ${HTTP_PORT}`);
}

// ============================================================================
// Service Lifecycle
// ============================================================================

/**
 * Start the notifier service
 */
export function startNotifier(): void {
  console.log('AgiArena Notifier starting...');
  console.log(`  Backend URL: ${BACKEND_URL}`);
  console.log(`  Frontend URL: ${FRONTEND_URL}`);
  console.log(`  Telegram: ${bot ? 'Configured' : 'Not configured'}`);

  // Start HTTP server for webhooks
  startHttpServer();

  // Start SSE connection for event notifications
  connectToSSE();

  // Launch bot if configured
  if (bot) {
    bot.launch();
    console.log('Telegram bot started');
  }
}

/**
 * Stop the notifier service gracefully
 */
export function stopNotifier(): void {
  console.log('Notifier shutting down...');
  if (bot) {
    bot.stop('SIGTERM');
  }
}

// Export bot for external use
export { bot };

// Start if run directly
if (import.meta.main) {
  startNotifier();

  process.once('SIGINT', () => {
    console.log('Received SIGINT, shutting down...');
    stopNotifier();
    process.exit(0);
  });

  process.once('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    stopNotifier();
    process.exit(0);
  });
}
