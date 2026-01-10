# Development

## Requirements

- [Bun](https://bun.sh) - JavaScript runtime and package manager

## Setup

```bash
git clone https://github.com/damianb-bitflipper/proton-drive-sync
cd proton-drive-sync
make install
```

## Running Locally

The canonical way to develop is via the `make dev` command, which runs the app directly with bun in watch mode (auto-reload on file changes):

```bash
make dev
```

This runs `start --no-daemon` automatically. Use `Ctrl+C` to stop.

For one-off commands (like service install), use `make run`:

```bash
make run ARGS="service install"
```

## Make Commands

| Command           | Description                             |
| ----------------- | --------------------------------------- |
| `make install`    | Install dependencies                    |
| `make dev ARGS=…` | Run with auto-reload on file changes    |
| `make run ARGS=…` | Run one-off commands (builds first)     |
| `make pre-commit` | Run lint, format, and type-check        |
| `make db-inspect` | Open Drizzle Studio to inspect database |
| `make help`       | Show all available commands             |

## Publishing

To publish a new version:

1. Update version in `package.json`
2. Create a new release with the respective tag

The GitHub Actions release workflow will automatically build binaries for all platforms.

## Installing Pre-release Versions

Pre-release packages (`proton-drive-sync-prerelease`) allow you to test upcoming features before stable release. They conflict with the stable package, so only one can be installed at a time.

### macOS (Homebrew)

```bash
brew tap DamianB-BitFlipper/tap
brew install proton-drive-sync-prerelease
```

### Debian / Ubuntu

```bash
# Download GPG key (if not already added)
sudo curl -fsSL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x832B348E3FF2D4F3" -o /usr/share/keyrings/proton-drive-sync.asc

# Add repository (if not already added)
echo "deb [signed-by=/usr/share/keyrings/proton-drive-sync.asc] https://repo.damianb.dev/apt/ /" | sudo tee /etc/apt/sources.list.d/proton-drive-sync.list
sudo apt update

# Install prerelease
sudo apt install proton-drive-sync-prerelease
```

### Fedora / RHEL / CentOS

```bash
# Add repository (if not already added)
sudo tee /etc/yum.repos.d/proton-drive-sync.repo << 'EOF'
[proton-drive-sync]
name=Proton Drive Sync
baseurl=https://repo.damianb.dev/yum/
enabled=1
gpgcheck=1
gpgkey=https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x832B348E3FF2D4F3
EOF

# Install prerelease
sudo dnf install proton-drive-sync-prerelease
```

### Manual Installation

Download the pre-release tarball for your platform from [GitHub Releases](https://github.com/DamianB-BitFlipper/proton-drive-sync/releases) and extract it:

```bash
# Example for macOS arm64
tar -xzf proton-drive-sync-darwin-arm64.tar.gz
sudo mv proton-drive-sync /usr/local/bin/
```

### Switching Between Stable and Pre-release

The packages conflict with each other, so installing one will automatically remove the other:

```bash
# Switch to prerelease
sudo apt install proton-drive-sync-prerelease

# Switch back to stable
sudo apt install proton-drive-sync
```
