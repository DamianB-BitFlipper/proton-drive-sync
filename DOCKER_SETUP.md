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

   # Host directory mount points: these map directories from your host
   # filesystem into the Docker container so the app can access them.
   # The actual sync configuration (which directories to watch and where
   # to sync them on Proton Drive) is set up separately in step 5 via
   # the dashboard.
   SYNC_DIR_1=/path/to/documents
   SYNC_DIR_2=/path/to/photos
   ```

   Then uncomment the corresponding volume mounts in `docker-compose.yml`:

   ```yaml
   - ${SYNC_DIR_1}:/data/documents
   - ${SYNC_DIR_2}:/data/photos
   ```

3. **Start the container**

   ```bash
   docker compose up -d
   ```

4. **Authenticate with Proton**

   **Option A: Interactive** (supports 2FA)

   ```bash
   docker exec -it proton-drive-sync proton-drive-sync auth
   ```

   Follow the prompts to enter your Proton credentials and 2FA code if enabled.

   **Option B: Headless via environment variables** (no 2FA support)

   Uncomment and set `PROTON_USERNAME` and `PROTON_PASSWORD` in your `.env` file, then restart:

   ```bash
   docker compose up -d
   ```

   The app will authenticate automatically on startup. Note: this does **not** work with accounts that have 2FA/TOTP enabled.

5. **Configure sync directories**

   Your host directories are mounted into the container under `/data/` (e.g., `SYNC_DIR_1` → `/data/documents`, `SYNC_DIR_2` → `/data/photos`). Open the dashboard at http://localhost:4242 and add these container paths as sync directories:
   - `/data/documents` → Your Proton Drive folder (e.g., `/Backup/Documents`)
   - `/data/photos` → Another Proton Drive folder (e.g., `/Backup/Photos`)

## Isolated staging environment

For manual testing without sharing configuration, credentials, state, or a
dashboard port with an installed client, use the staging Compose file. This
still connects to the real Proton Drive service, so configure it to use a
dedicated remote test folder. Do not point it at a folder used by your normal
installation.

From the repository root (`proton-drive-sync`):

```bash
cp docker/.env.staging.example docker/.env.staging
openssl rand -base64 32
# Put the generated value in docker/.env.staging as KEYRING_PASSWORD
mkdir -p .staging-sync
docker compose -f docker/docker-compose.staging.yml --env-file docker/.env.staging up --build
```

The staging dashboard is available at http://localhost:4243. Authenticate in
another terminal, including 2FA if required:

```bash
docker compose -f docker/docker-compose.staging.yml --env-file docker/.env.staging \
   exec proton-drive-sync-staging proton-drive-sync auth
```

In the dashboard, add `/data/staging` and use a dedicated Proton Drive folder,
for example `/proton-drive-sync-staging`. The host directory configured by
`STAGING_SYNC_DIR` is always available inside the container as `/data/staging`.
For example, to expose an existing host directory, set
`STAGING_SYNC_DIR=/path/to/proton-drive-sync-staging` in `docker/.env.staging`,
recreate the container, and add `/data/staging` in the dashboard. The staging instance uses separate
Docker volumes named `proton-drive-sync-staging-config` and
`proton-drive-sync-staging-state`; it does not read the installed client's
configuration or database.

Stop and remove the staging container with:

```bash
docker compose -f docker/docker-compose.staging.yml --env-file docker/.env.staging down
```

To delete the staging credentials and state as well:

```bash
docker compose -f docker/docker-compose.staging.yml --env-file docker/.env.staging down -v
rm -rf .staging-sync
```

The final command removes only the local staging directory. Delete the
dedicated remote test folder separately from Proton Drive when finished.

The staging Compose file does not set container inotify sysctls because some
Docker runtimes do not permit those settings in a separate kernel namespace.
If the container later reports an inotify limit error, increase the limits on
the Docker host using the troubleshooting commands below.

## Configuration

### Environment Variables

| Variable           | Required | Default | Description                                            |
| ------------------ | -------- | ------- | ------------------------------------------------------ |
| `KEYRING_PASSWORD` | Yes      | -       | Encryption key for credentials                         |
| `TZ`               | No       | `UTC`   | Container timezone                                     |
| `DASHBOARD_PORT`   | No       | `4242`  | Dashboard port on host                                 |
| `SYNC_DIR_1`       | No       | -       | Host path to mount into container at `/data/documents` |
| `SYNC_DIR_2`       | No       | -       | Host path to mount into container at `/data/photos`    |
| `PROTON_USERNAME`  | No       | -       | Proton username for headless auth                      |
| `PROTON_PASSWORD`  | No       | -       | Proton password for headless auth                      |

### Container Environment

The container sets `DOCKER=1` automatically. This causes the dashboard to bind to `0.0.0.0` instead of `127.0.0.1`, making it accessible via the mapped port on the host. No manual configuration of `dashboard_host` is needed.

### Adding More Sync Directories

1. Edit `docker-compose.yml` to add more volume mounts:

   ```yaml
   volumes:
     - ${SYNC_DIR_3}:/data/videos
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

### Dashboard not accessible

The dashboard automatically binds to `0.0.0.0` inside the container (via the `DOCKER=1` env var), so it should be accessible at `http://localhost:4242` on the host. If you're having issues:

- Ensure the port mapping is correct in `docker-compose.yml`
- Check that no other service is using port 4242 on the host
- Try changing `DASHBOARD_PORT` in `.env` to a different port

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

The app runs in foreground mode (`--no-daemon`) for proper Docker signal handling. Signals (`SIGTERM`, `SIGINT`) are forwarded directly to the application process via `exec` in the entrypoint, enabling graceful shutdown.

## Health Check

The container includes a health check that verifies the sync process is running via `proton-drive-sync status`. The start period is 30 seconds to allow time for authentication.

Check health status:

```bash
docker inspect --format='{{.State.Health.Status}}' proton-drive-sync
```
