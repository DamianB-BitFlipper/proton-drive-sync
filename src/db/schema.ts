/**
 * Proton Drive Sync - Database Schema
 *
 * Drizzle ORM schema for SQLite state storage.
 */

import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ============================================================================
// Enums
// ============================================================================

export const SyncJobStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SYNCED: 'SYNCED',
  BLOCKED: 'BLOCKED',
} as const;

export type SyncJobStatus = (typeof SyncJobStatus)[keyof typeof SyncJobStatus];

export const SyncEventType = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
} as const;

export type SyncEventType = (typeof SyncEventType)[keyof typeof SyncEventType];

// ============================================================================
// Tables
// ============================================================================

/**
 * Clocks table for storing per-directory watchman clocks.
 */
export const clocks = sqliteTable('clocks', {
  directory: text('directory').primaryKey(),
  clock: text('clock').notNull(),
});

/**
 * Signals table for inter-process communication queue (transient).
 */
export const signals = sqliteTable('signals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  signal: text('signal').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Flags table for persistent process state (running, paused, etc).
 */
export const flags = sqliteTable('flags', {
  name: text('name').primaryKey(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Sync jobs table for buffering file sync operations.
 */
export const syncJobs = sqliteTable(
  'sync_jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventType: text('event_type').notNull().$type<SyncEventType>(),
    localPath: text('local_path').notNull(),
    remotePath: text('remote_path').notNull(),
    status: text('status').notNull().$type<SyncJobStatus>().default(SyncJobStatus.PENDING),
    retryAt: integer('retry_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    nRetries: integer('n_retries').notNull().default(0),
    lastError: text('last_error'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_sync_jobs_status_retry').on(table.status, table.retryAt),
    uniqueIndex('idx_sync_jobs_local_path').on(table.localPath),
  ]
);

/**
 * Processing queue table for tracking jobs currently being processed.
 * Separate from sync_jobs to prevent race conditions when new updates arrive during processing.
 */
export const processingQueue = sqliteTable('processing_queue', {
  localPath: text('local_path').primaryKey(),
  startedAt: integer('started_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});
