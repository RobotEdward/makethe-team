ALTER TABLE `games` ADD `everyone_else_ask_after_hours` integer DEFAULT 12;--> statement-breakpoint
ALTER TABLE `invite_tiers` ADD `ask_after_hours` integer DEFAULT 12 NOT NULL;