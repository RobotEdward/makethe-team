SELECT
  f.id,
  datetime(f.kicks_off_at / 1000, 'unixepoch') AS kicks_off_at_utc,
  f.lifecycle,
  f.min_players,
  f.max_players,
  f.prefers_even_numbers,
  f.in_count
FROM fixtures f
JOIN games g ON g.id = f.game_id
ORDER BY f.kicks_off_at;
