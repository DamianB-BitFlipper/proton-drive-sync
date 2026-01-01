-- Add content hash tracking columns to sync_jobs
ALTER TABLE `sync_jobs` ADD `content_hash` text;
ALTER TABLE `sync_jobs` ADD `old_local_path` text;
ALTER TABLE `sync_jobs` ADD `old_remote_path` text;

-- Create file_hashes table for tracking content hashes of synced files
CREATE TABLE `file_hashes` (
	`local_path` text PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`updated_at` integer NOT NULL
);

-- Create node_mapping table for tracking Proton Drive nodeUids
CREATE TABLE `node_mapping` (
	`local_path` text PRIMARY KEY NOT NULL,
	`node_uid` text NOT NULL,
	`parent_node_uid` text NOT NULL,
	`is_directory` integer NOT NULL,
	`updated_at` integer NOT NULL
);
