-- ############################################################################
-- ##                                                                        ##
-- ##   DESTRUCTIVE. LOCAL ONLY. THIS FILE DELETES EVERY ROW IN FOUR TABLES. ##
-- ##                                                                        ##
-- ##   Run it only via `npm run seed:local`, never by hand, and NEVER with  ##
-- ##   `--remote`. It is local demo data for the M1 walkthrough; production ##
-- ##   holds a real Game with real Players.                                 ##
-- ##                                                                        ##
-- ############################################################################
--
-- The guard below is what makes the banner more than a warning. `npm run
-- seed:local` creates the `seed_guard` table (with `--local`) immediately
-- before invoking this file, and this file drops it again at the end. So the
-- table exists in exactly one place: a local database, for the few hundred
-- milliseconds of a deliberate seed run.
--
-- Run this file anywhere else — a mistyped `--remote`, a copy-pasted
-- `wrangler d1 execute ... --file=scripts/seed.sql` — and the very first
-- statement fails with `no such table: seed_guard` before a single `DELETE`
-- is reached. The guard has to come first for that to hold; do not move it,
-- and do not add anything above it.
INSERT INTO seed_guard (ok) VALUES (1);

DELETE FROM fixtures;
DELETE FROM memberships;
DELETE FROM games;
DELETE FROM players;

INSERT INTO players (id, name, email, is_guest) VALUES
  ('player-edward', 'Edward Cooper',  'edward@example.com', 0),
  ('player-sam',    'Sam Okonjo',     'sam@example.com',    0),
  ('player-priya',  'Priya Raman',    'priya@example.com',  0),
  ('player-tom',    'Tom Whitfield',  'tom@example.com',    0),
  ('guest-ringer',  'Dave from work', NULL,                 1);

INSERT INTO games (
  id, name, venue_name, venue_address, timezone,
  recurrence_rule, recurrence_start_date, kickoff_time, duration_minutes,
  min_players, max_players, prefers_even_numbers,
  reminder_days_before, reminder_local_time, short_warning_offset_hours,
  invite_token, active
) VALUES (
  'game-thursday',
  'Thursday 7-a-side',
  'Oxford Sports Park',
  'Court Place Farm, Marsh Lane, Oxford OX3 0NQ',
  'Europe/London',
  'FREQ=WEEKLY;INTERVAL=1;BYDAY=TH',
  '2026-08-13',
  '19:00',
  60,
  10, 14, 1,
  1, '09:00', 12,
  'invite-thursday-demo',
  1
);

INSERT INTO memberships (id, game_id, player_id, role, active) VALUES
  ('m-edward', 'game-thursday', 'player-edward', 'owner',  1),
  ('m-sam',    'game-thursday', 'player-sam',    'player', 1),
  ('m-priya',  'game-thursday', 'player-priya',  'player', 1),
  ('m-tom',    'game-thursday', 'player-tom',    'player', 1);

-- Guard consumed. Dropping it means the next run must go through
-- `npm run seed:local` again to re-create it.
DROP TABLE seed_guard;
