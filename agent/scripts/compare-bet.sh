#!/bin/bash
# compare-bet.sh - Compare a bet against the agent's portfolio score
#
# Usage: bash scripts/compare-bet.sh <betId>
#
# This script:
# 1. Accepts betId as command-line argument
# 2. Fetches bet portfolio from backend API (with pagination)
# 3. Loads agent's portfolio scores from portfolio-scores.json
# 4. Calculates Expected Value (EV)
# 5. Outputs JSON with recommendation
#
# Output JSON format:
# {
#   "betId": "123",
#   "evScore": 15.5,
#   "recommendedAction": "MATCH",
#   "confidence": 0.82,
#   "reasoning": "..."
# }
#
# Environment variables:
#   API_BASE_URL - Backend API URL (default: http://localhost:3001)
#   API_MAX_RETRIES - Max retry attempts (default: 3)
#   API_BASE_BACKOFF_MS - Base backoff in ms (default: 1000)

set -e

# Validate arguments
if [ -z "$1" ]; then
  echo '{"error": "Missing betId argument"}' >&2
  echo "Usage: bash scripts/compare-bet.sh <betId>" >&2
  exit 1
fi

BET_ID="$1"

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BOT_DIR="$(cd "${AGENT_DIR}/.." && pwd)"

# Files
PORTFOLIO_SCORES="${AGENT_DIR}/portfolio-scores.json"

# API Configuration (exported for CLI to read)
export API_BASE_URL="${API_BASE_URL:-http://localhost:3001}"
export API_MAX_RETRIES="${API_MAX_RETRIES:-3}"
export API_BASE_BACKOFF_MS="${API_BASE_BACKOFF_MS:-1000}"

# Check if portfolio scores exist
if [ ! -f "${PORTFOLIO_SCORES}" ]; then
  echo '{"error": "portfolio-scores.json not found. Run aggregate-scores.sh first."}' >&2
  exit 1
fi

# Run comparison using CLI entry point
cd "${BOT_DIR}"
bun run src/cli/compare-bet-cli.ts "${BET_ID}" "${PORTFOLIO_SCORES}" "${API_BASE_URL}"
