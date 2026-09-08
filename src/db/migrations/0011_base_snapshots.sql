CREATE TABLE `base_snapshots` (
	`local_path` text PRIMARY KEY NOT NULL,
	`snapshot_path` text NOT NULL,
	`local_sha1` text NOT NULL,
	`remote_revision_uid` text,
	`remote_sha1` text,
	`updated_at` integer NOT NULL
);