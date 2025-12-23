/**
 * Sync Job Processor
 *
 * Executes sync jobs: create/update/delete operations against Proton Drive.
 */

import { SyncEventType } from '../db/schema.js';
import { createNode } from '../proton/create.js';
import { deleteNode } from '../proton/delete.js';
import { logger } from '../logger.js';
import { registerSignalHandler, unregisterSignalHandler } from '../signals.js';
import type { ProtonDriveClient } from '../proton/types.js';
import type { Config } from '../config.js';
import {
  getNextPendingJob,
  markJobSynced,
  markJobBlocked,
  setJobError,
  categorizeError,
  scheduleRetry,
  ErrorCategory,
} from './queue.js';

// ============================================================================
// Helper Functions
// ============================================================================

/** Extract error message from unknown error */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Helper to delete a node, throws on failure */
async function deleteNodeOrThrow(
  client: ProtonDriveClient,
  remotePath: string,
  dryRun: boolean
): Promise<{ existed: boolean }> {
  if (dryRun) return { existed: false };
  const result = await deleteNode(client, remotePath, false);
  if (!result.success) {
    throw new Error(result.error);
  }
  return { existed: result.existed };
}

/** Helper to create/update a node, throws on failure */
async function createNodeOrThrow(
  client: ProtonDriveClient,
  localPath: string,
  remotePath: string,
  dryRun: boolean
): Promise<string> {
  if (dryRun) return 'dry-run-node-uid';
  const result = await createNode(client, localPath, remotePath);
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.nodeUid!;
}

/** Helper to delete and recreate a node */
async function deleteAndRecreateNode(
  client: ProtonDriveClient,
  localPath: string,
  remotePath: string,
  dryRun: boolean
): Promise<string> {
  await deleteNodeOrThrow(client, remotePath, dryRun);
  logger.info(`Deleted node ${remotePath}, now recreating`);
  const nodeUid = await createNodeOrThrow(client, localPath, remotePath, dryRun);
  logger.info(`Successfully recreated node: ${remotePath} -> ${nodeUid}`);
  return nodeUid;
}

// ============================================================================
// Job Processing
// ============================================================================

/**
 * Process a single job from the queue.
 * Returns true if a job was processed, false if queue is empty.
 */
export async function processNextJob(client: ProtonDriveClient, dryRun: boolean): Promise<boolean> {
  const job = getNextPendingJob(dryRun);
  if (!job) return false;

  const { id, eventType, localPath, remotePath, nRetries } = job;

  try {
    if (eventType === SyncEventType.DELETE) {
      logger.info(`Deleting: ${remotePath}`);
      const { existed } = await deleteNodeOrThrow(client, remotePath!, dryRun);
      logger.info(existed ? `Deleted: ${remotePath}` : `Already gone: ${remotePath}`);
    } else {
      const typeLabel = eventType === SyncEventType.CREATE ? 'Creating' : 'Updating';
      logger.info(`${typeLabel}: ${remotePath}`);
      const nodeUid = await createNodeOrThrow(client, localPath, remotePath!, dryRun);
      logger.info(`Success: ${remotePath} -> ${nodeUid}`);
    }

    markJobSynced(id, localPath, dryRun);
    return true;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const { category: errorCategory, maxRetries } = categorizeError(errorMessage);

    setJobError(id, errorMessage, dryRun);

    if (errorCategory === ErrorCategory.OTHER && nRetries >= maxRetries) {
      logger.error(
        `Job ${id} (${localPath}) failed permanently after ${maxRetries} retries: ${errorMessage}`
      );
      markJobBlocked(id, localPath, errorMessage, dryRun);
    } else if (errorCategory === ErrorCategory.REUPLOAD_NEEDED && nRetries >= maxRetries) {
      // Proton drive draft revision state corruption - delete and recreate
      logger.warn(
        `Job ${id} (${localPath}) hit max draft revision retries (${maxRetries}), deleting and recreating`
      );
      try {
        await deleteAndRecreateNode(client, localPath, remotePath!, dryRun);
        markJobSynced(id, localPath, dryRun);
      } catch (recreateError) {
        const recreateErrorMsg = getErrorMessage(recreateError);
        logger.error(`Failed to delete+recreate node: ${recreateErrorMsg}`);
        setJobError(id, recreateErrorMsg, dryRun);
        scheduleRetry(id, localPath, 0, errorCategory, dryRun);
      }
    } else {
      logger.error(`Job ${id} (${localPath}) failed: ${errorMessage}`);
      scheduleRetry(id, localPath, nRetries, errorCategory, dryRun);
    }

    return true;
  }
}

/**
 * Process all pending jobs in the queue with concurrency.
 * Stops processing if a stop signal is received.
 * Returns the number of jobs processed.
 */
export async function processAllPendingJobs(
  client: ProtonDriveClient,
  config: Config,
  dryRun: boolean
): Promise<number> {
  let count = 0;
  let stopRequested = false;

  const handleStop = (): void => {
    stopRequested = true;
  };
  registerSignalHandler('stop', handleStop);

  try {
    // Process jobs with up to sync_concurrency in parallel using a worker pool pattern
    const activeJobs = new Set<Promise<boolean>>();

    const startNextJob = (): void => {
      if (stopRequested) return;
      const jobPromise = processNextJob(client, dryRun).then((processed) => {
        activeJobs.delete(jobPromise);
        if (processed) {
          count++;
          startNextJob(); // Replenish the pool
        }
        return processed;
      });
      activeJobs.add(jobPromise);
    };

    // Start initial batch of concurrent jobs
    for (let i = 0; i < config.sync_concurrency; i++) {
      startNextJob();
    }

    // Wait for pool to drain
    while (activeJobs.size > 0) {
      await Promise.race(activeJobs);
    }
  } finally {
    unregisterSignalHandler('stop', handleStop);
  }

  return count;
}
