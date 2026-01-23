#!/bin/bash
# match-bet.sh - Execute bet matching on-chain
#
# Usage: bash scripts/match-bet.sh <betId> [fillAmount] [evScore]
#
# This script:
# 1. Fetches bet details from backend API
# 2. Validates bet status and balance
# 3. Approves USDC if needed
# 4. Executes matchBet on-chain
# 5. Uploads counter-scores to backend
# 6. Updates state and logs transaction
#
# Output JSON format (success):
# {
#   "success": true,
#   "betId": "123",
#   "fillAmount": "50.000000",
#   "txHash": "0x...",
#   "gasUsed": "45000",
#   "gasCostUSD": "0.02",
#   "message": "Bet matched successfully"
# }
#
# Output JSON format (error):
# {
#   "success": false,
#   "betId": "123",
#   "error": "INSUFFICIENT_BALANCE",
#   "message": "Need 100 USDC but only have 50 USDC",
#   "details": {...}
# }
#
# Environment variables:
#   API_BASE_URL - Backend API URL (default: http://localhost:3001)
#   BASE_RPC_URL - Base mainnet RPC URL (default: https://mainnet.base.org)
#   AGENT_PRIVATE_KEY - Agent's private key for signing transactions
#   AGENT_WALLET_ADDRESS - Agent's wallet address
#   AGENT_CAPITAL - Agent's total capital in USDC
#   AGENT_RISK_PROFILE - conservative/balanced/aggressive

set -e

# =============================================================================
# Configuration
# =============================================================================

# Validate betId argument
if [ -z "$1" ]; then
  echo '{"success": false, "error": "MISSING_ARGUMENT", "message": "Missing betId argument"}' >&2
  exit 1
fi

BET_ID="$1"
FILL_AMOUNT_ARG="${2:-}"
EV_SCORE_ARG="${3:-}"

# Get script directory and paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BOT_DIR="$(cd "${AGENT_DIR}/.." && pwd)"
PROJECT_ROOT="$(cd "${BOT_DIR}/.." && pwd)"

# Files
PORTFOLIO_SCORES="${AGENT_DIR}/portfolio-scores.json"
TRADE_STATE="${AGENT_DIR}/trade-state.json"
TRANSACTIONS_LOG="${AGENT_DIR}/transactions.log"

# Load deployed contracts
DEPLOYED_CONTRACTS="${PROJECT_ROOT}/deployed-contracts.json"
if [ -f "${DEPLOYED_CONTRACTS}" ]; then
  CONTRACT_ADDRESS=$(jq -r '.contracts.AgiArenaCore' "${DEPLOYED_CONTRACTS}")
else
  CONTRACT_ADDRESS="${CONTRACT_ADDRESS:-}"
fi

# Contract and token addresses
USDC_ADDRESS="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

# API and RPC configuration
API_BASE_URL="${API_BASE_URL:-http://localhost:3001}"
BASE_RPC_URL="${BASE_RPC_URL:-https://mainnet.base.org}"

# Agent configuration from environment
AGENT_ADDRESS="${AGENT_WALLET_ADDRESS:-}"
PRIVATE_KEY="${AGENT_PRIVATE_KEY:-}"
CAPITAL="${AGENT_CAPITAL:-1000}"
RISK_PROFILE="${AGENT_RISK_PROFILE:-balanced}"

# Timeout and retry configuration
TIMEOUT_SECONDS=30
MAX_RETRIES=1

# =============================================================================
# Validation
# =============================================================================

# Check required environment variables
if [ -z "$PRIVATE_KEY" ]; then
  echo '{"success": false, "error": "MISSING_CONFIG", "message": "AGENT_PRIVATE_KEY environment variable not set"}' >&2
  exit 1
fi

# Validate private key format (should be 64 hex chars, optionally with 0x prefix)
PRIVATE_KEY_CLEAN="${PRIVATE_KEY#0x}"
if ! [[ "$PRIVATE_KEY_CLEAN" =~ ^[a-fA-F0-9]{64}$ ]]; then
  echo '{"success": false, "error": "INVALID_CONFIG", "message": "AGENT_PRIVATE_KEY must be a 64-character hex string (with optional 0x prefix)"}' >&2
  exit 1
