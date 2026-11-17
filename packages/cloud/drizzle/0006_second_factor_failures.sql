ALTER TABLE `users` ADD `second_factor_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `second_factor_alert_at` text;