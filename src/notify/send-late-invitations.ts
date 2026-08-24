import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { fixtures, games, players, responses } from "../db/schema.js";
import { applySendResult, insertQueuedLogRows, markOrphanedRowsFailed } from "./delivery.js";
import type { Notifier } from "./notifier.js";
import { buildReminderMessages } from "./reminder-messages.js";

export interface LateInvitationSummary {
  sent: number;
  failed: number;
  /** Refused by the daily ceiling; the row was removed, so the hourly sweep retries it. */
  deferred: number;
  /** Fixtures skipped because they were no longer `open`, or the player had no usable address. */
  skipped: number;
}

/**
 * Send the N-1 invitation, immediately, to one player just backfilled into
 * already-open fixtures (BR-2′) — the message everyone else got when the
 * fixture opened its reminder window.
 *
 * Runs in the join flow's background task next to the N-6 welcome, because
 * the whole point of the rule change is the organiser desperately filling
 * this week's game: an invitee who joined thirty seconds ago should be able
 * to say "I'm in" now, not after the next hourly sweep tick.
 *
 * Reuses the sweep's exact message build and `n1` dedupe key, so the log row
 * written here is the one `existingReminderLog` checks — the sweep skips this
 * player and no duplicate goes out (BR-19). A ceiling refusal deletes the
 * `queued` row (`applySendResult`), so the sweep picks the player up on a
 * later tick instead — degraded to the pre-BR-2′ timing, never lost.
 *
 * The caller passes the fixture ids the backfill actually inserted, but the
 * `open` re-check here is not redundant: this runs in a `waitUntil` after the
 * response has gone out, and a fixture can be cancelled in the gap.
 */
export async function sendLateInvitations(params: {
  db: Db;
  notifier: Notifier;
  playerId: string;
  fixtureIds: readonly string[];
  responseTokenSecret: string;
  now: Date;
}): Promise<LateInvitationSummary> {
  const { db, notifier, playerId, fixtureIds, responseTokenSecret, now } = params;
  const summary: LateInvitationSummary = { sent: 0, failed: 0, deferred: 0, skipped: 0 };
  if (fixtureIds.length === 0) return summary;

  const [player] = await db.select().from(players).where(eq(players.id, playerId));
  // The join flow always has an address, but this mirrors the sweep's BR-32
  // guard so the two callers of `buildReminderMessages` filter identically.
  if (!player || player.isGuest || !player.email || player.email.trim() === "") {
    summary.skipped = fixtureIds.length;
    return summary;
  }

  for (const fixtureId of fixtureIds) {
    const [row] = await db
      .select({ fixture: fixtures, game: games })
      .from(fixtures)
      .innerJoin(games, eq(fixtures.gameId, games.id))
      .where(eq(fixtures.id, fixtureId));
    if (!row || row.fixture.lifecycle !== "open") {
      summary.skipped++;
      continue;
    }

    // BR-2′ backfills a row for a late joiner, but a gated Game (M34) has not
    // necessarily asked their tier yet (BR-41). Skipping here leaves them to
    // the reconciler, which stamps them the moment their tier is released and
    // hands them to the sweep's own N-1 — the same message, a little later.
    // Without this, joining a gated squad would jump the whole invite order.
    if (row.game.gatedInvitesEnabled) {
      const [response] = await db
        .select({ invitedAt: responses.invitedAt })
        .from(responses)
        .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
      if (!response || response.invitedAt === null) {
        summary.skipped++;
        continue;
      }
    }

    const pending = await buildReminderMessages({
      db,
      fixture: row.fixture,
      game: row.game,
      candidates: [{ playerId, name: player.name, email: player.email, isGuest: player.isGuest }],
      responseTokenSecret,
      now,
    });

    const inserted = await insertQueuedLogRows(db, { fixtureId, notificationType: "n1" }, pending);
    if (inserted.length === 0) continue;

    let results;
    try {
      results = await notifier.send(inserted.map((entry) => entry.message));
    } catch (error) {
      // The notifier itself rejected mid-batch: whether anything reached a
      // provider is unknowable, so the rows are marked `failed` (ambiguous,
      // never retried) exactly as the sweep does — BR-19 treats a duplicate
      // as strictly worse than a miss.
      const message = error instanceof Error ? error.message : String(error);
      await markOrphanedRowsFailed(db, inserted, `late invitation send rejected: ${message}`);
      summary.failed += inserted.length;
      continue;
    }

    for (let i = 0; i < inserted.length; i++) {
      const entry = inserted[i];
      if (!entry) continue;
      const outcome = await applySendResult(db, entry, results[i], now);
      if (outcome.kind === "sent") summary.sent++;
      else if (outcome.kind === "deferred") summary.deferred++;
      else summary.failed++;
    }
  }

  return summary;
}