fi

if [ -z "$AGENT_ADDRESS" ]; then
  echo '{"success": false, "error": "MISSING_CONFIG", "message": "AGENT_WALLET_ADDRESS environment variable not set"}' >&2
  exit 1
fi

if [ -z "$CONTRACT_ADDRESS" ] || [ "$CONTRACT_ADDRESS" = "null" ]; then
  echo '{"success": false, "error": "MISSING_CONFIG", "message": "CONTRACT_ADDRESS not found in deployed-contracts.json"}' >&2
  exit 1
fi

# Check for required tools
if ! command -v cast &> /dev/null; then
  echo '{"success": false, "error": "MISSING_TOOL", "message": "Foundry cast CLI not found"}' >&2
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo '{"success": false, "error": "MISSING_TOOL", "message": "jq not found"}' >&2
  exit 1
fi

# =============================================================================
# Helper Functions
# =============================================================================

# Log transaction using CLI
log_transaction() {
  local bet_id="$1"
  local amount="$2"
  local tx_hash="$3"
  local gas_used="$4"
  local gas_cost_usd="$5"
  local status="$6"
  local error="${7:-}"

  cd "${BOT_DIR}"
  if [ -n "$error" ]; then
    bun run src/cli/match-bet-cli.ts log-transaction "${TRANSACTIONS_LOG}" "$bet_id" "$amount" "$tx_hash" "$gas_used" "$gas_cost_usd" "$status" "$error" 2>/dev/null || true
  else
    bun run src/cli/match-bet-cli.ts log-transaction "${TRANSACTIONS_LOG}" "$bet_id" "$amount" "$tx_hash" "$gas_used" "$gas_cost_usd" "$status" 2>/dev/null || true
  fi
}

# Output error and exit
error_exit() {
  local error_code="$1"
  local message="$2"
  local details="${3:-}"
  local amount="${4:-0}"

  log_transaction "$BET_ID" "$amount" "null" "0" "0" "FAILED" "$error_code"

  if [ -n "$details" ]; then
    echo "{\"success\": false, \"betId\": \"$BET_ID\", \"error\": \"$error_code\", \"message\": \"$message\", \"details\": $details}"
  else
    echo "{\"success\": false, \"betId\": \"$BET_ID\", \"error\": \"$error_code\", \"message\": \"$message\"}"
  fi
  exit 1
}

# Convert hex to decimal (safe for large values)
hex_to_decimal() {
  local hex="$1"
  # Remove 0x prefix if present
  hex="${hex#0x}"
  # Use printf for safe conversion (handles large numbers better than bash arithmetic)
  printf "%d" "0x$hex" 2>/dev/null || echo "0"
}

# Format USDC from base units (6 decimals) to decimal string
format_usdc() {
  local base_units="$1"
  local whole=$((base_units / 1000000))
  local fraction=$((base_units % 1000000))
  printf "%d.%06d" "$whole" "$fraction"
}

# =============================================================================
# Step 1: Fetch Bet Details
# =============================================================================

echo "Fetching bet details for betId: $BET_ID" >&2

BET_RESPONSE=$(curl -s -f --max-time 10 "${API_BASE_URL}/api/bets/${BET_ID}" 2>/dev/null) || {
  error_exit "BET_NOT_FOUND" "Failed to fetch bet ${BET_ID} from API"
}

BET_STATUS=$(echo "$BET_RESPONSE" | jq -r '.status')
BET_AMOUNT=$(echo "$BET_RESPONSE" | jq -r '.amount')
BET_MATCHED=$(echo "$BET_RESPONSE" | jq -r '.matchedAmount')

echo "Bet status: $BET_STATUS, amount: $BET_AMOUNT, matched: $BET_MATCHED" >&2

# =============================================================================
# Step 2: Validate Bet Status
# =============================================================================

if [ "$BET_STATUS" = "fully_matched" ]; then
  echo "{\"success\": false, \"betId\": \"$BET_ID\", \"error\": \"BET_ALREADY_MATCHED\", \"message\": \"Bet already fully matched\"}"
  log_transaction "$BET_ID" "0" "null" "0" "0" "FAILED" "BET_ALREADY_MATCHED"
  exit 0  # Exit 0 since this is expected case, not an error
