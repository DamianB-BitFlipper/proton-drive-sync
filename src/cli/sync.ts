/**
 * Sync Command - Watch and sync files to Proton Drive
 */

import { realpathSync } from 'fs';
import { basename } from 'path';
import { execSync } from 'child_process';
import watchman from 'fb-watchman';
import { getClock, setClock } from '../state.js';
import { loadConfig, type Config } from '../config.js';
import { logger, disableConsoleLogging, enableDebug } from '../logger.js';
import { authenticateFromKeychain } from './auth.js';
import { hasSignal, consumeSignal, isAlreadyRunning } from '../signals.js';
import { enqueueJob, processAllPendingJobs } from '../jobs.js';
import { SyncEventType } from '../db/schema.js';
import type { ProtonDriveClient } from '../types.js';

// ============================================================================
// Types
// ============================================================================

interface FileChange {
  name: string; // Relative path from the watch root
  size: number; // File size in bytes
  mtime_ms: number; // Last modification time in milliseconds since epoch
  exists: boolean; // false if the file was deleted
  type: 'f' | 'd'; // 'f' for file, 'd' for directory
  new: boolean; // true if file is newer than the 'since' clock (i.e., newly created)
  watchRoot: string; // Which watch root this change came from (added by us, not from Watchman)
}

interface WatchmanQueryResponse {
  clock: string;
  files: Omit<FileChange, 'watchRoot'>[];
}

// ============================================================================
// Constants
// ============================================================================

const SUB_NAME = 'proton-drive-sync';

// Polling interval for processing jobs in watch mode (10 seconds)
const JOB_POLL_INTERVAL_MS = 10_000;

// ============================================================================
// Options & State
// ============================================================================

let dryRun = false;
let watchMode = false;
let remoteRoot = '';
let protonClient: ProtonDriveClient | null = null;

// ============================================================================
// Watchman Client
// ============================================================================

const watchmanClient = new watchman.Client();

