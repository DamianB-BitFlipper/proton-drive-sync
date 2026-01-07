# Proton Drive Sync

Automatically syncs selected local folders to Proton Drive in the background, with a dashboard for monitoring.

<p align="center">

https://github.com/user-attachments/assets/bf1fccac-9a08-4da1-bc0c-2c06d510fbf1

</p>

## Installation

### macOS (Homebrew)

```bash
brew tap DamianB-BitFlipper/tap
brew install proton-drive-sync
proton-drive-sync setup
```

### Debian / Ubuntu

Download the `.deb` package from [GitHub Releases](https://github.com/DamianB-BitFlipper/proton-drive-sync/releases/latest):

```bash
# Download the .deb for your architecture (amd64 or arm64), then:
sudo apt install ./proton-drive-sync_*.deb
proton-drive-sync setup
```

### Fedora / RHEL / CentOS

Download the `.rpm` package from [GitHub Releases](https://github.com/DamianB-BitFlipper/proton-drive-sync/releases/latest):

```bash
# Download the .rpm for your architecture (x86_64 or aarch64), then:
sudo dnf install ./proton-drive-sync-*.rpm
proton-drive-sync setup
```

### Other Linux

Download the Linux tarball from [GitHub Releases](https://github.com/DamianB-BitFlipper/proton-drive-sync/releases/latest):

```bash
tar -xzf proton-drive-sync-linux-x64.tar.gz
sudo mv proton-drive-sync /usr/local/bin/
proton-drive-sync setup
```

### Windows

Download the `.zip` from [GitHub Releases](https://github.com/DamianB-BitFlipper/proton-drive-sync/releases/latest), extract, and add to your PATH.

### Docker (WIP)

See **[DOCKER_SETUP.md](DOCKER_SETUP.md)** for running with Docker Compose on Linux x86_64 and ARM64.

```bash
cd docker/
cp .env.example .env
# Edit .env with KEYRING_PASSWORD and sync directory paths
docker compose up -d
docker exec -it proton-drive-sync proton-drive-sync auth
```

## Supported Platforms

- macOS
- Linux
- Windows (alpha)
- Docker (WIP)

## Usage

### Dashboard

The dashboard runs locally at http://localhost:4242. Use it to configure and manage the sync client.

### Commands

| Command                    | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `proton-drive-sync setup`  | Interactive setup wizard (recommended for first run) |
| `proton-drive-sync auth`   | Authenticate with Proton                             |
| `proton-drive-sync start`  | Start the sync daemon                                |
| `proton-drive-sync stop`   | Stop the sync daemon                                 |
| `proton-drive-sync status` | Show sync status                                     |
| `proton-drive-sync --help` | Show all available commands                          |

### Uninstall

To completely remove proton-drive-sync and all its data:

```bash
proton-drive-sync reset --purge
```

This will stop the service, remove credentials, and delete all configuration and sync history.

For package managers:

- **Homebrew**: `brew uninstall proton-drive-sync`
- **Debian/Ubuntu**: `sudo apt remove proton-drive-sync`
- **Fedora/RHEL**: `sudo dnf remove proton-drive-sync`

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for development setup and contributing guidelines.
