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

# 1. Create login keyring if it doesn't exist (--login creates the keyring file)
printf '%s\n' "$KEYRING_PASSWORD" | gnome-keyring-daemon --login --components=secrets 2>/dev/null || true

# 2. Start daemon if not running
if ! pgrep -f "gnome-keyring-daemon" >/dev/null 2>&1; then
	gnome-keyring-daemon --start --components=secrets --daemonize >/dev/null 2>&1
fi

# 3. Always unlock the keyring
printf '%s\n' "$KEYRING_PASSWORD" | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1 || true

# Export environment variables for dependent services
{
	echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS"
	echo "GNOME_KEYRING_CONTROL=${GNOME_KEYRING_CONTROL:-}"
} >"$KEYRING_ENV_FILE"

echo "Keyring initialized successfully"
