/**
 * Sync Engine
 *
 * Orchestrates the sync process: coordinates watcher, queue, and processor.
 */

import { join, basename } from 'path';
import { SyncEventType } from '../db/schema.js';
import { logger } from '../logger.js';
import { registerSignalHandler } from '../signals.js';
import { setFlag, clearFlag, isPaused, FLAGS } from '../flags.js';
import { stopDashboard } from '../dashboard/server.js';
import type { Config } from '../config.js';
import type { ProtonDriveClient } from '../proton/types.js';
import {
  waitForWatchman,
  closeWatchman,
  queryAllChanges,
  setupWatchSubscriptions,
  type FileChange,
} from './watcher.js';
import { enqueueJob } from './queue.js';
import { processAllPendingJobs } from './processor.js';

// ============================================================================
// Constants
// ============================================================================

// Polling interval for processing jobs in watch mode (10 seconds)
const JOB_POLL_INTERVAL_MS = 10_000;

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
// File Change Handler
// ============================================================================

/**
 * Convert a file change event to a sync job and enqueue it.
 */
function handleFileChange(file: FileChange, config: Config, dryRun: boolean): void {
  const localPath = join(file.watchRoot, file.name);

  // Find the sync dir config for this watch root
  const syncDir = config.sync_dirs.find((d) => file.watchRoot.startsWith(d.source_path));
  const remoteRoot = syncDir?.remote_root || '';

  // Build remote path: remote_root/dirName/file.name
  const dirName = basename(file.watchRoot);
  const remotePath = remoteRoot
    ? `${remoteRoot}/${dirName}/${file.name}`
    : `${dirName}/${file.name}`;

  // Determine event type
  let eventType: SyncEventType;
  if (!file.exists) {
    eventType = SyncEventType.DELETE;
  } else if (file.new) {
    eventType = SyncEventType.CREATE;
  } else {
    eventType = SyncEventType.UPDATE;
  }

  // Log the change with details
  const status = file.exists ? (file.type === 'd' ? 'dir changed' : 'changed') : 'deleted';
  const typeLabel = file.type === 'd' ? 'dir' : 'file';
  logger.debug(`[${status}] ${file.name} (size: ${file.size ?? 0}, type: ${typeLabel})`);
  logger.debug(`Enqueueing ${eventType} job for ${typeLabel}: ${file.name}`);

  // Enqueue the job
  enqueueJob({ eventType, localPath, remotePath }, dryRun);
}

// ============================================================================
// One-Shot Sync
// ============================================================================

/**
 * Run a one-shot sync: query all changes and process them.
 */
export async function runOneShotSync(options: SyncOptions): Promise<void> {
  const { config, client, dryRun } = options;

  await waitForWatchman();

  // Query all changes and enqueue jobs
  const totalChanges = await queryAllChanges(
    config,
    (file) => handleFileChange(file, config, dryRun),
    dryRun
  );

  if (totalChanges === 0) {
    logger.info('No changes to sync');
    return;
  }

  logger.info(`Found ${totalChanges} changes to sync`);

  // Process all jobs
  const processed = await processAllPendingJobs(client, config, dryRun);
  logger.info(`Processed ${processed} jobs`);

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

  await waitForWatchman();

  // Set up file watching
  await setupWatchSubscriptions(config, (file) => handleFileChange(file, config, dryRun), dryRun);

  // Start the job processor loop
  const processorHandle = startJobProcessorLoop(client, config, dryRun);

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
  processorHandle.stop();
  stopDashboard();
  closeWatchman();
}

// ============================================================================
// Job Processor Loop
// ============================================================================

interface ProcessorHandle {
  stop: () => void;
  isPaused: () => boolean;
}

/**
 * Start the job processor loop that polls for pending jobs.
 */
function startJobProcessorLoop(
  client: ProtonDriveClient,
  config: Config,
  dryRun: boolean
): ProcessorHandle {
  let running = true;
  let paused = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  // Register pause/resume signal handlers
  const handlePause = (): void => {
    paused = true;
    setFlag(FLAGS.PAUSED);
    logger.info('Sync paused');
  };

  const handleResume = (): void => {
    paused = false;
    clearFlag(FLAGS.PAUSED);
    logger.info('Sync resumed');
  };

  // Check if we were paused before restart (hot reload)
  if (isPaused()) {
    paused = true;
    logger.info('Sync is paused (restored from previous state)');
  }

  registerSignalHandler('pause-sync', handlePause);
  registerSignalHandler('resume-sync', handleResume);

  const processLoop = async (): Promise<void> => {
    if (!running) return;

    if (paused) {
      // When paused, just reschedule without processing
      if (running) {
        timeoutId = setTimeout(processLoop, JOB_POLL_INTERVAL_MS);
      }
      return;
    }

    const startTime = Date.now();
    logger.debug('Job processor polling...');

    try {
      const processed = await processAllPendingJobs(client, config, dryRun);
      if (processed > 0) {
        logger.info(`Processed ${processed} sync job(s)`);
      }
    } catch (error) {
      logger.error(`Job processor error: ${error}`);
    }

    if (running) {
      const elapsed = Date.now() - startTime;
      const delay = Math.max(0, JOB_POLL_INTERVAL_MS - elapsed);
      timeoutId = setTimeout(processLoop, delay);
    }
  };

  // Start the loop
  processLoop();

  return {
    stop: () => {
      running = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
    isPaused: () => paused,
  };
}
