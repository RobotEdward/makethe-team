import { eq } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { games, memberships } from "../db/schema.js";
import type { GameFormValues } from "./game-form.js";
import { localDateToday } from "./game-form.js";
import { materialiseGame } from "./materialise.js";

export interface CreateGameParams {
  db: Db;
  values: GameFormValues;
  /** The signed-in person creating it. They become the first Owner. */
  ownerPlayerId: string;
  now: Date;
}

export interface CreatedGame {
  gameId: string;
  inviteToken: string;
  fixturesCreated: number;
}

/**
 * Create a game, make its creator an Owner, and materialise its first four
 * weeks of fixtures (J1).
 *
 * **Materialising here rather than leaving it to the daily cron** is
 * deliberate: J1 promises "no further action needed — fixtures generate
 * themselves", and a game whose fixture list is empty for up to a day reads as
 * broken on the page the owner lands on immediately after creating it.
 *
 * `recurrence_start_date` is today's date *in the game's own timezone*, not
 * UTC and not the creator's. It anchors an INTERVAL=2 recurrence, which is
 * undefined without one (§2.8) — "every other Thursday" has no meaning until
 * you know which Thursday the fortnight counts from.
 *
 * The game row, the membership and the audit row go in one `db.batch()` —
 * D1's only atomicity primitive. Materialisation follows *outside* it, because
 * it needs the committed game row to expand and because it is idempotent by
 * way of the `(game_id, kicks_off_at)` unique index: if it fails, the game
 * exists with no fixtures and the next daily sweep fills them in, which is a
 * recoverable state. The reverse order would not be.
 *
 * **A materialisation failure is caught here, not left to propagate.** The
 * batch above has already committed by the time `materialiseGame` runs, so a
 * throw at that point does not mean the create failed — it means the create
 * succeeded and the *convenience* of having fixtures ready immediately did
 * not. Letting it propagate would turn a recoverable, already-committed state
 * into a 500 for the owner: they would never see the redirect, would have no
 * way to tell the game was created, and a natural retry would create a
 * *second* game with identical values. So this returns normally with
 * `fixturesCreated: 0`, and the caller still redirects to the new game exactly
 * as it would have on success. The daily sweep (`materialiseFixtures`) picks
 * up the gap by the same idempotent path.
 */
export async function createGame(params: CreateGameParams): Promise<CreatedGame> {
  const { db, values, ownerPlayerId, now } = params;

  const gameId = crypto.randomUUID();
  const inviteToken = crypto.randomUUID();

  await db.batch([
    db.insert(games).values({
      id: gameId,
      ...values,
      recurrenceStartDate: localDateToday(now, values.timezone),
      inviteToken,
      active: true,
      createdAt: now,
    }),
    db.insert(memberships).values({
      id: crypto.randomUUID(),
      gameId,
      playerId: ownerPlayerId,
      role: "owner",
      active: true,
      joinedAt: now,
    }),
    buildAuditInsert(db, {
      actorPlayerId: ownerPlayerId,
      entityType: "game",
      entityId: gameId,
      action: "game.created",
      after: { name: values.name, venueName: values.venueName, recurrenceRule: values.recurrenceRule },
      now,
    }),
  ]);

  let fixturesCreated = 0;
  try {
    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    if (game) fixturesCreated = await materialiseGame(db, game, now);
  } catch (error) {
    // See the doc comment above: the game and its owner membership are
    // already committed, so this is logged for the daily sweep to be
    // diagnosable, not rethrown.
    console.error(
      `materialising fixtures for newly created game ${gameId} failed, leaving it to the daily sweep: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
  }

  return { gameId, inviteToken, fixturesCreated };
}
