# Proton Drive Sync

Automatically syncs selected local folders to Proton Drive in the background, with a dashboard for monitoring.

<p align="center">

https://github.com/user-attachments/assets/bf1fccac-9a08-4da1-bc0c-2c06d510fbf1

</p>

## Getting Started

### Install: macOS / Linux

```bash
$ bash <(curl -fsSL https://www.damianb.dev/proton-drive-sync/install.sh)
```

<details>
<summary>Install: Windows</summary>

Run the following command in PowerShell:

```powershell
irm https://www.damianb.dev/proton-drive-sync/install.ps1 | iex
```

</details>

<details>
<summary>Install: Docker</summary>

See **[DOCKER_SETUP.md](DOCKER_SETUP.md)** for running with Docker Compose on Linux x86_64 and ARM64.

Quick start:

```bash
cd docker/
cp .env.example .env
# Edit .env with KEYRING_PASSWORD and sync directory paths
docker compose up -d
docker exec -it proton-drive-sync proton-drive-sync auth
```

</details>

### Platform Support

| Platform            | Requirements                                                |
| ------------------- | ----------------------------------------------------------- |
| **macOS**           | [Homebrew](https://brew.sh) (for Watchman)                  |
| **Linux** (beta)    | No extra requirements                                       |
| **Windows** (alpha) | [Chocolatey](https://chocolatey.org/install) (for Watchman) |
| **Docker**          | Docker Engine 20.10+, Docker Compose v2.0+                  |

### Dashboard

The dashboard runs locally at http://localhost:4242. Use it to configure and manage the sync client.

### Supplementary Commands

1. If you need to reauthenticate: `proton-drive-sync auth`

2. If you would like to start the sync client (as a daemon): `proton-drive-sync start`

3. If you would like to stop the sync client: `proton-drive-sync stop`

4. For more advanced commands, see: `proton-drive-sync --help`

### Uninstall: macOS / Linux

```bash
$ bash <(curl -fsSL https://www.damianb.dev/proton-drive-sync/uninstall.sh)
```

<details>
<summary>Uninstall: Windows</summary>

Run the following command in PowerShell:

```powershell
irm https://www.damianb.dev/proton-drive-sync/uninstall.ps1 | iex
```

</details>

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for development setup and contributing guidelines.
