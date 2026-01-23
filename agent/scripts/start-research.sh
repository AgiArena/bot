#!/bin/bash
# start-research.sh - Parallel Research Terminal System
# Fetches all Polymarket markets, segments them, and spawns research terminals
#
# Usage: bash scripts/start-research.sh
#
# Environment Variables:
#   AGENT_RESEARCH_TERMINALS - Number of parallel terminals (default: 5)
#
# Output:
#   - markets.json - All active Polymarket markets
#   - markets_segment_*.json - Segmented market files
#   - research/terminal-*/prompt.md - Generated prompts for each terminal
#   - research/terminal-*/scores.json - Output scores from terminals
#   - research/terminal-*/status.txt - "COMPLETE" when terminal finishes

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
RESEARCH_DIR="${AGENT_DIR}/research"
RESEARCH_TERMINALS="${AGENT_RESEARCH_TERMINALS:-5}"
POLYMARKET_API="https://gamma-api.polymarket.com/markets"
MARKETS_FILE="${AGENT_DIR}/markets.json"
TIMEOUT_SECONDS=600
MAX_RETRIES=3

echo "================================================"
echo "🔬 AgiArena Research Terminal System"
echo "================================================"
echo "Terminals: ${RESEARCH_TERMINALS}"
echo "Agent Dir: ${AGENT_DIR}"
echo ""

# Function: Fetch all markets from Polymarket API with pagination
fetch_all_markets() {
    echo "📡 Fetching markets from Polymarket API..."

    local all_markets="[]"
    local offset=0
    local limit=500
    local page=1
    local retry_count=0

    while true; do
        echo "  Fetching page ${page} (offset: ${offset})..."

        # Fetch page with retry logic
        local response=""
        retry_count=0
        while [ $retry_count -lt $MAX_RETRIES ]; do
            response=$(curl -s "${POLYMARKET_API}?closed=false&limit=${limit}&offset=${offset}" 2>/dev/null) || true

            if [ -n "$response" ] && [ "$response" != "null" ]; then
                break
            fi

            retry_count=$((retry_count + 1))
            echo "    Retry ${retry_count}/${MAX_RETRIES}..."
            sleep $((retry_count * 2))
        done

        if [ -z "$response" ] || [ "$response" = "null" ]; then
            echo "  ⚠️  API returned empty/null response at offset ${offset}"
            break
        fi

        # Check if we got any markets
        local count=$(echo "$response" | jq 'length' 2>/dev/null || echo "0")

        if [ "$count" = "0" ] || [ "$count" = "null" ]; then
            echo "  ✓ No more markets to fetch"
            break
        fi

        echo "    Retrieved ${count} markets"

        # Merge with existing markets
        all_markets=$(echo "$all_markets" "$response" | jq -s 'add' 2>/dev/null)

        # Check if we got less than limit (last page)
        if [ "$count" -lt "$limit" ]; then
            echo "  ✓ Reached last page"
            break
        fi

        offset=$((offset + limit))
        page=$((page + 1))

        # Safety check to prevent infinite loops
        if [ $page -gt 100 ]; then
            echo "  ⚠️  Safety limit reached (100 pages)"
            break
        fi

        # Small delay to avoid rate limiting
        sleep 0.5
    done

    echo "$all_markets"
}

# Function: Save markets to file
save_markets() {
    local markets="$1"
    local file="$2"

    echo "$markets" > "$file"
    local count=$(echo "$markets" | jq 'length' 2>/dev/null || echo "0")
    echo "💾 Saved ${count} markets to ${file}"
}

# Function: Segment markets into N files
segment_markets() {
    local markets_file="$1"
    local num_segments="$2"
    local output_dir="$3"

    local total=$(jq 'length' "$markets_file")
    echo "📊 Segmenting ${total} markets into ${num_segments} terminals..."

    # Handle edge case: fewer markets than terminals
    if [ "$total" -lt "$num_segments" ]; then
        echo "  ⚠️  Fewer markets (${total}) than terminals (${num_segments})"
        num_segments=$total
        echo "  → Adjusting to ${num_segments} terminals"
    fi

    # Handle edge case: no markets
    if [ "$total" -eq 0 ]; then
        echo "  ❌ ERROR: No markets to segment"
        return 1
    fi

    local base_size=$((total / num_segments))
    local remainder=$((total % num_segments))

    local current_idx=0
    for i in $(seq 1 $num_segments); do
        # First 'remainder' segments get one extra item
        local segment_size=$base_size
        if [ $i -le $remainder ]; then
            segment_size=$((segment_size + 1))
        fi

        local end_idx=$((current_idx + segment_size))
        local segment_file="${output_dir}/markets_segment_${i}.json"

        # Extract segment using jq
        jq ".[$current_idx:$end_idx]" "$markets_file" > "$segment_file"

        local actual_count=$(jq 'length' "$segment_file")
        echo "  Segment ${i}: markets ${current_idx}-$((end_idx - 1)) (${actual_count} markets)"

        current_idx=$end_idx
    done

    echo "✓ Segmentation complete"
    echo "$num_segments"
}

