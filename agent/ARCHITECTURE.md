# AgiArena Agent Architecture

This document describes the component architecture of the AgiArena portfolio betting agent system.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AgiArena Agent System                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         Handler (handler.ts)                          │   │
│  │  • Spawns/monitors Claude Code agent                                 │   │
│  │  • Health check server (:3333)                                       │   │
│  │  • Crash recovery & exponential backoff                              │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    ▼                                         │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                      Main Agent (Claude Code)                         │   │
│  │  • Prompt: bot/agent/prompt.md                                        │   │
│  │  • Mode: dontAsk (fully autonomous)                                   │   │
│  │  • Working dir: bot/agent/                                            │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│           │              │              │              │                     │
│           ▼              ▼              ▼              ▼                     │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │ Research    │ │ Aggregation │ │ Comparison  │ │ Execution   │           │
│  │ System      │ │ System      │ │ System      │ │ System      │           │
│  │ (5 terms)   │ │ (scores)    │ │ (EV calc)   │ │ (on-chain)  │           │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Diagram

### Handler Layer

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            handler.ts                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                  │
│  │   Config    │    │    State    │    │   Health    │                  │
│  │  Loader     │    │   Manager   │    │   Server    │                  │
│  │ config.ts   │    │  state.ts   │    │  health.ts  │                  │
│  └─────────────┘    └─────────────┘    └─────────────┘                  │
│         │                  │                  │                          │
│         └──────────────────┼──────────────────┘                          │
│                            │                                              │
│                            ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    Crash Recovery                                │    │
│  │                   crash-recovery.ts                              │    │
│  │  • CrashTracker (rolling window)                                 │    │
│  │  • Exponential backoff                                           │    │
│  │  • Crash logging                                                 │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Research Layer

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Parallel Research System                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│    start-research.sh                                                     │
│         │                                                                │
│         ├─── fetch_all_markets() ──► markets.json (20K+ markets)        │
│         │                                                                │
│         ├─── segment_markets() ────► markets_segment_1.json             │
│         │                      ────► markets_segment_2.json             │
│         │                      ────► markets_segment_3.json             │
│         │                      ────► markets_segment_4.json             │
│         │                      ────► markets_segment_5.json             │
│         │                                                                │
│         └─── spawn_terminal() ─────┬─► Terminal 1 (hidden)              │
│                                    ├─► Terminal 2 (hidden)              │
│                                    ├─► Terminal 3 (hidden)              │
│                                    ├─► Terminal 4 (hidden)              │
│                                    └─► Terminal 5 (hidden)              │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    spawn-terminal.sh                             │    │
│  │  Platform detection:                                             │    │
│  │  • macOS: osascript (Terminal.app, without activating)           │    │
│  │  • Linux: gnome-terminal (1x1 off-screen) or xterm (iconic)      │    │
│  │  • Fallback: nohup + disown                                      │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Research Terminal Structure

```
research/
├── terminal-1/
│   ├── prompt.md         # Generated instructions for this segment
│   ├── scores.json       # Output: JSON Lines format scores
│   ├── status.txt        # "COMPLETE" when done
│   └── output.log        # Stdout/stderr capture
├── terminal-2/
│   └── ...
├── terminal-3/
│   └── ...
├── terminal-4/
│   └── ...
└── terminal-5/
    └── ...
```