/** Wait for Watchman to be available, retrying with delay */
async function waitForWatchman(maxAttempts = 30, delayMs = 1000): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      execSync('watchman version', { stdio: 'ignore' });
      return;
    } catch {
      if (attempt === maxAttempts) {
        console.error('Error: Watchman failed to start.');
        console.error('Install it from: https://facebook.github.io/watchman/docs/install');
        process.exit(1);
      }
      logger.debug(`Waiting for watchman to start (attempt ${attempt}/${maxAttempts})...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// ============================================================================
// Change Queue
// ============================================================================

/**
 * Queue a file change as a sync job.
 * Converts the file change into a job with proper paths and event type.
 */
function queueChange(file: FileChange): void {
  const status = file.exists ? (file.type === 'd' ? 'dir changed' : 'changed') : 'deleted';
  const typeLabel = file.type === 'd' ? 'dir' : 'file';
  logger.debug(`[${status}] ${file.name} (size: ${file.size ?? 0}, type: ${typeLabel})`);

  // Build local path (where to read from)
  const localPath = `${file.watchRoot}/${file.name}`;
  // Build remote path (where to upload to on Proton Drive)
  const dirName = basename(file.watchRoot);
  const remotePath = remoteRoot
    ? `${remoteRoot}/${dirName}/${file.name}`
    : `${dirName}/${file.name}`;

  // Determine event type
  let eventType: SyncEventType;
  if (!file.exists) {
    eventType = SyncEventType.DELETE;
  } else if (file.new) {
    // Newly created file or directory
    eventType = SyncEventType.CREATE;
  } else {
    // Modified existing file or directory
    eventType = SyncEventType.UPDATE;
  }

  logger.debug(`Enqueueing ${eventType} job for ${typeLabel}: ${file.name}`);

  enqueueJob(
    {
      eventType,
      localPath,
      remotePath,
    },
    dryRun
  );
}

// ============================================================================
// Watchman Helpers (promisified)
// ============================================================================

/** Promisified wrapper for Watchman watch-project command */
function registerWithWatchman(dir: string): Promise<watchman.WatchProjectResponse> {
  return new Promise((resolve, reject) => {
    watchmanClient.command(['watch-project', dir], (err, resp) => {
      if (err) reject(err);
      else resolve(resp as watchman.WatchProjectResponse);
    });
  });
}

/** Promisified wrapper for Watchman query command */
function queryWatchman(
  root: string,
  query: Record<string, unknown>
): Promise<WatchmanQueryResponse> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (watchmanClient as any).command(
      ['query', root, query],
      (err: Error | null, resp: WatchmanQueryResponse) => {
        if (err) reject(err);
        else resolve(resp);
      }
    );
  });
}

/** Promisified wrapper for Watchman subscribe command */
function subscribeWatchman(
  root: string,
  subName: string,
  sub: Record<string, unknown>
): Promise<void> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (watchmanClient as any).command(['subscribe', root, subName, sub], (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Build a Watchman query/subscription object */
function buildWatchmanQuery(savedClock: string | null, relative: string): Record<string, unknown> {
  const query: Record<string, unknown> = {
    expression: ['anyof', ['type', 'f'], ['type', 'd']],
    fields: ['name', 'size', 'mtime_ms', 'exists', 'type', 'new'],
  };

  if (savedClock) {
    query.since = savedClock;
  }

  if (relative) {
    query.relative_root = relative;
  }

  return query;
}

// ============================================================================
// One-shot Sync (query mode)
// ============================================================================

/**
 * Run a one-shot sync for all configured directories.
 * Uses Promise.all to query all directories concurrently, then processes changes.
 */
async function runOneShotSync(config: Config): Promise<void> {
  let jobsQueued = 0;

  // Query all directories concurrently
  await Promise.all(
    config.sync_dirs.map(async (dir) => {
      const watchDir = realpathSync(dir);

      // Register directory with Watchman
      const watchResp = await registerWithWatchman(watchDir);
      // Watchman may watch a parent dir; root is the actual watch, relative is our target within it
      const root = watchResp.watch;
      const relative = watchResp.relative_path || '';

      const savedClock = getClock(watchDir);

      if (savedClock) {
        logger.info(`Syncing changes since last run for ${dir}...`);
      } else {
        logger.info(`First run - syncing all existing files in ${dir}...`);
      }

      const query = buildWatchmanQuery(savedClock, relative);
      const resp = await queryWatchman(root, query);

      // Save clock
      if (resp.clock) {
        setClock(watchDir, resp.clock, dryRun);
      }

      // Queue changes as jobs
      const files = resp.files || [];
      for (const file of files) {
        const fileChange = file as Omit<FileChange, 'watchRoot'>;
        queueChange({ ...fileChange, watchRoot: watchDir });
        jobsQueued++;
      }
    })
  );

  // Process all queued jobs
  if (jobsQueued === 0) {
    logger.info('No changes to sync.');
    return;
  }

  const processed = await processAllPendingJobs(protonClient!, dryRun);
  if (processed > 0) {
    logger.info(`Processed ${processed} sync job(s)`);
  }
}

// ============================================================================
// Daemon Mode (subscription mode)
// ============================================================================

async function setupWatchmanDaemon(config: Config): Promise<void> {
  // Set up watches for all configured directories
  await Promise.all(
    config.sync_dirs.map(async (dir) => {
      const watchDir = realpathSync(dir);
      const subName = `${SUB_NAME}-${basename(watchDir)}`;

      // Register directory with Watchman
      const watchResp = await registerWithWatchman(watchDir);
      // Watchman may watch a parent dir; root is the actual watch, relative is our target within it
      const root = watchResp.watch;
      const relative = watchResp.relative_path || '';

      // Use saved clock for this directory or null for initial sync
      const savedClock = getClock(watchDir);

      if (savedClock) {
        logger.info(`Resuming ${dir} from last sync state...`);
      } else {
        logger.info(`First run - syncing all existing files in ${dir}...`);
      }

      const sub = buildWatchmanQuery(savedClock, relative);

      // Register subscription
      await subscribeWatchman(root, subName, sub);
      logger.info(`Watching ${dir} for changes...`);
    })
  );

  // Listen for notifications from all subscriptions
  watchmanClient.on('subscription', (resp: watchman.SubscriptionResponse) => {
    // Check if this is one of our subscriptions
    if (!resp.subscription.startsWith(SUB_NAME)) return;

    logger.debug(`Watchman event: ${resp.subscription} (${resp.files.length} files)`);

    // Extract the watch root from the subscription name
    const dirName = resp.subscription.replace(`${SUB_NAME}-`, '');
    const watchRoot = config.sync_dirs.find((d) => basename(realpathSync(d)) === dirName) || '';

    if (!watchRoot) {
      logger.error(`Could not find watch root for subscription: ${resp.subscription}`);
      return;
    }

    const resolvedRoot = realpathSync(watchRoot);

    for (const file of resp.files) {
      const fileChange = file as unknown as Omit<FileChange, 'watchRoot'>;
      logger.debug(
        `  File: ${fileChange.name} (exists: ${fileChange.exists}, type: ${fileChange.type}, new: ${fileChange.new})`
      );
      queueChange({ ...fileChange, watchRoot: resolvedRoot });
    }
  });

  // Handle errors & shutdown
  watchmanClient.on('error', (e: Error) => logger.error(`Watchman error: ${e}`));
  watchmanClient.on('end', () => {});

  logger.info('Watching for file changes... (press Ctrl+C to exit)');
}

/**
 * Start a polling service that processes queued jobs every JOB_POLL_INTERVAL_MS.
 * Returns the interval ID so it can be cleared on shutdown.
 */
function startJobProcessor(): NodeJS.Timeout {
  return setInterval(async () => {
    if (!protonClient) return;
    const processed = await processAllPendingJobs(protonClient, dryRun);
    if (processed > 0) {
      logger.info(`Processed ${processed} sync job(s)`);
    }
  }, JOB_POLL_INTERVAL_MS);
}

// ============================================================================
// Command
// ============================================================================

export async function startCommand(options: {
  dryRun: boolean;
  watch: boolean;
  daemon: boolean;
  debug: boolean;
}): Promise<void> {
  // Enable debug logging if requested
  if (options.debug) {
    enableDebug();
  }

  // Validate: --daemon requires --watch
  if (options.daemon && !options.watch) {
    console.error('Error: --daemon (-d) requires --watch (-w)');
    process.exit(1);
  }

  // Wait for watchman to be ready
  await waitForWatchman();

  // Check if another proton-drive-sync instance is already running
  if (isAlreadyRunning(true)) {
    console.error(
      'Error: Another proton-drive-sync instance is already running. Run `proton-drive-sync stop` first.'
    );
    process.exit(1);
  }

  if (options.daemon) {
    // Daemon mode: disable console logging (only log to file)
    disableConsoleLogging();
  }

  if (options.dryRun) {
    dryRun = true;
    logger.info('[DRY-RUN] Dry run mode enabled - no changes will be made');
  }

  watchMode = options.watch;

  // Load config
  const config = loadConfig();

  // Set remote root from config
  remoteRoot = config.remote_root;

  // Authenticate using stored credentials
  protonClient = await authenticateFromKeychain();

  if (watchMode) {
    // Watch mode: use subscriptions and keep running
    try {
      await setupWatchmanDaemon(config);
    } catch (err) {
      logger.error(`Failed to setup watchman daemon: ${err}`);
      process.exit(1);
    }

    // Start job processor (polls every 10 seconds)
    const jobProcessor = startJobProcessor();

    // Check for stop signal every second
    const stopSignalCheck = setInterval(() => {
      if (hasSignal('stop')) {
        consumeSignal('stop');
        logger.info('Stop signal received. Shutting down...');
        clearInterval(stopSignalCheck);
        clearInterval(jobProcessor);
        watchmanClient.end();
        process.exit(0);
      }
    }, 1000);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      clearInterval(stopSignalCheck);
      clearInterval(jobProcessor);
      logger.info('Shutting down...');
      watchmanClient.end();
      process.exit(0);
    });
  } else {
    // One-shot mode: query for changes, process, and exit
    await runOneShotSync(config);
    watchmanClient.end();
  }
}
