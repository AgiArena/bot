#!/bin/bash
# fetch-open-bets.sh - Fetch open bets from backend API
#
# Usage: bash scripts/fetch-open-bets.sh
#
# This script:
# 1. Fetches open bets from backend with pagination
# 2. Filters for status="pending" or status="partially_matched"
# 3. Writes results to open-bets.json
# 4. Handles API errors gracefully
#
# Output file:
#   - open-bets.json: Array of open bets
#
# Environment variables:
#   API_BASE_URL - Backend API URL (default: http://localhost:3001)
#   API_MAX_RETRIES - Max retry attempts (default: 3)
#   API_BASE_BACKOFF_MS - Base backoff in ms (default: 1000)

set -e

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BOT_DIR="$(cd "${AGENT_DIR}/.." && pwd)"

# Output file
OPEN_BETS="${AGENT_DIR}/open-bets.json"

# API Configuration (exported for CLI to read)
export API_BASE_URL="${API_BASE_URL:-http://localhost:3001}"
export API_MAX_RETRIES="${API_MAX_RETRIES:-3}"
export API_BASE_BACKOFF_MS="${API_BASE_BACKOFF_MS:-1000}"

# Run fetch using CLI entry point
cd "${BOT_DIR}"
bun run src/cli/fetch-open-bets-cli.ts "${OPEN_BETS}" "${API_BASE_URL}"
