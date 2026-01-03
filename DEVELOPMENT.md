# Development

## Requirements

Run the install script first (see README) to install Watchman and other system dependencies. The install script is only needed to set up the required dependencies, so it can be exited before completion.

### Additional requirements

- [pywatchman](https://pypi.org/project/pywatchman/) (`pip install pywatchman`) - required on Linux and Windows for `make dev`

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

| Command           | Description                                       |
| ----------------- | ------------------------------------------------- |
| `make install`    | Install dependencies                              |
| `make build`      | Build standalone binary to `./dist`               |
| `make dev`        | Run `start --no-daemon` with bun (auto-reload)    |
| `make run ARGS=…` | Run one-off commands with bun (exits on complete) |
| `make pre-commit` | Run lint and format on all files                  |
| `make clean`      | Remove build artifacts                            |
| `make db-inspect` | Open Drizzle Studio to inspect database           |

## Publishing

To publish a new version:

1. Update version in `package.json`
2. Create and push a git tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Actions release workflow will automatically build binaries for macOS (arm64 and x64) and create a GitHub release.
