import { and, eq, isNull } from "drizzle-orm";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import type { Db } from "../db/client.js";
import { fixtures, games } from "../db/schema.js";
import { INITIAL_LIFECYCLE } from "./lifecycle.js";
import { expandWeekly } from "./recurrence/expand.js";
import { parseRecurrenceRule } from "./recurrence/parse.js";
import { parseLocalDate, parseLocalTime } from "./time/local.js";

// BR-10/TR-6 require *at least* 4 weeks of future fixtures. The horizon is
// measured from `now`, so a flat 28 would decay towards 27 between daily runs
// and a missed run would breach the guarantee outright. 35 keeps a week of
// margin at the cost of one extra row per game per week.
export const MATERIALISATION_HORIZON_DAYS = 35;

const DAY_MS = 86_400_000;

// See src/db/chunk.ts for why rows are chunked and how the constant was
// measured.

export interface MaterialisationResult {
  gamesProcessed: number;
  fixturesCreated: number;
  failures: Array<{ gameId: string; message: string }>;
}

export type FixtureInsert = typeof fixtures.$inferInsert;
export type Game = typeof games.$inferSelect;

/**
 * The fixture rows one game's recurrence produces between `now` and `horizon`.
 * Pure — builds rows, writes nothing.
 *
 * Split out from `materialiseFixtures` so an edit can re-derive a game's
 * `scheduled` fixtures inside its own `db.batch()` (see
 * `src/domain/update-game.ts`) without a second implementation of
 * recurrence-to-fixtures, and without this function deciding when to write.
 */
export function fixtureRowsFor(game: Game, now: Date, horizon: Date): FixtureInsert[] {
  const rule = parseRecurrenceRule(game.recurrenceRule);
  const instants = expandWeekly(
    rule,
    parseLocalDate(game.recurrenceStartDate),
    parseLocalTime(game.kickoffTime),
    game.timezone,
    now,
    horizon,
  );

  return instants.map((kicksOffAt) => ({
    id: crypto.randomUUID(),
    gameId: game.id,
    kicksOffAt,
    lifecycle: INITIAL_LIFECYCLE,
    minPlayers: game.minPlayers,
    maxPlayers: game.maxPlayers,
    prefersEvenNumbers: game.prefersEvenNumbers,
    shortWarningOffsetHours: game.shortWarningOffsetHours,
    durationMinutes: game.durationMinutes,
  }));
}

/**
 * Materialise one game's fixtures out to the horizon, returning how many rows
 * were actually created.
 *
 * Idempotent via the `(game_id, kicks_off_at)` unique index, which is what
 * makes the chunked write safe partway through — see the comment inside.
 */
export async function materialiseGame(
  db: Db,
  game: Game,
  now: Date,
  horizonDays: number = MATERIALISATION_HORIZON_DAYS,
): Promise<number> {
  const rows = fixtureRowsFor(game, now, new Date(now.getTime() + horizonDays * DAY_MS));
  if (rows.length === 0) return 0;

  let created = 0;
  // Chunked to stay under D1's 100-bound-parameter limit (TR-38). A failure
  // partway leaves earlier chunks committed and later ones missing, which is
  // safe only because onConflictDoNothing makes the whole operation
  // idempotent — the next run completes whatever is missing.
  for (const batch of chunk(rows, INSERT_CHUNK_SIZE)) {
    const inserted = await db.insert(fixtures).values(batch).onConflictDoNothing().returning({ id: fixtures.id });
    created += inserted.length;
  }
  return created;
}

/**
 * Ensure every active game has fixture rows out to the horizon (BR-10, TR-6).
 *
 * Idempotent by way of the (game_id, kicks_off_at) unique index rather than by
 * checking first: the daily cron may overlap with itself or be retried, and a
 * check-then-insert would race. A cancelled fixture keeps its row, so conflict
 * handling is also what stops it being silently resurrected (BR-16).
 *
 * One broken game must not stop the others — a bad recurrence rule is recorded
 * as a failure and the sweep continues.
 */
export async function materialiseFixtures(
  db: Db,
  now: Date,
  horizonDays: number = MATERIALISATION_HORIZON_DAYS,
): Promise<MaterialisationResult> {
  // Archived games (M41) get no new fixtures; their existing ones were
  // cancelled when they were archived.
  const activeGames = await db
    .select()
    .from(games)
    .where(and(eq(games.active, true), isNull(games.archivedAt)));

  const result: MaterialisationResult = {
    gamesProcessed: activeGames.length,
    fixturesCreated: 0,
    failures: [],
  };

  for (const game of activeGames) {
    try {
      result.fixturesCreated += await materialiseGame(db, game, now, horizonDays);
    } catch (error) {
      result.failures.push({
        gameId: game.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
