/**
 * Sync Engine
 *
 * Orchestrates the sync process: coordinates watcher, queue, and processor.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { db } from '../db/index.js';
import { SyncEventType } from '../db/schema.js';
import { logger } from '../logger.js';
import { registerSignalHandler } from '../signals.js';
import { isPaused, setFlag, FLAGS } from '../flags.js';
import { sendStatusToDashboard } from '../dashboard/server.js';
import { getConfig, onConfigChange } from '../config.js';

import type { Config } from '../config.js';
import type { ProtonDriveClient } from '../proton/types.js';
import {
  initializeWatcher,
  closeWatcher,
  queryAllChanges,
  setupWatchSubscriptions,
  triggerFullReconciliation,
  scanDirectory,
  getAllStoredChangeTokens,
  compareWithStoredChangeTokens,
  type FileChange,
} from './watcher.js';
import { enqueueJob, cleanupOrphanedJobs, getPendingJobCount, recoverBlockedJobs } from './queue.js';
import {
  processAvailableJobs,
  waitForActiveTasks,
  getActiveTaskCount,
  drainQueue,
  setSyncConcurrency,
} from './processor.js';
import {
  getFileState,
  deleteChangeToken,
  deleteChangeTokensUnderPath,
  cleanupOrphanedChangeTokens,
  computeFileSha1,
  updateChangeToken,
} from './fileState.js';
import {
  getNodeMapping,
  deleteNodeMapping,
  deleteNodeMappingsUnderPath,
  cleanupOrphanedNodeMappings,
} from './nodes.js';
import { isPathExcluded } from './exclusions.js';
import {
  JOB_POLL_INTERVAL_MS,
  SHUTDOWN_TIMEOUT_MS,
  BACKGROUND_RECONCILIATION_INTERVAL_MS,
  BACKGROUND_RECONCILIATION_THROTTLE_MS,
  BACKGROUND_RECONCILIATION_SKIP_THRESHOLD,
} from './constants.js';

// ============================================================================
// Types
// ============================================================================

export interface SyncOptions {
  config: Config;
  client: ProtonDriveClient;
  dryRun: boolean;
  watch: boolean;
}

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Resolve the sync target for a file change event.
 * Each watcher event is tied to a specific sync_dir via its watchRoot.
 */
function resolveSyncTarget(
  file: FileChange,
  config: Config
): { localPath: string; remotePath: string } | null {
  const localPath = join(file.watchRoot, file.name);

  // Find the sync_dir that matches this watcher's root
  // Normalize both paths to handle trailing slashes consistently
  const syncDir = config.sync_dirs.find((d) => {
    const sourcePath = d.source_path.endsWith('/') ? d.source_path.slice(0, -1) : d.source_path;
    const watchRoot = file.watchRoot.endsWith('/') ? file.watchRoot.slice(0, -1) : file.watchRoot;
    return watchRoot === sourcePath;
  });

  if (!syncDir) return null;

  // Calculate relative path from this sync_dir's root
  const sourcePath = syncDir.source_path.endsWith('/')
    ? syncDir.source_path.slice(0, -1)
    : syncDir.source_path;
  const relative = localPath === sourcePath ? '' : localPath.slice(sourcePath.length + 1);
  const remotePath = relative ? `${syncDir.remote_root}/${relative}` : syncDir.remote_root;

  return { localPath, remotePath };
}

// ============================================================================
// File Change Handler
// ============================================================================

/**
 * Check whether a file change should be enqueued or can be skipped.
 *
 * Performs a single DB read to get both the change token and stored SHA1.
 * - If mtime:size matches the stored token, skip (no change).
 * - If mtime:size differs but a stored SHA1 exists and matches the local file,
 *   update the stored token and skip (mtime shifted but content unchanged).
 * - Otherwise, enqueue the job.
 *
 * Returns the stored change token (for logging) and whether to enqueue.
 */
