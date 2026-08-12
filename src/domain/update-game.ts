import { and, count, eq, gte, ne } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import type { Db } from "../db/client.js";
import { fixtures, games } from "../db/schema.js";
import type { GameFormValues } from "./game-form.js";
import { localDateToday } from "./game-form.js";
import { fixtureRowsFor, MATERIALISATION_HORIZON_DAYS } from "./materialise.js";

const DAY_MS = 86_400_000;

export interface UpdateGameParams {
  db: Db;
  game: typeof games.$inferSelect;
  values: GameFormValues;
  actorPlayerId: string;
  now: Date;
}

export interface UpdateGameResult {
  /** Scheduled fixtures deleted and rebuilt. */
  scheduledRewritten: number;
  /** Open, played and cancelled fixtures left exactly as they were. */
  untouched: number;
}

/**
 * Save a game's settings and propagate them to its future fixtures (spec §3.3).
 *
 * **What propagates, and why the line is where it is.** §2.8 copies five
 * columns onto each fixture at materialisation "so changing the Game later
 * doesn't rewrite history". Read literally that would freeze a `scheduled`
 * fixture four weeks out, which is not what an owner means when they correct a
 * kickoff time. The line this function draws instead is *has anyone been told
 * about this fixture yet*: `open` means the reminder has been sent (BR-11), so
 * its terms are in somebody's inbox and are genuinely history. `scheduled`
 * means nobody has heard anything, so there is nothing to preserve.
 *
 * **Delete and re-materialise, not update in place.** Re-deriving kickoff
 * instants moves rows onto new `kicks_off_at` values, and a game shifted by a
 * week moves every fixture onto the slot its neighbour held — which the
 * `(game_id, kicks_off_at)` unique index refuses. Deleting the whole
 * `scheduled` set first sidesteps that entirely.
 *
 * This is safe *only* for `scheduled` fixtures, and that is a second
 * independent reason the others are excluded: a `scheduled` fixture has no
 * `responses` and no `notification_log` rows — both are written when it opens
 * — so nothing holds a foreign key to the ids being deleted. Deleting an
 * `open` fixture this way would orphan real data.
 *
 * Everything is one `db.batch()`: D1 has no interactive transactions, so this
 * is the only way the delete and the re-insert cannot half-happen.
 */
export async function updateGame(params: UpdateGameParams): Promise<UpdateGameResult> {
  const { db, game, values, actorPlayerId, now } = params;

  // Re-anchor only when the *pattern* moves. A fortnightly game keeps counting
  // from its original anchor when only the kickoff time changes; if the day or
  // the interval changes, the old anchor names a week that no longer means
  // anything and "every other Monday" would start on the wrong one.
  const patternChanged = values.recurrenceRule !== game.recurrenceRule;
  const recurrenceStartDate = patternChanged
    ? localDateToday(now, values.timezone)
    : game.recurrenceStartDate;

  const updated = { ...game, ...values, recurrenceStartDate };

  const horizon = new Date(now.getTime() + MATERIALISATION_HORIZON_DAYS * DAY_MS);
  const rows = fixtureRowsFor(updated, now, horizon);

  const scheduledBefore = await db
    .select({ value: count() })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, game.id), eq(fixtures.lifecycle, "scheduled")));

  const untouched = await db
    .select({ value: count() })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, game.id), ne(fixtures.lifecycle, "scheduled")));

  const statements = [
    db.update(games).set({ ...values, recurrenceStartDate }).where(eq(games.id, game.id)),
    // Scoped to this game *and* to `scheduled`. Both halves are load-bearing.
    db.delete(fixtures).where(and(eq(fixtures.gameId, game.id), eq(fixtures.lifecycle, "scheduled"))),
    ...chunk(rows, INSERT_CHUNK_SIZE).map((batch) =>
      // `onConflictDoNothing` because a re-derived instant can collide with a
      // surviving `open` fixture at the same moment — the open one wins, since
      // it is the one people were emailed about.
      db.insert(fixtures).values(batch).onConflictDoNothing(),
    ),
    buildAuditInsert(db, {
      actorPlayerId,
      entityType: "game",
      entityId: game.id,
      action: "game.updated",
      before: auditShape(game),
      after: auditShape(updated),
      now,
    }),
  ];

  await db.batch(statements as [typeof statements[number], ...typeof statements]);

  return {
    scheduledRewritten: scheduledBefore[0]?.value ?? 0,
    untouched: untouched[0]?.value ?? 0,
  };
}

/** The fields worth showing an owner in an audit trail — not the whole row. */
function auditShape(game: {
  name: string;
  venueName: string;
  kickoffTime: string;
  recurrenceRule: string;
  minPlayers: number;
  maxPlayers: number;
  prefersEvenNumbers: boolean;
  timezone: string;
}) {
  return {
    name: game.name,
    venueName: game.venueName,
    kickoffTime: game.kickoffTime,
    recurrenceRule: game.recurrenceRule,
    minPlayers: game.minPlayers,
    maxPlayers: game.maxPlayers,
    prefersEvenNumbers: game.prefersEvenNumbers,
    timezone: game.timezone,
  };
}

/**
 * How many fixtures an edit would rewrite, and how many it would leave alone.
 * Shown on the edit form before the save, so the effect is never a surprise.
 */
export async function countFixturesByPropagation(
  db: Db,
  gameId: string,
  now: Date,
): Promise<{ scheduled: number; untouched: number }> {
  const [scheduled] = await db
    .select({ value: count() })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), eq(fixtures.lifecycle, "scheduled"), gte(fixtures.kicksOffAt, now)));
  const [untouched] = await db
    .select({ value: count() })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), ne(fixtures.lifecycle, "scheduled"), gte(fixtures.kicksOffAt, now)));

  return { scheduled: scheduled?.value ?? 0, untouched: untouched?.value ?? 0 };
}
