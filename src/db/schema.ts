/**
 * Proton Drive Sync - Database Schema
 *
 * Drizzle ORM schema for SQLite state storage.
 */

import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core';

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
  CREATE_FILE: 'CREATE_FILE',
  CREATE_DIR: 'CREATE_DIR',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
} as const;

export type SyncEventType = (typeof SyncEventType)[keyof typeof SyncEventType];

// ============================================================================
// Tables
// ============================================================================

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
    contentHash: text('content_hash'),
    oldLocalPath: text('old_local_path'),
    oldRemotePath: text('old_remote_path'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_sync_jobs_status_retry').on(table.status, table.retryAt),
    uniqueIndex('idx_sync_jobs_local_remote').on(table.localPath, table.remotePath),
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

/**
 * File hashes table for tracking content hashes of synced files.
 * Used to skip uploads when content hasn't changed.
 */
export const fileHashes = sqliteTable('file_hashes', {
  localPath: text('local_path').primaryKey(),
  contentHash: text('content_hash').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Node mapping table for tracking Proton Drive nodeUids.
 * Used to support rename/move operations without re-uploading.
 * Composite key (localPath, remotePath) supports overlapping sync dirs.
 */
export const nodeMapping = sqliteTable(
  'node_mapping',
  {
    localPath: text('local_path').notNull(),
    remotePath: text('remote_path').notNull(),
    nodeUid: text('node_uid').notNull(),
    parentNodeUid: text('parent_node_uid').notNull(),
    isDirectory: integer('is_directory', { mode: 'boolean' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.localPath, table.remotePath] })]
);
