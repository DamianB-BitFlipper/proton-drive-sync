-- Migration: Schema cleanup - merge migrations 7, 8, 9
-- Changes:
-- 1. Drop clocks table (no longer needed)
-- 2. Support overlapping sync directories - change sync_jobs unique index, recreate node_mapping with composite PK
-- 3. Rename file_hashes to file_state, rename content_hash to change_token

-- Step 1: Drop clocks table
DROP TABLE IF EXISTS `clocks`;--> statement-breakpoint

-- Step 2: Clear existing jobs and mappings (required since schema changes are incompatible)
DELETE FROM `sync_jobs`;--> statement-breakpoint
DELETE FROM `node_mapping`;--> statement-breakpoint
DELETE FROM `file_hashes`;--> statement-breakpoint

-- Step 3: Drop old tables
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE `node_mapping`;--> statement-breakpoint
DROP TABLE `sync_jobs`;--> statement-breakpoint
DROP TABLE `file_hashes`;--> statement-breakpoint

-- Step 4: Recreate node_mapping with composite primary key (localPath, remotePath)
CREATE TABLE `node_mapping` (
	`local_path` text NOT NULL,
	`remote_path` text NOT NULL,
	`node_uid` text NOT NULL,
	`parent_node_uid` text NOT NULL,
	`is_directory` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`local_path`, `remote_path`)
);--> statement-breakpoint

-- Step 5: Recreate sync_jobs with change_token column and composite unique index
CREATE TABLE `sync_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`local_path` text NOT NULL,
	`remote_path` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`retry_at` integer NOT NULL,
	`n_retries` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`change_token` text,
	`old_local_path` text,
	`old_remote_path` text,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_sync_jobs_status_retry` ON `sync_jobs` (`status`,`retry_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sync_jobs_local_remote` ON `sync_jobs` (`local_path`,`remote_path`);--> statement-breakpoint

-- Step 6: Create file_state table (renamed from file_hashes, with change_token column)
CREATE TABLE `file_state` (
	`local_path` text PRIMARY KEY NOT NULL,
	`change_token` text NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint

PRAGMA foreign_keys=ON;
