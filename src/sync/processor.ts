/**
 * Sync Job Processor
 *
 * Executes sync jobs: create/update/delete operations against Proton Drive.
 */

import { SyncEventType } from '../db/schema.js';
import { createNode } from '../proton/create.js';
import { deleteNode } from '../proton/delete.js';
import { logger } from '../logger.js';
import { DEFAULT_SYNC_CONCURRENCY } from '../config.js';
import type { ProtonDriveClient } from '../proton/types.js';
import {
  getNextPendingJob,
  markJobSynced,
  markJobBlocked,
  setJobError,
  categorizeError,
  scheduleRetry,
  ErrorCategory,
  REUPLOAD_DELETE_RECREATE_THRESHOLD,
} from './queue.js';

// ============================================================================
// Task Pool State (persistent across iterations)
// ============================================================================

/** Active tasks: jobId -> promise */
const activeTasks = new Map<number, Promise<void>>();

// ============================================================================
// Dynamic Concurrency
// ============================================================================

/** Current sync concurrency - can be updated via config change */
let syncConcurrency = DEFAULT_SYNC_CONCURRENCY;

/** Update the sync concurrency value */
export function setSyncConcurrency(value: number): void {
  syncConcurrency = value;
  logger.info(`Sync concurrency updated to ${value}`);
}

// ============================================================================
// Task Pool Management
// ============================================================================

/**
 * Wait for all active tasks to complete.
 */
export function waitForActiveTasks(): Promise<void> {
  return Promise.all(activeTasks.values()).then(() => {});
}

/**
 * Get the number of currently active tasks.
 */
export function getActiveTaskCount(): number {
  return activeTasks.size;
}

/**
 * Process all pending jobs until queue is empty (blocking).
 * Used for one-shot sync mode.
 */
export async function drainQueue(client: ProtonDriveClient, dryRun: boolean): Promise<void> {
  // Keep processing until no more jobs and no active tasks
  while (true) {
    processAvailableJobs(client, dryRun);

    if (activeTasks.size === 0) {
      // Check if there are more jobs (could have been added during processing)
      const job = getNextPendingJob(dryRun);
      if (!job) break; // Queue is truly empty

      // Process it directly
      const jobId = job.id;
      const taskPromise = processJob(client, job, dryRun).finally(() => {
        activeTasks.delete(jobId);
      });
      activeTasks.set(jobId, taskPromise);
    }

    // Wait for at least one task to complete
    if (activeTasks.size > 0) {
      await Promise.race(activeTasks.values());
    }
  }
}

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
  const result = await deleteNode(client, remotePath);
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
  logger.info(`Deleting node for recreate: ${remotePath}`);
  await deleteNodeOrThrow(client, remotePath, dryRun);
  logger.info(`Deleted node ${remotePath}, now recreating`);
  const nodeUid = await createNodeOrThrow(client, localPath, remotePath, dryRun);
  logger.info(`Successfully recreated node: ${remotePath} -> ${nodeUid}`);
  return nodeUid;
}

/**
 * Process available jobs up to concurrency limit (non-blocking).
 * Spawns new tasks to fill available capacity and returns immediately.
 * Call this periodically to keep the task pool saturated.
 */
export function processAvailableJobs(client: ProtonDriveClient, dryRun: boolean): void {
  // Calculate available capacity
  const availableSlots = syncConcurrency - activeTasks.size;
  if (availableSlots <= 0) return;

  // Spawn tasks to fill available slots
  for (let i = 0; i < availableSlots; i++) {
    const job = getNextPendingJob(dryRun);
    if (!job) break; // No more pending jobs

    const jobId = job.id;

    // Start the job and track it
    const taskPromise = processJob(client, job, dryRun).finally(() => {
      activeTasks.delete(jobId);
    });

    activeTasks.set(jobId, taskPromise);
  }
}

/**
 * Process a single job (internal helper).
 */
async function processJob(
  client: ProtonDriveClient,
  job: {
    id: number;
    eventType: SyncEventType;
    localPath: string;
    remotePath: string | null;
    nRetries: number;
  },
  dryRun: boolean
): Promise<void> {
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
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const { category: errorCategory, maxRetries } = categorizeError(errorMessage);

    setJobError(id, errorMessage, dryRun);

    if (errorCategory === ErrorCategory.OTHER && nRetries >= maxRetries) {
      logger.error(
        `Job ${id} (${localPath}) failed permanently after ${maxRetries} retries: ${errorMessage}`
      );
      markJobBlocked(id, localPath, errorMessage, dryRun);
    } else if (errorCategory === ErrorCategory.REUPLOAD_NEEDED) {
      if (nRetries >= maxRetries) {
        // Exceeded max retries, move to blocked queue
        logger.error(
          `Job ${id} (${localPath}) failed permanently after ${maxRetries} retries: ${errorMessage}`
        );
        markJobBlocked(id, localPath, errorMessage, dryRun);
      } else if (nRetries >= REUPLOAD_DELETE_RECREATE_THRESHOLD) {
        // Retry count >= 2, attempt delete+recreate
        logger.warn(`Job ${id} (${localPath}) retry ${nRetries}, attempting delete+recreate`);
        try {
          await deleteAndRecreateNode(client, localPath, remotePath!, dryRun);
          markJobSynced(id, localPath, dryRun);
        } catch (recreateError) {
          const recreateErrorMsg = getErrorMessage(recreateError);
          logger.error(`Failed to delete+recreate node: ${recreateErrorMsg}`);
          setJobError(id, recreateErrorMsg, dryRun);
          scheduleRetry(id, localPath, nRetries, errorCategory, dryRun);
        }
      } else {
        // Retry count < 2, normal retry
        logger.error(`Job ${id} (${localPath}) failed: ${errorMessage}`);
        scheduleRetry(id, localPath, nRetries, errorCategory, dryRun);
      }
    } else {
      logger.error(`Job ${id} (${localPath}) failed: ${errorMessage}`);
      scheduleRetry(id, localPath, nRetries, errorCategory, dryRun);
    }
  }
}
