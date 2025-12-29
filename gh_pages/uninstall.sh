#!/usr/bin/env bash
set -euo pipefail
APP=proton-drive-sync

MUTED='\033[0;2m'
RED='\033[0;31m'
NC='\033[0m' # No Color

INSTALL_DIR=$HOME/.local/bin

echo -e ""
echo -e "${MUTED}Uninstalling Proton Drive Sync...${NC}"
echo -e ""

# Uninstall service files if proton-drive-sync exists
if command -v proton-drive-sync >/dev/null 2>&1; then
	echo -e "${MUTED}Removing service files...${NC}"
	proton-drive-sync service uninstall -y || true
elif [[ -f "$INSTALL_DIR/$APP" ]]; then
	echo -e "${MUTED}Removing service files...${NC}"
	"$INSTALL_DIR/$APP" service uninstall -y || true
fi

# Remove the binary
if [[ -f "$INSTALL_DIR/$APP" ]]; then
	rm -f "$INSTALL_DIR/$APP"
	echo -e "${MUTED}Removed ${NC}$INSTALL_DIR/$APP"
else
	echo -e "${MUTED}Binary not found at $INSTALL_DIR/$APP${NC}"
fi

echo -e ""
echo -e "${MUTED}Proton Drive Sync${NC} uninstalled successfully!"
echo -e ""

# Prompt user about config and data directories
CONFIG_DIR="$HOME/.config/proton-drive-sync"
STATE_DIR="$HOME/.local/state/proton-drive-sync"

if [[ -d "$CONFIG_DIR" ]] || [[ -d "$STATE_DIR" ]]; then
	read -p "Delete your configuration settings and sync history? (y/N): " -n 1 -r
	echo -e ""
	if [[ $REPLY =~ ^[Yy]$ ]]; then
		[[ -d "$CONFIG_DIR" ]] && rm -rf "$CONFIG_DIR" && echo -e "${MUTED}Removed${NC} $CONFIG_DIR"
		[[ -d "$STATE_DIR" ]] && rm -rf "$STATE_DIR" && echo -e "${MUTED}Removed${NC} $STATE_DIR"
	fi
	echo -e ""
fi

# Prompt user about Watchman
if command -v watchman >/dev/null 2>&1; then
	echo -e "${MUTED}Watchman is still installed on your system.${NC}"
	read -p "Would you like to remove Watchman as well? [y/N] " -n 1 -r
	echo -e ""
	if [[ $REPLY =~ ^[Yy]$ ]]; then
		if command -v brew >/dev/null 2>&1; then
			echo -e "${MUTED}Removing Watchman...${NC}"
			brew uninstall watchman
			echo -e "${MUTED}Watchman removed.${NC}"
		else
			echo -e "${RED}Homebrew not found. Please remove Watchman manually.${NC}"
		fi
	fi
fi

echo -e ""
