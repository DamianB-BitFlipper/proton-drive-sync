/**
 * Sync Job Queue
 *
 * Manages the sync job queue: enqueue, dequeue, status updates, retry logic.
 */

import { EventEmitter } from 'events';
import { eq, and, lte, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema, run, type Tx } from '../db/index.js';
import { SyncJobStatus, SyncEventType } from '../db/schema.js';
import { logger, isDebugEnabled } from '../logger.js';
import { isPathWatched } from '../config.js';
import {
  RETRY_DELAYS_SEC,
  JITTER_FACTOR,
  STALE_PROCESSING_MS,
  NETWORK_RETRY_CAP_INDEX,
  REUPLOAD_NEEDED_RETRY_SEC,
  REUPLOAD_DELETE_RECREATE_THRESHOLD,
  ErrorCategory,
  MAX_RETRIES,
  type ErrorClassification,
} from './constants.js';

// ============================================================================
// Event Emitter for Dashboard
// ============================================================================

export const jobEvents = new EventEmitter();

export type JobEventType = 'enqueue' | 'processing' | 'synced' | 'blocked' | 'retry';

export interface JobEvent {
  type: JobEventType;
  jobId: number;
  localPath: string;
  remotePath?: string;
  error?: string;
  timestamp: Date;
}

// ============================================================================
// Types
// ============================================================================

export interface Job {
  /** Unique identifier for this sync job */
  id: number;
  /** Type of sync operation: CREATE, UPDATE, DELETE, RENAME, or MOVE */
  eventType: SyncEventType;
  /** Absolute path to the file/directory on the local filesystem */
  localPath: string;
  /** Path on Proton Drive where the file/directory will be synced */
  remotePath: string;
  /** Current status: PENDING, PROCESSING, SYNCED, or BLOCKED */
  status: SyncJobStatus;
  /** Number of retry attempts made for this job */
  nRetries: number;
  /** Timestamp when this job should next be attempted */
  retryAt: Date;
  /** Error message from the last failed attempt, if any */
  lastError: string | null;
  /** Timestamp when this job was created */
  createdAt: Date;
  /** SHA1 hash of file content for change detection (null for directories) */
  contentHash: string | null;
  /** Original local path before rename/move (null for CREATE/UPDATE/DELETE) */
  oldLocalPath: string | null;
  /** Original remote path before rename/move (null for CREATE/UPDATE/DELETE) */
  oldRemotePath: string | null;
}

// Re-export for backward compatibility
export { ErrorCategory, REUPLOAD_DELETE_RECREATE_THRESHOLD, type ErrorClassification };

// ============================================================================
// Dry-Run State (module-level, only used when dryRun=true)
// ============================================================================

/** Set of job IDs currently being processed during dry-run mode */
export const dryRunProcessingIds = new Set<number>();

/** Set of job IDs already synced during dry-run mode */
export const dryRunSyncedIds = new Set<number>();

// ============================================================================
// Job Queue Functions
// ============================================================================

/** Parameters for creating a new sync job - subset of Job fields */
export type EnqueueJobParams = Pick<
  Job,
  'eventType' | 'localPath' | 'remotePath' | 'contentHash' | 'oldLocalPath' | 'oldRemotePath'
>;

/**
 * Add a sync job to the queue, or update if one already exists for this localPath.
 * Uses upsert logic: if a job for localPath exists, update it; otherwise insert.
 * No-op if dryRun is true.
 */
export function enqueueJob(params: EnqueueJobParams, dryRun: boolean, tx: Tx): void {
  if (dryRun) return;

  // Guard: only enqueue if localPath is within a configured sync_dir
  if (!isPathWatched(params.localPath)) {
    logger.debug(`Skipping enqueue for ${params.localPath} - not in any sync_dirs`);
    return;
  }

  // Check if job is already being processed (only query if debug enabled)
  if (isDebugEnabled()) {
    const inFlight = tx
      .select()
      .from(schema.processingQueue)
      .where(eq(schema.processingQueue.localPath, params.localPath))
      .get();

    if (inFlight) {
      logger.debug(`Job for ${params.localPath} is in-flight, will be re-queued as PENDING`);
    }
  }

  // INSERT ... ON CONFLICT DO UPDATE is a single atomic SQL statement
  const result = run(
    tx
      .insert(schema.syncJobs)
      .values({
        eventType: params.eventType,
        localPath: params.localPath,
        remotePath: params.remotePath,
        status: SyncJobStatus.PENDING,
        retryAt: new Date(),
        nRetries: 0,
        lastError: null,
        contentHash: params.contentHash ?? null,
        oldLocalPath: params.oldLocalPath ?? null,
        oldRemotePath: params.oldRemotePath ?? null,
      })
      .onConflictDoUpdate({
        target: schema.syncJobs.localPath,
        set: {
          eventType: params.eventType,
          remotePath: params.remotePath,
          status: SyncJobStatus.PENDING,
          retryAt: new Date(),
          nRetries: 0,
          lastError: null,
          contentHash: params.contentHash ?? null,
          oldLocalPath: params.oldLocalPath ?? null,
          oldRemotePath: params.oldRemotePath ?? null,
        },
      })
  );

  // Emit event for dashboard
  jobEvents.emit('job', {
    type: 'enqueue',
    jobId: Number(result.lastInsertRowid),
    localPath: params.localPath,
    remotePath: params.remotePath,
    timestamp: new Date(),
  } satisfies JobEvent);
}

