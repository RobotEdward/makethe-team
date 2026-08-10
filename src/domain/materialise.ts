import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { fixtures, games } from "../db/schema.js";
import { expandWeekly } from "./recurrence/expand.js";
import { parseRecurrenceRule } from "./recurrence/parse.js";
import { parseLocalDate, parseLocalTime } from "./time/local.js";

export const MATERIALISATION_HORIZON_DAYS = 28;

const DAY_MS = 86_400_000;

// D1 rejects a statement with more than 100 bound parameters. The effective
// per-row parameter count is a Drizzle implementation detail (measured at 11
// for the 9 declared `fixtures` columns we insert here, not a 1:1 mapping),
// so we do not compute a chunk size from arithmetic on the column count.
// A small, conservative constant leaves headroom for extra columns, longer
// horizons, or sub-weekly recurrence rules that produce more rows per game.
const INSERT_CHUNK_SIZE = 8;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export interface MaterialisationResult {
  gamesProcessed: number;
  fixturesCreated: number;
  failures: Array<{ gameId: string; message: string }>;
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
  const activeGames = await db.select().from(games).where(eq(games.active, true));
  const horizon = new Date(now.getTime() + horizonDays * DAY_MS);

  const result: MaterialisationResult = {
    gamesProcessed: activeGames.length,
    fixturesCreated: 0,
    failures: [],
  };

  for (const game of activeGames) {
    try {
      const rule = parseRecurrenceRule(game.recurrenceRule);
      const instants = expandWeekly(
        rule,
        parseLocalDate(game.recurrenceStartDate),
        parseLocalTime(game.kickoffTime),
        game.timezone,
        now,
        horizon,
      );

      if (instants.length === 0) continue;

      const rows = instants.map((kicksOffAt) => ({
        id: crypto.randomUUID(),
        gameId: game.id,
        kicksOffAt,
        lifecycle: "scheduled" as const,
        minPlayers: game.minPlayers,
        maxPlayers: game.maxPlayers,
        prefersEvenNumbers: game.prefersEvenNumbers,
        shortWarningOffsetHours: game.shortWarningOffsetHours,
        durationMinutes: game.durationMinutes,
      }));

      // Chunked to stay under D1's 100-bound-parameter limit (see
      // INSERT_CHUNK_SIZE above). This means a game's fixtures are no longer
      // written in a single statement, so a failure partway through can leave
      // earlier chunks committed and later ones missing. That is intentional
      // and safe, not a bug to "fix" back into one statement: the whole
      // operation is idempotent via onConflictDoNothing, so the next run
      // simply completes whatever chunks are still missing.
      for (const batch of chunk(rows, INSERT_CHUNK_SIZE)) {
        const inserted = await db.insert(fixtures).values(batch).onConflictDoNothing().returning({ id: fixtures.id });

        result.fixturesCreated += inserted.length;
      }
    } catch (error) {
      result.failures.push({
        gameId: game.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
