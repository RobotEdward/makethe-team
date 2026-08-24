CREATE TABLE `invite_tiers` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invite_tiers_game_position_idx` ON `invite_tiers` (`game_id`,`position`);--> statement-breakpoint
ALTER TABLE `games` ADD `gated_invites_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `gated_fallback_hours_before` integer;--> statement-breakpoint
ALTER TABLE `memberships` ADD `invite_tier_id` text REFERENCES invite_tiers(id);--> statement-breakpoint
ALTER TABLE `responses` ADD `invited_at` integer;