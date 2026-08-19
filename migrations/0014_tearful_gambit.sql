CREATE TABLE `signin_refusals` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `signin_refusals_created_idx` ON `signin_refusals` (`created_at`);