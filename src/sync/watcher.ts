/**
 * Watchman File Watcher
 *
 * Handles Watchman client management, file change detection, and subscriptions.
 */

import { realpathSync } from 'fs';
import { basename } from 'path';
import watchman from 'fb-watchman';
import { getClock, setClock } from '../state.js';
import { logger } from '../logger.js';
import { setFlag, clearFlag, getFlagData, FLAGS, WATCHMAN_STATE, ALL_VARIANTS } from '../flags.js';
import { sendSignal } from '../signals.js';
import { getConfig, type Config } from '../config.js';
import { WATCHMAN_SUB_NAME } from './constants.js';

// ============================================================================
// Types
// ============================================================================

export interface FileChange {
  name: string; // Relative path from the watch root
  size: number; // File size in bytes
  mtime_ms: number; // Last modification time in milliseconds since epoch
  exists: boolean; // false if the file was deleted
  type: 'f' | 'd'; // 'f' for file, 'd' for directory
  new: boolean; // true if file is newer than the 'since' clock (i.e., newly created)
  watchRoot: string; // Which watch root this change came from (added by us, not from Watchman)
  ino: number; // Inode number - stable across renames/moves within same filesystem
  'content.sha1hex'?: string; // Content hash for files (null/undefined for directories)
}

interface WatchmanQueryResponse {
  clock: string;
  files: Omit<FileChange, 'watchRoot'>[];
}

export type FileChangeHandler = (file: FileChange) => void;
export type FileChangeBatchHandler = (files: FileChange[]) => void;

// ============================================================================
// State
// ============================================================================

/** Track active subscription names for teardown */
let activeSubscriptions: { root: string; subName: string }[] = [];

// ============================================================================
// Watchman Client
// ============================================================================

const watchmanClient = new watchman.Client();

/** Promisified wrapper for Watchman command */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function watchmanCommand<T>(args: any[]): Promise<T> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (watchmanClient as any).command(args, (err: Error | null, resp: T) => {
      if (err) reject(err);
      else resolve(resp);
    });
  });
}

/** Check if watchman is already running without starting it */
function isWatchmanRunning(): boolean {
  const result = Bun.spawnSync(['watchman', 'get-pid', '--no-spawn']);
  return result.exitCode === 0;
}

/** Connect to Watchman and track if we spawned it */
export async function connectWatchman(): Promise<void> {
  const wasRunning = isWatchmanRunning();

  // The client will auto-start watchman if not running
  await watchmanCommand<{ version: string }>(['version']);

  if (!wasRunning) {
    setFlag(FLAGS.WATCHMAN_RUNNING, WATCHMAN_STATE.SPAWNED);
    logger.debug('Watchman was not running, we spawned it');
  } else {
    setFlag(FLAGS.WATCHMAN_RUNNING, WATCHMAN_STATE.EXISTING);
    logger.debug('Watchman was already running');
  }

  // Signal dashboard to refresh (watchman is now ready)
  sendSignal('refresh-dashboard');
}

/** Close the Watchman client connection */
export function closeWatchman(): void {
  watchmanClient.end();
}

