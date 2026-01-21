# Docker Setup

Run Proton Drive Sync in Docker with support for Linux x86_64 and ARM64.

## Prerequisites

- Docker Engine 20.10+
- Docker Compose v2.0+

## Quick Start

1. **Clone and configure**

   ```bash
   cd docker/
   cp .env.example .env
   ```

2. **Edit `.env`** with your settings:

   ```bash
   # Generate a secure encryption key
   openssl rand -base64 32

   # Add it to .env as KEYRING_PASSWORD
   # Optionally add KEYCHAIN_BACKEND=file to skip native keyrings inside the container
   # Set your sync directory paths (host paths)
   SYNC_DIR_1=/path/to/documents
   SYNC_DIR_2=/path/to/photos
   ```

3. **Start the container**

   ```bash
   docker compose up -d
   ```

4. **Authenticate with Proton**

   ```bash
   docker exec -it proton-drive-sync proton-drive-sync auth
   ```

   Follow the prompts to enter your Proton credentials and 2FA code if enabled.

5. **Configure sync directories**

   Open the dashboard at http://localhost:4242 and add your sync directories:
   - `/data/documents` → Your Proton Drive folder (e.g., `/Backup/Documents`)
   - `/data/photos` → Another Proton Drive folder (e.g., `/Backup/Photos`)

## Configuration

### Environment Variables

| Variable           | Required | Default            | Description                       |
| ------------------ | -------- | ------------------ | --------------------------------- |
| `KEYRING_PASSWORD` | Yes      | -                  | Encryption key for credentials    |
| `KEYCHAIN_BACKEND` | No       | `auto` (recommended: `file`) | Force file-based credential store |
| `TZ`               | No       | `UTC`              | Container timezone                |
| `DASHBOARD_PORT`   | No       | `4242`             | Dashboard port on host            |
| `SYNC_DIR_1`       | No       | `./data/documents` | First sync directory (host path)  |
| `SYNC_DIR_2`       | No       | `./data/photos`    | Second sync directory (host path) |

### Adding More Sync Directories

1. Edit `docker-compose.yml` to add more volume mounts:

   ```yaml
   volumes:
     - ${SYNC_DIR_3:-./data/videos}:/data/videos
   ```

2. Add the corresponding variable to your `.env`:

   ```bash
   SYNC_DIR_3=/path/to/videos
   ```

3. Restart the container and configure the new directory in the dashboard.

## Commands

```bash
# View logs
docker compose logs -f

# Check sync status
docker exec proton-drive-sync proton-drive-sync status

# Pause sync
docker exec proton-drive-sync proton-drive-sync pause

# Resume sync
docker exec proton-drive-sync proton-drive-sync resume

# View detailed logs
docker exec proton-drive-sync proton-drive-sync logs

# Stop container
docker compose down

# Rebuild after updates
docker compose build --no-cache
docker compose up -d
```

## Using Pre-built Images

Instead of building locally, pull from GitHub Container Registry:

```bash
# Pull the latest image
docker pull ghcr.io/damianb-bitflipper/proton-drive-sync:latest

# Or a specific version
docker pull ghcr.io/damianb-bitflipper/proton-drive-sync:1.0.0
```

Update your `docker-compose.yml` to use the pre-built image:

```yaml
services:
  proton-drive-sync:
    image: ghcr.io/damianb-bitflipper/proton-drive-sync:latest
    # Remove the 'build:' section
```

## Building Locally

```bash
# Build for your current architecture
cd docker/
docker compose build

# Build with no cache (after code changes)
docker compose build --no-cache
```

## Volume Persistence

The container uses two named volumes for persistent data:

| Volume   | Container Path              | Contents                         |
| -------- | --------------------------- | -------------------------------- |
| `config` | `/config/proton-drive-sync` | `config.json`, `credentials.enc` |
| `state`  | `/state/proton-drive-sync`  | `state.db`, `sync.log`           |

To backup your configuration:

```bash
docker run --rm -v proton-drive-sync_config:/data -v $(pwd):/backup alpine tar czf /backup/config-backup.tar.gz -C /data .
```

To restore:

```bash
docker run --rm -v proton-drive-sync_config:/data -v $(pwd):/backup alpine tar xzf /backup/config-backup.tar.gz -C /data
```

## Troubleshooting

### "Too many open files" or inotify errors

The container sets `fs.inotify.max_user_watches=524288` via sysctls. If you still see errors, increase limits on the Docker host:

```bash
echo "fs.inotify.max_user_watches=524288" | sudo tee -a /etc/sysctl.conf
echo "fs.inotify.max_user_instances=512" | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

### Container shows as unhealthy

Check the logs for details:

```bash
docker compose logs proton-drive-sync
```

Common causes:

- **Missing `KEYRING_PASSWORD`** - Ensure it's set in `.env`
- **Not authenticated** - Run `docker exec -it proton-drive-sync proton-drive-sync auth`
- **No sync directories configured** - Add directories via the dashboard at http://localhost:4242

### Permission denied on sync directories

Ensure the host directories exist and are readable/writable:

```bash
mkdir -p /path/to/sync/dir
chmod -R 755 /path/to/sync/dir
```

### Reset everything

To start fresh, remove the volumes:

```bash
docker compose down -v
```

This removes all configuration, credentials, and sync state. You'll need to re-authenticate.

## Architecture

The container runs a single process that manages:

1. **File Watcher** - Native file system monitoring via fs.watch
2. **Sync Engine** - Queues and processes file changes
3. **Dashboard** - Web UI on port 4242

The app runs in foreground mode (`--no-daemon`) for proper Docker signal handling.

## Health Check

The container includes a health check that verifies:

1. `proton-drive-sync status` returns successfully
2. Dashboard is responding on port 4242

Check health status:

```bash
docker inspect --format='{{.State.Health.Status}}' proton-drive-sync
```