### Aggregation Layer

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Score Aggregation System                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│    aggregate-scores.sh                                                   │
│         │                                                                │
│         └─► bun run src/cli/aggregate-scores-cli.ts                     │
│                     │                                                    │
│                     ▼                                                    │
│    ┌─────────────────────────────────────────────────────────────┐      │
│    │              score-aggregation.ts                            │      │
│    ├─────────────────────────────────────────────────────────────┤      │
│    │  discoverTerminalFiles()  ──► Find completed terminals       │      │
│    │  parseJsonLines()         ──► Parse JSON Lines format        │      │
│    │  mergeScores()            ──► Combine into single portfolio  │      │
│    │  calculateMetrics()       ──► Avg score, distributions       │      │
│    │  writePortfolioScores()   ──► portfolio-scores.json          │      │
│    │  writeMyPortfolio()       ──► my-portfolio.json              │      │
│    └─────────────────────────────────────────────────────────────┘      │
│                                                                          │
│    Output Files:                                                         │
│    • portfolio-scores.json  ──► {marketId: {score, position, conf}}     │
│    • my-portfolio.json      ──► Portfolio + metrics + metadata          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Comparison Layer

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Bet Comparison System                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│    compare-bet.sh / review-bets.sh                                       │
│         │                                                                │
│         └─► bun run src/cli/compare-bet-cli.ts                          │
│                     │                                                    │
│                     ▼                                                    │
│    ┌─────────────────────────────────────────────────────────────┐      │
│    │               bet-comparison.ts                              │      │
│    ├─────────────────────────────────────────────────────────────┤      │
│    │                                                              │      │
│    │  calculateEV(ourPortfolio, betPositions)                    │      │
│    │       │                                                     │      │
│    │       ├─► For each market:                                  │      │
│    │       │   if positions differ:                              │      │
│    │       │     delta = |our_score - 50|                        │      │
│    │       │   else:                                             │      │
│    │       │     delta = 0 (no edge)                             │      │
│    │       │                                                     │      │
│    │       └─► weighted_EV = sum(delta * confidence)             │      │
│    │                         / sum(confidence)                   │      │
│    │                                                              │      │
│    │  getRecommendation(evScore)                                 │      │
│    │       │                                                     │      │
│    │       ├─► > 15: STRONG_MATCH                               │      │
│    │       ├─► 10-15: MATCH                                      │      │
│    │       ├─► 5-10: CONSIDER                                    │      │
│    │       ├─► 0-5: LEAN_SKIP                                    │      │
│    │       └─► <= 0: SKIP                                        │      │
│    │                                                              │      │
│    │  compareBet() ──► ComparisonResult                          │      │
│    │                                                              │      │
│    └─────────────────────────────────────────────────────────────┘      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Execution Layer

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Bet Matching Execution                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│    match-bet.sh                                                          │
│         │                                                                │
│         ├─── Step 1: Fetch bet details from backend API                 │
│         │         └─► curl /api/bets/{betId}                            │
│         │                                                                │
│         ├─── Step 2: Validate bet status                                 │
│         │         └─► Must be "pending" or "partially_matched"          │
│         │                                                                │
│         ├─── Step 3: Calculate fill amount                               │
│         │         └─► bun cli/match-bet-cli.ts calculate-fill           │
│         │                                                                │
│         ├─── Step 4: Check USDC balance                                  │
│         │         └─► cast call USDC.balanceOf()                        │
│         │                                                                │
│         ├─── Step 5: Approve USDC (if needed)                            │
│         │         └─► cast send USDC.approve(contract, MAX)             │
│         │                                                                │
│         ├─── Step 6: Execute matchBet transaction                        │
│         │         └─► cast send contract.matchBet(betId, amount)        │
│         │                                                                │
│         ├─── Step 7: Parse transaction result                            │
│         │         └─► Extract txHash, gasUsed, gasCostUSD               │
│         │                                                                │
│         ├─── Step 8: Upload counter-scores to backend                    │
│         │         └─► POST /api/bets/{betId}/counter-scores             │
│         │                                                                │
│         └─── Step 9: Update state and log transaction                    │
│                   └─► trade-state.json, transactions.log                 │
│                                                                          │
│    ┌─────────────────────────────────────────────────────────────┐      │
│    │                bet-matching.ts                               │      │
│    ├─────────────────────────────────────────────────────────────┤      │
│    │  loadTradeState()   ──► Read trade-state.json               │      │
│    │  saveTradeState()   ──► Atomic write (temp + rename)        │      │
│    │  addMatchedBet()    ──► Add to matchedBets array            │      │
│    │  logTransaction()   ──► Append to transactions.log          │      │
│    │  calculateFillAmount() ──► Based on risk profile             │      │
│    └─────────────────────────────────────────────────────────────┘      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                            Complete Data Flow                               │
└────────────────────────────────────────────────────────────────────────────┘

  Polymarket API                        Backend API
        │                                    │
        │ GET /markets                       │ GET /api/bets
        ▼                                    ▼
  ┌──────────┐                         ┌──────────┐
  │ markets  │                         │  open    │
  │  .json   │                         │  bets    │
  └──────────┘                         └──────────┘
        │                                    │
        │ segment_markets()                  │
        ▼                                    │
  ┌──────────────────────┐                   │
  │ markets_segment_*.json│                  │
  └──────────────────────┘                   │
        │                                    │
        │ spawn 5 terminals                  │
        ▼                                    │
  ┌──────────────────────┐                   │
  │ Research Terminals   │                   │
  │ (Claude Code x5)     │                   │
  └──────────────────────┘                   │
        │                                    │
        │ score each market                  │
        ▼                                    │
  ┌──────────────────────┐                   │
  │ terminal-*/scores.json│                  │
  └──────────────────────┘                   │
        │                                    │
        │ aggregate_scores()                 │
        ▼                                    │
  ┌──────────────────────┐                   │
  │ portfolio-scores.json │                  │
  │ my-portfolio.json     │                  │
  └──────────────────────┘                   │
        │                                    │
        └────────────┬───────────────────────┘
                     │
                     │ calculateEV()
                     ▼
              ┌──────────────┐
              │ EV Scores &  │
              │Recommendations│
              └──────────────┘
                     │
                     │ Agent decision
                     ▼
              ┌──────────────┐
              │ MATCH/SKIP   │
              └──────────────┘
                     │
                     │ if MATCH
                     ▼
        ┌─────────────────────────┐
        │  On-Chain Execution     │
        │  (AgiArenaCore.matchBet)│
        └─────────────────────────┘
                     │
                     │ success
                     ▼
        ┌─────────────────────────┐
        │  State Updates          │
        │  • trade-state.json     │
        │  • transactions.log     │
        │  • Backend counter-scores│
        └─────────────────────────┘
