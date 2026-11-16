CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`owner_user_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`mcp_writes` integer DEFAULT false NOT NULL,
	`schema_version` integer,
	`db_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_active_at` text,
	`deleted_at` text,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `accounts_owner_idx` ON `accounts` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `accounts_status_idx` ON `accounts` (`status`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`account_id` text,
	`subject_user_id` text,
	`event` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
CREATE INDEX `audit_events_account_idx` ON `audit_events` (`account_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_events_subject_idx` ON `audit_events` (`subject_user_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_events_actor_idx` ON `audit_events` (`actor_id`,`at`);--> statement-breakpoint
CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`object_key` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`schema_version` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`expires_at` text,
	`verified_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backups_object_key_uq` ON `backups` (`object_key`);--> statement-breakpoint
CREATE INDEX `backups_account_created_idx` ON `backups` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `billing_notices` (
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`sent_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`account_id`, `kind`, `dedupe_key`)
);
--> statement-breakpoint
CREATE TABLE `email_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`template` text NOT NULL,
	`category` text NOT NULL,
	`provider_message_id` text,
	`status` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_log_created_idx` ON `email_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `email_log_user_idx` ON `email_log` (`user_id`);--> statement-breakpoint
CREATE TABLE `email_suppressions` (
	`email_normalized` text NOT NULL,
	`category` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`email_normalized`, `category`)
);
--> statement-breakpoint
CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`path` text NOT NULL,
	`bytes` integer,
	`expires_at` text NOT NULL,
	`downloaded_at` text
);
--> statement-breakpoint
CREATE INDEX `exports_account_idx` ON `exports` (`account_id`);--> statement-breakpoint
CREATE INDEX `exports_expires_idx` ON `exports` (`expires_at`);--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`email_normalized` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by` text,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_uq` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitations_account_idx` ON `invitations` (`account_id`);--> statement-breakpoint
CREATE INDEX `invitations_email_idx` ON `invitations` (`email_normalized`);--> statement-breakpoint
CREATE TABLE `known_devices` (
	`user_id` text NOT NULL,
	`device_hmac` text NOT NULL,
	`first_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`user_id`, `device_hmac`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `memberships` (
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`tenant_user_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	PRIMARY KEY(`account_id`, `user_id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_account_tenant_user_uq` ON `memberships` (`account_id`,`tenant_user_id`);--> statement-breakpoint
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`auth_method` text DEFAULT 'none' NOT NULL,
	`scope` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_used_at` text,
	`registered_ip` text
);
--> statement-breakpoint
CREATE INDEX `oauth_clients_ip_idx` ON `oauth_clients` (`registered_ip`,`created_at`);--> statement-breakpoint
CREATE TABLE `operator_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`operator_id` text NOT NULL,
	`csrf` text NOT NULL,
	`ip` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`operator_id`) REFERENCES `operators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `operator_sessions_operator_idx` ON `operator_sessions` (`operator_id`);--> statement-breakpoint
CREATE TABLE `operators` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret_enc` text,
	`totp_last_step` integer,
	`role` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`disabled_at` text,
	`last_signin_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operators_email_uq` ON `operators` (`email`);--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hmac` text NOT NULL,
	`used_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_codes_user_code_uq` ON `recovery_codes` (`user_id`,`code_hmac`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`csrf` text NOT NULL,
	`active_account_id` text,
	`mfa` integer DEFAULT false NOT NULL,
	`reauth_at` text,
	`user_agent` text,
	`ip` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `stripe_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`created` integer NOT NULL,
	`livemode` integer NOT NULL,
	`account_id` text,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`processed_at` text,
	`status` text DEFAULT 'received' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error_code` text
);
--> statement-breakpoint
CREATE INDEX `stripe_events_status_idx` ON `stripe_events` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `stripe_events_received_idx` ON `stripe_events` (`received_at`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`account_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`product_id` text NOT NULL,
	`price_lookup_key` text,
	`trial_ends_at` text,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`current_period_end` text,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`canceled_at` text,
	`past_due_since` text,
	`comped_until` text,
	`stripe_updated` integer,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_stripe_customer_uq` ON `subscriptions` (`stripe_customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_stripe_subscription_uq` ON `subscriptions` (`stripe_subscription_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_trial_idx` ON `subscriptions` (`status`,`trial_ends_at`);--> statement-breakpoint
CREATE TABLE `support_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`granted_by_user_id` text NOT NULL,
	`reason` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `support_grants_account_idx` ON `support_grants` (`account_id`);--> statement-breakpoint
CREATE TABLE `tenant_keys` (
	`account_id` text PRIMARY KEY NOT NULL,
	`wrapped_dek` text,
	`kek_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`destroyed_at` text
);
--> statement-breakpoint
CREATE TABLE `tenant_schedules` (
	`account_id` text PRIMARY KEY NOT NULL,
	`next_checkin_at` text,
	`last_checkin_at` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tenant_schedules_next_idx` ON `tenant_schedules` (`next_checkin_at`);--> statement-breakpoint
CREATE TABLE `trial_grants` (
	`email_hmac` text PRIMARY KEY NOT NULL,
	`granted_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`account_id` text NOT NULL,
	`metric` text NOT NULL,
	`day` text NOT NULL,
	`value` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`account_id`, `metric`, `day`)
);
--> statement-breakpoint
CREATE TABLE `user_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`purpose` text NOT NULL,
	`token_hash` text NOT NULL,
	`payload` text,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_tokens_token_hash_uq` ON `user_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `user_tokens_user_purpose_idx` ON `user_tokens` (`user_id`,`purpose`);--> statement-breakpoint
CREATE INDEX `user_tokens_expires_idx` ON `user_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`email_normalized` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`email_verified_at` text,
	`totp_secret_enc` text,
	`totp_enabled_at` text,
	`totp_last_step` integer,
	`signin_alerts` integer DEFAULT true NOT NULL,
	`checkin_emails` integer DEFAULT true NOT NULL,
	`terms_version` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_signin_at` text,
	`disabled_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_normalized_uq` ON `users` (`email_normalized`);--> statement-breakpoint
CREATE INDEX `users_unverified_idx` ON `users` (`email_verified_at`,`created_at`);