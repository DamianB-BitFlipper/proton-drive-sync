/**
 * Sync CLI Command
 *
 * Handles CLI argument parsing and delegates to the sync engine.
 */

import { getConfig, watchConfig } from '../config.js';
import { logger, setDryRun } from '../logger.js';
import {
  startSignalListener,
  stopSignalListener,
  registerSignalHandler,
  clearAllSignals,
} from '../signals.js';
import { acquireRunLock, releaseRunLock, setFlag, isPaused, FLAGS } from '../flags.js';
import { getStoredCredentials, createClientFromTokens, type ProtonDriveClient } from './auth.js';
import { startDashboard, stopDashboard, sendStatusToDashboard } from '../dashboard/server.js';
import {
  isServiceInstalled,
  loadSyncService,
  unloadSyncService,
  serviceInstallCommand,
} from './service/index.js';
import { startDashboardMode } from '../dashboard/app.js';
import { runOneShotSync, runWatchMode, closeWatcher } from '../sync/index.js';

// ============================================================================
// Types
// ============================================================================

interface StartOptions {
  daemon?: boolean; // Commander's --no-daemon sets this to false
  watch?: boolean; // Commander's --no-watch sets this to false
  dryRun?: boolean;
  debug?: boolean; // Global --debug flag
  sdkDebug?: boolean; // Global --sdk-debug flag
  dashboard?: boolean;
  paused?: boolean;
}

// ============================================================================
// Authentication
// ============================================================================

// Retry delays in seconds (array length determines max retries)
const NETWORK_DELAYS = [1, 4, 16, 64, 256];
const RATE_LIMIT_DELAYS = [32, 128, 512, 512, 512];

/**
 * Authenticate using stored tokens with retry and exponential backoff.
 * Sends status updates to the dashboard via IPC.
 * @param sdkDebug - Enable debug logging for the Proton SDK
 */
async function authenticateWithStatus(sdkDebug = false): Promise<ProtonDriveClient> {
  const storedCreds = await getStoredCredentials();
  if (!storedCreds) {
    sendStatusToDashboard({ auth: { status: 'failed' } });
    throw new Error('No credentials found. Run `proton-drive-sync auth` first.');
  }

  logger.info('Authenticating with stored tokens...');

  const getRetryDelays = (error: Error): number[] | null => {
    if (error.message.includes('Too many recent API requests')) return RATE_LIMIT_DELAYS;
    if (
      error.message.includes('fetch failed') ||
      error.message.includes('socket connection was closed')
    ) {
      return NETWORK_DELAYS;
    }
    return null;
  };

  for (let attempt = 0; ; attempt++) {
    sendStatusToDashboard({ auth: { status: 'authenticating' } });

    try {
      const client = await createClientFromTokens(storedCreds, sdkDebug);
      sendStatusToDashboard({ auth: { status: 'authenticated', username: storedCreds.username } });
      logger.info(`Authenticated as ${storedCreds.username}.`);
      return client;
    } catch (error) {
      const err = error as Error;
      const delays = getRetryDelays(err);

      if (!delays || attempt >= delays.length) {
        sendStatusToDashboard({ auth: { status: 'failed' } });
        throw err;
      }

      const delaySec = delays[attempt];
      logger.warn(
        `Authentication failed (attempt ${attempt + 1}/${delays.length}), retrying in ${delaySec}s: ${err.message}`
      );
      await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
    }
  }
}

// ============================================================================
// CLI Command
// ============================================================================

/**
 * Spawn a detached background process (daemon) and exit.
 * The child process runs with --no-daemon to execute the actual sync.
 */
function spawnDaemon(options: StartOptions): void {
  const args = ['start', '--no-daemon'];

  // Forward relevant flags to the daemon process
  if (options.watch === false) args.push('--no-watch');
  if (options.dryRun) args.push('--dry-run');
  if (options.debug) args.push('--debug');
  if (options.sdkDebug) args.push('--sdk-debug');
  if (options.paused) args.push('--paused');

  const child = Bun.spawn(['proton-drive-sync', ...args], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env },
  });

  // Unref so parent can exit without waiting for child
  child.unref();

  logger.info(`Started daemon process (PID: ${child.pid})`);
  process.exit(0);
}

/**
 * Main entry point for the sync command.
 */