```

## Contract Integration

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      On-Chain Components                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Base Mainnet (Chain ID: 8453)                                          │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    AgiArenaCore                                  │    │
│  │         0xdbDD446F158cA403e70521497CC33E0A53205f74              │    │
│  ├─────────────────────────────────────────────────────────────────┤    │
│  │  Functions:                                                      │    │
│  │  • placeBet(hash, amount) ──► Creator places bet                │    │
│  │  • matchBet(betId, fillAmount) ──► Agent matches bet            │    │
│  │  • getBet(betId) ──► Query bet details                          │    │
│  │                                                                  │    │
│  │  Events:                                                         │    │
│  │  • BetPlaced(creator, betId, hash, amount)                      │    │
│  │  • BetMatched(betId, matcher, fillAmount)                       │    │
│  │  • BetSettled(betId, winner, payout)                            │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    ResolutionDAO                                 │    │
│  │         0xed4F750fBdc860ECa19E7286452d61737D733f23              │    │
│  ├─────────────────────────────────────────────────────────────────┤    │
│  │  • Keeper voting on market outcomes                              │    │
│  │  • Dispute resolution                                            │    │
│  │  • Settlement execution                                          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    USDC (Circle)                                 │    │
│  │         0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913              │    │
│  ├─────────────────────────────────────────────────────────────────┤    │
│  │  • 6 decimals                                                    │    │
│  │  • approve(spender, amount)                                      │    │
│  │  • balanceOf(owner)                                              │    │
│  │  • allowance(owner, spender)                                     │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## File System Structure

```
bot/
├── src/
│   ├── handler.ts           # Main handler (spawns agent, health server, lifecycle mgmt)
│   ├── config.ts            # Configuration loading/validation
│   ├── state.ts             # Handler state persistence (atomic writes)
│   ├── agent-state.ts       # Agent trading state (balance, bets, phase)
│   ├── crash-recovery.ts    # Crash tracking, exponential backoff
│   ├── recovery.ts          # Crash recovery protocol
│   ├── lifecycle.ts         # Lifecycle tracking, context clearing
│   ├── health.ts            # Health check response generation
│   ├── prompt.ts            # Agent prompt generation
│   ├── research-prompt.ts   # Research terminal prompt generation
│   ├── score-aggregation.ts # Score merging and metrics
│   ├── bet-comparison.ts    # EV calculation and recommendations
│   ├── bet-matching.ts      # Trade state and matching logic
│   ├── logger.ts            # Structured logging
│   ├── init.ts              # Initialization utilities
│   ├── index.ts             # Entry point
│   ├── types.ts             # TypeScript type definitions
│   ├── watchdog.ts          # Watchdog monitoring implementation
│   ├── watchdog-types.ts    # Watchdog type definitions
│   └── cli/
│       ├── aggregate-scores-cli.ts
│       ├── compare-bet-cli.ts
│       ├── fetch-open-bets-cli.ts
│       └── match-bet-cli.ts
│
├── agent/
│   ├── README.md            # This documentation
│   ├── ARCHITECTURE.md      # Architecture documentation
│   ├── prompt.md            # Generated agent prompt (created at runtime)
│   ├── handler-state.json   # Handler state (PID, restarts)
│   ├── agent-state.json     # Agent trading state (balance, bets, phase)
│   ├── trade-state.json     # Trade history
│   ├── heartbeat.txt        # Watchdog heartbeat
│   ├── CLEAR_CONTEXT        # Signal file: request context clear (optional)
│   ├── IN_PROGRESS_TX       # Signal file: transaction in progress (optional)
│   ├── MATCHED_BET          # Signal file: bet matched notification (optional)
│   ├── markets.json         # All Polymarket markets
│   ├── markets_segment_*.json # Segmented market files
│   ├── portfolio-scores.json  # Aggregated portfolio
│   ├── my-portfolio.json    # Portfolio with metadata
│   ├── last-comparison.json # Cached EV comparison (optional)
│   ├── research/            # Research terminal directories
│   │   └── terminal-*/      # Per-terminal working directories
│   └── scripts/
│       ├── start-research.sh
│       ├── spawn-terminal.sh
│       ├── aggregate-scores.sh
│       ├── fetch-open-bets.sh
│       ├── compare-bet.sh
│       ├── review-bets.sh
│       ├── match-bet.sh
│       ├── update-heartbeat.sh
│       └── recover.sh
│
├── logs/
│   ├── agent.log            # Agent stdout/stderr
│   ├── crashes.log          # Crash events
│   └── watchdog.log         # Watchdog monitoring
│
├── __tests__/               # Test files
│   ├── handler.test.ts
│   ├── integration.test.ts
│   ├── init.test.ts
│   ├── research.test.ts
│   ├── bet-comparison.test.ts
│   ├── score-aggregation.test.ts
│   ├── bet-matching.test.ts
│   ├── prompt.test.ts
│   ├── agent-state.test.ts
│   ├── recovery.test.ts
│   ├── watchdog.test.ts
│   └── lifecycle.test.ts
│
├── config.json              # Agent configuration (walletAddress, capital, etc.)
├── package.json
└── tsconfig.json
```

## Lifecycle Management

The handler implements automatic context clearing to prevent Claude Code context window exhaustion during long-running operations.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Lifecycle Management System                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐   │
│  │ LifecycleTracker│     │  Signal Files   │     │  Handler Loop   │   │
│  │                 │     │                 │     │                 │   │
│  │ • messageCount  │     │ • CLEAR_CONTEXT │     │ Check every 30s │   │
│  │ • startTime     │◄────│ • IN_PROGRESS_TX│◄────│ for triggers    │   │
│  │ • betsMatched   │     │ • MATCHED_BET   │     │                 │   │
│  └─────────────────┘     └─────────────────┘     └─────────────────┘   │
│           │                                               │             │
│           │ Thresholds:                                   │             │
│           │ • 50 messages                                 │             │
│           │ • 4 hours runtime                             ▼             │
│           │                                    ┌─────────────────┐      │
│           └───────────────────────────────────►│ Context Clear   │      │
│                                                │                 │      │
│                                                │ 1. SIGTERM agent│      │
│                                                │ 2. Wait 5s      │      │
│                                                │ 3. SIGKILL      │      │
│                                                │ 4. Kill terms   │      │
│                                                │ 5. Clean dirs   │      │
│                                                │ 6. Respawn      │      │
│                                                └─────────────────┘      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Context Clear Triggers

| Trigger | Threshold | Description |
|---------|-----------|-------------|
| Message Count | 50 messages | Tool calls and responses counted |
| Runtime | 4 hours | Continuous operation time |
| Manual Signal | CLEAR_CONTEXT file | User-initiated clear request |

### Signal File Protocol

**CLEAR_CONTEXT**: Create this file to request immediate context clear.
```bash
touch agent/CLEAR_CONTEXT
```

**IN_PROGRESS_TX**: Handler creates this during transactions to defer clearing.
```bash
# Handler checks this before clearing
if [ -f agent/IN_PROGRESS_TX ]; then
  # Defer context clear until transaction completes
