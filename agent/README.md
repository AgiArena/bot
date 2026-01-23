# AgiArena Portfolio Betting Agent Workflow

This document describes the complete autonomous workflow for the AgiArena portfolio betting agent. The agent operates 24/7, researching Polymarket markets, scoring portfolios, and matching bets on-chain.

## Overview

The AgiArena agent is an AI-powered portfolio betting system that:

1. **Researches** all active Polymarket markets (~20K+) using parallel terminals
2. **Scores** each market (0-100) to build a portfolio view
3. **Compares** portfolio scores against existing bets to find EV opportunities
4. **Matches** bets on-chain when positive expected value is detected
5. **Repeats** this cycle every 30 minutes

**Key Principle**: The agent **only MATCHES** existing bets - it never places new bets.

## Complete Cycle (Every 30 minutes)

### Phase 1: Market Research (Parallel Processing)

The agent fetches all active Polymarket markets and distributes them across 5 parallel research terminals for scoring.

```bash
# Start the research phase
bash scripts/start-research.sh
```

**What happens:**
1. Fetches ALL active markets from Polymarket API (pagination handles 20K+ markets)
2. Saves to `markets.json`
3. Segments markets into 5 files: `markets_segment_1.json` through `markets_segment_5.json`
4. Spawns 5 hidden research terminals (Claude Code agents in dontAsk mode)
5. Each terminal scores its segment independently (0-100 per market)
6. Terminals write scores to `research/terminal-N/scores.json`
7. Terminals write "COMPLETE" to `research/terminal-N/status.txt` when done

**Research Terminal Prompt:**
Each terminal receives instructions to:
- Read its market segment file
- Analyze each market's question, outcomes, and current odds
- Assign a score (0-100): 100 = very bullish YES, 0 = very bullish NO
- Write scores incrementally for crash resilience
- Mark complete when all markets scored

### Phase 2: Score Aggregation

After all 5 terminals complete, the agent merges scores into a unified portfolio.

```bash
# Aggregate scores from all terminals
bash scripts/aggregate-scores.sh
```

**What happens:**
1. Discovers all `research/terminal-*/scores.json` files
2. Verifies each terminal's `status.txt` contains "COMPLETE"
3. Parses JSON Lines format (one score object per line)
4. Merges into single `portfolio-scores.json` keyed by marketId
5. Calculates aggregate metrics (avg score, position distribution)
6. Saves agent's portfolio to `my-portfolio.json`

**Output format (`portfolio-scores.json`):**
```json
{
  "0x1234...": {"score": 75, "position": 1, "confidence": 0.85},
  "0x5678...": {"score": 30, "position": 0, "confidence": 0.70}
}
```

### Phase 3: Bet Evaluation (Code + Agent Decision)

The agent fetches open bets and calculates Expected Value (EV) for each.

```bash
# Fetch open bets from backend
bash scripts/fetch-open-bets.sh

# Compare a specific bet against our portfolio
bash scripts/compare-bet.sh <betId>

# Review top N opportunities
bash scripts/review-bets.sh
```

**EV Calculation Logic (`bot/src/bet-comparison.ts`):**
```
For each market where we have a score:
  If positions match (both YES or both NO):
    delta = 0  (no edge)
  If we're YES (score >= 50) and bet is NO:
    delta = our_score - 50  (our conviction above neutral)
  If we're NO (score < 50) and bet is YES:
    delta = 50 - our_score  (our conviction below neutral)

Raw EV = average(all deltas)
Weighted EV = sum(delta * confidence) / sum(confidence)
```

**Recommendation Thresholds:**
| EV Score | Recommendation | Action |
|----------|----------------|--------|
| > 15 | STRONG_MATCH | All risk profiles proceed |
| 10-15 | MATCH | Aggressive proceeds, others review |
| 5-10 | CONSIDER | Agent judgment call |
| 0-5 | LEAN_SKIP | Only aggressive might proceed |
| <= 0 | SKIP | Negative edge, always skip |

### Phase 4: Agent Decision

The agent reviews top 3 EV opportunities and makes final MATCH/SKIP decision based on:
- EV score and confidence
- Risk profile (conservative/balanced/aggressive)
- Available capital
- Position sizing rules

**Position Sizing by Risk Profile:**
| Profile | Per-Bet Size | Description |
|---------|--------------|-------------|
| Conservative | 1-3% of capital | Low risk, steady growth |
| Balanced | 3-5% of capital | Moderate risk/reward |
| Aggressive | 5-10% of capital | High risk, higher potential |

### Phase 5: Execution (On-Chain Bet Matching)

If the decision is MATCH, execute the bet matching transaction.

```bash
# Execute bet match on-chain
bash scripts/match-bet.sh <betId> [fillAmount] [evScore]
```

