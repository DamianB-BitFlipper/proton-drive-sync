/**
 * Sync Engine
 *
 * Orchestrates the sync process: coordinates watcher, queue, and processor.
 * Includes inode-based rename/move detection and content hash comparison.
 */

import { join, basename, dirname } from 'path';
import { db } from '../db/index.js';
import { SyncEventType } from '../db/schema.js';
import { logger } from '../logger.js';
import { registerSignalHandler } from '../signals.js';
import { isPaused } from '../flags.js';
import { sendStatusToDashboard } from '../dashboard/server.js';
import { getConfig, onConfigChange } from '../config.js';
import { cleanupOrphanedClocks } from '../state.js';
import type { Config } from '../config.js';
import type { ProtonDriveClient } from '../proton/types.js';
import {
  connectWatchman,
  closeWatchman,
  queryAllChanges,
  setupWatchSubscriptions,
  type FileChange,
} from './watcher.js';
import { enqueueJob, cleanupOrphanedJobs } from './queue.js';
import {
  processAvailableJobs,
  waitForActiveTasks,
  getActiveTaskCount,
  drainQueue,
  setSyncConcurrency,
} from './processor.js';
import {
  getStoredHash,
  deleteStoredHash,
  deleteStoredHashesUnderPath,
  cleanupOrphanedHashes,
} from './hashes.js';
import {
  getNodeMapping,
  deleteNodeMapping,
  deleteNodeMappingsUnderPath,
  cleanupOrphanedNodeMappings,
} from './nodes.js';
import { JOB_POLL_INTERVAL_MS, SHUTDOWN_TIMEOUT_MS } from './constants.js';

// ============================================================================
// Types
// ============================================================================

export interface SyncOptions {
  config: Config;
  client: ProtonDriveClient;
  dryRun: boolean;
  watch: boolean;
}

interface FileChangeWithPaths extends FileChange {
  localPath: string;
  remotePath: string;
}

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Build local and remote paths for a file change event.
 */
function buildPaths(file: FileChange, config: Config): { localPath: string; remotePath: string } {
  const localPath = join(file.watchRoot, file.name);

  // Find the sync dir config for this watch root
  const syncDir = config.sync_dirs.find((d) => file.watchRoot.startsWith(d.source_path));
  const remoteRoot = syncDir?.remote_root || '';

  // Build remote path: remote_root/dirName/file.name
  const dirName = basename(file.watchRoot);
  const remotePath = remoteRoot
    ? `${remoteRoot}/${dirName}/${file.name}`
    : `${dirName}/${file.name}`;

  return { localPath, remotePath };
}

// ============================================================================
// Batch File Change Handler
// ============================================================================

/**
 * Process a batch of file change events with rename/move detection.
 */
function handleFileChangeBatch(files: FileChange[], config: Config, dryRun: boolean): void {
  if (files.length === 0) return;

  // Augment files with computed paths
  const filesWithPaths: FileChangeWithPaths[] = files.map((file) => ({
    ...file,
    ...buildPaths(file, config),
  }));

  // Separate events by type
  const deletes = filesWithPaths.filter((f) => !f.exists);
  const creates = filesWithPaths.filter((f) => f.exists && f.new);
  const updates = filesWithPaths.filter((f) => f.exists && !f.new);

  // Build inode maps for rename/move detection
  const deletesByIno = new Map<number, FileChangeWithPaths>();
  for (const file of deletes) {
    deletesByIno.set(file.ino, file);
  }

  const createsByIno = new Map<number, FileChangeWithPaths>();
  for (const file of creates) {
    createsByIno.set(file.ino, file);
  }

  // Match renames/moves (same ino in both maps)
  const renames: Array<{ from: FileChangeWithPaths; to: FileChangeWithPaths }> = [];
  for (const [ino, deleteFile] of deletesByIno) {
    const createFile = createsByIno.get(ino);
    if (createFile) {
      renames.push({ from: deleteFile, to: createFile });
      deletesByIno.delete(ino);
      createsByIno.delete(ino);
    }
  }

  // Process all database operations in a single transaction
  db.transaction((tx) => {
    // Process renames/moves
    for (const { from, to } of renames) {
      const fromParent = dirname(from.localPath);
      const toParent = dirname(to.localPath);
      const isSameParent = fromParent === toParent;

      // Check if we have node mapping for the old path (required for rename/move)
      const nodeMapping = getNodeMapping(from.localPath, tx);

      if (!nodeMapping) {
        // No mapping found - fall back to DELETE + CREATE
        logger.debug(`No node mapping for ${from.localPath}, falling back to DELETE + CREATE`);

        // Enqueue DELETE for old path
        enqueueJob(
          {
            eventType: SyncEventType.DELETE,
            localPath: from.localPath,
            remotePath: from.remotePath,
            contentHash: null,
            oldLocalPath: null,
            oldRemotePath: null,
          },
          dryRun,
          tx
        );
        deleteStoredHash(from.localPath, tx);
        deleteNodeMapping(from.localPath, tx);
        if (from.type === 'd') {
          deleteStoredHashesUnderPath(from.localPath, tx);
          deleteNodeMappingsUnderPath(from.localPath, tx);
        }

        // Enqueue CREATE for new path
        const eventType = SyncEventType.CREATE;
        const contentHash = to['content.sha1hex'] ?? null;
        logger.info(`[fallback create] ${to.name} (type: ${to.type === 'd' ? 'dir' : 'file'})`);
        enqueueJob(
          {
            eventType,
            localPath: to.localPath,
            remotePath: to.remotePath,
            contentHash,
            oldLocalPath: null,
            oldRemotePath: null,
          },
          dryRun,
          tx
        );

        continue;
      }

      // We have mapping - enqueue RENAME or MOVE
      const eventType = isSameParent ? SyncEventType.RENAME : SyncEventType.MOVE;
      const typeLabel = to.type === 'd' ? 'dir' : 'file';
      logger.info(`[${eventType.toLowerCase()}] ${from.name} -> ${to.name} (type: ${typeLabel})`);

      enqueueJob(
        {
          eventType,
          localPath: to.localPath,
          remotePath: to.remotePath,
          contentHash: to['content.sha1hex'] ?? null,
          oldLocalPath: from.localPath,
          oldRemotePath: from.remotePath,
        },
        dryRun,
        tx
      );
    }

    // Process remaining deletes
    for (const file of deletesByIno.values()) {
      const typeLabel = file.type === 'd' ? 'dir' : 'file';
      logger.info(`[delete] ${file.name} (type: ${typeLabel})`);

      enqueueJob(
        {
          eventType: SyncEventType.DELETE,
          localPath: file.localPath,
          remotePath: file.remotePath,
          contentHash: null,
          oldLocalPath: null,
          oldRemotePath: null,
        },
        dryRun,
        tx
      );

      deleteStoredHash(file.localPath, tx);
      deleteNodeMapping(file.localPath, tx);
      if (file.type === 'd') {
        deleteStoredHashesUnderPath(file.localPath, tx);
        deleteNodeMappingsUnderPath(file.localPath, tx);
      }
    }

    // Process remaining creates
    for (const file of createsByIno.values()) {
      const typeLabel = file.type === 'd' ? 'dir' : 'file';
      logger.info(`[create] ${file.name} (type: ${typeLabel})`);

      enqueueJob(
        {
          eventType: SyncEventType.CREATE,
          localPath: file.localPath,
          remotePath: file.remotePath,
          contentHash: file['content.sha1hex'] ?? null,
          oldLocalPath: null,
          oldRemotePath: null,
        },
        dryRun,
        tx
      );
    }

    // Process updates (files only, directories ignored)
    for (const file of updates) {
      if (file.type === 'd') {
        // Directory metadata change - skip
        logger.debug(`[skip] directory metadata change: ${file.name}`);
        continue;
      }

      // File update - compare hash
      const storedHash = getStoredHash(file.localPath, tx);
      const newHash = file['content.sha1hex'];

      if (storedHash && storedHash === newHash) {
        // Content unchanged - skip
        logger.debug(`[skip] hash unchanged: ${file.name}`);
        continue;
      }

      logger.info(
        `[update] ${file.name} (hash: ${storedHash?.slice(0, 8) || 'none'} -> ${newHash?.slice(0, 8) || 'none'})`
      );

      enqueueJob(
        {
          eventType: SyncEventType.UPDATE,
          localPath: file.localPath,
          remotePath: file.remotePath,
          contentHash: newHash ?? null,
          oldLocalPath: null,
          oldRemotePath: null,
        },
        dryRun,
        tx
      );
    }
  });
}

