-- M41. Owner-archived games: non-null means read-only history, no new
-- fixtures, dead invite link. See `games.archivedAt` in src/db/schema.ts.
ALTER TABLE `games` ADD `archived_at` integer;