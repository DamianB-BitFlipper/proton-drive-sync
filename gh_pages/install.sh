#!/usr/bin/env bash
set -euo pipefail
APP=proton-drive-sync
REPO="damianb-bitflipper/proton-drive-sync"
ASSETS_URL="https://www.damianb.dev/proton-drive-sync"

MUTED='\033[0;2m'
RED='\033[0;31m'
GREEN='\033[0;32m'
ORANGE='\033[38;5;214m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

show_banner() {
	echo -e "${CYAN}"
	cat <<'EOF'
  ____            _                ____       _              ____                   
 |  _ \ _ __ ___ | |_ ___  _ __   |  _ \ _ __(_)_   _____   / ___| _   _ _ __   ___ 
 | |_) | '__/ _ \| __/ _ \| '_ \  | | | | '__| \ \ / / _ \  \___ \| | | | '_ \ / __|
 |  __/| | | (_) | || (_) | | | | | |_| | |  | |\ V /  __/   ___) | |_| | | | | (__ 
 |_|   |_|  \___/ \__\___/|_| |_| |____/|_|  |_| \_/ \___|  |____/ \__, |_| |_|\___|
                                                                   |___/            
EOF
	echo -e "${NC}"
}

usage() {
	cat <<EOF
Proton Drive Sync Installer

Usage: install [options]

Options:
    -h, --help              Display this help message
    -v, --version <version> Install a specific version (e.g., v0.1.0)
        --no-modify-path    Don't modify shell config files (.zshrc, .bashrc, etc.)

Examples:
    bash <(curl -fsSL $ASSETS_URL/install.sh)
    bash <(curl -fsSL $ASSETS_URL/install.sh) --version v0.1.0
EOF
}

requested_version=${VERSION:-}
no_modify_path=false

while [[ $# -gt 0 ]]; do
	case "$1" in
	-h | --help)
		usage
		exit 0
		;;
	-v | --version)
		if [[ -n "${2:-}" ]]; then
			requested_version="$2"
			shift 2
		else
			echo -e "${RED}Error: --version requires a version argument${NC}"
			exit 1
		fi
		;;
	--no-modify-path)
		no_modify_path=true
		shift
		;;
	*)
		echo -e "${ORANGE}Warning: Unknown option '$1'${NC}" >&2
		shift
		;;
	esac
done

raw_os=$(uname -s)
os=$(echo "$raw_os" | tr '[:upper:]' '[:lower:]')
case "$raw_os" in
Darwin*) os="darwin" ;;
Linux*) os="linux" ;;
MINGW* | MSYS* | CYGWIN*) os="windows" ;;
esac

arch=$(uname -m)
if [[ "$arch" == "aarch64" ]]; then
	arch="arm64"
fi
if [[ "$arch" == "x86_64" ]]; then
	arch="x64"
fi

# Rosetta detection (macOS only)
show_banner
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
	rosetta_flag=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)
	if [ "$rosetta_flag" = "1" ]; then
		arch="arm64"
	fi
fi

# Validate OS/arch combination
combo="$os-$arch"
case "$combo" in
darwin-x64 | darwin-arm64 | linux-x64 | linux-arm64) ;;
*)
	echo -e "${RED}Unsupported platform: $combo${NC}"
	echo -e "${MUTED}Supported platforms: macOS (x64, arm64), Linux (x64, arm64)${NC}"
	exit 1
	;;
esac

archive_ext=".tar.gz"

target="$os-$arch"
filename="$APP-$target$archive_ext"

if ! command -v tar >/dev/null 2>&1; then
	echo -e "${RED}Error: 'tar' is required but not installed.${NC}"
	exit 1
fi

# ============================================================================
# Install Watchman
# ============================================================================

install_watchman_macos() {
	# Check for Homebrew
	if ! command -v brew >/dev/null 2>&1; then
		echo -e "${RED}Error: Homebrew is required but not installed.${NC}"
		echo -e "Install it from: https://brew.sh"
		exit 1
	fi

	echo -e "${MUTED}Installing Watchman via Homebrew...${NC}"
	brew update
	brew install watchman

	# Install jq for JSON parsing if not present
	if ! command -v jq >/dev/null 2>&1; then
		echo -e "${MUTED}Installing jq...${NC}"
		brew install jq
	fi
}

