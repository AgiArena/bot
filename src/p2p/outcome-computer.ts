/**
 * Outcome Computer Module (Story 5-2: Method-Based Resolution)
 *
 * Computes bet outcomes using method-based resolution:
 * - "up:X" = maker wins if price increased > X%
 * - "down:X" = maker wins if price decreased > X%
 * - "flat:X" = maker wins if price stayed within ±X%
 *
 * CRITICAL: All calculations use BigInt for determinism across Bot, Data Node, and Keeper.
 *
 * Tie-breaking convention: taker wins ties
 */

import {
  type MerkleTree,
  type Trade,
  type ParsedMethod,
  parseMethod,
  evaluateTrade,
} from "../merkle-tree";

// Re-export for consumers that import from this module
export { parseMethod, evaluateTrade };
export type { ParsedMethod };

/**
 * Result of computing bet outcome
 */
export interface OutcomeResult {
  /** Number of trades won by maker */
  makerWins: number;
  /** Number of trades won by taker */
  takerWins: number;
  /** Total trades evaluated (excludes null exit prices) */
  total: number;
  /** Address of winner */
  winner: string;
}

/**
 * Exit prices map: trade index -> exit price (bigint, or null if pending)
 */
export type ExitPrices = Map<number, bigint | null>;

// ============================================================================
// Outcome Computation (AC: #6)
// ============================================================================

/**
 * Compute outcome from MerkleTree trades and exit prices
 *
 * AC6: Tie-breaking convention - taker wins ties (makerWins <= takerWins)
 *
 * @param tree - MerkleTree containing trades with entry prices and methods
 * @param exitPrices - Map of trade index to exit price (null = pending)
 * @param maker - Maker's address
 * @param taker - Taker's address
 * @returns OutcomeResult with winner determination
 */
export function computeOutcome(
  tree: MerkleTree,
  exitPrices: ExitPrices,
  maker: string,
  taker: string,
): OutcomeResult {
  let makerWins = 0;
  let takerWins = 0;

  for (let i = 0; i < tree.trades.length; i++) {
    const trade = tree.trades[i];
    const exitPrice = exitPrices.get(i);

    // AC7: Skip if exit price is null (pending)
    if (exitPrice === undefined || exitPrice === null) {
      continue;
    }

    // Skip if entry is zero (invalid trade)
    if (trade.entryPrice === 0n) {
      continue;
    }

    try {
      const result = evaluateTrade(trade.entryPrice, exitPrice, trade.method);

      // null result = pending (already filtered above, but safety check)
      if (result === null) {
        continue;
      }

      if (result) {
        makerWins++;
      } else {
        takerWins++;
      }
    } catch {
      // Invalid method - skip this trade
      console.warn(`[OutcomeComputer] Invalid method for trade ${i}: ${trade.method}`);
      continue;
    }
  }

  const total = makerWins + takerWins;

  // AC6: Tie-breaking - taker wins ties
  // Taker wins if makerWins <= takerWins (including ties)
  const winner = makerWins > takerWins ? maker : taker;

  return {
    makerWins,
    takerWins,
    total,
    winner,
  };
}

/**
 * Compute outcome from trades array directly (alternative interface)
 *
 * @param trades - Array of trades with entry prices and methods
 * @param exitPrices - Map of trade index to exit price
 * @param maker - Maker's address
 * @param taker - Taker's address
 * @returns OutcomeResult with winner determination
 */
export function computeOutcomeFromTrades(
  trades: Trade[],
  exitPrices: ExitPrices,
  maker: string,
  taker: string,
): OutcomeResult {
  let makerWins = 0;
  let takerWins = 0;

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    const exitPrice = exitPrices.get(i);

    if (exitPrice === undefined || exitPrice === null) continue;
    if (trade.entryPrice === 0n) continue;

    try {
      const result = evaluateTrade(trade.entryPrice, exitPrice, trade.method);
      if (result === null) continue;

      if (result) {
        makerWins++;
      } else {
        takerWins++;
      }
    } catch {
      continue;
    }
  }

  const total = makerWins + takerWins;
  const winner = makerWins > takerWins ? maker : taker;

  return { makerWins, takerWins, total, winner };
}

/**
 * Compare two outcome results for agreement
 *
 * Used when comparing proposer's outcome with local computation
 *
 * @param a - First outcome
 * @param b - Second outcome
 * @returns True if outcomes match
 */
export function outcomesMatch(a: OutcomeResult, b: OutcomeResult): boolean {
  return (
    a.makerWins === b.makerWins &&
    a.takerWins === b.takerWins &&
    a.total === b.total &&
    a.winner.toLowerCase() === b.winner.toLowerCase()
  );
}

/**
 * Validate outcome is consistent (internal sanity check)
 *
 * @param outcome - Outcome to validate
 * @returns True if outcome is internally consistent
 */
export function validateOutcomeConsistency(outcome: OutcomeResult): boolean {
  // total should equal makerWins + takerWins
  if (outcome.total !== outcome.makerWins + outcome.takerWins) {
    return false;
  }

  // Can't have negative wins
  if (outcome.makerWins < 0 || outcome.takerWins < 0) {
    return false;
  }

  return true;
}
