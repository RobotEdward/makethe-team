-- Local demo data for the M1 walkthrough. Never run against production.
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