install_watchman_linux() {
	# Check architecture for arm64-specific installation
	local machine_arch
	machine_arch=$(uname -m)

	if [[ "$machine_arch" == "aarch64" || "$machine_arch" == "arm64" ]]; then
		# ARM64 requires Debian-based system for .deb installation
		if ! command -v dpkg >/dev/null 2>&1; then
			echo -e "${RED}Error: Linux ARM64 is only supported on Debian-based distributions${NC}"
			echo -e "${MUTED}The Watchman package is provided as a .deb file${NC}"
			exit 1
		fi

		echo -e "${MUTED}Installing Watchman for ARM64 via .deb package...${NC}"

		# Install dependencies first to avoid dpkg error messages
		echo -e "${MUTED}Installing Watchman dependencies...${NC}"
		sudo apt-get update
		sudo apt-get install -y libgoogle-glog-dev libboost-all-dev libgflags-dev libevent-dev libdouble-conversion-dev libssl-dev libsnappy1v5 libzstd1 liblz4-1 libunwind8

		local tmp_dir
		tmp_dir=$(mktemp -d)
		local deb_url="$ASSETS_URL/watchman_2025.12.28.00_arm64.deb"

		curl -L -o "$tmp_dir/watchman.deb" "$deb_url"
		sudo dpkg -i "$tmp_dir/watchman.deb"

		rm -rf "$tmp_dir"

		echo -e "${MUTED}Watchman installed successfully${NC}"
		return
	fi

	echo -e "${MUTED}Installing Watchman from Facebook releases...${NC}"

	# Detect package manager and install dependencies
	if command -v apt-get >/dev/null 2>&1; then
		echo -e "${MUTED}Installing dependencies (curl, unzip)...${NC}"
		sudo apt-get update
		sudo apt-get install -y curl unzip
	elif command -v dnf >/dev/null 2>&1; then
		echo -e "${MUTED}Installing dependencies (curl, unzip)...${NC}"
		sudo dnf install -y curl unzip
	elif command -v pacman >/dev/null 2>&1; then
		echo -e "${MUTED}Installing dependencies (curl, unzip)...${NC}"
		sudo pacman -Sy --noconfirm curl unzip
	fi

	# Get latest version from GitHub API
	local version
	version=$(curl -s https://api.github.com/repos/facebook/watchman/releases/latest | grep '"tag_name"' | cut -d'"' -f4)

	if [[ -z "$version" ]]; then
		echo -e "${RED}Error: Failed to determine latest Watchman version${NC}"
		exit 1
	fi

	echo -e "${MUTED}Downloading Watchman ${version}...${NC}"

	local url="https://github.com/facebook/watchman/releases/download/${version}/watchman-${version}-linux.zip"
	local tmp_dir
	tmp_dir=$(mktemp -d)

	curl -L -o "$tmp_dir/watchman.zip" "$url"
	unzip -q "$tmp_dir/watchman.zip" -d "$tmp_dir"

	# Find the extracted directory (name varies with version)
	local watchman_dir
	watchman_dir=$(find "$tmp_dir" -maxdepth 1 -type d -name "watchman-*" | head -1)

	if [[ -z "$watchman_dir" ]]; then
		echo -e "${RED}Error: Failed to extract Watchman${NC}"
		rm -rf "$tmp_dir"
		exit 1
	fi

	# Install to /opt/watchman to keep libraries isolated from system
	# This prevents conflicts with system libraries (e.g., liblzma) that can break dpkg/apt
	echo -e "${MUTED}Installing Watchman to /opt/watchman...${NC}"
	sudo rm -rf /opt/watchman
	sudo mkdir -p /opt/watchman /usr/local/var/run/watchman
	sudo cp -r "$watchman_dir"/* /opt/watchman/
	sudo chmod 755 /opt/watchman/bin/watchman
	sudo chmod 2777 /usr/local/var/run/watchman

	# Create wrapper script in /usr/local/bin that sets LD_LIBRARY_PATH
	# This ensures Watchman uses its bundled libraries without polluting system library path
	sudo tee /usr/local/bin/watchman >/dev/null <<'WRAPPER'
#!/bin/bash
export LD_LIBRARY_PATH="/opt/watchman/lib:$LD_LIBRARY_PATH"
exec /opt/watchman/bin/watchman "$@"
WRAPPER
	sudo chmod 755 /usr/local/bin/watchman

	rm -rf "$tmp_dir"

	echo -e "${MUTED}Watchman installed successfully${NC}"
}

install_watchman() {
	if command -v watchman >/dev/null 2>&1; then
		echo -e "${MUTED}Watchman is already installed${NC}"
		return
	fi

	if [ "$os" = "darwin" ]; then
		install_watchman_macos
	elif [ "$os" = "linux" ]; then
		install_watchman_linux
	fi

	# Verify installation
	if ! command -v watchman >/dev/null 2>&1; then
		echo -e "${RED}Error: Watchman installation failed${NC}"
		exit 1
	fi
}

# ============================================================================
# Install dependencies (Linux only)
# ============================================================================

install_linux_dependencies() {
	if [ "$os" != "linux" ]; then
		return
	fi

	echo -e "${MUTED}Installing dependencies (libsecret, jq)...${NC}"

	if command -v apt-get >/dev/null 2>&1; then
		sudo apt-get update
		sudo apt-get install -y libsecret-1-0 jq
	elif command -v dnf >/dev/null 2>&1; then
		sudo dnf install -y libsecret jq
	elif command -v pacman >/dev/null 2>&1; then
		sudo pacman -Sy --noconfirm libsecret jq
	else
		echo -e "${ORANGE}Warning: Could not install dependencies automatically${NC}"
		echo -e "${MUTED}Please install libsecret and jq manually${NC}"
	fi
}

# Install Watchman first
install_watchman

# Install Linux dependencies (libsecret, gnome-keyring, dbus-x11, jq) before any proton-drive-sync commands
# These are required for the binary to even start on Linux
install_linux_dependencies

INSTALL_DIR=$HOME/.local/bin
mkdir -p "$INSTALL_DIR"

if [ -z "$requested_version" ]; then
	url="https://github.com/$REPO/releases/latest/download/$filename"
	# Extract version from redirect URL to avoid GitHub API rate limits
	redirect_url=$(curl -sIL -o /dev/null -w "%{url_effective}" "https://github.com/$REPO/releases/latest" 2>/dev/null)
	specific_version=$(echo "$redirect_url" | sed -n 's|.*/tag/v\([^/]*\)$|\1|p')

	if [[ -z "$specific_version" ]]; then
		echo -e "${RED}Failed to fetch version information${NC}"
		echo -e "${MUTED}Could not determine latest version from: $redirect_url${NC}"
		echo -e "${MUTED}Try specifying a version manually: --version 0.1.0${NC}"
		exit 1
	fi
else
	# Validate version format (must start with 'v')
	if [[ ! "$requested_version" =~ ^v[0-9] ]]; then
		echo -e "${RED}Error: Version must start with 'v' (e.g., v0.1.0)${NC}"
		exit 1
	fi
	url="https://github.com/$REPO/releases/download/${requested_version}/$filename"
	specific_version=${requested_version#v}
fi

print_message() {
	local level=$1
	local message=$2
	local color=""

	case $level in
	info) color="${NC}" ;;
	warning) color="${NC}" ;;
	error) color="${RED}" ;;
	esac

	echo -e "${color}${message}${NC}"
}

