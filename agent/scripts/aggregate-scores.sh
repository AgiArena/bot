#!/bin/bash
# aggregate-scores.sh - Aggregate scores from all research terminals
#
# Usage: bash scripts/aggregate-scores.sh
#
# This script:
# 1. Discovers all research terminal score files (terminal-*/scores.json)
# 2. Merges scores into unified portfolio-scores.json
# 3. Calculates aggregate metrics
# 4. Saves agent's portfolio to my-portfolio.json
#
# Output files:
#   - portfolio-scores.json: Merged scores keyed by marketId
#   - my-portfolio.json: Agent's portfolio with metadata

set -e

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BOT_DIR="$(cd "${AGENT_DIR}/.." && pwd)"
RESEARCH_DIR="${AGENT_DIR}/research"

# Output files
PORTFOLIO_SCORES="${AGENT_DIR}/portfolio-scores.json"
MY_PORTFOLIO="${AGENT_DIR}/my-portfolio.json"

# Check if research directory exists
if [ ! -d "${RESEARCH_DIR}" ]; then
  echo "ERROR: Research directory not found: ${RESEARCH_DIR}"
  echo "Run start-research.sh first to generate terminal scores."
  exit 1
fi

# Run aggregation using CLI entry point
cd "${BOT_DIR}"
bun run src/cli/aggregate-scores-cli.ts "${RESEARCH_DIR}" "${PORTFOLIO_SCORES}" "${MY_PORTFOLIO}"

exit 0