fi

if [ "$BET_STATUS" != "pending" ] && [ "$BET_STATUS" != "partially_matched" ]; then
  error_exit "BET_NOT_PENDING" "Bet status is '$BET_STATUS', expected pending or partially_matched"
fi

# =============================================================================
# Step 3: Calculate Fill Amount
# =============================================================================

# Calculate remaining amount
BET_REMAINING=$(echo "$BET_AMOUNT - $BET_MATCHED" | bc -l)
echo "Bet remaining: $BET_REMAINING USDC" >&2

# Determine fill amount
if [ -n "$FILL_AMOUNT_ARG" ]; then
  # Use provided fill amount (already in decimal format)
  FILL_AMOUNT_DECIMAL="$FILL_AMOUNT_ARG"
  # Convert to base units
  FILL_AMOUNT_BASE=$(echo "$FILL_AMOUNT_ARG * 1000000" | bc | cut -d. -f1)
else
  # Calculate based on risk profile using CLI
  cd "${BOT_DIR}"
  CALC_RESULT=$(bun run src/cli/match-bet-cli.ts calculate-fill "$CAPITAL" "$RISK_PROFILE" "$BET_REMAINING" 2>/dev/null) || {
    error_exit "CALCULATION_FAILED" "Failed to calculate fill amount"
  }
  FILL_AMOUNT_BASE=$(echo "$CALC_RESULT" | jq -r '.fillAmountBaseUnits')
  FILL_AMOUNT_DECIMAL=$(echo "$CALC_RESULT" | jq -r '.fillAmountFormatted')
fi

echo "Fill amount: $FILL_AMOUNT_DECIMAL USDC (base units: $FILL_AMOUNT_BASE)" >&2

# Validate fill amount is positive
if [ "$FILL_AMOUNT_BASE" -le 0 ]; then
  error_exit "ZERO_AMOUNT" "Calculated fill amount is zero or negative"
fi

# =============================================================================
# Step 4: Check USDC Balance
# =============================================================================

echo "Checking USDC balance..." >&2

BALANCE_HEX=$(cast call "$USDC_ADDRESS" "balanceOf(address)(uint256)" "$AGENT_ADDRESS" --rpc-url "$BASE_RPC_URL" 2>/dev/null) || {
  error_exit "RPC_ERROR" "Failed to fetch USDC balance"
}

# Clean up the result (remove any extra output)
BALANCE_HEX=$(echo "$BALANCE_HEX" | head -1 | tr -d '[:space:]')
BALANCE=$(hex_to_decimal "$BALANCE_HEX")

echo "USDC balance: $(format_usdc $BALANCE) USDC" >&2

if [ "$BALANCE" -lt "$FILL_AMOUNT_BASE" ]; then
  BALANCE_FORMATTED=$(format_usdc $BALANCE)
  error_exit "INSUFFICIENT_BALANCE" "Need $FILL_AMOUNT_DECIMAL USDC but only have $BALANCE_FORMATTED USDC" \
    "{\"required\": \"$FILL_AMOUNT_DECIMAL\", \"available\": \"$BALANCE_FORMATTED\"}" \
    "$FILL_AMOUNT_DECIMAL"
fi

# =============================================================================
# Step 5: Check and Approve USDC Allowance
# =============================================================================

echo "Checking USDC allowance..." >&2

ALLOWANCE_HEX=$(cast call "$USDC_ADDRESS" "allowance(address,address)(uint256)" "$AGENT_ADDRESS" "$CONTRACT_ADDRESS" --rpc-url "$BASE_RPC_URL" 2>/dev/null) || {
  error_exit "RPC_ERROR" "Failed to fetch USDC allowance"
}

ALLOWANCE_HEX=$(echo "$ALLOWANCE_HEX" | head -1 | tr -d '[:space:]')
ALLOWANCE=$(hex_to_decimal "$ALLOWANCE_HEX")

echo "Current allowance: $(format_usdc $ALLOWANCE) USDC" >&2