/**
 * Cleans up orphaned jobs on startup.
 * - Resets any PROCESSING jobs back to PENDING (stale since app wasn't running)
 * - Deletes PENDING jobs whose localPath doesn't match any current sync_dirs
 */
export function cleanupOrphanedJobs(dryRun: boolean, tx: Tx): void {
  if (dryRun) return;

  // 1. Move all PROCESSING -> PENDING (stale since app wasn't running)
  const resetResult = run(
    tx
      .update(schema.syncJobs)
      .set({ status: SyncJobStatus.PENDING })
      .where(eq(schema.syncJobs.status, SyncJobStatus.PROCESSING))
  );

  // Clear processing queue table
  tx.delete(schema.processingQueue).run();

  if (resetResult.changes > 0) {
    logger.info(`Reset ${resetResult.changes} stale processing jobs to pending`);
  }

  // 2. Delete PENDING jobs not matching any sync_dirs
  const pendingJobs = tx
    .select({ id: schema.syncJobs.id, localPath: schema.syncJobs.localPath })
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.PENDING))
    .all();

  const orphanIds = pendingJobs.filter((job) => !isPathWatched(job.localPath)).map((job) => job.id);

  if (orphanIds.length > 0) {
    run(tx.delete(schema.syncJobs).where(inArray(schema.syncJobs.id, orphanIds)));
    logger.info(`Removed ${orphanIds.length} orphaned pending jobs`);
  }
}

/**
 * Get the next job to process and atomically mark it as PROCESSING.
 * Cleans up stale processing queue entries first.
 * Returns the job or undefined if no pending jobs.
 */
