/**
 * Telegram Notifier Service for AgiArena
 *
 * Story 6-3: Subscribes to SSE bet events and sends Telegram notifications
 *
 * This service:
 * - Connects to GET /api/sse/bets endpoint
 * - Listens for bet-matched, bet-settled events
 * - Looks up Telegram user ID from wallet address
 * - Sends formatted notifications to Telegram users
 *
 * Run with: bun run telegram-notifier
 *
 * NOTE: This service shares the rate limiter with telegram-bot.ts to respect
 * Telegram's global 30 msg/sec limit across both services.
 */

import { bot, rateLimitedSend } from './telegram-bot';

// Configuration
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Rate limiting is handled by the shared rateLimitedSend from telegram-bot.ts
// This ensures both services respect Telegram's global 30 msg/sec limit

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
// Notification Formatters (AC7)
// ============================================================================

/**
 * Format bet-matched notification
 */
function formatBetMatchedMessage(data: BetMatchedEvent): string {
  return (
    `🤝 *Bet Matched!*\n\n` +
    `💰 Amount: $${data.amount}\n` +
    `⏱️ Just now\n\n` +
    `[View Details](${FRONTEND_URL}/bet/${data.betId})`
  );
}

/**
 * Format bet-settled notification (win)
 */
function formatBetWonMessage(data: BetSettledEvent): string {
  return (
    `🎉 *You won!*\n\n` +
    `💰 +$${data.pnl} on ${data.portfolioSize.toLocaleString()} markets\n\n` +
    `[View Details](${FRONTEND_URL}/bet/${data.betId})`
  );
}

/**
 * Format bet-settled notification (loss)
 */
function formatBetLostMessage(data: BetSettledEvent): string {
  const pnlNum = parseFloat(data.pnl);
  return (
    `📉 *Bet settled*\n\n` +
    `💸 -$${Math.abs(pnlNum).toFixed(2)} on ${data.portfolioSize.toLocaleString()} markets\n\n` +
    `[View Details](${FRONTEND_URL}/bet/${data.betId})`
  );
}

/**
 * Format rank-change notification
 */
function formatRankChangeMessage(data: RankChangeEvent): string {
  const delta = data.oldRank - data.newRank;
  if (delta > 0) {
    return `📈 You moved to rank #${data.newRank} (+${delta} positions)`;
  } else {
    return `📉 You dropped to rank #${data.newRank} (${delta} positions)`;
  }
}

// ============================================================================
// SSE Event Handlers
// ============================================================================

/**
 * Handle bet-matched event
 */
async function handleBetMatched(data: BetMatchedEvent): Promise<void> {
  console.log(`Bet matched: ${data.betId} by ${data.matcher}`);

  // Notify the matcher (the counter-party who just matched)
  const telegramId = await getTelegramUserId(data.matcher);
  if (telegramId) {
    const message = formatBetMatchedMessage(data);
    await rateLimitedSend(telegramId, message, { parse_mode: 'Markdown' });
    console.log(`Sent bet-matched notification to Telegram user ${telegramId}`);
  }
}

/**
 * Handle bet-settled event
 */
async function handleBetSettled(data: BetSettledEvent): Promise<void> {
  console.log(`Bet settled: ${data.betId}, winner: ${data.winner}, pnl: ${data.pnl}`);

  // Notify the winner/loser
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

/**
 * Handle rank-change event
 */
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
const MAX_RECONNECT_DELAY = 60000; // Max 1 minute between reconnects

/**
 * Parse SSE event from raw text line
 */
function parseSSEEvent(line: string): { event: string; data: string } | null {
  // SSE format: "event: eventName" followed by "data: {...}"
  const eventMatch = line.match(/^event:\s*(.+)$/);
  const dataMatch = line.match(/^data:\s*(.+)$/);

  if (dataMatch) {
    return { event: 'message', data: dataMatch[1] };
  }
  return null;
}

/**
 * Connect to SSE endpoint for bet events using fetch streaming
 * (EventSource is not available in Bun runtime)
 */
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

    console.log('📡 Connected to SSE for bet events');
    reconnectAttempts = 0; // Reset on successful connection

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
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmedLine = line.trim();

        if (trimmedLine === '') {
          // Empty line marks end of event
          currentEvent = '';
          continue;
        }

        // Parse event type
        if (trimmedLine.startsWith('event:')) {
          currentEvent = trimmedLine.slice(6).trim();
          continue;
        }

        // Parse data
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
              default:
                // Ignore unknown events (like heartbeat)
                break;
            }
          } catch (error) {
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
// Service Lifecycle
// ============================================================================

console.log('🔔 AgiArena Telegram Notifier starting...');
console.log(`   Backend URL: ${BACKEND_URL}`);

// Start SSE connection
connectToSSE();

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  process.exit(0);
});

// Re-export from telegram-bot for convenience
export { bot, rateLimitedSend } from './telegram-bot';