# Function: Generate research prompt for a terminal
generate_terminal_prompt() {
    local terminal_num="$1"
    local segment_file="$2"
    local start_idx="$3"
    local end_idx="$4"
    local total_markets="$5"
    local output_dir="$6"

    local terminal_dir="${output_dir}/terminal-${terminal_num}"
    local prompt_file="${terminal_dir}/prompt.md"

    mkdir -p "$terminal_dir"

    cat > "$prompt_file" << EOF
# Research Terminal ${terminal_num}

Your job: Score markets ${start_idx} to ${end_idx} from ${segment_file}

## Total Markets in Segment: ${total_markets}

## Instructions

For each market in the segment file:

1. **Read market data** (question, outcomes, current odds)
2. **Analyze probability** based on available information
3. **Assign score 0-100** (100 = very bullish on YES outcome, 0 = very bullish on NO)

## Output Format

Write results incrementally to scores using JSON Lines format (one JSON object per line):

\`\`\`json
{"marketId": "0x...", "score": 75, "position": 1, "confidence": 0.85}
{"marketId": "0x...", "score": 30, "position": 0, "confidence": 0.70}
\`\`\`

Where:
- **marketId**: The market's unique identifier from the segment file
- **score**: Your probability assessment 0-100 (100 = YES will happen)
- **position**: 1 for YES (score >= 50), 0 for NO (score < 50)
- **confidence**: How confident you are in this score (0.0 to 1.0)

## Output Files

Save results to: \`research/terminal-${terminal_num}/scores.json\`

**CRITICAL**: Write scores incrementally (every 10-20 markets) for crash resilience.

When done processing ALL markets, write "COMPLETE" to: \`research/terminal-${terminal_num}/status.txt\`

## Scoring Guidelines

- **80-100**: High confidence YES - strong evidence event will occur
- **60-79**: Moderate confidence YES - some evidence favoring YES
- **50-59**: Slight YES lean - marginally favoring YES outcome
- **40-49**: Slight NO lean - marginally favoring NO outcome
- **20-39**: Moderate confidence NO - some evidence favoring NO
- **0-19**: High confidence NO - strong evidence event won't occur

## Important Notes

- Process markets in order as they appear in the segment file
- Skip markets with insufficient data (mark confidence as 0.1)
- Do NOT stop until ALL markets in the segment are scored
- Write progress updates to output.log
EOF

    echo "  Generated prompt for terminal ${terminal_num}"
}

# Array to store PIDs for health checking
declare -a TERMINAL_PIDS

# Function: Spawn research terminal using spawn-terminal.sh
spawn_terminal() {
    local terminal_num="$1"
    local terminal_dir="$2"

    echo "  🚀 Spawning terminal ${terminal_num}..."

    # Use the dedicated spawn-terminal.sh script
    local spawn_script="${SCRIPT_DIR}/spawn-terminal.sh"

    if [ -f "$spawn_script" ]; then
        # Spawn using the helper script and capture PID
        bash "$spawn_script" "$terminal_num" "$terminal_dir" &
        local spawn_pid=$!
        wait $spawn_pid 2>/dev/null || true

        # Try to find the actual claude-code process PID
        sleep 0.5
        local actual_pid=$(pgrep -f "claude-code.*terminal-${terminal_num}" 2>/dev/null | head -1)
        if [ -n "$actual_pid" ]; then
            TERMINAL_PIDS[$terminal_num]=$actual_pid
            echo "  ✓ Terminal ${terminal_num} spawned (PID: ${actual_pid})"
        else
            # Fallback: store a marker that we spawned but couldn't track PID
            TERMINAL_PIDS[$terminal_num]="unknown"
            echo "  ✓ Terminal ${terminal_num} spawned (PID tracking unavailable)"
        fi
    else
        # Fallback if spawn-terminal.sh doesn't exist
        echo "  ⚠️  spawn-terminal.sh not found, using inline spawn..."
        if [[ "$OSTYPE" == "darwin"* ]]; then
            nohup bash -c "cd '${terminal_dir}' && claude-code --mode dontAsk --prompt-file prompt.md > output.log 2>&1" &
            TERMINAL_PIDS[$terminal_num]=$!
            disown
        else
            nohup bash -c "cd '${terminal_dir}' && claude-code --mode dontAsk --prompt-file prompt.md > output.log 2>&1" &
            TERMINAL_PIDS[$terminal_num]=$!
            disown
        fi
        echo "  ✓ Terminal ${terminal_num} spawned (PID: ${TERMINAL_PIDS[$terminal_num]})"
    fi
}

# Function: Check if terminal process is still running
check_terminal_health() {
    local terminal_num="$1"
    local pid="${TERMINAL_PIDS[$terminal_num]}"

    if [ -z "$pid" ] || [ "$pid" = "unknown" ]; then
        # Can't track - check by process name
        if pgrep -f "claude-code.*terminal-${terminal_num}" > /dev/null 2>&1; then
            return 0  # Running
        fi
        return 1  # Not running or can't determine
    fi

    # Check if PID is still running
    if kill -0 "$pid" 2>/dev/null; then
        return 0  # Running
    fi
    return 1  # Not running
}

# Function: Retry failed terminal
retry_terminal() {
    local terminal_num="$1"
    local research_dir="$2"

    echo "  🔄 Retrying terminal ${terminal_num}..."

    local terminal_dir="${research_dir}/terminal-${terminal_num}"

    # Clean up previous attempt
    rm -f "${terminal_dir}/output.log" 2>/dev/null

    # Respawn
    spawn_terminal "$terminal_num" "$terminal_dir"
}

# Function: Monitor terminal completion with health checks and retry
monitor_completion() {
    local num_terminals="$1"
    local research_dir="$2"
    local timeout_seconds="$3"

    echo ""
    echo "================================================"
    echo "⏳ Monitoring ${num_terminals} research terminals..."
    echo "   Timeout: ${timeout_seconds} seconds"
    echo "   Max retries per terminal: ${MAX_RETRIES}"
    echo "================================================"

    local start_time=$(date +%s)
    declare -A retry_counts

    # Initialize retry counts
    for i in $(seq 1 $num_terminals); do
        retry_counts[$i]=0
    done

    while true; do
        local complete_count=$(ls "${research_dir}"/terminal-*/status.txt 2>/dev/null | wc -l | tr -d ' ')
        local current_time=$(date +%s)
        local elapsed=$((current_time - start_time))

        echo "Progress: ${complete_count}/${num_terminals} terminals complete (${elapsed}s elapsed)"

        # Check for completion
        if [ "$complete_count" -eq "$num_terminals" ]; then
            echo ""
            echo "✅ All terminals complete!"
            return 0
        fi

        # Health check and retry logic (every 30 seconds after first 60 seconds)
        if [ "$elapsed" -gt 60 ] && [ $((elapsed % 30)) -lt 6 ]; then
            echo "  🔍 Running health checks..."
            for i in $(seq 1 $num_terminals); do
                local status_file="${research_dir}/terminal-${i}/status.txt"

                # Skip if already complete
                if [ -f "$status_file" ]; then
                    continue
                fi

                # Check if terminal process is still running
                if ! check_terminal_health "$i"; then
                    local current_retries=${retry_counts[$i]}

                    if [ "$current_retries" -lt "$MAX_RETRIES" ]; then
                        echo "  ⚠️  Terminal ${i} appears dead (retry ${current_retries}/${MAX_RETRIES})"
                        retry_terminal "$i" "$research_dir"
                        retry_counts[$i]=$((current_retries + 1))
                    else
                        echo "  ❌ Terminal ${i} failed after ${MAX_RETRIES} retries"
                    fi
                fi
            done
        fi

        # Timeout check
        if [ "$elapsed" -ge "$timeout_seconds" ]; then
            echo ""
            echo "⚠️  Timeout reached after ${timeout_seconds}s"

            # Final retry attempt for incomplete terminals
            local incomplete_terminals=()
            for i in $(seq 1 $num_terminals); do
                if [ ! -f "${research_dir}/terminal-${i}/status.txt" ]; then
                    incomplete_terminals+=($i)
                fi
            done

            if [ ${#incomplete_terminals[@]} -gt 0 ]; then
                echo "   Attempting final retry for ${#incomplete_terminals[@]} incomplete terminal(s)..."

                for i in "${incomplete_terminals[@]}"; do
                    local current_retries=${retry_counts[$i]}
                    if [ "$current_retries" -lt "$MAX_RETRIES" ]; then
                        retry_terminal "$i" "$research_dir"
                        retry_counts[$i]=$((current_retries + 1))
                    fi
                done

                # Give retried terminals 60 more seconds
                echo "   Waiting 60s for retried terminals..."
                local retry_timeout=$((current_time + 60))

                while [ $(date +%s) -lt $retry_timeout ]; do
                    local new_complete_count=$(ls "${research_dir}"/terminal-*/status.txt 2>/dev/null | wc -l | tr -d ' ')
                    if [ "$new_complete_count" -eq "$num_terminals" ]; then
                        echo ""
                        echo "✅ All terminals complete after retry!"
                        return 0
                    fi
                    sleep 5
                done
            fi

            # Final status report
            echo ""
            echo "❌ ERROR: Research incomplete"
            echo "   Incomplete terminals:"
            for i in $(seq 1 $num_terminals); do
                if [ ! -f "${research_dir}/terminal-${i}/status.txt" ]; then
                    echo "   - Terminal ${i} (retries: ${retry_counts[$i]}/${MAX_RETRIES})"
                fi
            done
            return 1
        fi

        sleep 5
    done
}

# Function: Cleanup stale terminal directories
cleanup_stale_terminals() {
    local research_dir="$1"

    if [ -d "$research_dir" ]; then
        echo "🧹 Cleaning up stale terminal directories..."
        rm -rf "${research_dir}"/terminal-*/
        echo "  ✓ Cleanup complete"
    fi
}

# Main execution
main() {
    # Cleanup stale directories
    cleanup_stale_terminals "$RESEARCH_DIR"

    # Create research directory
    mkdir -p "$RESEARCH_DIR"

    # Step 1: Fetch all markets
    local markets=$(fetch_all_markets)
    local market_count=$(echo "$markets" | jq 'length' 2>/dev/null || echo "0")

    if [ "$market_count" -eq "0" ]; then
        echo "❌ ERROR: No markets fetched from API"
        exit 1
    fi

    echo ""
    echo "📊 Total markets fetched: ${market_count}"

    # Save markets to file
    save_markets "$markets" "$MARKETS_FILE"

    # Step 2: Segment markets
    echo ""
    local actual_terminals=$(segment_markets "$MARKETS_FILE" "$RESEARCH_TERMINALS" "$AGENT_DIR")

    if [ -z "$actual_terminals" ] || [ "$actual_terminals" -eq "0" ]; then
        echo "❌ ERROR: Market segmentation failed"
        exit 1
    fi

    # Step 3: Generate prompts and spawn terminals
    echo ""
    echo "🔧 Generating prompts and spawning terminals..."

    local current_idx=0
    for i in $(seq 1 $actual_terminals); do
        local segment_file="markets_segment_${i}.json"
        local segment_count=$(jq 'length' "${AGENT_DIR}/${segment_file}")
        local end_idx=$((current_idx + segment_count - 1))

        # Generate prompt
        generate_terminal_prompt "$i" "$segment_file" "$current_idx" "$end_idx" "$segment_count" "$RESEARCH_DIR"

        # Spawn terminal with small delay to avoid resource contention
        spawn_terminal "$i" "${RESEARCH_DIR}/terminal-${i}"
        sleep 1

        current_idx=$((end_idx + 1))
    done

    echo ""
    echo "✓ All ${actual_terminals} terminals spawned"

    # Step 4: Monitor completion
    monitor_completion "$actual_terminals" "$RESEARCH_DIR" "$TIMEOUT_SECONDS"

    local result=$?

    echo ""
    echo "================================================"
    if [ $result -eq 0 ]; then
        echo "🎉 Research complete!"
        echo "   Scores available at: ${RESEARCH_DIR}/terminal-*/scores.json"
    else
        echo "⚠️  Research incomplete - check terminal logs"
        echo "   Logs at: ${RESEARCH_DIR}/terminal-*/output.log"
    fi
    echo "================================================"

    exit $result
}

# Run main
main
