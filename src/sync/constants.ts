/**
 * Sync Module Constants
 *
 * Centralized constants for the sync engine, queue, processor, and watcher.
 */

// ============================================================================
// Timing Constants
// ============================================================================

/** Polling interval for processing jobs in watch mode (2 seconds) */
export const JOB_POLL_INTERVAL_MS = 2_000;

/** Timeout for graceful shutdown (2 seconds) */
export const SHUTDOWN_TIMEOUT_MS = 2_000;

/** Time after which a PROCESSING job is considered stale (10 minutes) */
export const STALE_PROCESSING_MS = 10 * 60 * 1000;

/** Debounce time for file watcher events (200ms) */
export const WATCHER_DEBOUNCE_MS = 200;

/** Interval for running incremental reconciliation checks (1 minute) */
export const RECONCILIATION_INTERVAL_MS = 1 * 60 * 1000;

/** Time a dirty path must wait before being eligible for reconciliation (5 minutes) */
export const DIRTY_PATH_DEBOUNCE_MS = 5 * 60 * 1000;

// ============================================================================
// Retry Configuration
// ============================================================================

/** Retry delays in seconds (x4 exponential backoff, capped at ~1 week) */
export const RETRY_DELAYS_SEC = [
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

/** Jitter factor for retry timing (±25%) */
export const JITTER_FACTOR = 0.25;

/** Cap index for network error retries (limits backoff growth) */
export const NETWORK_RETRY_CAP_INDEX = 4;

/** Fixed retry delay for REUPLOAD_NEEDED errors (256 seconds) */
export const REUPLOAD_NEEDED_RETRY_SEC = 256;

/** Number of retries before attempting delete+recreate for REUPLOAD_NEEDED errors */
export const REUPLOAD_DELETE_RECREATE_THRESHOLD = 2;

// ============================================================================
// Error Categories
// ============================================================================

export const ErrorCategory = {
  NETWORK: 'network',
  REUPLOAD_NEEDED: 'reupload_needed',
  LOCAL_NOT_FOUND: 'local_not_found',
  AUTH: 'auth', // Authentication failures - no retry, requires re-auth
  OTHER: 'other',
} as const;
export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

export interface ErrorClassification {
  category: ErrorCategory;
  maxRetries: number;
}

/** Maximum retries per error category */
export const MAX_RETRIES: Record<ErrorCategory, number> = {
  [ErrorCategory.OTHER]: RETRY_DELAYS_SEC.length,
  [ErrorCategory.REUPLOAD_NEEDED]: 4,
  [ErrorCategory.LOCAL_NOT_FOUND]: 3,
  [ErrorCategory.NETWORK]: Infinity,
  [ErrorCategory.AUTH]: 0, // No retries - requires user re-authentication
};
