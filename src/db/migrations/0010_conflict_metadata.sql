ALTER TABLE `node_mapping` ADD `remote_revision_uid` text;
--> statement-breakpoint
ALTER TABLE `node_mapping` ADD `remote_sha1` text;
--> statement-breakpoint
ALTER TABLE `node_mapping` ADD `remote_modified_at` integer;
--> statement-breakpoint
CREATE TABLE `conflicts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`local_path` text NOT NULL,
	`remote_path` text NOT NULL,
	`local_sha1` text NOT NULL,
	`remote_revision_uid` text,
	`remote_sha1` text,
	`remote_deleted` integer DEFAULT false NOT NULL,
	`conflict_path` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_conflicts_status` ON `conflicts` (`status`);