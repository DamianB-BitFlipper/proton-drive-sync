# Proton Drive Sync

Automatically syncs selected local folders to Proton Drive in the background, with a dashboard for monitoring.

<p align="center">
  <img src="readme_assets/home.png" alt="Dashboard" width="600">
</p>

## Getting Started

### Quick Start

#### macOS / Linux

```bash
bash <(curl -fsSL https://www.damianb.dev/proton-drive-sync/install.sh)
```

#### Windows

```powershell
irm https://www.damianb.dev/proton-drive-sync/install.ps1 | iex
```

### Requirements

| Platform    | Requirements                                                |
| ----------- | ----------------------------------------------------------- |
| **macOS**   | [Homebrew](https://brew.sh) (for Watchman)                  |
| **Linux**   | None                                                        |
| **Windows** | [Chocolatey](https://chocolatey.org/install) (for Watchman) |

### Dashboard

The dashboard runs locally at http://localhost:4242. Use it to configure and manage the sync client.

### Supplementary Commands

1. If you need to reauthenticate: `proton-drive-sync auth`

2. If you would like to start the sync client (as a daemon): `proton-drive-sync start`

3. If you would like to stop the sync client: `proton-drive-sync stop`

4. For more advanced commands, see: `proton-drive-sync --help`

### Uninstall

#### macOS / Linux

```bash
bash <(curl -fsSL https://www.damianb.dev/proton-drive-sync/uninstall.sh)
```

#### Windows

```powershell
irm https://www.damianb.dev/proton-drive-sync/uninstall.ps1 | iex
```

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for development setup and contributing guidelines.