async function shouldEnqueueFileChange(
  localPath: string,
  newHash: string,
  fileName: string,
  dryRun: boolean
): Promise<{ enqueue: boolean; storedToken: string | null }> {
  const state = db.transaction((tx) => getFileState(localPath, tx));

  // Token matches — nothing changed
  if (state && state.changeToken === newHash) {
    logger.debug(`[skip] mtime+size unchanged: ${fileName}`);
    return { enqueue: false, storedToken: state.changeToken };
  }

  // SHA1 fallback: mtime:size changed but content may be the same
  if (state?.contentSha1) {
    const localSha1 = await computeFileSha1(localPath);
    if (localSha1 && localSha1.toLowerCase() === state.contentSha1.toLowerCase()) {
      logger.debug(`[skip] SHA1 unchanged after mtime shift: ${fileName}`);
      db.transaction((tx) => {
        updateChangeToken(localPath, newHash, dryRun, tx);
      });
      return { enqueue: false, storedToken: state.changeToken };
    }
  }

  return { enqueue: true, storedToken: state?.changeToken ?? null };
}

/**
 * Process a single file change event.
 * Each watcher event creates one sync job for its corresponding sync_dir.
 *
 * When mtime:size differs but a stored SHA1 exists, computes local SHA1
 * and skips enqueueing if the content hasn't actually changed (e.g. after
 * macOS reboot shifts mtimes).
 */
async function handleFileChange(file: FileChange, config: Config, dryRun: boolean): Promise<void> {
  const target = resolveSyncTarget(file, config);

  if (!target) {
    logger.warn(`[watcher] No matching sync_dir for: ${file.name}`);
    return;
  }

  const { localPath, remotePath } = target;

  // Check if path is excluded
  const excludePatterns = getConfig().exclude_patterns;
  if (isPathExcluded(localPath, file.watchRoot, excludePatterns)) {
    logger.debug(`[watcher] Skipping excluded path: ${file.name}`);
    return;
  }

  if (!file.exists) {
    // DELETE event
    db.transaction((tx) => {
      const typeLabel = file.type === 'd' ? 'dir' : 'file';
      logger.info(`[watcher] [delete] ${file.name} (type: ${typeLabel})`);

      enqueueJob(
        {
          eventType: SyncEventType.DELETE,
          localPath,
          remotePath,
          changeToken: null,
        },
        dryRun,
        tx
      );

      deleteChangeToken(localPath, dryRun, tx);
      deleteNodeMapping(localPath, remotePath, dryRun, tx);
      if (file.type === 'd') {
        deleteChangeTokensUnderPath(localPath, tx);
        deleteNodeMappingsUnderPath(localPath, remotePath, tx);
      }
    });
    return;
  }

  // File/directory exists - check if it's new or updated
  const isDirectory = file.type === 'd';
  const newHash = `${file.mtime_ms}:${file.size}`;

  if (file.new) {
    // CREATE event
    if (isDirectory) {
      db.transaction((tx) => {
        // Check if directory already synced for this remote target
        const existingMapping = getNodeMapping(localPath, remotePath, tx);
        if (existingMapping) {
          logger.debug(`[skip] create directory already synced: ${file.name} -> ${remotePath}`);
          return;
        }
        logger.info(`[watcher] [create_dir] ${file.name}`);
        enqueueJob(
          {
            eventType: SyncEventType.CREATE_DIR,
            localPath,
            remotePath,
            changeToken: newHash,
          },
          dryRun,
          tx
        );
      });
    } else {
      // File — token check + SHA1 fallback (single DB read)
      const { enqueue } = await shouldEnqueueFileChange(localPath, newHash, file.name, dryRun);
      if (enqueue) {
        logger.info(`[watcher] [create] ${file.name}`);
        db.transaction((tx) => {
          enqueueJob(
            {
              eventType: SyncEventType.CREATE_FILE,
              localPath,
              remotePath,
              changeToken: newHash,
            },
            dryRun,
            tx
          );
        });
      }
    }
    return;
  }

  // UPDATE event (file only - directory metadata changes are skipped)
  if (isDirectory) {
    logger.debug(`[skip] directory metadata change: ${file.name}`);
    return;
  }

  // File — token check + SHA1 fallback (single DB read)
  const { enqueue, storedToken } = await shouldEnqueueFileChange(
    localPath,
    newHash,
    file.name,
    dryRun
  );
  if (enqueue) {
    logger.info(
      `[watcher] [update] ${file.name} (mtime+size: ${storedToken || 'none'} -> ${newHash})`
    );
    db.transaction((tx) => {
      enqueueJob(
        {
          eventType: SyncEventType.UPDATE,
          localPath,
          remotePath,
          changeToken: newHash,
        },
        dryRun,
        tx
      );
    });
  }
}

/**
 * Process a batch of file change events (from startup scan or reconciliation).
 */
