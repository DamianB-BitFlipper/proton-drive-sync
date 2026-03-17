#!/bin/bash
set -e

# Ensure persistent and data directories exist
mkdir -p /config/proton-drive-sync /state/proton-drive-sync /data

# If arguments are passed (e.g. "docker compose run ... proton-drive-sync auth"),
# run them directly instead of starting the sync server
if [ $# -gt 0 ]; then
  exec "$@"
fi

# Start sync in foreground (no daemon mode)
# Using exec so signals (SIGTERM, SIGINT) go directly to the app
echo "Starting Proton Drive Sync..."
exec proton-drive-sync start --no-daemon
