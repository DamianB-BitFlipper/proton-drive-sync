/**
 * Sync CLI Command
 *
 * Handles CLI argument parsing and delegates to the sync engine.
 */

import { loadConfig, watchConfig } from '../config.js';
import { logger, enableDebug, disableConsoleLogging, setDryRun } from '../logger.js';
import { startSignalListener, stopSignalListener, registerSignalHandler } from '../signals.js';
import { acquireRunLock, releaseRunLock } from '../flags.js';
import { getStoredCredentials, createClientFromTokens, type ProtonDriveClient } from './auth.js';
import { startDashboard, stopDashboard, sendStatusToDashboard } from '../dashboard/server.js';
import { runOneShotSync, runWatchMode } from '../sync/index.js';

// ============================================================================
// Types
// ============================================================================

interface StartOptions {
  noDaemon?: boolean;
  noWatch?: boolean;
  dryRun?: boolean;
  debug?: number;
}

// ============================================================================
// Authentication
// ============================================================================

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

  // Retry with exponential backoff: 1s, 4s, 16s, 64s, 256s
  const MAX_RETRIES = 5;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    sendStatusToDashboard({ auth: { status: 'authenticating' } });

    try {
      const client = await createClientFromTokens(storedCreds, sdkDebug);
      sendStatusToDashboard({ auth: { status: 'authenticated', username: storedCreds.username } });
      logger.info('Authenticated.');
      return client;
    } catch (error) {
      lastError = error as Error;

      // Only retry on network errors (fetch failed)
      if (!lastError.message.includes('fetch failed')) {
        sendStatusToDashboard({ auth: { status: 'failed' } });
        throw lastError;
      }

      if (attempt < MAX_RETRIES - 1) {
        const delayMs = Math.pow(4, attempt) * 1000; // 1s, 4s, 16s, 64s
        sendStatusToDashboard({ auth: { status: 'authenticating' } });
        logger.warn(
          `Authentication failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delayMs / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  sendStatusToDashboard({ auth: { status: 'failed' } });
  throw lastError;
}

// ============================================================================
// CLI Command
// ============================================================================

/**
 * Main entry point for the sync command.
 */
export async function startCommand(options: StartOptions): Promise<void> {
  // Derive effective modes from flags
  const watch = !options.noWatch;

  // Validate: --no-watch requires --no-daemon
  if (options.noWatch && !options.noDaemon) {
    console.error('Error: --no-watch requires --no-daemon');
    process.exit(1);
  }

  // Set debug level from CLI flag
  if (options.debug) {
    const level = options.debug;
    process.env.DEBUG_LEVEL = String(level);
    enableDebug();
    logger.debug(`Debug level ${level}: App debug enabled`);
    if (level >= 2) logger.debug(`Debug level ${level}: SDK debug enabled`);
  }

  // Disable console logging when not connected to a TTY (running as background service)
  if (!process.stdout.isTTY) {
    disableConsoleLogging();
  }

  // Handle dry-run mode
  if (options.dryRun) {
    setDryRun(true);
    logger.info('Dry run mode enabled - no changes will be made');
  }

  // Load configuration
  const config = loadConfig();
  if (!config) {
    logger.error('No config file found. Run `proton-drive-sync init` first.');
    process.exit(1);
  }

  // Validate sync directories
  if (!config.sync_dirs || config.sync_dirs.length === 0) {
    logger.error('No sync directories configured. Add sync_dirs to your config file.');
    process.exit(1);
  }

  // Acquire run lock (prevents multiple instances)
  const lockAcquired = acquireRunLock();
  if (!lockAcquired) {
    logger.error('Another instance is already running. Use `proton-drive-sync stop` to stop it.');
    process.exit(1);
  }

  // Start signal listener for IPC
  startSignalListener();

  // Start watching for config reload signals
  watchConfig();

  // Set up cleanup handler
  const cleanup = async (): Promise<void> => {
    await stopDashboard();
    stopSignalListener();
    releaseRunLock();
  };

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

  // Start dashboard early (before auth) so user can see auth status
  const dryRun = options.dryRun ?? false;
  if (watch) {
    startDashboard(config, dryRun);
  }

  // Authenticate with Proton
  const sdkDebug = (options.debug ?? 0) >= 2;
  let client;
  try {
    client = await authenticateWithStatus(sdkDebug);
  } catch (error) {
    logger.error(`Authentication failed: ${error}`);
    cleanup();
    process.exit(1);
  }

  try {
    if (watch) {
      // Watch mode: continuous sync
      await runWatchMode({ config, client, dryRun, watch: true });
    } else {
      // One-shot mode: sync once and exit
      await runOneShotSync({ config, client, dryRun, watch: false });
    }
  } catch (error) {
    logger.error(`Sync failed: ${error}`);
    cleanup();
    process.exit(1);
  }

  cleanup();
}