if [ "$ALLOWANCE" -lt "$FILL_AMOUNT_BASE" ]; then
  echo "Approving unlimited USDC..." >&2

  # Approve max uint256 for gas efficiency
  MAX_UINT256=$(cast max-uint)

  APPROVE_TX=$(timeout ${TIMEOUT_SECONDS}s cast send "$USDC_ADDRESS" "approve(address,uint256)" "$CONTRACT_ADDRESS" "$MAX_UINT256" \
    --private-key "$PRIVATE_KEY" \
    --rpc-url "$BASE_RPC_URL" \
    --json 2>/dev/null) || {
    error_exit "APPROVAL_FAILED" "USDC approval transaction failed" "" "$FILL_AMOUNT_DECIMAL"
  }

  APPROVE_TX_HASH=$(echo "$APPROVE_TX" | jq -r '.transactionHash')
  APPROVE_STATUS=$(echo "$APPROVE_TX" | jq -r '.status')

  if [ "$APPROVE_STATUS" != "0x1" ] && [ "$APPROVE_STATUS" != "1" ]; then
    error_exit "APPROVAL_FAILED" "USDC approval transaction reverted" "{\"txHash\": \"$APPROVE_TX_HASH\"}" "$FILL_AMOUNT_DECIMAL"
  fi

  echo "USDC approved. TX: $APPROVE_TX_HASH" >&2
fi

# =============================================================================
# Step 6: Execute matchBet Transaction
# =============================================================================

echo "Executing matchBet($BET_ID, $FILL_AMOUNT_BASE)..." >&2

RETRY_COUNT=0
MATCH_TX=""
MATCH_SUCCESS=false

while [ $RETRY_COUNT -le $MAX_RETRIES ]; do
  MATCH_TX=$(timeout ${TIMEOUT_SECONDS}s cast send "$CONTRACT_ADDRESS" "matchBet(uint256,uint256)" "$BET_ID" "$FILL_AMOUNT_BASE" \
    --private-key "$PRIVATE_KEY" \
    --rpc-url "$BASE_RPC_URL" \
    --confirmations 1 \
    --json 2>&1) && {
    # Check if transaction succeeded
    TX_STATUS=$(echo "$MATCH_TX" | jq -r '.status' 2>/dev/null)
    if [ "$TX_STATUS" = "0x1" ] || [ "$TX_STATUS" = "1" ]; then
      MATCH_SUCCESS=true
      break
    fi
  }

  RETRY_COUNT=$((RETRY_COUNT + 1))

  if [ $RETRY_COUNT -le $MAX_RETRIES ]; then
    echo "Transaction failed, retrying (attempt $((RETRY_COUNT + 1)))..." >&2
    sleep $((2 ** RETRY_COUNT))  # Exponential backoff
  fi
done

if [ "$MATCH_SUCCESS" != "true" ]; then
  # Extract revert reason if available
  REVERT_REASON=$(echo "$MATCH_TX" | grep -o 'revert.*' | head -1 || echo "Unknown error")
  error_exit "MATCH_REVERTED" "matchBet transaction reverted: $REVERT_REASON" "" "$FILL_AMOUNT_DECIMAL"
fi

# =============================================================================
# Step 7: Parse Transaction Result
# =============================================================================

TX_HASH=$(echo "$MATCH_TX" | jq -r '.transactionHash')
GAS_USED=$(echo "$MATCH_TX" | jq -r '.gasUsed')
GAS_PRICE=$(echo "$MATCH_TX" | jq -r '.effectiveGasPrice')

# Convert hex values to decimal
GAS_USED_DEC=$(hex_to_decimal "$GAS_USED")
GAS_PRICE_DEC=$(hex_to_decimal "$GAS_PRICE")

# Calculate gas cost in USD (assuming ~$2000 ETH price)
# Gas cost = gasUsed * gasPrice (in wei) / 1e18 * ETH_PRICE
ETH_PRICE=2000
GAS_COST_WEI=$((GAS_USED_DEC * GAS_PRICE_DEC))
GAS_COST_ETH=$(echo "scale=18; $GAS_COST_WEI / 1000000000000000000" | bc -l)
GAS_COST_USD=$(echo "scale=4; $GAS_COST_ETH * $ETH_PRICE" | bc -l)

