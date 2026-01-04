#!/usr/bin/env bash
set -euo pipefail
APP=proton-drive-sync

MUTED='\033[0;2m'
RED='\033[0;31m'
NC='\033[0m' # No Color

INSTALL_DIR="$HOME/.local/bin"

# Detect OS
raw_os=$(uname -s)
case "$raw_os" in
Darwin*) os="darwin" ;;
Linux*) os="linux" ;;
*) os="unknown" ;;
esac

# Detect architecture
arch=$(uname -m)
if [[ "$arch" == "aarch64" ]]; then
	arch="arm64"
fi
if [[ "$arch" == "x86_64" ]]; then
	arch="x64"
fi

echo -e ""
echo -e "${MUTED}Uninstalling Proton Drive Sync...${NC}"
echo -e ""

# Uninstall service files if proton-drive-sync exists
if [[ -f "$INSTALL_DIR/$APP" ]]; then
	echo -e "${MUTED}Removing service files...${NC}"
	# Try user service first
	"$INSTALL_DIR/$APP" service uninstall -y 2>/dev/null || true
	# Try system service with sudo (needed for /etc/systemd/system/ files)
	if [ "$os" = "linux" ]; then
		sudo "$INSTALL_DIR/$APP" service uninstall -y 2>/dev/null || true
	fi
fi

# Remove the binary
if [[ -f "$INSTALL_DIR/$APP" ]]; then
	rm -f "$INSTALL_DIR/$APP"
	echo -e "${MUTED}Removed ${NC}$INSTALL_DIR/$APP"
else
	echo -e "${MUTED}Binary not found at $INSTALL_DIR/$APP${NC}"
fi

# Linux-specific cleanup
if [ "$os" = "linux" ]; then
	# Remove system-level directories if they exist
	if [[ -d "/etc/proton-drive-sync" ]]; then
		sudo rm -rf /etc/proton-drive-sync
		echo -e "${MUTED}Removed ${NC}/etc/proton-drive-sync"
	fi
	if [[ -d "/var/lib/proton-drive-sync" ]]; then
		sudo rm -rf /var/lib/proton-drive-sync
		echo -e "${MUTED}Removed ${NC}/var/lib/proton-drive-sync"
	fi

	# Remove keyring dummy secret if secret-tool is available
	if command -v secret-tool >/dev/null 2>&1; then
		secret-tool clear service proton-drive-sync type init 2>/dev/null || true
	fi
fi

echo -e ""
echo -e "${MUTED}Proton Drive Sync${NC} uninstalled successfully!"
echo -e ""

# ============================================================================
# Remove PATH from shell config
# ============================================================================

remove_from_path() {
	local config_file=$1

	if [[ ! -f "$config_file" ]]; then
		return
	fi

	# Check if our PATH entry exists in the file
	if grep -q "# proton-drive-sync" "$config_file"; then
		echo -e "${MUTED}Removing PATH entry from ${NC}$config_file"
		# Remove the comment line and the following export/fish_add_path line
		# Use sed to remove both lines (the comment and the PATH line that follows)
		if [[ "$os" == "darwin" ]]; then
			# macOS sed requires backup extension with -i
			sed -i '' '/# proton-drive-sync/{N;d;}' "$config_file"
		else
			# GNU sed
			sed -i '/# proton-drive-sync/{N;d;}' "$config_file"
		fi
	fi
}

XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}

current_shell=$(basename "$SHELL")
case $current_shell in
fish)
	config_files="$HOME/.config/fish/config.fish"
	;;
zsh)
	config_files="$HOME/.zshrc $HOME/.zshenv $XDG_CONFIG_HOME/zsh/.zshrc $XDG_CONFIG_HOME/zsh/.zshenv"
	;;
bash)
	config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
	;;
ash)
	config_files="$HOME/.ashrc $HOME/.profile /etc/profile"
	;;
sh)
	config_files="$HOME/.ashrc $HOME/.profile /etc/profile"
	;;
*)
	config_files="$HOME/.bashrc $HOME/.bash_profile $XDG_CONFIG_HOME/bash/.bashrc $XDG_CONFIG_HOME/bash/.bash_profile"
	;;
esac

for file in $config_files; do
	remove_from_path "$file"
done

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
	read -p "Would you like to remove Watchman as well? [Y/n] " -n 1 -r
	echo -e ""
	if [[ ! $REPLY =~ ^[Nn]$ ]]; then
		if [ "$os" = "darwin" ]; then
			# macOS: use Homebrew
			if command -v brew >/dev/null 2>&1; then
				echo -e "${MUTED}Removing Watchman via Homebrew...${NC}"
				brew uninstall watchman
				echo -e "${MUTED}Watchman removed.${NC}"
			else
				echo -e "${RED}Homebrew not found. Please remove Watchman manually.${NC}"
			fi
		elif [ "$os" = "linux" ]; then
			# Linux ARM64: installed via .deb package
			if [[ "$arch" == "arm64" ]]; then
				if command -v dpkg >/dev/null 2>&1 && dpkg -l watchman >/dev/null 2>&1; then
					echo -e "${MUTED}Removing Watchman via dpkg...${NC}"
					sudo dpkg -r watchman
					echo -e "${MUTED}Watchman removed.${NC}"
				else
					echo -e "${MUTED}Watchman package not found via dpkg.${NC}"
					echo -e "${MUTED}It may have been installed manually or via a different method.${NC}"
				fi
			# Linux x64: installed to /opt/watchman with wrapper in /usr/local/bin
			elif [[ -d "/opt/watchman" ]] || [[ -f "/usr/local/bin/watchman" ]]; then
				echo -e "${MUTED}Removing Watchman...${NC}"
				# Remove the wrapper script
				[[ -f "/usr/local/bin/watchman" ]] && sudo rm -f /usr/local/bin/watchman
				# Remove the main installation directory
				[[ -d "/opt/watchman" ]] && sudo rm -rf /opt/watchman
				# Remove the runtime directory
				[[ -d "/usr/local/var/run/watchman" ]] && sudo rm -rf /usr/local/var/run/watchman
				echo -e "${MUTED}Watchman removed.${NC}"
			else
				echo -e "${MUTED}Watchman installation not found in expected locations.${NC}"
				echo -e "${MUTED}It may have been installed via a package manager.${NC}"
				echo -e "${MUTED}Try: sudo apt remove watchman, sudo dnf remove watchman, or sudo pacman -R watchman${NC}"
			fi
		else
			echo -e "${RED}Unknown OS. Please remove Watchman manually.${NC}"
		fi
	fi
fi

# Note about Linux packages
if [ "$os" = "linux" ]; then
	echo -e ""
	echo -e "${MUTED}Note: The following packages were installed as dependencies and may be${NC}"
	echo -e "${MUTED}used by other applications. Remove them manually if no longer needed:${NC}"
	echo -e "${MUTED}  sudo apt remove libsecret-1-0 libsecret-tools gnome-keyring dbus-x11 jq${NC}"
fi

echo -e ""
