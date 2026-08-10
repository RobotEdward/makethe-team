CREATE TABLE `responses` (
	`id` text PRIMARY KEY NOT NULL,
	`fixture_id` text NOT NULL,
	`player_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`waitlist_position` integer,
	`responded_at` integer,
	`set_by_player_id` text,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`set_by_player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `responses_fixture_player_unique` ON `responses` (`fixture_id`,`player_id`);--> statement-breakpoint
CREATE INDEX `responses_fixture_status_idx` ON `responses` (`fixture_id`,`status`);--> statement-breakpoint
CREATE INDEX `responses_player_idx` ON `responses` (`player_id`);