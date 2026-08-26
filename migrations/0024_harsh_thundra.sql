-- M37. Owner switches move from six boolean columns on `games` to one row
-- per (game, type, channel). Rows are written only where the old column is
-- off; a game with everything on gets no rows and resolves to on by absence.
--
-- The backfill is NOT uniform. `reminder_enabled`, `short_warning_enabled`
-- and `result_prompt_enabled` gate the whole notification today — the send
-- path skips before either leg is built — so each maps to BOTH channels.
-- `teams_published_email_enabled` and `team_picker_email_enabled` gate the
-- email leg only; their push legs are ungated in `send-teams.ts` and
-- `send-picker-handover.ts`, and mapping them to push would silently switch
-- off pushes being delivered today, to owners who never asked for that.
-- `group_nudge_enabled` gates a push-only notification.
--
-- The six columns are dropped by migration 0025, once nothing reads them.
CREATE TABLE `game_notification_settings` (
	`game_id` text NOT NULL,
	`notification_type` text NOT NULL,
	`channel` text NOT NULL,
	`enabled` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`game_id`, `notification_type`, `channel`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n1', 'email', 0, (unixepoch() * 1000) FROM `games` WHERE `reminder_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n1', 'push', 0, (unixepoch() * 1000) FROM `games` WHERE `reminder_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n4', 'email', 0, (unixepoch() * 1000) FROM `games` WHERE `short_warning_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n4', 'push', 0, (unixepoch() * 1000) FROM `games` WHERE `short_warning_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n12', 'email', 0, (unixepoch() * 1000) FROM `games` WHERE `result_prompt_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n12', 'push', 0, (unixepoch() * 1000) FROM `games` WHERE `result_prompt_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n11', 'push', 0, (unixepoch() * 1000) FROM `games` WHERE `group_nudge_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n9', 'email', 0, (unixepoch() * 1000) FROM `games` WHERE `teams_published_email_enabled` = 0;--> statement-breakpoint
INSERT INTO `game_notification_settings` (`game_id`, `notification_type`, `channel`, `enabled`, `updated_at`)
SELECT `id`, 'n13', 'email', 0, (unixepoch() * 1000) FROM `games` WHERE `team_picker_email_enabled` = 0;
