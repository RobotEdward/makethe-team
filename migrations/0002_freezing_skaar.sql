CREATE TABLE `email_quota` (
	`day` text PRIMARY KEY NOT NULL,
	`sent_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_log` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`notification_type` text NOT NULL,
	`fixture_id` text,
	`player_id` text NOT NULL,
	`channel` text DEFAULT 'email' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`provider_message_id` text,
	`sent_at` integer,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_log_dedupe_key_unique` ON `notification_log` (`dedupe_key`);