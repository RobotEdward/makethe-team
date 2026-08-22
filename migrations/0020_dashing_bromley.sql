ALTER TABLE `fixtures` ADD `picker_mode` text DEFAULT 'organiser' NOT NULL;--> statement-breakpoint
ALTER TABLE `fixtures` ADD `team_picker_player_id` text REFERENCES players(id);--> statement-breakpoint
ALTER TABLE `fixtures` ADD `team_picker_set_at` integer;--> statement-breakpoint
ALTER TABLE `games` ADD `team_picker_email_enabled` integer DEFAULT true NOT NULL;