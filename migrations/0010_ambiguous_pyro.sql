ALTER TABLE `fixtures` ADD `teams_published_at` integer;--> statement-breakpoint
ALTER TABLE `games` ADD `team_a_name` text DEFAULT 'Team A' NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `team_b_name` text DEFAULT 'Team B' NOT NULL;--> statement-breakpoint
ALTER TABLE `responses` ADD `team` text;