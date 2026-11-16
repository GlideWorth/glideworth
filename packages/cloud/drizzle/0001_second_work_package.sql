CREATE TABLE `cell_heartbeat` (
	`id` text PRIMARY KEY NOT NULL,
	`pid` integer NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `checkout_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`lookup_key` text,
	`price_id` text NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `checkout_sessions_account_idx` ON `checkout_sessions` (`account_id`,`status`);--> statement-breakpoint
CREATE TABLE `lifecycle_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`step` text NOT NULL,
	`state` text NOT NULL,
	`actor_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lifecycle_tasks_subject_uq` ON `lifecycle_tasks` (`kind`,`subject_id`);--> statement-breakpoint
CREATE TABLE `mail_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text,
	`user_id` text,
	`to_email` text NOT NULL,
	`to_name` text,
	`template` text NOT NULL,
	`data` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`last_error_code` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_outbox_dedupe_uq` ON `mail_outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `mail_outbox_due_idx` ON `mail_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `mail_outbox_user_idx` ON `mail_outbox` (`user_id`);--> statement-breakpoint
CREATE TABLE `ops_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`args` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`result` text,
	`error_code` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`started_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `ops_commands_status_idx` ON `ops_commands` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `webhook_nonces` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `writer_locks` (
	`key` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`token` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tenant_keys` ADD `escrowed_at` text;