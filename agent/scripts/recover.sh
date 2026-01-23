#!/bin/bash
# Recovery script for AgiArena agent
# Implements manual recovery protocol per AC4

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_FILE="$AGENT_DIR/state.json"

# Base mainnet USDC contract
USDC_CONTRACT="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

echo -e "${YELLOW}🔄 AgiArena Agent Recovery${NC}"
echo "================================"

# Check for required environment
if [ -z "$BASE_RPC_URL" ]; then
  echo -e "${RED}Error: BASE_RPC_URL environment variable not set${NC}"
  echo "Please set BASE_RPC_URL to a Base mainnet RPC endpoint"
  exit 1
fi

# Check for required tools
if ! command -v jq &> /dev/null; then
  echo -e "${RED}Error: jq is required but not installed${NC}"
  exit 1
fi

if ! command -v cast &> /dev/null; then
  echo -e "${YELLOW}Warning: cast (Foundry) not installed, skipping on-chain verification${NC}"
  SKIP_CHAIN=true
else
  SKIP_CHAIN=false
fi

# Check for state file
if [ ! -f "$STATE_FILE" ]; then
  echo -e "${RED}Error: State file not found at $STATE_FILE${NC}"
  echo "No recovery needed - agent has no previous state"
  exit 0
fi

echo -e "\n${GREEN}1. Reading current state${NC}"

# Read current state
AGENT_ADDRESS=$(jq -r '.agentAddress // empty' "$STATE_FILE")
PHASE=$(jq -r '.phase // "unknown"' "$STATE_FILE")
RESEARCH_JOB=$(jq -r '.researchJobId // empty' "$STATE_FILE")
CURRENT_BALANCE=$(jq -r '.currentBalance // 0' "$STATE_FILE")
MATCHED_COUNT=$(jq '.matchedBets | length' "$STATE_FILE")

if [ -z "$AGENT_ADDRESS" ]; then
  echo -e "${RED}Error: No agent address found in state${NC}"
  exit 1
fi

echo "  Agent Address: $AGENT_ADDRESS"
echo "  Current Phase: $PHASE"
echo "  Research Job ID: ${RESEARCH_JOB:-none}"
echo "  Local Balance: \$$CURRENT_BALANCE"
echo "  Matched Bets: $MATCHED_COUNT"

# Fetch on-chain balance
if [ "$SKIP_CHAIN" = false ]; then
  echo -e "\n${GREEN}2. Fetching on-chain balance${NC}"

  BALANCE_RAW=$(cast call "$USDC_CONTRACT" "balanceOf(address)(uint256)" "$AGENT_ADDRESS" --rpc-url "$BASE_RPC_URL" 2>/dev/null || echo "0")

  if [ "$BALANCE_RAW" != "0" ]; then
    # Convert from 6 decimals using bc
    if command -v bc &> /dev/null; then
      BALANCE_USDC=$(echo "scale=2; $BALANCE_RAW / 1000000" | bc)
    else
      # Fallback: integer division (less precise)
      BALANCE_USDC=$((BALANCE_RAW / 1000000))
    fi
    echo "  On-chain Balance: \$$BALANCE_USDC USDC"
  else
    echo -e "${YELLOW}  Warning: Could not fetch on-chain balance${NC}"
    BALANCE_USDC=$CURRENT_BALANCE
  fi
else
  echo -e "\n${YELLOW}2. Skipping on-chain verification (cast not available)${NC}"
  BALANCE_USDC=$CURRENT_BALANCE
fi

# Check for orphaned research terminals
echo -e "\n${GREEN}3. Checking for orphaned processes${NC}"

if [ -n "$RESEARCH_JOB" ]; then
  echo "  Found incomplete research job: $RESEARCH_JOB"

  # Kill any orphaned terminal processes (specific to research terminals)
  KILLED=$(pkill -f "agent/research/terminal-" 2>/dev/null && echo "yes" || echo "no")
  if [ "$KILLED" = "yes" ]; then
    echo "  Cleaned up orphaned terminal processes"
  else
    echo "  No orphaned processes found"
  fi
else
  echo "  No incomplete research jobs"
fi

# Check matched bets on-chain (simplified - just count)
echo -e "\n${GREEN}4. Verifying matched bets${NC}"
echo "  Total matched bets in state: $MATCHED_COUNT"
# Note: Full on-chain verification would require contract ABI and event logs

# Update state file
echo -e "\n${GREEN}5. Updating state file${NC}"

# Create updated state using jq
if command -v bc &> /dev/null && [ "$SKIP_CHAIN" = false ]; then
  UPDATED_BALANCE=$BALANCE_USDC
else
  UPDATED_BALANCE=$CURRENT_BALANCE
fi

# Write to temp file first, then atomic rename
jq --argjson balance "$UPDATED_BALANCE" \
   '.currentBalance = $balance | .phase = "idle" | .researchJobId = null' \
   "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

echo "  Phase reset to: idle"
echo "  Balance updated to: \$$UPDATED_BALANCE"
echo "  Research job cleared"

# Final summary
echo -e "\n${GREEN}================================${NC}"
echo -e "${GREEN}✓ Recovered: $MATCHED_COUNT matched bets, \$$UPDATED_BALANCE balance, ready to resume${NC}"
echo ""
echo "You can now restart the agent with: bun run handler"
