#!/bin/bash
# spawn-terminal.sh - Cross-platform hidden terminal spawner
# Spawns a research terminal in the background without visible windows
#
# Usage: bash spawn-terminal.sh <terminal_num> <terminal_dir>
#
# Arguments:
#   terminal_num - The terminal number (1, 2, 3, etc.)
#   terminal_dir - Full path to the terminal's working directory
#
# The spawned terminal will:
#   - Run claude-code in dontAsk mode
#   - Use prompt.md as the initial prompt
#   - Redirect output to output.log
#   - Run completely in background (hidden)

set -e

# Validate arguments
if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <terminal_num> <terminal_dir>"
    echo "Example: $0 1 /path/to/research/terminal-1"
    exit 1
fi

TERMINAL_NUM="$1"
TERMINAL_DIR="$2"

# Validate terminal directory exists
if [ ! -d "$TERMINAL_DIR" ]; then
    echo "ERROR: Terminal directory does not exist: ${TERMINAL_DIR}"
    exit 1
fi

# Validate prompt.md exists
if [ ! -f "${TERMINAL_DIR}/prompt.md" ]; then
    echo "ERROR: prompt.md not found in ${TERMINAL_DIR}"
    exit 1
fi

echo "Spawning research terminal ${TERMINAL_NUM} at ${TERMINAL_DIR}..."

# Detect platform and spawn accordingly
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS: Try osascript first for true hidden terminal
    # "without activating" prevents Terminal from coming to foreground
    osascript_result=$(osascript -e "
        tell application \"Terminal\"
            do script \"cd '${TERMINAL_DIR}' && claude-code --mode dontAsk --prompt-file prompt.md > output.log 2>&1; exit\" without activating
        end tell
    " 2>/dev/null) || {
        echo "osascript failed, using nohup fallback..."
        # Fallback: Use nohup for background process
        cd "$TERMINAL_DIR"
        nohup bash -c "claude-code --mode dontAsk --prompt-file prompt.md > output.log 2>&1" &
        disown
        echo "PID: $!"
    }

    if [ -n "$osascript_result" ]; then
        echo "Terminal spawned via osascript (hidden)"
    fi

elif [[ "$OSTYPE" == "linux"* ]]; then
    # Linux: Multiple fallback options

    # Try gnome-terminal with minimize/geometry tricks
    if command -v gnome-terminal &> /dev/null; then
        gnome-terminal --hide-menubar --geometry=1x1+9999+9999 -- bash -c \
            "cd '${TERMINAL_DIR}' && claude-code --mode dontAsk --prompt-file prompt.md > output.log 2>&1" &
        disown
        echo "Terminal spawned via gnome-terminal"

    # Try xterm in iconic (minimized) mode
    elif command -v xterm &> /dev/null; then
        xterm -iconic -e "cd '${TERMINAL_DIR}' && claude-code --mode dontAsk --prompt-file prompt.md > output.log 2>&1" &
        disown
        echo "Terminal spawned via xterm (iconic)"

    # Fallback to pure background process
    else
        cd "$TERMINAL_DIR"
        nohup bash -c "claude-code --mode dontAsk --prompt-file prompt.md > output.log 2>&1" &
        disown
        echo "Terminal spawned via nohup (background)"
    fi

else
    # Unknown OS: Try basic background process
    echo "Unknown OS: ${OSTYPE}, using nohup..."
    cd "$TERMINAL_DIR"
    nohup bash -c "claude-code --mode dontAsk --prompt-file prompt.md > output.log 2>&1" &
    disown
    echo "Terminal spawned via nohup (background)"
fi

echo "✓ Research terminal ${TERMINAL_NUM} spawned successfully"
exit 0