export function getNextPendingJob(dryRun: boolean = false): Job | undefined {
  const now = new Date();

  if (dryRun) {
    // DRY-RUN MODE: No DB writes, use in-memory tracking
    const jobs = db
      .select({
        id: schema.syncJobs.id,
        eventType: schema.syncJobs.eventType,
        localPath: schema.syncJobs.localPath,
        remotePath: schema.syncJobs.remotePath,
        status: schema.syncJobs.status,
        nRetries: schema.syncJobs.nRetries,
        retryAt: schema.syncJobs.retryAt,
        lastError: schema.syncJobs.lastError,
        createdAt: schema.syncJobs.createdAt,
        contentHash: schema.syncJobs.contentHash,
        oldLocalPath: schema.syncJobs.oldLocalPath,
        oldRemotePath: schema.syncJobs.oldRemotePath,
      })
      .from(schema.syncJobs)
      .where(
        and(eq(schema.syncJobs.status, SyncJobStatus.PENDING), lte(schema.syncJobs.retryAt, now))
      )
      .orderBy(schema.syncJobs.retryAt)
      .all();

    const job = jobs.find(
      (job) => !dryRunProcessingIds.has(job.id) && !dryRunSyncedIds.has(job.id)
    );

    if (job) {
      dryRunProcessingIds.add(job.id);
    }

    return job;
  }

  // NORMAL MODE
  // Clean up stale processing entries and reset jobs back to PENDING
  // This handles jobs left in PROCESSING state due to crashes/restarts
  const staleThreshold = new Date(Date.now() - STALE_PROCESSING_MS);
  const staleReset = db.transaction((tx) => {
    // Find stale local paths
    const stalePaths = tx
      .select({ localPath: schema.processingQueue.localPath })
      .from(schema.processingQueue)
      .where(lte(schema.processingQueue.startedAt, staleThreshold))
      .all();

    if (stalePaths.length === 0) return 0;

    const pathList = stalePaths.map((p) => p.localPath);

    const reset = run(
      tx
        .update(schema.syncJobs)
        .set({ status: SyncJobStatus.PENDING })
        .where(
          and(
            eq(schema.syncJobs.status, SyncJobStatus.PROCESSING),
            inArray(schema.syncJobs.localPath, pathList)
          )
        )
    );

    tx.delete(schema.processingQueue)
      .where(lte(schema.processingQueue.startedAt, staleThreshold))
      .run();

    return reset.changes;
  });

  if (staleReset > 0) {
    logger.debug(`Reset ${staleReset} stale processing jobs back to PENDING`);
  }

  // Transaction: select next PENDING job and mark as PROCESSING atomically
  return db.transaction((tx) => {
    const job = tx
      .select({
        id: schema.syncJobs.id,
        eventType: schema.syncJobs.eventType,
        localPath: schema.syncJobs.localPath,
        remotePath: schema.syncJobs.remotePath,
        status: schema.syncJobs.status,
        nRetries: schema.syncJobs.nRetries,
        retryAt: schema.syncJobs.retryAt,
        lastError: schema.syncJobs.lastError,
        createdAt: schema.syncJobs.createdAt,
        contentHash: schema.syncJobs.contentHash,
        oldLocalPath: schema.syncJobs.oldLocalPath,
        oldRemotePath: schema.syncJobs.oldRemotePath,
      })
      .from(schema.syncJobs)
      .leftJoin(
        schema.processingQueue,
        eq(schema.syncJobs.localPath, schema.processingQueue.localPath)
      )
      .where(
        and(
          eq(schema.syncJobs.status, SyncJobStatus.PENDING),
          lte(schema.syncJobs.retryAt, now),
          isNull(schema.processingQueue.localPath)
        )
      )
      .orderBy(schema.syncJobs.retryAt)
      .limit(1)
      .get();

    if (!job) return job;

    // Mark as PROCESSING and add to processing queue
    tx.update(schema.syncJobs)
      .set({ status: SyncJobStatus.PROCESSING })
      .where(eq(schema.syncJobs.id, job.id))
      .run();
    tx.insert(schema.processingQueue)
      .values({ localPath: job.localPath, startedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.processingQueue.localPath,
        set: { startedAt: new Date() },
      })
      .run();

    // Emit event for dashboard
    jobEvents.emit('job', {
      type: 'processing',
      jobId: job.id,
      localPath: job.localPath,
      remotePath: job.remotePath,
      timestamp: new Date(),
    } satisfies JobEvent);

    return job;
  });
}

/**
 * Mark a job as synced (completed successfully).
 */
export function markJobSynced(jobId: number, localPath: string, dryRun: boolean, tx: Tx): void {
  if (dryRun) {
    dryRunProcessingIds.delete(jobId);
    dryRunSyncedIds.add(jobId);
    return;
  }

  logger.debug(`Marking job ${jobId} as SYNCED (${localPath})`);

  tx.update(schema.syncJobs)
    .set({ status: SyncJobStatus.SYNCED, lastError: null })
    .where(and(eq(schema.syncJobs.id, jobId), eq(schema.syncJobs.status, SyncJobStatus.PROCESSING)))
    .run();
  tx.delete(schema.processingQueue).where(eq(schema.processingQueue.localPath, localPath)).run();

  jobEvents.emit('job', {
    type: 'synced',
    jobId,
    localPath,
    timestamp: new Date(),
  } satisfies JobEvent);

  // Cleanup old SYNCED jobs (watermark: 1280)
  const syncedCount = db
    .select()
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.SYNCED))
    .all().length;

  if (syncedCount > 1280) {
    db.transaction((t) => {
      const oldestSynced = t
        .select({ id: schema.syncJobs.id })
        .from(schema.syncJobs)
        .where(eq(schema.syncJobs.status, SyncJobStatus.SYNCED))
        .orderBy(schema.syncJobs.id)
        .limit(256)
        .all();

      const idsToDelete = oldestSynced.map((row) => row.id);
      t.delete(schema.syncJobs).where(inArray(schema.syncJobs.id, idsToDelete)).run();

      logger.debug(`Cleaned up ${idsToDelete.length} old SYNCED jobs`);
    });
  }
}

/**
 * Mark a job as blocked (failed permanently after max retries).
 */
export function markJobBlocked(
  jobId: number,
  localPath: string,
  error: string,
  dryRun: boolean,
  tx: Tx
): void {
  if (dryRun) return;

  logger.debug(`Marking job ${jobId} as BLOCKED (${localPath})`);

  tx.update(schema.syncJobs)
    .set({ status: SyncJobStatus.BLOCKED, lastError: error })
    .where(and(eq(schema.syncJobs.id, jobId), eq(schema.syncJobs.status, SyncJobStatus.PROCESSING)))
    .run();
  tx.delete(schema.processingQueue).where(eq(schema.processingQueue.localPath, localPath)).run();

  jobEvents.emit('job', {
    type: 'blocked',
    jobId,
    localPath,
    error,
    timestamp: new Date(),
  } satisfies JobEvent);
}

