CREATE TABLE `marketing_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`email_normalized` text NOT NULL,
	`status` text NOT NULL,
	`consent_version` text NOT NULL,
	`consent_text` text NOT NULL,
	`source` text NOT NULL,
	`tool` text NOT NULL,
	`inputs` text NOT NULL,
	`requested_at` text NOT NULL,
	`confirm_token_hash` text,
	`confirm_expires_at` text,
	`confirmed_at` text,
	`unsubscribed_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `marketing_consents_email_ux` ON `marketing_consents` (`email_normalized`);--> statement-breakpoint
CREATE UNIQUE INDEX `marketing_consents_token_ux` ON `marketing_consents` (`confirm_token_hash`);--> statement-breakpoint
CREATE INDEX `marketing_consents_status_ix` ON `marketing_consents` (`status`);