echo "Transaction successful! TX: $TX_HASH, Gas: $GAS_USED_DEC, Cost: \$$GAS_COST_USD" >&2

# =============================================================================
# Step 8: Resolve EV Score and Upload Counter-Scores to Backend
# =============================================================================

# Get EV score from argument, cached comparison, or default to 0
if [ -n "$EV_SCORE_ARG" ]; then
  EV_SCORE="$EV_SCORE_ARG"
  echo "Using provided EV score: $EV_SCORE" >&2
else
  # Try to read from cached comparison result
  COMPARISON_CACHE="${AGENT_DIR}/last-comparison.json"
  if [ -f "$COMPARISON_CACHE" ]; then
    CACHED_BET_ID=$(jq -r '.betId // empty' "$COMPARISON_CACHE" 2>/dev/null)
    if [ "$CACHED_BET_ID" = "$BET_ID" ]; then
      EV_SCORE=$(jq -r '.evScore // 0' "$COMPARISON_CACHE" 2>/dev/null)
      echo "Using cached EV score: $EV_SCORE" >&2
    else
      EV_SCORE="0"
      echo "Warning: Cached comparison is for different bet, using EV_SCORE=0" >&2
    fi
  else
    EV_SCORE="0"
    echo "Warning: No EV score provided and no cached comparison found, using EV_SCORE=0" >&2
  fi
fi

if [ -f "$PORTFOLIO_SCORES" ]; then
  echo "Uploading counter-scores to backend..." >&2

  cd "${BOT_DIR}"
  UPLOAD_RESULT=$(bun run src/cli/match-bet-cli.ts upload-scores "$API_BASE_URL" "$BET_ID" "$AGENT_ADDRESS" "$PORTFOLIO_SCORES" "$EV_SCORE" 2>/dev/null) || true

  if echo "$UPLOAD_RESULT" | jq -e '.success == true' &>/dev/null; then
    echo "Counter-scores uploaded successfully" >&2
  else
    echo "Warning: Counter-scores upload failed (non-fatal)" >&2
  fi
else
  echo "Warning: portfolio-scores.json not found, skipping counter-scores upload" >&2
fi

# =============================================================================
# Step 9: Update State and Log Transaction
# =============================================================================

echo "Updating trade state..." >&2

# Get block number from transaction
BLOCK_NUMBER=$(echo "$MATCH_TX" | jq -r '.blockNumber')
BLOCK_NUMBER_DEC=$(hex_to_decimal "$BLOCK_NUMBER")

# Create matched bet record
MATCH_RECORD=$(cat <<EOF
{
  "betId": "$BET_ID",
  "fillAmount": "$FILL_AMOUNT_DECIMAL",
  "txHash": "$TX_HASH",
  "blockNumber": $BLOCK_NUMBER_DEC,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "gasUsed": "$GAS_USED_DEC",
  "gasCostUSD": "$GAS_COST_USD",
  "evScore": $EV_SCORE,
  "ourPortfolioRef": "$PORTFOLIO_SCORES"
}
EOF
)

# Record match in state
cd "${BOT_DIR}"
STATE_RESULT=$(bun run src/cli/match-bet-cli.ts record-match "$TRADE_STATE" "$MATCH_RECORD" 2>/dev/null) || {
  echo "Warning: Failed to update trade state (non-fatal)" >&2
}

# Log successful transaction
log_transaction "$BET_ID" "$FILL_AMOUNT_DECIMAL" "$TX_HASH" "$GAS_USED_DEC" "$GAS_COST_USD" "SUCCESS"

# =============================================================================
# Step 10: Output Success Result
# =============================================================================

cat <<EOF
{
  "success": true,
  "betId": "$BET_ID",
  "fillAmount": "$FILL_AMOUNT_DECIMAL",
  "txHash": "$TX_HASH",
  "gasUsed": "$GAS_USED_DEC",
  "gasCostUSD": "$GAS_COST_USD",
  "message": "Bet matched successfully"
}
EOF
