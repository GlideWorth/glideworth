CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`user_id` text,
	`user_name` text,
	`via` text NOT NULL,
	`credential_id` text,
	`action` text NOT NULL,
	`resource_type` text,
	`resource_id` text,
	`status` integer,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_resource_idx` ON `audit_log` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `audit_log_user_idx` ON `audit_log` (`user_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`plan_id` text,
	`health_id` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`read_at` text
);
--> statement-breakpoint
CREATE INDEX `notifications_created_idx` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`auth_method` text DEFAULT 'none' NOT NULL,
	`scope` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`scopes` text NOT NULL,
	`resource` text,
	`expires_at` text NOT NULL,
	`used_at` text,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`access_hash` text NOT NULL,
	`refresh_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`resource` text,
	`access_expires_at` text NOT NULL,
	`refresh_expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_access_uq` ON `oauth_tokens` (`access_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_refresh_uq` ON `oauth_tokens` (`refresh_hash`);--> statement-breakpoint
CREATE TABLE `plan_health` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`taken_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`trigger` text NOT NULL,
	`plan_version` integer NOT NULL,
	`household_version` integer NOT NULL,
	`success_rate` real,
	`fi_year` integer,
	`actual_net_worth` real,
	`planned_net_worth` real,
	`body` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plan_health_plan_idx` ON `plan_health` (`plan_id`,`taken_at`);--> statement-breakpoint
CREATE TABLE `schedule_config` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`last_run_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `share_links` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text,
	`privacy` text NOT NULL,
	`basis` text DEFAULT 'real' NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`snapshot` text NOT NULL,
	`snapshot_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`view_count` integer DEFAULT 0 NOT NULL,
	`last_viewed_at` text,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_links_token_uq` ON `share_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `share_links_plan_idx` ON `share_links` (`plan_id`);--> statement-breakpoint
CREATE TABLE `user_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_tokens_hash_uq` ON `user_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`hash` text,
	`disabled_at` text,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_login_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_login_uq` ON `users` (`login`);--> statement-breakpoint
ALTER TABLE `api_keys` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD `user_id` text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `users` (`id`, `login`, `name`, `role`) VALUES ('owner', 'owner', 'Owner', 'owner');--> statement-breakpoint
UPDATE `households` SET `version` = `version` + 1;
