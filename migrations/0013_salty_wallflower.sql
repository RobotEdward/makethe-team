CREATE TABLE `signup_allowlist` (
	`email` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `user` ADD `is_admin` integer DEFAULT false NOT NULL;