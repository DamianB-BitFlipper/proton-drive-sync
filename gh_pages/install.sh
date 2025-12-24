#!/usr/bin/env bash
set -euo pipefail
APP=proton-drive-sync
REPO="damianb-bitflipper/proton-drive-sync"

MUTED='\033[0;2m'
RED='\033[0;31m'
ORANGE='\033[38;5;214m'
NC='\033[0m' # No Color

usage() {
    cat <<EOF
Proton Drive Sync Installer

Usage: install [options]

Options:
    -h, --help              Display this help message
    -v, --version <version> Install a specific version (e.g., 0.1.0)
        --no-modify-path    Don't modify shell config files (.zshrc, .bashrc, etc.)

Examples:
    curl -fsSL https://raw.githubusercontent.com/$REPO/main/install | bash
    curl -fsSL https://raw.githubusercontent.com/$REPO/main/install | bash -s -- --version 0.1.0
EOF
}

requested_version=${VERSION:-}
no_modify_path=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        -v|--version)
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
  MINGW*|MSYS*|CYGWIN*) os="windows" ;;
esac

arch=$(uname -m)
if [[ "$arch" == "aarch64" ]]; then
  arch="arm64"
fi
if [[ "$arch" == "x86_64" ]]; then
  arch="x64"
fi

if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
  rosetta_flag=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)
  if [ "$rosetta_flag" = "1" ]; then
    arch="arm64"
  fi
fi

if [ "$os" != "darwin" ]; then
    echo -e "${RED}Error: proton-drive-sync is only supported on macOS${NC}"
    exit 1
fi

combo="$os-$arch"
case "$combo" in
  darwin-x64|darwin-arm64)
    ;;
  *)
    echo -e "${RED}Unsupported architecture: $arch${NC}"
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

# Check for Homebrew
if ! command -v brew >/dev/null 2>&1; then
    echo -e "${RED}Error: Homebrew is required but not installed.${NC}"
    echo -e "Install it from: https://brew.sh"
    exit 1
fi

# Install Watchman if not present
if ! command -v watchman >/dev/null 2>&1; then
    echo -e "${MUTED}Installing Watchman...${NC}"
    brew update
    brew install watchman
fi

INSTALL_DIR=$HOME/.local/bin
mkdir -p "$INSTALL_DIR"

if [ -z "$requested_version" ]; then
    url="https://github.com/$REPO/releases/latest/download/$filename"
    specific_version=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')

    if [[ $? -ne 0 || -z "$specific_version" ]]; then
        echo -e "${RED}Failed to fetch version information${NC}"
        exit 1
    fi
else
    url="https://github.com/$REPO/releases/download/v${requested_version}/$filename"
    specific_version=$requested_version
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

check_version() {
    if command -v proton-drive-sync >/dev/null 2>&1; then
        installed_version=$(proton-drive-sync --version 2>/dev/null || echo "0.0.0")
        installed_version=$(echo "$installed_version" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "0.0.0")

        if [[ "$installed_version" != "$specific_version" ]]; then
            print_message info "${MUTED}Installed version: ${NC}$installed_version"
        else
            print_message info "${MUTED}Version ${NC}$specific_version${MUTED} already installed${NC}"
            exit 0
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
download_and_install

add_to_path() {
    local config_file=$1
    local command=$2

    if grep -Fxq "$command" "$config_file"; then
        print_message info "Command already exists in $config_file, skipping write."
    elif [[ -w $config_file ]]; then
        echo -e "\n# proton-drive-sync" >> "$config_file"
        echo "$command" >> "$config_file"
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
            zsh|bash|ash|sh)
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

if [ -n "${GITHUB_ACTIONS-}" ] && [ "${GITHUB_ACTIONS}" == "true" ]; then
    echo "$INSTALL_DIR" >> "$GITHUB_PATH"
    print_message info "Added $INSTALL_DIR to \$GITHUB_PATH"
fi

echo -e ""
echo -e "${MUTED}Proton Drive Sync${NC} installed successfully!"
echo -e ""
echo -e "${MUTED}To get started:${NC}"
echo -e ""
echo -e "  proton-drive-sync auth     ${MUTED}# Authenticate with Proton${NC}"
echo -e "  proton-drive-sync start    ${MUTED}# Start syncing${NC}"
echo -e ""
echo -e "${MUTED}For more information:${NC} https://github.com/$REPO"
echo -e ""