/**
 * Set the last error message for a job.
 */
export function setJobError(jobId: number, error: string, dryRun: boolean, tx: Tx): void {
  if (dryRun) return;
  tx.update(schema.syncJobs).set({ lastError: error }).where(eq(schema.syncJobs.id, jobId)).run();
}

// ============================================================================
// Error Categorization & Retry Logic
// ============================================================================

/** Categorize an error message and return category with max retries */
export function categorizeError(error: string): ErrorClassification {
  const lowerError = error.toLowerCase();

  // Proton API conflict errors - delete and recreate after max retries
  if (
    lowerError.includes('draft revision already exists') ||
    lowerError.includes('a file or folder with that name already exists')
  ) {
    return {
      category: ErrorCategory.REUPLOAD_NEEDED,
      maxRetries: MAX_RETRIES[ErrorCategory.REUPLOAD_NEEDED],
    };
  }

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
    'fetch failed',
  ];
  if (networkPatterns.some((pattern) => lowerError.includes(pattern.toLowerCase()))) {
    return {
      category: ErrorCategory.NETWORK,
      maxRetries: MAX_RETRIES[ErrorCategory.NETWORK],
    };
  }

  return {
    category: ErrorCategory.OTHER,
    maxRetries: MAX_RETRIES[ErrorCategory.OTHER],
  };
}

/**
 * Schedule a job for retry with exponential backoff and jitter.
 */
export function scheduleRetry(
  jobId: number,
  localPath: string,
  nRetries: number,
  errorCategory: ErrorCategory,
  dryRun: boolean,
  tx: Tx
): void {
  if (dryRun) return;

  let delaySec: number;
  let newRetries: number;

  if (errorCategory === ErrorCategory.REUPLOAD_NEEDED) {
    delaySec = REUPLOAD_NEEDED_RETRY_SEC;
    newRetries = nRetries + 1;
  } else if (errorCategory === ErrorCategory.NETWORK) {
    const effectiveRetries = Math.min(nRetries, NETWORK_RETRY_CAP_INDEX);
    const delayIndex = Math.min(effectiveRetries, RETRY_DELAYS_SEC.length - 1);
    const baseDelaySec = RETRY_DELAYS_SEC[delayIndex];
    const jitterSec = baseDelaySec * JITTER_FACTOR * (Math.random() * 2 - 1);
    delaySec = Math.max(1, baseDelaySec + jitterSec);
    newRetries = Math.min(nRetries + 1, NETWORK_RETRY_CAP_INDEX + 1);
  } else {
    const delayIndex = Math.min(nRetries, RETRY_DELAYS_SEC.length - 1);
    const baseDelaySec = RETRY_DELAYS_SEC[delayIndex];
    const jitterSec = baseDelaySec * JITTER_FACTOR * (Math.random() * 2 - 1);
    delaySec = Math.max(1, baseDelaySec + jitterSec);
    newRetries = nRetries + 1;
  }

  const retryAt = new Date(Date.now() + delaySec * 1000);

  tx.update(schema.syncJobs)
    .set({ status: SyncJobStatus.PENDING, nRetries: newRetries, retryAt })
    .where(eq(schema.syncJobs.id, jobId))
    .run();
  tx.delete(schema.processingQueue).where(eq(schema.processingQueue.localPath, localPath)).run();

  jobEvents.emit('job', {
    type: 'retry',
    jobId,
    localPath,
    timestamp: new Date(),
  } satisfies JobEvent);

  const maxRetries = MAX_RETRIES[errorCategory];
  const maxDisplay = maxRetries === Infinity ? '∞' : maxRetries;
  logger.info(
    `Job ${jobId} scheduled for retry ${newRetries}/${maxDisplay} in ${Math.round(delaySec)}s`
  );
}

// ============================================================================
// Dashboard Query Functions
// ============================================================================

/**
 * Get counts of jobs by status.
 * Uses conditional aggregation for efficient single-query counting.
 */