skip_download=false

check_version() {
	if [ -x "$INSTALL_DIR/proton-drive-sync" ]; then
		installed_version=$("$INSTALL_DIR/proton-drive-sync" --version 2>/dev/null || echo "0.0.0")
		installed_version=$(echo "$installed_version" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "0.0.0")

		if [[ "$installed_version" != "$specific_version" ]]; then
			print_message info "${MUTED}Installed version: ${NC}$installed_version"
		else
			print_message info "${MUTED}Version ${NC}$specific_version${MUTED} already installed${NC}"
			skip_download=true
		fi
	fi
}

download_and_install() {
	print_message info "\n${MUTED}Installing ${NC}proton-drive-sync ${MUTED}version: ${NC}$specific_version"
	local tmp_dir="${TMPDIR:-/tmp}/proton_drive_sync_install_$$"
	mkdir -p "$tmp_dir"

	curl -# -L -o "$tmp_dir/$filename" "$url"

	tar -xzf "$tmp_dir/$filename" -C "$tmp_dir"

	mv "$tmp_dir/proton-drive-sync" "$INSTALL_DIR/"
	chmod 755 "${INSTALL_DIR}/proton-drive-sync"
	rm -rf "$tmp_dir"
}

check_version
if [[ "$skip_download" != "true" ]]; then
	download_and_install
