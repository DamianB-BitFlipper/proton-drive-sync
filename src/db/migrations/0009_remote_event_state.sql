CREATE TABLE `remote_event_state` (
	`sync_dir_path` text PRIMARY KEY NOT NULL,
	`tree_event_scope_id` text NOT NULL,
	`last_event_id` text,
	`updated_at` integer NOT NULL
);