export function getJobCounts(): {
  pending: number;
  pendingReady: number;
  retry: number;
  processing: number;
  synced: number;
  blocked: number;
} {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const result = db
    .select({
      pendingReady: sql<number>`SUM(CASE WHEN ${schema.syncJobs.status} = ${SyncJobStatus.PENDING} AND ${schema.syncJobs.retryAt} <= ${nowSeconds} THEN 1 ELSE 0 END)`,
      retry: sql<number>`SUM(CASE WHEN ${schema.syncJobs.status} = ${SyncJobStatus.PENDING} AND ${schema.syncJobs.retryAt} > ${nowSeconds} THEN 1 ELSE 0 END)`,
      processing: sql<number>`SUM(CASE WHEN ${schema.syncJobs.status} = ${SyncJobStatus.PROCESSING} THEN 1 ELSE 0 END)`,
      synced: sql<number>`SUM(CASE WHEN ${schema.syncJobs.status} = ${SyncJobStatus.SYNCED} THEN 1 ELSE 0 END)`,
      blocked: sql<number>`SUM(CASE WHEN ${schema.syncJobs.status} = ${SyncJobStatus.BLOCKED} THEN 1 ELSE 0 END)`,
    })
    .from(schema.syncJobs)
    .get();

  const pendingReady = result?.pendingReady ?? 0;
  const retry = result?.retry ?? 0;

  return {
    pending: pendingReady + retry,
    pendingReady,
    retry,
    processing: result?.processing ?? 0,
    synced: result?.synced ?? 0,
    blocked: result?.blocked ?? 0,
  };
}

/**
 * Get recently synced jobs.
 */
export function getRecentJobs(limit: number = 50) {
  return db
    .select({
      id: schema.syncJobs.id,
      localPath: schema.syncJobs.localPath,
      remotePath: schema.syncJobs.remotePath,
      createdAt: schema.syncJobs.createdAt,
    })
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.SYNCED))
    .orderBy(schema.syncJobs.id)
    .limit(limit)
    .all()
    .reverse();
}

/**
 * Get blocked jobs with error details.
 */
export function getBlockedJobs(limit: number = 50) {
  return db
    .select({
      id: schema.syncJobs.id,
      localPath: schema.syncJobs.localPath,
      remotePath: schema.syncJobs.remotePath,
      lastError: schema.syncJobs.lastError,
      nRetries: schema.syncJobs.nRetries,
      createdAt: schema.syncJobs.createdAt,
    })
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.BLOCKED))
    .limit(limit)
    .all();
}

/**
 * Get currently processing jobs.
 */
export function getProcessingJobs() {
  return db
    .select({
      id: schema.syncJobs.id,
      localPath: schema.syncJobs.localPath,
      remotePath: schema.syncJobs.remotePath,
      createdAt: schema.syncJobs.createdAt,
    })
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.PROCESSING))
    .all();
}

/**
 * Get pending jobs (ready to process, retryAt <= now).
 */
export function getPendingJobs(limit: number = 50) {
  const now = new Date();
  return db
    .select({
      id: schema.syncJobs.id,
      localPath: schema.syncJobs.localPath,
      remotePath: schema.syncJobs.remotePath,
      createdAt: schema.syncJobs.createdAt,
    })
    .from(schema.syncJobs)
    .where(
      and(eq(schema.syncJobs.status, SyncJobStatus.PENDING), lte(schema.syncJobs.retryAt, now))
    )
    .orderBy(schema.syncJobs.retryAt)
    .limit(limit)
    .all();
}

/**
 * Get jobs scheduled for retry (retryAt > now).
 */
export function getRetryJobs(limit: number = 50) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return db
    .select({
      id: schema.syncJobs.id,
      localPath: schema.syncJobs.localPath,
      remotePath: schema.syncJobs.remotePath,
      retryAt: schema.syncJobs.retryAt,
      nRetries: schema.syncJobs.nRetries,
      lastError: schema.syncJobs.lastError,
      createdAt: schema.syncJobs.createdAt,
    })
    .from(schema.syncJobs)
    .where(
      and(
        eq(schema.syncJobs.status, SyncJobStatus.PENDING),
        sql`${schema.syncJobs.retryAt} > ${nowSeconds}`
      )
    )
    .orderBy(schema.syncJobs.retryAt)
    .limit(limit)
    .all();
}

/**
 * Set retry_at to now for all PENDING jobs with retry_at in the future.
 * This makes them immediately eligible for processing.
 */
export function retryAllNow(): number {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const now = new Date();

  const result = run(
    db
      .update(schema.syncJobs)
      .set({ retryAt: now })
      .where(
        and(
          eq(schema.syncJobs.status, SyncJobStatus.PENDING),
          sql`${schema.syncJobs.retryAt} > ${nowSeconds}`
        )
      )
  );

  if (result.changes > 0) {
    logger.info(`Moved ${result.changes} jobs from retry queue to immediate processing`);
  }

  return result.changes;
}
