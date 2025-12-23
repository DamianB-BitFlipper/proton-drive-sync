/**
 * Sync Job Queue
 *
 * Manages the sync job queue: enqueue, dequeue, status updates, retry logic.
 */

import { EventEmitter } from 'events';
import { eq, and, lte, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { SyncJobStatus, SyncEventType } from '../db/schema.js';
import { logger, isDebugEnabled } from '../logger.js';

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
  id: number;
  eventType: SyncEventType;
  localPath: string;
  remotePath: string | null;
  status: SyncJobStatus;
  nRetries: number;
  retryAt: Date;
  lastError: string | null;
  createdAt: Date;
}

// ============================================================================
// Constants
// ============================================================================

// Retry delays in seconds (x4 exponential backoff, capped at ~1 week)
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

const JITTER_FACTOR = 0.25;
const STALE_PROCESSING_MS = 2 * 60 * 1000;
const NETWORK_RETRY_CAP_INDEX = 4;
const REUPLOAD_NEEDED_RETRY_SEC = 256;

export const ErrorCategory = {
  NETWORK: 'network',
  REUPLOAD_NEEDED: 'reupload_needed',
  OTHER: 'other',
} as const;
export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

export interface ErrorClassification {
  category: ErrorCategory;
  maxRetries: number;
}

const MAX_RETRIES: Record<ErrorCategory, number> = {
  [ErrorCategory.OTHER]: RETRY_DELAYS_SEC.length,
  [ErrorCategory.REUPLOAD_NEEDED]: 3,
  [ErrorCategory.NETWORK]: Infinity,
};

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

/**
 * Add a sync job to the queue, or update if one already exists for this localPath.
 * Uses upsert logic: if a job for localPath exists, update it; otherwise insert.
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

  // Check if job is already being processed (only query if debug enabled)
  if (isDebugEnabled()) {
    const inFlight = db
      .select()
      .from(schema.processingQueue)
      .where(eq(schema.processingQueue.localPath, params.localPath))
      .get();

    if (inFlight) {
      logger.debug(`Job for ${params.localPath} is in-flight, will be re-queued as PENDING`);
    }
  }

  // INSERT ... ON CONFLICT DO UPDATE is a single atomic SQL statement
  const result = db
    .insert(schema.syncJobs)
    .values({
      eventType: params.eventType,
      localPath: params.localPath,
      remotePath: params.remotePath,
      status: SyncJobStatus.PENDING,
      retryAt: new Date(),
      nRetries: 0,
      lastError: null,
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
      },
    })
    .run();

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
    const reset = tx
      .update(schema.syncJobs)
      .set({ status: SyncJobStatus.PENDING })
      .where(
        and(
          eq(schema.syncJobs.status, SyncJobStatus.PROCESSING),
          inArray(
            schema.syncJobs.localPath,
            tx
              .select({ localPath: schema.processingQueue.localPath })
              .from(schema.processingQueue)
              .where(lte(schema.processingQueue.startedAt, staleThreshold))
          )
        )
      )
      .run();

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
export function markJobSynced(jobId: number, localPath: string, dryRun: boolean): void {
  if (dryRun) {
    dryRunProcessingIds.delete(jobId);
    dryRunSyncedIds.add(jobId);
    return;
  }

  logger.debug(`Marking job ${jobId} as SYNCED (${localPath})`);

  db.transaction((tx) => {
    tx.update(schema.syncJobs)
      .set({ status: SyncJobStatus.SYNCED, lastError: null })
      .where(
        and(eq(schema.syncJobs.id, jobId), eq(schema.syncJobs.status, SyncJobStatus.PROCESSING))
      )
      .run();
    tx.delete(schema.processingQueue).where(eq(schema.processingQueue.localPath, localPath)).run();
  });

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
    db.transaction((tx) => {
      const oldestSynced = tx
        .select({ id: schema.syncJobs.id })
        .from(schema.syncJobs)
        .where(eq(schema.syncJobs.status, SyncJobStatus.SYNCED))
        .orderBy(schema.syncJobs.id)
        .limit(256)
        .all();

      const idsToDelete = oldestSynced.map((row) => row.id);
      tx.delete(schema.syncJobs).where(inArray(schema.syncJobs.id, idsToDelete)).run();

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
  dryRun: boolean
): void {
  if (dryRun) return;

  logger.debug(`Marking job ${jobId} as BLOCKED (${localPath})`);

  db.transaction((tx) => {
    tx.update(schema.syncJobs)
      .set({ status: SyncJobStatus.BLOCKED, lastError: error })
      .where(
        and(eq(schema.syncJobs.id, jobId), eq(schema.syncJobs.status, SyncJobStatus.PROCESSING))
      )
      .run();
    tx.delete(schema.processingQueue).where(eq(schema.processingQueue.localPath, localPath)).run();
  });

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
export function setJobError(jobId: number, error: string, dryRun: boolean): void {
  if (dryRun) return;
  db.update(schema.syncJobs).set({ lastError: error }).where(eq(schema.syncJobs.id, jobId)).run();
}

// ============================================================================
// Error Categorization & Retry Logic
// ============================================================================

/** Categorize an error message and return category with max retries */
export function categorizeError(error: string): ErrorClassification {
  const lowerError = error.toLowerCase();

  if (lowerError.includes('draft revision already exists')) {
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
  dryRun: boolean
): void {
  if (dryRun) return;

  let delaySec: number;
  let newRetries: number;

  if (errorCategory === ErrorCategory.REUPLOAD_NEEDED) {
    delaySec = REUPLOAD_NEEDED_RETRY_SEC;
    newRetries = nRetries;
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

  db.transaction((tx) => {
    tx.update(schema.syncJobs)
      .set({ status: SyncJobStatus.PENDING, nRetries: newRetries, retryAt })
      .where(eq(schema.syncJobs.id, jobId))
      .run();
    tx.delete(schema.processingQueue).where(eq(schema.processingQueue.localPath, localPath)).run();
  });

  jobEvents.emit('job', {
    type: 'retry',
    jobId,
    localPath,
    timestamp: new Date(),
  } satisfies JobEvent);

  logger.info(`Job ${jobId} scheduled for retry in ${Math.round(delaySec)}s`);
}

// ============================================================================
// Dashboard Query Functions
// ============================================================================

/**
 * Get counts of jobs by status.
 */
export function getJobCounts(): {
  pending: number;
  processing: number;
  synced: number;
  blocked: number;
} {
  const rows = db
    .select({
      status: schema.syncJobs.status,
      count: sql<number>`count(*)`,
    })
    .from(schema.syncJobs)
    .groupBy(schema.syncJobs.status)
    .all();

  const counts = { pending: 0, processing: 0, synced: 0, blocked: 0 };
  for (const row of rows) {
    if (row.status === SyncJobStatus.PENDING) counts.pending = row.count;
    else if (row.status === SyncJobStatus.PROCESSING) counts.processing = row.count;
    else if (row.status === SyncJobStatus.SYNCED) counts.synced = row.count;
    else if (row.status === SyncJobStatus.BLOCKED) counts.blocked = row.count;
  }

  return counts;
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

  const result = db
    .update(schema.syncJobs)
    .set({ retryAt: now })
    .where(
      and(
        eq(schema.syncJobs.status, SyncJobStatus.PENDING),
        sql`${schema.syncJobs.retryAt} > ${nowSeconds}`
      )
    )
    .run();

  if (result.changes > 0) {
    logger.info(`Moved ${result.changes} jobs from retry queue to immediate processing`);
  }

  return result.changes;
}
