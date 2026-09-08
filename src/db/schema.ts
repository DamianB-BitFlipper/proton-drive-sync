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
  DOWNLOAD_FILE: 'DOWNLOAD_FILE',
  MERGE_FILE: 'MERGE_FILE',
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
    changeToken: text('change_token'),
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
 * File state table for tracking local file state (mtime:size).
 * Used to detect changes and skip uploads when content hasn't changed.
 */
export const fileState = sqliteTable('file_state', {
  localPath: text('local_path').primaryKey(),
  changeToken: text('change_token').notNull(),
  contentSha1: text('content_sha1'),
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
    remoteRevisionUid: text('remote_revision_uid'),
    remoteSha1: text('remote_sha1'),
    remoteModifiedAt: integer('remote_modified_at', { mode: 'timestamp' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.localPath, table.remotePath] })]
);

/** Files where local and remote content changed since their last common state. */
export const conflicts = sqliteTable(
  'conflicts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    localPath: text('local_path').notNull(),
    remotePath: text('remote_path').notNull(),
    localSha1: text('local_sha1').notNull(),
    remoteRevisionUid: text('remote_revision_uid'),
    remoteSha1: text('remote_sha1'),
    remoteDeleted: integer('remote_deleted', { mode: 'boolean' }).notNull().default(false),
    conflictPath: text('conflict_path').notNull(),
    status: text('status').notNull().default('OPEN'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index('idx_conflicts_status').on(table.status)]
);

/** Last common local snapshot used as the base for three-way merges. */
export const baseSnapshots = sqliteTable('base_snapshots', {
  localPath: text('local_path').primaryKey(),
  snapshotPath: text('snapshot_path').notNull(),
  localSha1: text('local_sha1').notNull(),
  remoteRevisionUid: text('remote_revision_uid'),
  remoteSha1: text('remote_sha1'),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Persisted cursor for a Proton Drive tree event scope. */
export const remoteEventState = sqliteTable('remote_event_state', {
  syncDirPath: text('sync_dir_path').primaryKey(),
  treeEventScopeId: text('tree_event_scope_id').notNull(),
  lastEventId: text('last_event_id'),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});
