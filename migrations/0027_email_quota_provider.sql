-- M42. The daily send ceiling counts each email provider separately, so a
-- message Resend's ceiling refused can spill over to Cloudflare instead of
-- being deferred by capacity it was never going to use. See `emailQuota` in
-- src/db/schema.ts and `QuotaNotifier` in src/notify/quota.ts.
--
-- SQLite cannot add a column to a primary key in place, hence the rebuild.
-- The backfill writes the literal 'resend' rather than selecting a
-- `provider` column: the old table has no such column, and the generated
-- version of this migration did select it, which would have failed on the
-- production database at `migrations apply` — before `deploy`, so the
-- release would have been half-applied.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_email_quota` (
	`day` text NOT NULL,
	`provider` text DEFAULT 'resend' NOT NULL,
	`sent_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `provider`)
);
--> statement-breakpoint
INSERT INTO `__new_email_quota`("day", "provider", "sent_count") SELECT "day", 'resend', "sent_count" FROM `email_quota`;--> statement-breakpoint
DROP TABLE `email_quota`;--> statement-breakpoint
ALTER TABLE `__new_email_quota` RENAME TO `email_quota`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
