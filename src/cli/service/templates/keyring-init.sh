#!/bin/bash
# Proton Drive Sync - Keyring initialization for headless environments
# WARNING: This file contains a cleartext password for automated keyring unlocking

set -e

# Configuration (populated by installer)
KEYRING_DIR="{{KEYRING_DIR}}"
KEYRING_ENV_FILE="{{KEYRING_ENV_FILE}}"
KEYRING_PASSWORD="{{KEYRING_PASSWORD}}"

# Set up D-Bus session bus address
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
	export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
fi

# Create keyring directory if it doesn't exist
mkdir -p "$KEYRING_DIR"

# Check if gnome-keyring-daemon is already running
if ! pgrep -u "$(id -u)" -x "gnome-keyring-d" >/dev/null 2>&1; then
	# Start and unlock the keyring daemon
	echo "$KEYRING_PASSWORD" | gnome-keyring-daemon --unlock --components=secrets --daemonize >/dev/null 2>&1
fi

# Create default collection if it doesn't exist (stores a dummy secret)
echo -n "init" | secret-tool store --label="proton-drive-sync-init" service proton-drive-sync type init 2>/dev/null || true

# Export environment variables for dependent services
{
	echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS"
	echo "GNOME_KEYRING_CONTROL=${GNOME_KEYRING_CONTROL:-}"
} >"$KEYRING_ENV_FILE"

echo "Keyring initialized successfully"