async function handleFileChangeBatch(
  files: FileChange[],
  config: Config,
  dryRun: boolean
): Promise<void> {
  for (const file of files) {
    await handleFileChange(file, config, dryRun);
  }
}

// ============================================================================
// One-Shot Sync
// ============================================================================

/**
 * Run a one-shot sync: query all changes and process them.
 */
export async function runOneShotSync(options: SyncOptions): Promise<void> {
  const { config, client, dryRun } = options;

  await initializeWatcher();

  // Clean up stale/orphaned data from previous run
  db.transaction((tx) => {
    cleanupOrphanedJobs(dryRun, tx);
    cleanupOrphanedNodeMappings(tx);
    cleanupOrphanedChangeTokens(tx);
  });

  // Query all changes and enqueue jobs
  const totalChanges = await queryAllChanges(config, (files) =>
    handleFileChangeBatch(files, config, dryRun)
  );

  if (totalChanges === 0) {
    logger.info('No changes to sync');
    return;
  }

  logger.info(`Found ${totalChanges} changes to sync`);

  // Process all jobs until queue is empty
  await drainQueue(client, dryRun);
  logger.info('Sync complete');

  closeWatcher();
}

// ============================================================================
// Watch Mode
// ============================================================================

/**
 * Run in watch mode: continuously watch for changes and process them.
 */
export async function runWatchMode(options: SyncOptions): Promise<void> {
  const { config, client, dryRun } = options;

  await initializeWatcher();

  // Initialize concurrency from config
  setSyncConcurrency(config.sync_concurrency);

  // Helper to create file change handler with current config
  const createChangeHandler = () => (files: FileChange[]) =>
    handleFileChangeBatch(files, getConfig(), dryRun);

  // Clean up stale/orphaned data from previous run
  db.transaction((tx) => {
    cleanupOrphanedJobs(dryRun, tx);
    cleanupOrphanedNodeMappings(tx);
    cleanupOrphanedChangeTokens(tx);
  });

  // Scan for changes that happened while we were offline
  logger.info('Checking for changes since last run...');
  const totalChanges = await queryAllChanges(config, createChangeHandler());
  if (totalChanges > 0) {
    logger.info(`Found ${totalChanges} changes since last run`);
  } else {
    logger.info('No changes since last run');
  }

  // Set up file watching for future changes
  await setupWatchSubscriptions(config, createChangeHandler());

  // Signal that startup is complete (daemon is ready)
  setFlag(FLAGS.STARTUP_READY);

  // Wire up config change handlers
  onConfigChange('sync_concurrency', () => {
    setSyncConcurrency(getConfig().sync_concurrency);
  });

  onConfigChange('sync_dirs', async () => {
    logger.info('sync_dirs changed, reinitializing watch subscriptions...');
    const newConfig = getConfig();
    db.transaction((tx) => {
      cleanupOrphanedJobs(dryRun, tx);
      cleanupOrphanedNodeMappings(tx);
      cleanupOrphanedChangeTokens(tx);
    });

    // Scan for changes in all sync dirs (including newly added ones)
    logger.info('Checking for changes in sync directories...');
    const totalChanges = await queryAllChanges(newConfig, createChangeHandler());
    if (totalChanges > 0) {
      logger.info(`Found ${totalChanges} changes to sync`);
    }

    await setupWatchSubscriptions(newConfig, createChangeHandler());
  });

  // Start the job processor loop
  const processorHandle = startJobProcessorLoop(client, dryRun);

  // Start background reconciliation (safety net for missed watcher events)
  const reconciliationHandle = startBackgroundReconciliation(dryRun, createChangeHandler());

  // Register reconcile signal handler
  const handleReconcile = async (): Promise<void> => {
    logger.info('Reconcile signal received, starting full filesystem scan...');
    const currentConfig = getConfig();
    await triggerFullReconciliation(currentConfig, createChangeHandler());
  };
  registerSignalHandler('reconcile', handleReconcile);

  // Wait for stop signal
  await new Promise<void>((resolve) => {
    const handleStop = (): void => {
      logger.info('Stop signal received, shutting down...');
      resolve();
    };

    const handleSigint = (): void => {
      logger.info('Ctrl+C received, shutting down...');
      resolve();
    };

    registerSignalHandler('stop', handleStop);
    process.once('SIGINT', handleSigint);
  });

  // Cleanup
  reconciliationHandle.stop();
  await processorHandle.stop();
}

