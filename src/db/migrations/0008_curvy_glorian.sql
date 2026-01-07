-- Migration: Support overlapping sync directories
-- Changes:
-- 1. syncJobs: Change unique index from localPath to (localPath, remotePath)
-- 2. node_mapping: Add remotePath column, change PK to composite (localPath, remotePath)
-- 3. Clear existing sync_jobs and node_mapping data (will re-sync on next run)

-- Step 1: Clear existing jobs and mappings (required since schema changes are incompatible)
DELETE FROM `sync_jobs`;--> statement-breakpoint
DELETE FROM `node_mapping`;--> statement-breakpoint

-- Step 2: Update syncJobs unique index
DROP INDEX IF EXISTS `idx_sync_jobs_local_path`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sync_jobs_local_remote` ON `sync_jobs` (`local_path`,`remote_path`);--> statement-breakpoint

-- Step 3: Recreate node_mapping with composite primary key
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE `node_mapping`;--> statement-breakpoint
CREATE TABLE `node_mapping` (
	`local_path` text NOT NULL,
	`remote_path` text NOT NULL,
	`node_uid` text NOT NULL,
	`parent_node_uid` text NOT NULL,
	`is_directory` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`local_path`, `remote_path`)
);--> statement-breakpoint
PRAGMA foreign_keys=ON;
