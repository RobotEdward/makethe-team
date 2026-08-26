-- M37. The six owner switches now live in `game_notification_settings`
-- (migration 0024 backfilled them). Nothing reads these columns any more.
ALTER TABLE `games` DROP COLUMN `reminder_enabled`;--> statement-breakpoint
ALTER TABLE `games` DROP COLUMN `short_warning_enabled`;--> statement-breakpoint
ALTER TABLE `games` DROP COLUMN `group_nudge_enabled`;--> statement-breakpoint
ALTER TABLE `games` DROP COLUMN `result_prompt_enabled`;--> statement-breakpoint
ALTER TABLE `games` DROP COLUMN `teams_published_email_enabled`;--> statement-breakpoint
ALTER TABLE `games` DROP COLUMN `team_picker_email_enabled`;