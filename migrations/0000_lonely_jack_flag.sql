CREATE TABLE `fixtures` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`kicks_off_at` integer NOT NULL,
	`lifecycle` text DEFAULT 'scheduled' NOT NULL,
	`min_players` integer NOT NULL,
	`max_players` integer NOT NULL,
	`prefers_even_numbers` integer NOT NULL,
	`short_warning_offset_hours` integer NOT NULL,
	`duration_minutes` integer NOT NULL,
	`in_count` integer DEFAULT 0 NOT NULL,
	`waitlist_count` integer DEFAULT 0 NOT NULL,
	`venue_override` text,
	`notes` text,
	`cancelled_at` integer,
	`cancellation_reason` text,
	`opened_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fixtures_game_kickoff_unique` ON `fixtures` (`game_id`,`kicks_off_at`);--> statement-breakpoint
CREATE INDEX `fixtures_lifecycle_kickoff_idx` ON `fixtures` (`lifecycle`,`kicks_off_at`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`venue_name` text NOT NULL,
	`venue_address` text,
	`venue_url` text,
	`timezone` text NOT NULL,
	`recurrence_rule` text NOT NULL,
	`recurrence_start_date` text NOT NULL,
	`kickoff_time` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`min_players` integer NOT NULL,
	`max_players` integer NOT NULL,
	`prefers_even_numbers` integer DEFAULT true NOT NULL,
	`reminder_days_before` integer DEFAULT 1 NOT NULL,
	`reminder_local_time` text DEFAULT '09:00' NOT NULL,
	`short_warning_offset_hours` integer DEFAULT 12 NOT NULL,
	`invite_token` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `games_invite_token_unique` ON `games` (`invite_token`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`player_id` text NOT NULL,
	`role` text DEFAULT 'player' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`joined_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`left_at` integer,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_game_player_unique` ON `memberships` (`game_id`,`player_id`);--> statement-breakpoint
CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`is_guest` integer DEFAULT false NOT NULL,
	`auth_user_id` text,
	`notification_channel` text DEFAULT 'email' NOT NULL,
	`email_verified_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_email_unique` ON `players` (`email`) WHERE "players"."email" is not null;