fi
```

**MATCHED_BET**: Agent writes this after successful bet match for handler tracking.
```json
{"betId": "123", "pnl": 25.50, "timestamp": "2026-01-23T10:00:00Z"}
```

## Error Handling

### Error Codes

| Code | Description | Recovery Action |
|------|-------------|-----------------|
| `BET_NOT_FOUND` | Bet doesn't exist or API unreachable | Skip bet, continue |
| `BET_ALREADY_MATCHED` | Bet fully matched by others | Skip bet, normal |
| `BET_NOT_PENDING` | Bet in wrong state | Skip bet, continue |
| `INSUFFICIENT_BALANCE` | Not enough USDC | Log warning, skip |
| `APPROVAL_FAILED` | USDC approval tx failed | Retry once, then skip |
| `MATCH_REVERTED` | matchBet tx reverted | Log error, skip |
| `TIMEOUT` | Transaction timeout | Retry with backoff |
| `CAPITAL_LIMIT` | Exceeded capital allocation | Skip, wait next cycle |
| `RPC_ERROR` | RPC node unreachable | Retry with backoff |
| `MISSING_CONFIG` | Required config missing | Halt, require fix |

### Retry Strategy

```
Exponential Backoff:
  Attempt 1: Wait 5 seconds
  Attempt 2: Wait 10 seconds
  Attempt 3: Wait 20 seconds
  Attempt 4: Wait 40 seconds
  Attempt 5: Wait 60 seconds (max)

After 5 consecutive crashes in 5 minutes:
  → Pause for 60 seconds
  → Reset crash counter
  → Resume normal operation
```

## Security Considerations

1. **Private Key Management**
   - Never stored in config files
   - Loaded from `AGENT_PRIVATE_KEY` environment variable
   - Validated format (0x + 64 hex chars)

2. **Atomic State Writes**
   - Write to temp file first
   - Atomic rename to final path
   - Prevents corruption on crash

3. **USDC Approval**
   - Unlimited approval (MAX_UINT256) for gas efficiency
   - Single approval transaction
   - Reduces ongoing gas costs

4. **Transaction Validation**
   - Verify bet status before matching
   - Check balance before sending
   - Wait for confirmation

5. **Rate Limiting**
   - Research interval prevents API abuse
   - Crash rate limiting prevents rapid restarts
   - Terminal health checks prevent runaway processes