**Execution steps:**
1. Fetch bet details from backend API
2. Validate bet status (must be `pending` or `partially_matched`)
3. Calculate fill amount based on risk profile
4. Check USDC balance
5. Approve USDC if allowance insufficient (unlimited approval for gas efficiency)
6. Call `matchBet(betId, fillAmount)` on AgiArenaCore contract
7. Wait for transaction confirmation
8. Upload counter-scores to backend API
9. Update `trade-state.json` atomically
10. Log to `transactions.log`

**Output JSON (success):**
```json
{
  "success": true,
  "betId": "123",
  "fillAmount": "50.000000",
  "txHash": "0x...",
  "gasUsed": "45000",
  "gasCostUSD": "0.02",
  "message": "Bet matched successfully"
}
```

### Phase 6: State Update & Heartbeat

After each action, the agent updates its state and heartbeat.

**State update:**
- `state.json` updated with handler state (agentPid, uptime, restartCount)
- `trade-state.json` updated with matched bets history
- `heartbeat.txt` updated with current timestamp

**Atomic writes pattern:**
```typescript
// Write to temp file first, then atomic rename
const tempPath = `${statePath}.tmp`;
writeFileSync(tempPath, JSON.stringify(state, null, 2));
renameSync(tempPath, statePath);
```

### Phase 7: Sleep & Repeat

The agent sleeps for the configured interval (default: 30 minutes), then starts the next research cycle.

```
Loop:
  Phase 1: Research (5-10 min)
  Phase 2: Aggregate (< 1 min)
  Phase 3-4: Evaluate & Decide (1-2 min)
  Phase 5: Execute (if match) (< 1 min)
  Phase 6: Update state (< 1 sec)
  Sleep: 30 minutes
  Repeat
```

## Key Files

### State Management Files

| File | Purpose | Updated By |
|------|---------|-----------|
| `agent/handler-state.json` | Handler state (PID, uptime, restarts) | handler.ts |
| `agent/agent-state.json` | Agent trading state (balance, bets, phase) | handler.ts |
| `agent/trade-state.json` | Matched bets history, totals | match-bet.sh |
| `agent/heartbeat.txt` | Watchdog monitoring (timestamp) | Agent |

### Market Data Files

| File | Purpose | Updated By |
|------|---------|-----------|
| `agent/markets.json` | All Polymarket markets | start-research.sh |
| `agent/markets_segment_*.json` | Segmented market files (1-5) | start-research.sh |
| `agent/research/terminal-*/scores.json` | Terminal output scores | Research terminals |
| `agent/research/terminal-*/status.txt` | "COMPLETE" when done | Research terminals |
| `agent/portfolio-scores.json` | Merged scores by marketId | aggregate-scores.sh |
| `agent/my-portfolio.json` | Portfolio with metadata | aggregate-scores.sh |

### Script Files

| Script | Purpose |
|--------|---------|
| `scripts/start-research.sh` | Launch parallel research terminals |
| `scripts/spawn-terminal.sh` | Platform-specific hidden terminal spawner |
| `scripts/aggregate-scores.sh` | Merge terminal scores |
| `scripts/fetch-open-bets.sh` | Get open bets from backend |
| `scripts/compare-bet.sh` | Calculate EV for a bet |
| `scripts/review-bets.sh` | Review top N opportunities |
| `scripts/match-bet.sh` | Execute on-chain bet match |

### Output Files

| File | Purpose |
|------|---------|
| `agent/transactions.log` | All bet matching transactions |
| `logs/agent.log` | Agent stdout/stderr |
| `logs/crashes.log` | Crash events |
| `logs/watchdog.log` | Watchdog monitoring logs |
| `research/terminal-*/output.log` | Per-terminal execution logs |

## Recovery

### Automatic Recovery (Handler)

The handler (`bot/src/handler.ts`) provides automatic crash recovery:

- **Exponential backoff**: 5s, 10s, 20s, 40s, 60s (max)
- **Crash rate limiting**: If 5 crashes in 5 minutes, pause for 1 minute
- **State persistence**: PID, restart count, last restart time saved atomically

### Manual Recovery

```bash
# Full recovery workflow
bash scripts/recover.sh
```

**Recovery steps:**
1. Check `state.json` for last known state
2. Kill orphaned research terminals (if any)
3. Verify on-chain state matches local state
4. Resume from last checkpoint or restart research

### State Checkpoint Format

`state.json`:
```json
{
  "agentPid": 12345,
  "startTime": 1706000000000,
  "restartCount": 2,
  "lastRestartAt": "2026-01-23T10:00:00.000Z"
}
```

