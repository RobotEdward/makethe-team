ALTER TABLE `games` ADD `reminder_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `short_warning_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `group_nudge_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `result_prompt_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `teams_published_email_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `result_prompt_offset_hours` integer DEFAULT 0 NOT NULL;