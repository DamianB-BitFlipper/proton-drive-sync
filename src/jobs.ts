/**
 * Proton Drive Sync - Job Queue
 *
 * Manages the sync job queue for buffered file operations.
 */

import { eq, and, lte } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { SyncJobStatus, SyncEventType } from './db/schema.js';
import { createNode } from './create.js';
import { deleteNode } from './delete.js';
import { logger } from './logger.js';
import type { ProtonDriveClient } from './types.js';

// ============================================================================
// Constants
// ============================================================================

// Retry delays in seconds (×4 exponential backoff, capped at ~1 week)
const RETRY_DELAYS_SEC = [
  1,
  4,
  16,
  64,
  256, // ~4 minutes
  1024, // ~17 minutes
  4096, // ~1 hour
  16384, // ~4.5 hours
  65536, // ~18 hours
  262144, // ~3 days
  604800, // ~1 week (cap)
];

const MAX_RETRIES = RETRY_DELAYS_SEC.length;

// Jitter as percentage of retry delay (0.25 = 25%)
const JITTER_FACTOR = 0.25;

// ============================================================================
// Job Queue Functions
// ============================================================================

/**
 * Add a sync job to the queue.
 * No-op if dryRun is true.
 */
export function enqueueJob(
  params: {
    eventType: SyncEventType;
    localPath: string;
    remotePath: string;
  },
  dryRun: boolean
): void {
  if (dryRun) return;
  db.insert(schema.syncJobs)
    .values({
      eventType: params.eventType,
      localPath: params.localPath,
      remotePath: params.remotePath,
      status: SyncJobStatus.PENDING,
      retryAt: new Date(),
      nRetries: 0,
      lastError: null,
    })
    .run();
}

/**
 * Get the next pending job that's ready to be processed.
 */
export function getNextPendingJob() {
  return db
    .select()
    .from(schema.syncJobs)
    .where(
      and(
        eq(schema.syncJobs.status, SyncJobStatus.PENDING),
        lte(schema.syncJobs.retryAt, new Date())
      )
    )
    .orderBy(schema.syncJobs.retryAt)
    .limit(1)
    .get();
}

/**
 * Mark a job as synced (completed successfully).
 * No-op if dryRun is true.
 */
export function markJobSynced(jobId: number, dryRun: boolean): void {
  if (dryRun) return;
  db.update(schema.syncJobs)
    .set({ status: SyncJobStatus.SYNCED, lastError: null })
    .where(eq(schema.syncJobs.id, jobId))
    .run();
}

/**
 * Mark a job as blocked (failed permanently after max retries).
 * No-op if dryRun is true.
 */
export function markJobBlocked(jobId: number, error: string, dryRun: boolean): void {
  if (dryRun) return;
  db.update(schema.syncJobs)
    .set({ status: SyncJobStatus.BLOCKED, lastError: error })
    .where(eq(schema.syncJobs.id, jobId))
    .run();
}

// Index in RETRY_DELAYS_SEC for 256s (~4 min) - network errors cap here
const NETWORK_RETRY_CAP_INDEX = 4;

/** Check if an error message indicates a network error */
function isNetworkError(error: string): boolean {
  const networkPatterns = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'socket hang up',
    'network',
    'timeout',
    'connection',
  ];
  const lowerError = error.toLowerCase();
  return networkPatterns.some((pattern) => lowerError.includes(pattern.toLowerCase()));
}

/**
 * Schedule a job for retry with exponential backoff and jitter.
 * Network errors are retried indefinitely at max ~4 min intervals.
 * No-op if dryRun is true.
 */
export function scheduleRetry(
  jobId: number,
  nRetries: number,
  error: string,
  isNetworkError: boolean,
  dryRun: boolean
): void {
  if (dryRun) return;

  // For network errors, cap delay at 256s (~4 min) and don't increment retries beyond that
  const effectiveRetries = isNetworkError ? Math.min(nRetries, NETWORK_RETRY_CAP_INDEX) : nRetries;

  // Get delay from array (use last value if beyond array length)
  const delayIndex = Math.min(effectiveRetries, RETRY_DELAYS_SEC.length - 1);
  const baseDelaySec = RETRY_DELAYS_SEC[delayIndex];

  // Add jitter (±JITTER_FACTOR of base delay)
  const jitterSec = baseDelaySec * JITTER_FACTOR * (Math.random() * 2 - 1);
  const delaySec = Math.max(1, baseDelaySec + jitterSec);
  const retryAt = new Date(Date.now() + delaySec * 1000);

  // For network errors, don't increment nRetries beyond the cap (retry indefinitely)
  const newRetries = isNetworkError
    ? Math.min(nRetries + 1, NETWORK_RETRY_CAP_INDEX + 1)
    : nRetries + 1;

  db.update(schema.syncJobs)
    .set({
      nRetries: newRetries,
      retryAt,
      lastError: error,
    })
    .where(eq(schema.syncJobs.id, jobId))
    .run();

  if (isNetworkError) {
    logger.info(`Job ${jobId} (network error) scheduled for retry in ${Math.round(delaySec)}s`);
  } else {
    logger.info(
      `Job ${jobId} scheduled for retry in ${Math.round(delaySec)}s (attempt ${newRetries}/${MAX_RETRIES})`
    );
  }
}

/**
 * Process a single job from the queue.
 * Returns true if a job was processed, false if queue is empty.
 */
export async function processNextJob(client: ProtonDriveClient, dryRun: boolean): Promise<boolean> {
  const job = getNextPendingJob();
  if (!job) return false;

  const { id, eventType, localPath, remotePath, nRetries } = job;

  try {
    if (eventType === SyncEventType.DELETE) {
      logger.info(`Deleting: ${remotePath}`);
      const result = await deleteNode(client, remotePath, false);

      if (!result.success) {
        throw new Error(result.error);
      }

      if (result.existed) {
        logger.info(`Deleted: ${remotePath}`);
      } else {
        logger.info(`Already gone: ${remotePath}`);
      }
    } else {
      // CREATE or UPDATE
      const typeLabel = eventType === SyncEventType.CREATE ? 'Creating' : 'Updating';

      logger.info(`${typeLabel}: ${remotePath}`);
      const result = await createNode(client, localPath, remotePath);

      if (!result.success) {
        throw new Error(result.error);
      }

      logger.info(`Success: ${remotePath} -> ${result.nodeUid}`);
    }

    // Job completed successfully
    markJobSynced(id, dryRun);

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const networkError = isNetworkError(errorMessage);

    if (!networkError && nRetries >= MAX_RETRIES) {
      logger.error(`Job ${id} failed permanently after ${MAX_RETRIES} retries: ${errorMessage}`);
      markJobBlocked(id, errorMessage, dryRun);
    } else {
      scheduleRetry(id, nRetries, errorMessage, networkError, dryRun);
    }

    return true;
  }
}

/**
 * Process all pending jobs in the queue.
 * Returns the number of jobs processed.
 */
export async function processAllPendingJobs(
  client: ProtonDriveClient,
  dryRun: boolean
): Promise<number> {
  let count = 0;
  while (await processNextJob(client, dryRun)) {
    count++;
  }
  return count;
}

/**
 * Get counts of jobs by status.
 */
export function getJobCounts(): { pending: number; synced: number; blocked: number } {
  const pending = db
    .select()
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.PENDING))
    .all().length;
  const synced = db
    .select()
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.SYNCED))
    .all().length;
  const blocked = db
    .select()
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.BLOCKED))
    .all().length;

  return { pending, synced, blocked };
}
