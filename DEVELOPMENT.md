# Development

## Setup

```bash
git clone https://github.com/damianb-bitflipper/proton-drive-sync
cd proton-drive-sync
make install
```

## Running Locally

The canonical way to develop is via the `make dev` command, which runs the app directly with tsx (no build step required):

```bash
make dev ARGS="start"
```

> **Note:** In dev mode, use `Ctrl+C` to stop the process. The `proton-drive-sync stop` command does not work with `make dev` because `tsx watch` keeps the process alive.

## Make Commands

| Command           | Description                               |
| ----------------- | ----------------------------------------- |
| `make install`    | Install dependencies                      |
| `make build`      | Build standalone binary                   |
| `make dev ARGS=…` | Run directly with tsx (no build required) |
| `make pre-commit` | Run lint and format on all files          |
| `make clean`      | Remove build artifacts                    |
| `make db-inspect` | Open Drizzle Studio to inspect database   |

## Publishing

To publish a new version:

1. Update version in `package.json`
2. Create and push a git tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Actions release workflow will automatically build binaries for macOS (arm64 and x64) and create a GitHub release.