fi

add_to_path() {
	local config_file=$1
	local command=$2

	if grep -Fxq "$command" "$config_file"; then
		print_message info "Command already exists in $config_file, skipping write."
	elif [[ -w $config_file ]]; then
		echo -e "\n# proton-drive-sync" >>"$config_file"
		echo "$command" >>"$config_file"
		print_message info "${MUTED}Successfully added ${NC}proton-drive-sync ${MUTED}to \$PATH in ${NC}$config_file"
	else
		print_message warning "Manually add the directory to $config_file (or similar):"
		print_message info "  $command"
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

if [[ "$no_modify_path" != "true" ]]; then
	config_file=""
	for file in $config_files; do
		if [[ -f $file ]]; then
			config_file=$file
			break
		fi
	done

	if [[ -z $config_file ]]; then
		print_message warning "No config file found for $current_shell. You may need to manually add to PATH:"
		print_message info "  export PATH=$INSTALL_DIR:\$PATH"
	elif [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
		case $current_shell in
		fish)
			add_to_path "$config_file" "fish_add_path $INSTALL_DIR"
			;;
		zsh | bash | ash | sh)
			add_to_path "$config_file" "export PATH=$INSTALL_DIR:\$PATH"
			;;
		*)
			export PATH=$INSTALL_DIR:$PATH
			print_message warning "Manually add the directory to $config_file (or similar):"
			print_message info "  export PATH=$INSTALL_DIR:\$PATH"
			;;
		esac
	fi
fi

# Verify proton-drive-sync is found
if [ ! -x "$INSTALL_DIR/proton-drive-sync" ]; then
	echo -e "${RED}Error: proton-drive-sync not found at $INSTALL_DIR after installation${NC}"
	exit 1
fi

echo -e ""
echo -e "${MUTED}Proton Drive Sync${NC} installed successfully!"
echo -e ""

# ============================================================================
# Remote Dashboard Configuration (config only, no keyring setup)
# ============================================================================

echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${CYAN}Remote Dashboard Access${NC}"
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e ""
echo -e "  The dashboard is available at ${NC}localhost:4242${MUTED} by default.${NC}"
echo -e ""
echo -e "  For headless/server installs, you can enable remote access by binding"
echo -e "  the web interface to all network interfaces (0.0.0.0:4242)."
echo -e ""
echo -e "  ${ORANGE}WARNING: This exposes the dashboard to your network.${NC}"
echo -e "  ${MUTED}The dashboard allows service control and configuration changes.${NC}"
echo -e "  ${MUTED}Only enable this on trusted networks or behind a firewall.${NC}"
echo -e ""
read -p "  Enable remote dashboard access? [y/N]: " remote_choice

DASHBOARD_HOST="127.0.0.1"
if [[ "$remote_choice" =~ ^[Yy]$ ]]; then
	DASHBOARD_HOST="0.0.0.0"
	echo -e ""
	echo -e "  ${MUTED}Enabling remote dashboard access...${NC}"
	"$INSTALL_DIR/proton-drive-sync" config --set dashboard_host=0.0.0.0
else
	echo -e ""
	echo -e "  ${MUTED}Keeping dashboard local-only (localhost:4242)...${NC}"
	"$INSTALL_DIR/proton-drive-sync" config --set dashboard_host=127.0.0.1
fi

# ============================================================================
# Service Installation (before auth on Linux to set up keyring)
# ============================================================================

echo -e ""
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${CYAN}Service Installation${NC}"
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e ""

SERVICE_INSTALLED=false