// ============================================================================
// Background Reconciliation
// ============================================================================

interface BackgroundReconciliationHandle {
  stop: () => void;
}

/**
 * Start background reconciliation that runs periodically.
 * Slowly walks the filesystem to catch any missed watcher events.
 */
function startBackgroundReconciliation(
  dryRun: boolean,
  onFileChangeBatch: (files: FileChange[]) => void | Promise<void>
): BackgroundReconciliationHandle {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let running = true;

  const runReconciliation = async (): Promise<void> => {
    if (!running) return;

    // Skip if queue is busy
    const pendingJobs = getPendingJobCount();
    if (pendingJobs > BACKGROUND_RECONCILIATION_SKIP_THRESHOLD) {
      logger.debug(
        `Skipping background reconciliation: ${pendingJobs} jobs pending (threshold: ${BACKGROUND_RECONCILIATION_SKIP_THRESHOLD})`
      );
      if (running) {
        timeoutId = setTimeout(runReconciliation, BACKGROUND_RECONCILIATION_INTERVAL_MS);
      }
      return;
    }

    logger.debug('Starting background reconciliation...');
    let totalChanges = 0;
    const currentConfig = getConfig();
    const excludePatterns = currentConfig.exclude_patterns;

    for (const dir of currentConfig.sync_dirs) {
      if (!running) break;

      const watchDir = dir.source_path;
      if (!existsSync(watchDir)) continue;

      // Use throttled scan to minimize CPU/memory impact
      const fsState = await scanDirectory(
        watchDir,
        excludePatterns,
        BACKGROUND_RECONCILIATION_THROTTLE_MS
      );

      const storedTokens = getAllStoredChangeTokens(watchDir);
      const changes = compareWithStoredChangeTokens(watchDir, fsState, storedTokens);

      if (changes.length > 0) {
        for (const change of changes) {
          logger.debug(
            `[reconcile] Found missed change: ${change.name} (${change.exists ? 'exists' : 'deleted'})`
          );
        }
        await onFileChangeBatch(changes);
        totalChanges += changes.length;
      }
    }

    logger.debug(`Background reconciliation complete: ${totalChanges} changes found`);

    // Schedule next run
    if (running) {
      timeoutId = setTimeout(runReconciliation, BACKGROUND_RECONCILIATION_INTERVAL_MS);
    }
  };

  // Schedule first run after interval (not immediately on startup)
  timeoutId = setTimeout(runReconciliation, BACKGROUND_RECONCILIATION_INTERVAL_MS);

  return {
    stop: () => {
      running = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
  };
}

// ============================================================================
// Job Processor Loop
// ============================================================================

interface ProcessorHandle {
  stop: () => Promise<void>;
}

/**
 * Start the job processor loop that polls for pending jobs.
 */
function startJobProcessorLoop(client: ProtonDriveClient, dryRun: boolean): ProcessorHandle {
  let running = true;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let loopCount = 0;
  const blockedRecoveryIntervalLoops = Math.ceil(60_000 / JOB_POLL_INTERVAL_MS); // ~1 minute
  const processLoop = (): void => {
    loopCount++;

    // Debug log occasionally to ensure the loop is alive
    if (loopCount % 25 === 0) {
      logger.debug('processLoop iteration');
    }
    if (!running) return;

    const paused = isPaused();

    // Always send heartbeat (merged with job processing)
    sendStatusToDashboard({ paused });

    if (!paused) {
      // Periodically recover blocked jobs caused by transient remote/local races.
      if (loopCount % blockedRecoveryIntervalLoops === 0) {
        recoverBlockedJobs(dryRun);
      }
      processAvailableJobs(client, dryRun);
    }

    if (running) {
      timeoutId = setTimeout(processLoop, JOB_POLL_INTERVAL_MS);
    }
  };

  // Start the loop
  processLoop();

  return {
    stop: async () => {
      running = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      // Wait for active tasks to complete (with timeout)
      const timeoutPromise = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS)
      );
      const result = await Promise.race([
        waitForActiveTasks().then(() => 'done' as const),
        timeoutPromise,
      ]);
      if (result === 'timeout') {
        logger.warn(`Shutdown timeout: ${getActiveTaskCount()} tasks abandoned`);
      }
    },
  };
}
