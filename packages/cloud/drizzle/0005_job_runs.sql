CREATE TABLE `job_runs` (
	`name` text PRIMARY KEY NOT NULL,
	`last_started_at` text,
	`last_success_at` text,
	`last_failure_at` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL
);