/** Shutdown watchman server if we spawned it */
export function shutdownWatchman(): void {
  const watchmanState = getFlagData(FLAGS.WATCHMAN_RUNNING);
  if (watchmanState === WATCHMAN_STATE.SPAWNED) {
    logger.debug('Shutting down watchman server (we spawned it)');
    Bun.spawnSync(['watchman', 'shutdown-server']);
  }
  clearFlag(FLAGS.WATCHMAN_RUNNING, ALL_VARIANTS);
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

/** Promisified wrapper for Watchman unsubscribe command */
function unsubscribeWatchman(root: string, subName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (watchmanClient as any).command(['unsubscribe', root, subName], (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Build a Watchman query/subscription object */
function buildWatchmanQuery(savedClock: string | null, relative: string): Record<string, unknown> {
  const query: Record<string, unknown> = {
    expression: ['anyof', ['type', 'f'], ['type', 'd']],
    fields: ['name', 'size', 'mtime_ms', 'exists', 'type', 'new', 'ino', 'content.sha1hex'],
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
// One-shot Query
// ============================================================================

/**
 * Query all configured directories for changes since last sync.
 * Returns all file changes found across all directories.
 */
export async function queryAllChanges(
  config: Config,
  onFileChangeBatch: FileChangeBatchHandler,
  dryRun: boolean
): Promise<number> {
  let totalChanges = 0;

  await Promise.all(
    config.sync_dirs.map(async (dir) => {
      const watchDir = realpathSync(dir.source_path);

      // Register directory with Watchman
      const watchResp = await registerWithWatchman(watchDir);
      const root = watchResp.watch;
      const relative = watchResp.relative_path || '';

      const savedClock = getClock(watchDir);

      if (savedClock) {
        logger.info(`Syncing changes since last run for ${dir.source_path}...`);
      } else {
        logger.info(`First run - syncing all existing files in ${dir.source_path}...`);
      }

      const query = buildWatchmanQuery(savedClock, relative);
      const resp = await queryWatchman(root, query);

      // Save clock
      if (resp.clock) {
        setClock(watchDir, resp.clock, dryRun);
      }

      // Process changes as a batch
      const files = resp.files || [];
      if (files.length > 0) {
        const fileChanges: FileChange[] = files.map((file) => ({
          ...file,
          watchRoot: watchDir,
        }));
        onFileChangeBatch(fileChanges);
        totalChanges += files.length;
      }
    })
  );

  return totalChanges;
}

// ============================================================================
// Watch Mode (Subscriptions)
// ============================================================================

/**
 * Set up Watchman subscriptions for all configured directories.
 * Calls onFileChangeBatch for each batch of file changes detected.
 */
export async function setupWatchSubscriptions(
  config: Config,
  onFileChangeBatch: FileChangeBatchHandler,
  dryRun: boolean
): Promise<void> {
  // Clear any existing subscriptions first
  await teardownWatchSubscriptions();

  // Register event listener BEFORE creating subscriptions to avoid missing events
  watchmanClient.on('subscription', (resp: watchman.SubscriptionResponse) => {
    // Check if this is one of our subscriptions
    if (!resp.subscription.startsWith(WATCHMAN_SUB_NAME)) return;

    // Log full subscription event data
    logger.info(`Watchman subscription event: ${JSON.stringify(resp)}`);

    // Use Watchman's root directly instead of parsing from subscription name
    const watchRoot = (resp as unknown as { root: string }).root;

    // Use getConfig() to get fresh config instead of stale closure
    const currentConfig = getConfig();
    const syncDir = currentConfig.sync_dirs.find((d) => realpathSync(d.source_path) === watchRoot);

    if (!syncDir) {
      // This can happen legitimately during config transitions or stale events
      logger.warn(
        `Ignoring event for unknown watch root: ${watchRoot} (subscription: ${resp.subscription})`
      );
      return;
    }

    const resolvedRoot = watchRoot;

    // Process files as a batch
    const fileChanges: FileChange[] = resp.files.map((file) => {
      const fileChange = file as unknown as Omit<FileChange, 'watchRoot'>;
      return { ...fileChange, watchRoot: resolvedRoot };
    });

    if (fileChanges.length > 0) {
      onFileChangeBatch(fileChanges);
    }

    // Save the new clock so we don't see these events again on restart
    const clock = (resp as unknown as { clock?: string }).clock;
    if (clock) {
      setClock(resolvedRoot, clock, dryRun);
    }
  });

  // Handle errors
  watchmanClient.on('error', (e: Error) => logger.error(`Watchman error: ${e}`));
  watchmanClient.on('end', () => {});

  // Set up watches for all configured directories
  await Promise.all(
    config.sync_dirs.map(async (dir) => {
      const watchDir = realpathSync(dir.source_path);
      const subName = `${WATCHMAN_SUB_NAME}-${basename(watchDir)}`;

      // Register directory with Watchman
      const watchResp = await registerWithWatchman(watchDir);
      const root = watchResp.watch;
      const relative = watchResp.relative_path || '';

      // Use saved clock for this directory or null for initial sync
      const savedClock = getClock(watchDir);

      if (savedClock) {
        logger.info(`Resuming ${dir.source_path} from last sync state...`);
      } else {
        logger.info(`First run - syncing all existing files in ${dir.source_path}...`);
      }

      const sub = buildWatchmanQuery(savedClock, relative);

      // Register subscription
      await subscribeWatchman(root, subName, sub);
      activeSubscriptions.push({ root, subName });
      logger.info(`Watching ${dir.source_path} for changes...`);
    })
  );

  logger.info('Watching for file changes... (press Ctrl+C to exit)');
}

/**
 * Tear down all active Watchman subscriptions.
 * Call this before re-setting up subscriptions on config change.
 */
export async function teardownWatchSubscriptions(): Promise<void> {
  if (activeSubscriptions.length === 0) return;

  logger.info('Tearing down watch subscriptions...');

  // Remove subscription event listeners
  watchmanClient.removeAllListeners('subscription');

  // Unsubscribe from all active subscriptions
  await Promise.all(
    activeSubscriptions.map(async ({ root, subName }) => {
      try {
        await unsubscribeWatchman(root, subName);
        logger.debug(`Unsubscribed from ${subName}`);
      } catch (err) {
        logger.warn(`Failed to unsubscribe from ${subName}: ${(err as Error).message}`);
      }
    })
  );

  activeSubscriptions = [];
}
