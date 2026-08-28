import { and, eq, notInArray } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { fixtures, games } from "../db/schema.js";
import { cancelFixture, type CancellationRecipient } from "./cancel-fixture.js";
import { TERMINAL_LIFECYCLES } from "./lifecycle.js";
import { findGameForOwner } from "../db/queries.js";

export interface ArchiveGameInput {
  gameId: string;
  actorPlayerId: string;
  now: Date;
}

/** One fixture the archive called off, with who is owed N-3 for it. */
export interface CancelledByArchive {
  fixture: typeof fixtures.$inferSelect;
  recipients: CancellationRecipient[];
}

export type ArchiveGameResult =
  | { archived: true; cancelled: CancelledByArchive[] }
  | { archived: false; reason: "not-entitled" | "already-archived" };

export type UnarchiveGameResult =
  | { unarchived: true }
  | { unarchived: false; reason: "not-entitled" | "not-archived" };

/**
 * Archive a game (M41): call off every fixture that has not yet happened,
 * then stamp `archived_at`.
 *
 * The fixtures are cancelled through `cancelFixture`, one batch each, so
 * each one is real `cancelled` history with its own audit row and its own
 * N-3 recipients — not a `scheduled` row left stranded in the past for every
 * list to special-case. **This function sends nothing**; the route mails the
 * recipients, exactly as `/cancel` does.
 *
 * Ordered so a failure is recoverable by pressing the button again: the
 * fixtures go first and the `archived_at` write last, so a cancel that
 * throws partway leaves the game live with fewer fixtures, and the next
 * attempt cancels only what is left (`cancelFixture` refuses a cancelled
 * fixture, and this loop only ever selects non-terminal ones). Once
 * `archived_at` is set, `src/app.ts`'s guard refuses this route and every
 * other `POST` on the game.
 *
 * `not-entitled` covers "no such game" too, for the reason `cancelFixture`
 * gives: a refusal must not say whether the game exists (TR-18).
 */
export async function archiveGame(db: Db, input: ArchiveGameInput): Promise<ArchiveGameResult> {
  const { gameId, actorPlayerId, now } = input;
  const game = await findGameForOwner(db, gameId, actorPlayerId);
  if (game === null) return { archived: false, reason: "not-entitled" };
  if (game.archivedAt !== null) return { archived: false, reason: "already-archived" };

  const pending = await db
    .select()
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), notInArray(fixtures.lifecycle, [...TERMINAL_LIFECYCLES])))
    .orderBy(fixtures.kicksOffAt);

  const cancelled: CancelledByArchive[] = [];
  for (const fixture of pending) {
    const result = await cancelFixture(db, { fixtureId: fixture.id, actorPlayerId, reason: "", now });
    // A fixture that raced to `played` or `cancelled` between the select and
    // here is simply not ours to report; the archive still completes.
    if (result.cancelled) cancelled.push({ fixture, recipients: result.recipients });
  }

  await db.batch([
    db.update(games).set({ archivedAt: now }).where(eq(games.id, gameId)),
    buildAuditInsert(db, {
      actorPlayerId,
      entityType: "game",
      entityId: gameId,
      action: "game.archived",
      before: { archivedAt: null },
      after: { archivedAt: now.toISOString(), fixturesCancelled: cancelled.length },
      now,
    }),
  ]);

  return { archived: true, cancelled };
}

/**
 * Reopen an archived game. Clears the stamp and nothing else: the next sweep
 * materialises fixtures forward from now (`fixtureRowsFor` never backfills),
 * and the fixtures the archive cancelled stay cancelled — they were
 * announced as off, and un-announcing them is not a thing this app does.
 */
export async function unarchiveGame(db: Db, input: ArchiveGameInput): Promise<UnarchiveGameResult> {
  const { gameId, actorPlayerId, now } = input;
  const game = await findGameForOwner(db, gameId, actorPlayerId);
  if (game === null) return { unarchived: false, reason: "not-entitled" };
  if (game.archivedAt === null) return { unarchived: false, reason: "not-archived" };

  await db.batch([
    db.update(games).set({ archivedAt: null }).where(eq(games.id, gameId)),
    buildAuditInsert(db, {
      actorPlayerId,
      entityType: "game",
      entityId: gameId,
      action: "game.unarchived",
      before: { archivedAt: game.archivedAt.toISOString() },
      after: { archivedAt: null },
      now,
    }),
  ]);
  return { unarchived: true };
}