`trade-state.json`:
```json
{
  "matchedBets": [
    {
      "betId": "123",
      "fillAmount": "50.000000",
      "txHash": "0x...",
      "blockNumber": 12345678,
      "timestamp": "2026-01-23T10:05:00.000Z",
      "gasUsed": "45000",
      "gasCostUSD": "0.02",
      "evScore": 12.5,
      "ourPortfolioRef": "portfolio-scores.json"
    }
  ],
  "totalMatchedAmount": "50000000",
  "lastMatchedAt": "2026-01-23T10:05:00.000Z"
}
```

### Orphaned Terminal Cleanup

If research terminals crash mid-cycle:

```bash
# Find orphaned terminal processes
pgrep -f "claude-code.*terminal-"

# Kill orphaned terminals
pkill -f "claude-code.*terminal-"

# Clean up incomplete research directories
rm -rf agent/research/terminal-*/
```

### On-Chain State Verification

Compare local `trade-state.json` against on-chain data:

```bash
# Get bet status from contract
cast call $CONTRACT_ADDRESS "getBet(uint256)" $BET_ID --rpc-url $BASE_RPC_URL

# Verify transaction was mined
cast receipt $TX_HASH --rpc-url $BASE_RPC_URL
```

## Hidden Terminal System

### macOS (osascript)

```bash
osascript -e '
tell application "Terminal"
  do script "cd '\''${TERMINAL_DIR}'\'' && claude-code --mode dontAsk --prompt-file prompt.md > output.log 2>&1" without activating
end tell
'
```

- `without activating` prevents Terminal from coming to foreground
- Output redirected to `terminal-N/output.log`
- Runs completely hidden in background

### Linux (gnome-terminal)

```bash
gnome-terminal --hide-menubar --geometry=1x1+9999+9999 -- \
  bash -c "cd '${TERMINAL_DIR}' && claude-code --mode dontAsk --prompt-file prompt.md > output.log 2>&1"
```

- `--geometry=1x1+9999+9999` creates 1x1 window off-screen
- `--hide-menubar` removes chrome
- Minimal visible footprint

### Fallback (nohup)

```bash
cd "$TERMINAL_DIR"
nohup bash -c "claude-code --mode dontAsk --prompt-file prompt.md > output.log 2>&1" &
disown
```

- Works on any Unix-like system
- Runs as background process
- Survives terminal disconnect

### Terminal Coordination

Terminals coordinate via status files:
- Main agent spawns terminals and records PIDs
- Main agent polls `status.txt` files every 5 seconds
- When all show "COMPLETE", proceed to aggregation
- Timeout after 600 seconds (10 minutes)
- Failed terminals are retried up to 3 times

## Key Concepts

### Only MATCH Bets (Never Place New)

The agent **never** creates new bets. It only matches existing bets placed by other users:

- Finds bets with positive EV (where we disagree with the bet creator)
- Takes the opposite side of the bet
- Earns profit when the market resolves in our favor

**Why?** This ensures:
- No liquidity fragmentation
- Capital efficiency (only deploy when opportunities exist)
- Risk management (only bet when we have edge)

### Parallel Research Architecture

Why 5 terminals?

1. **Speed**: Scoring 20K+ markets sequentially would take hours
2. **Resilience**: If one terminal fails, others continue
3. **Resource management**: Each terminal is an independent Claude Code session
4. **Incremental results**: Scores saved incrementally for crash resilience

### Code + Agent Collaboration

The system divides work between automated code and agent decision-making:

| Automated (Code) | Agent Decision |
|------------------|----------------|
| Fetch markets | Score each market (0-100) |
| Segment data | Assess probability |
| Calculate EV | Final MATCH/SKIP decision |
| Execute transaction | Review edge cases |
| Update state | Consider risk factors |

### No-Validation Mode (dontAsk)

The agent runs in `--mode dontAsk`:

- No permission prompts for file operations
- No confirmation dialogs for commands
- Fully autonomous operation
- Suitable for 24/7 unattended operation

**Important**: Only use dontAsk mode in controlled environments with trusted code.

### BMAD-Style Recovery

Inspired by Build Measure Analyze Design (BMAD) methodology:

1. **Atomic state writes**: Never corrupt state files
2. **Idempotent operations**: Safe to retry any operation
3. **Checkpoint resume**: Continue from last known good state
4. **Incremental saves**: Don't lose work on crash

### Lifecycle Management (Context Clearing)

The handler implements automatic context clearing to prevent context window exhaustion:

**Thresholds:**
- **Max Messages**: 50 message exchanges trigger context clear
- **Max Runtime**: 4 hours of continuous operation trigger context clear
- **Manual Signal**: Create `agent/CLEAR_CONTEXT` file to request immediate clear

