#!/bin/bash
# Updates heartbeat file with current timestamp
# Called by agent every 5 minutes to signal liveness
#
# Usage: ./update-heartbeat.sh [heartbeat_file_path]
#
# The heartbeat file contains: ALIVE {unix_timestamp}
# The watchdog process monitors this file's modification time

set -e

# Default heartbeat file path (relative to bot directory)
HEARTBEAT_FILE="${1:-agent/heartbeat.txt}"

# Ensure parent directory exists
mkdir -p "$(dirname "$HEARTBEAT_FILE")"

# Write heartbeat with current Unix timestamp
echo "ALIVE $(date +%s)" > "$HEARTBEAT_FILE"

# Optional: output for logging (can be suppressed with >/dev/null)
echo "Heartbeat updated: $(date)"
