# Proton Drive Sync

Automatically syncs selected local folders to Proton Drive in the background, with a dashboard for monitoring.

<p align="center">

https://github.com/user-attachments/assets/bf1fccac-9a08-4da1-bc0c-2c06d510fbf1

</p>

## Installation

### macOS (Homebrew)

```bash
brew tap DamianB-BitFlipper/tap
brew update
brew install proton-drive-sync

proton-drive-sync setup
```

### Debian / Ubuntu

Download the `.deb` file for your architecture from [GitHub Releases](https://github.com/DamianB-BitFlipper/proton-drive-sync/releases).

```bash
sudo apt update
sudo apt install libsecret-1-0
sudo dpkg -i <downloaded.deb>

proton-drive-sync setup
```

### Fedora / RHEL / CentOS

Download the `.rpm` file for your architecture from [GitHub Releases](https://github.com/DamianB-BitFlipper/proton-drive-sync/releases).

```bash
sudo dnf update
sudo dnf install libsecret
sudo dnf install ./<downloaded.rpm>

proton-drive-sync setup
```

### Arch Linux (AUR)

On Arch Linux and derivatives, install from the [AUR package](https://aur.archlinux.org/packages/proton-drive-sync-bin):

```bash
yay -S proton-drive-sync-bin
# alternatively using paru
paru -S proton-drive-sync-bin
# or use your preferred AUR helper
```

<details>
<summary>Other Linux</summary>

Download the Linux tarball from [GitHub Releases](https://github.com/DamianB-BitFlipper/proton-drive-sync/releases/latest):

```bash
tar -xzf proton-drive-sync-linux-x64.tar.gz
sudo mv proton-drive-sync /usr/local/bin/
proton-drive-sync setup
```

</details>

<details>
<summary>Windows (alpha)</summary>

Download the `.zip` from [GitHub Releases](https://github.com/DamianB-BitFlipper/proton-drive-sync/releases/latest), extract, and add to your PATH.

</details>

<details>
<summary>Docker (WIP)</summary>

See **[DOCKER_SETUP.md](DOCKER_SETUP.md)** for running with Docker Compose on Linux x86_64 and ARM64.

```bash
cd docker/
cp .env.example .env
# Edit .env with KEYRING_PASSWORD and sync directory paths
docker compose up -d
docker exec -it proton-drive-sync proton-drive-sync auth
```

</details>

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

---

<a href="https://www.buymeacoffee.com/thebitflipper" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50">
</a>