if [ "$os" = "linux" ]; then
	echo -e "  When should the sync service start?"
	echo -e ""
	echo -e "    ${CYAN}1)${NC} On login (user service) - runs when you log in"
	echo -e "    ${CYAN}2)${NC} On boot (system service) - runs at system startup ${MUTED}(requires sudo)${NC}"
	echo -e ""
	read -p "  Choice [1/2]: " service_choice

	if [ "$service_choice" = "2" ]; then
		echo -e ""
		echo -e "  ${MUTED}Installing system service (requires sudo)...${NC}"
		sudo "$INSTALL_DIR/proton-drive-sync" service install --install-scope=system
	else
		echo -e ""
		echo -e "  ${MUTED}Installing user service...${NC}"
		"$INSTALL_DIR/proton-drive-sync" service install
	fi
	SERVICE_INSTALLED=true
else
	# macOS/Windows - only user scope supported
	read -p "  Start sync service automatically on login? [Y/n]: " login_choice

	if [[ ! "$login_choice" =~ ^[Nn]$ ]]; then
		echo -e ""
		echo -e "  ${MUTED}Installing service...${NC}"
		"$INSTALL_DIR/proton-drive-sync" service install
		SERVICE_INSTALLED=true
	else
		echo -e ""
		echo -e "  ${MUTED}Skipping automatic startup.${NC}"
		echo -e "  ${MUTED}You can enable it later with: proton-drive-sync service install${NC}"
	fi
fi

# ============================================================================
# Authentication
# ============================================================================

echo -e ""
echo -e "${MUTED}Starting authentication...${NC}"
echo -e ""

# On Linux, set KEYRING_PASSWORD for file-based credential storage
# This must match the hardcoded password in the service file
if [ "$os" = "linux" ]; then
	export KEYRING_PASSWORD="proton-drive-sync"
fi

if ! "$INSTALL_DIR/proton-drive-sync" auth; then
	echo -e ""
	echo -e "${RED}Authentication failed or was cancelled.${NC}"
	echo -e "${MUTED}Run the install command again to retry.${NC}"
	exit 1
fi

# Open browser (platform-specific)
open_browser() {
	local url="$1"
	if [ "$os" = "darwin" ]; then
		open "$url"
	elif [ "$os" = "linux" ]; then
		if command -v xdg-open >/dev/null 2>&1; then
			xdg-open "$url" 2>/dev/null || echo -e "${MUTED}Open $url in your browser${NC}"
		else
			echo -e "${MUTED}Open $url in your browser${NC}"
		fi
	fi
}

# Wait for service to be ready
echo -e ""
echo -e "${MUTED}Waiting for service to start...${NC}"
max_attempts=30
attempt=0
port=4242
status=""

while [ $attempt -lt $max_attempts ]; do
	if status_json=$("$INSTALL_DIR/proton-drive-sync" status 2>/dev/null); then
		status=$(echo "$status_json" | jq -r '.status' 2>/dev/null) || true
		port=$(echo "$status_json" | jq -r '.port' 2>/dev/null) || true
		if [ "$status" = "running" ]; then
			break
		fi
	fi
	sleep 1
	attempt=$((attempt + 1))
done

if [ "$status" = "running" ]; then
	echo -e "${GREEN}✔${NC} Service started successfully"
	echo -e ""
	if [ "$DASHBOARD_HOST" != "0.0.0.0" ]; then
		echo -e "${MUTED}Opening dashboard...${NC}"
		open_browser "http://localhost:${port:-4242}"
	fi
else
	echo -e "${RED}Warning: Service did not start within 30 seconds${NC}"
	echo -e "${MUTED}Check logs with: proton-drive-sync logs${NC}"
fi

echo -e ""
echo -e "${MUTED}Complete your configuration by visiting the dashboard at:${NC}"
echo -e ""
if [ "$DASHBOARD_HOST" = "0.0.0.0" ]; then
	# Try to get local IP address
	if [ "$os" = "darwin" ]; then
		LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "your-server-ip")
	else
		LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "your-server-ip")
	fi
	echo -e "  http://${LOCAL_IP}:4242"
	echo -e "  ${MUTED}(Also accessible at http://localhost:4242 on this machine)${NC}"
else
	echo -e "  http://localhost:4242"
fi
echo -e ""