export async function startCommand(options: StartOptions): Promise<void> {
  // If --dashboard flag is passed, run as dashboard subprocess
  if (options.dashboard) {
    startDashboardMode();
    return;
  }

  // Derive effective modes from flags
  // Commander's --no-watch sets watch=false, default is true
  const watchMode = options.watch !== false;

  // Validate: --no-watch requires --no-daemon
  if (options.watch === false && options.daemon !== false) {
    logger.error('Error: --no-watch requires --no-daemon');
    process.exit(1);
  }

  // Validate: --paused requires watch mode
  if (options.paused && options.watch === false) {
    logger.error('Error: --paused requires watch mode');
    process.exit(1);
  }

  // Daemonize: spawn background process and exit
  // Commander's --no-daemon sets daemon=false, default is true
  if (options.daemon !== false) {
    spawnDaemon(options);
    return;
  }

  // From here on, we're running in foreground (--no-daemon mode)

  // Set DEBUG_LEVEL env var for SDK debug (used by daemon subprocess)
  if (options.sdkDebug) {
    Bun.env.DEBUG_LEVEL = '2';
  } else if (options.debug) {
    Bun.env.DEBUG_LEVEL = '1';
  }

  // Handle dry-run mode
  if (options.dryRun) {
    setDryRun(true);
    logger.info('Dry run mode enabled - no changes will be made');
  }

  // Load configuration
  const config = getConfig();
  if (!config) {
    logger.error('No config file found. Run `proton-drive-sync init` first.');
    process.exit(1);
  }

  // Warn if no sync directories configured
  if (!config.sync_dirs || config.sync_dirs.length === 0) {
    logger.warn('No sync directories configured. Nothing will be synced.');
  }

  // Acquire run lock (prevents multiple instances)
  const lockAcquired = acquireRunLock();
  if (!lockAcquired) {
    logger.error('Another instance is already running. Use `proton-drive-sync stop` to stop it.');
    process.exit(1);
  }

  // Set paused flag if --paused was passed
  if (options.paused) {
    setFlag(FLAGS.PAUSED);
    logger.info('Starting in paused state');
  }

  // Clear any stale signals from when service was offline, then start listener
  clearAllSignals();
  startSignalListener();

  // Start watching for config reload signals
  watchConfig();

  // Set up cleanup handler
  const cleanup = async (): Promise<void> => {
    closeWatcher();
    await stopDashboard();
    stopSignalListener();
    releaseRunLock();
  };

  // Global crash handlers - log errors and cleanup before exit
  process.on('uncaughtException', async (error) => {
    logger.error(`Uncaught exception: ${error.message}`);
    if (error.stack) {
      logger.error(error.stack);
    }
    await cleanup();
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error(`Unhandled rejection: ${message}`);
    if (stack) {
      logger.error(stack);
    }
    await cleanup();
    process.exit(1);
  });

  // Windows doesn't support SIGTERM - only register on Unix platforms
  if (process.platform !== 'win32') {
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down...');
      cleanup().then(() => process.exit(0));
    });
  }

  // Handle Ctrl+C early (before auth) to ensure cleanup
  process.once('SIGINT', () => {
    logger.info('Interrupted');
    cleanup().then(() => process.exit(0));
  });

  // Handle stop signal
  registerSignalHandler('stop', () => {
    logger.info('Stop signal received');
    sendStatusToDashboard({ disconnected: true });
    cleanup().then(() => process.exit(0));
  });

  // Handle start-on-login enable signal
  registerSignalHandler('start-on-login-enable', async () => {
    const isInstalled = isServiceInstalled();
    if (!isInstalled) {
      await serviceInstallCommand(false);
    } else {
      await loadSyncService();
    }
  });

  // Handle start-on-login disable signal
  registerSignalHandler('start-on-login-disable', async () => {
    await unloadSyncService();
  });

  // Start dashboard early (before auth) so user can see auth status
  const dryRun = options.dryRun ?? false;
  if (watchMode) {
    startDashboard(config, dryRun);

    // Handle refresh-dashboard signal for immediate dashboard updates (e.g., after pause toggle)
    registerSignalHandler('refresh-dashboard', () => {
      const paused = isPaused();
      logger.info(`Updating dashboard (${paused ? 'paused' : 'resuming'})`);
      sendStatusToDashboard({ paused });
    });
  }

  // Authenticate with Proton
  const sdkDebug = options.sdkDebug;
  let client;
  try {
    client = await authenticateWithStatus(sdkDebug);
  } catch (error) {
    logger.error(`Authentication failed: ${error}`);
    await cleanup();
    process.exit(1);
  }

  try {
    if (watchMode) {
      // Watch mode: continuous sync
      await runWatchMode({ config, client, dryRun, watch: true });
    } else {
      // One-shot mode: sync once and exit
      await runOneShotSync({ config, client, dryRun, watch: false });
    }
  } catch (error) {
    logger.error(`Sync failed: ${error}`);
    await cleanup();
    process.exit(1);
  }

  cleanup();
}