// ============================================================================
// One-Shot Sync
// ============================================================================

/**
 * Run a one-shot sync: query all changes and process them.
 */
export async function runOneShotSync(options: SyncOptions): Promise<void> {
  const { config, client, dryRun } = options;

  await connectWatchman();

  // Clean up stale/orphaned data from previous run
  db.transaction((tx) => {
    cleanupOrphanedJobs(dryRun, tx);
    cleanupOrphanedHashes(tx);
    cleanupOrphanedNodeMappings(tx);
  });

  // Query all changes and enqueue jobs (batch handler)
  const totalChanges = await queryAllChanges(
    config,
    (files) => handleFileChangeBatch(files, config, dryRun),
    dryRun
  );

  if (totalChanges === 0) {
    logger.info('No changes to sync');
    return;
  }

  logger.info(`Found ${totalChanges} changes to sync`);

  // Process all jobs until queue is empty
  await drainQueue(client, dryRun);
  logger.info('Sync complete');

  closeWatchman();
}

// ============================================================================
// Watch Mode
// ============================================================================

/**
 * Run in watch mode: continuously watch for changes and process them.
 */
export async function runWatchMode(options: SyncOptions): Promise<void> {
  const { config, client, dryRun } = options;

  await connectWatchman();

  // Initialize concurrency from config
  setSyncConcurrency(config.sync_concurrency);

  // Helper to create file change batch handler with current config
  const createBatchHandler = () => (files: FileChange[]) =>
    handleFileChangeBatch(files, getConfig(), dryRun);

  // Clean up stale/orphaned data from previous run
  db.transaction((tx) => {
    cleanupOrphanedJobs(dryRun, tx);
    cleanupOrphanedClocks(dryRun, tx);
    cleanupOrphanedHashes(tx);
    cleanupOrphanedNodeMappings(tx);
  });

  // Set up file watching
  await setupWatchSubscriptions(config, createBatchHandler(), dryRun);

  // Wire up config change handlers
  onConfigChange('sync_concurrency', () => {
    setSyncConcurrency(getConfig().sync_concurrency);
  });

  onConfigChange('sync_dirs', async () => {
    logger.info('sync_dirs changed, reinitializing watch subscriptions...');
    const newConfig = getConfig();
    db.transaction((tx) => {
      cleanupOrphanedJobs(dryRun, tx);
      cleanupOrphanedClocks(dryRun, tx);
      cleanupOrphanedHashes(tx);
      cleanupOrphanedNodeMappings(tx);
    });
    await setupWatchSubscriptions(newConfig, createBatchHandler(), dryRun);
  });

  // Start the job processor loop
  const processorHandle = startJobProcessorLoop(client, dryRun);

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
  await processorHandle.stop();
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

  const processLoop = (): void => {
    if (!running) return;

    const paused = isPaused();

    // Always send heartbeat (merged with job processing)
    sendStatusToDashboard({ paused });

    if (!paused) {
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