**Context Clear Process:**
1. Handler detects threshold or signal file
2. Checks for `IN_PROGRESS_TX` file (defers if transaction in progress)
3. Sends SIGTERM to agent (graceful shutdown)
4. Falls back to SIGKILL after 5 seconds if needed
5. Kills orphaned research terminal processes
6. Cleans research terminal directories
7. Removes signal files
8. Respawns fresh agent instance

**Signal Files:**
| File | Purpose |
|------|---------|
| `agent/CLEAR_CONTEXT` | Request manual context clear |
| `agent/IN_PROGRESS_TX` | Defer clear during transaction |
| `agent/MATCHED_BET` | Signal bet match to handler for tracking |

### Watchdog Monitoring

External watchdog process monitors agent health:

```
Check interval: 60 seconds
Heartbeat staleness: 10 minutes
```

**Heartbeat protocol:**
- Agent updates `heartbeat.txt` every 5 minutes
- Watchdog checks heartbeat age every 60 seconds
- If heartbeat > 10 minutes old, restart agent

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `AGENT_WALLET_ADDRESS` | Agent's wallet address | `0x...` |
| `AGENT_PRIVATE_KEY` | Agent's private key (64 hex chars) | `0x...` |
| `AGENT_CAPITAL` | Total USDC capital | `1000` |
| `AGENT_RISK_PROFILE` | Risk level | `conservative\|balanced\|aggressive` |
| `BASE_RPC_URL` | Base mainnet RPC | `https://mainnet.base.org` |
| `CONTRACT_ADDRESS` | AgiArenaCore address | From deployed-contracts.json |
| `API_BASE_URL` | Backend API endpoint | `http://localhost:3001` |
| `ANTHROPIC_API_KEY` | Claude API key | `sk-ant-...` |
| `AGENT_RESEARCH_TERMINALS` | Number of parallel terminals | `5` (default) |
| `AGENT_RESEARCH_INTERVAL` | Minutes between cycles | `30` (default) |
| `AGENT_CLAUDE_SUBSCRIPTION` | Subscription tier | `free\|pro\|team` |

## Troubleshooting

### Research terminals not completing

**Symptoms:** Terminals spawn but never complete

**Solutions:**
1. Check `research/terminal-*/output.log` for errors
2. Verify Anthropic API key is valid
3. Increase timeout in `start-research.sh`
4. Reduce market count (filter by volume/liquidity)

### Bet matching fails

**Symptoms:** `match-bet.sh` returns error

**Common errors:**
- `INSUFFICIENT_BALANCE`: Need more USDC in agent wallet
- `BET_ALREADY_MATCHED`: Bet was matched by someone else
- `APPROVAL_FAILED`: USDC approval transaction failed
- `MATCH_REVERTED`: Contract rejected the match

**Debug:**
```bash
# Check USDC balance
cast call $USDC_ADDRESS "balanceOf(address)" $AGENT_ADDRESS --rpc-url $BASE_RPC_URL

# Check allowance
cast call $USDC_ADDRESS "allowance(address,address)" $AGENT_ADDRESS $CONTRACT_ADDRESS --rpc-url $BASE_RPC_URL
```

### Agent keeps crashing

**Symptoms:** Handler logs show repeated restarts

**Solutions:**
1. Check `logs/crashes.log` for error patterns
2. Verify environment variables are set correctly
3. Check available disk space (for logs and state files)
4. Review `logs/agent.log` for runtime errors

### State corruption

**Symptoms:** Agent behaves erratically after crash

**Solutions:**
1. Compare `trade-state.json` with on-chain data
2. Reset state: `rm agent/state.json agent/trade-state.json`
3. Re-sync from blockchain events
4. Restart handler

## Anti-Patterns (Avoid These)

- **Don't run multiple agents on same wallet** - nonce conflicts will cause transaction failures
- **Don't modify state.json manually** - use atomic writes via handler
- **Don't kill research terminals mid-cycle** - leads to orphaned state
- **Don't skip heartbeat updates** - watchdog will restart agent
- **Don't ignore insufficient balance warnings** - transaction will fail with gas wasted
- **Don't use high gas prices** - let the network determine appropriate fees
- **Don't match bets without checking EV** - negative EV leads to guaranteed losses

## Quick Start

1. **Configure agent:**
   ```bash
   cp config.json.example config.json
   # Edit config.json with wallet address, capital, risk profile
   export AGENT_PRIVATE_KEY="0x..."
   ```

2. **Start handler:**
   ```bash
   cd bot
   bun run src/handler.ts
   ```

3. **Monitor health:**
   ```bash
   curl http://localhost:3333/health
   ```

4. **View logs:**
   ```bash
   tail -f logs/agent.log
   ```

The agent will automatically start researching markets and matching bets!
