import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { getFixtureWithSquad } from "../db/queries.js";
import { notificationLog, players } from "../db/schema.js";
import { displayName } from "../domain/display-name.js";
import { squadForViewer } from "../domain/squad-visibility.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { leaveTokenExpiry, signLeaveToken } from "../domain/token.js";
import { TEAM_IDS, teamNames } from "../domain/teams.js";
import { teamsKey } from "./dedupe-key.js";
import {
  applySendResult,
  insertQueuedLogRows,
  markOrphanedRowsFailed,
  SITE_ORIGIN,
  type PendingNotification,
} from "./delivery.js";
import type { Notifier } from "./notifier.js";
import { renderTeamsEmail } from "./templates/teams.js";

/** What one publish's worth of N-9 sends did, in aggregate. */
export interface TeamsSendResult {
  sent: number;
  failed: number;
  deferred: number;
  /** BR-32: guests, and anyone with no usable address. Not a log row (see the guard below). */
  guestsSkipped: number;
}

export interface SendTeamsEmailsParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier` — never a raw provider. */
  notifier: Notifier;
  fixtureId: string;
  /**
   * The instant this publish happened. Part of the dedupe key (`teamsKey`),
   * and echoed into every recipient's row unmodified — never re-derived per
   * player, or a single publish would mint a different key for each of them.
   */
  publishedAt: Date;
  /** The request's `now`. Used for `sent_at` and the leave token's expiry. */
  now: Date;
  responseTokenSecret: string;
}

/**
 * Tell the whole squad an organiser has just published a team pick for a
 * fixture (N-9, BR-35).
 *
 * **Every `in` player with a usable address, once per publish.** Unlike N-2
 * (one recipient) this is closer in shape to the reminder sweep: one batch of
 * messages, inserted, sent and applied together, following exactly the same
 * ordering as `insertQueuedLogRows` / `applySendResult` (§2.4, BR-19) — the
 * `queued` row lands first, the send happens second, the outcome is recorded
 * third, and a crash mid-apply is closed the same way the sweep closes it:
 * `markOrphanedRowsFailed` marks whatever `applySendResult` never reached
 * `failed` rather than leaving it `queued` forever, which the next publish's
 * dedupe key (`publishedAt` again) would not even see as "already handled",
 * since a genuinely new publish always has a genuinely new key.
 *
 * **Every recipient already has a side.** The publish route this sender is
 * called from (a later task) refuses to publish while `unassignedIn` from
 * `src/domain/teams.ts` is non-empty, so every `in` player reaching this
 * function has a `team`. This is not re-checked here — re-deriving that
 * invariant per player would be a second copy of the publish guard's rule,
 * which is exactly the kind of drift `src/domain/teams.ts`'s module comment
 * warns about.
 *
 * **BR-33 is applied here, once.** `squadForViewer` decides whether the
 * *other* players are visible — as a non-owner, since this message is the
 * player-facing announcement regardless of which recipient happens to also
 * be an owner. A `null` back from it means `lineUps` is `null` for every
 * recipient in this send; the recipient's own side is read from their own
 * squad row, never from the (possibly hidden) list, so it is never affected
 * by that decision.
 */
export async function sendTeamsEmails(params: SendTeamsEmailsParams): Promise<TeamsSendResult> {
  const { db, notifier, fixtureId, publishedAt, now, responseTokenSecret } = params;

  const withSquad = await getFixtureWithSquad(db, fixtureId);
  if (withSquad === null) {
    // Unreachable in practice: the publish route that calls this has just
    // loaded and updated this same fixture inside the same request. Reported
    // loudly rather than thrown — this typically runs inside
    // `c.executionCtx.waitUntil`, after the organiser's own response has
    // already been sent, so there is no caller left to hand a rejection to.
    console.error(`sendTeamsEmails: fixture ${fixtureId} not found`);
    return { sent: 0, failed: 0, deferred: 0, guestsSkipped: 0 };
  }
  const { fixture, game, squad } = withSquad;

  const inSquad = squad.filter((member) => member.status === "in" && member.team !== null);

  const names = teamNames(game);
  const visibleSquad = squadForViewer(game, inSquad, { isOwner: false });
  const lineUps =
    visibleSquad === null
      ? null
      : TEAM_IDS.map((id) => ({
          name: names[id],
          players: visibleSquad
            .filter((member) => member.team === id)
            .map((member) => `${displayName(member.name, member.erasedAt)}${member.isGuest ? " (guest)" : ""}`),
        }));

  // `SquadMember` carries no email — every other sender in this file's
  // family re-queries `players` for it, and this one does the same, in one
  // batch rather than once per recipient.
  const emailRows =
    inSquad.length === 0
      ? []
      : await db
          .select({ id: players.id, email: players.email })
          .from(players)
          .where(inArray(players.id, inSquad.map((member) => member.playerId)));
  const emailByPlayerId = new Map(emailRows.map((row) => [row.id, row.email]));

  const whenLocal = formatLocalDateTime(fixture.kicksOffAt, game.timezone);
  const venueName = fixture.venueOverride ?? game.venueName;
  const publishedAtIso = publishedAt.toISOString();

  let guestsSkipped = 0;
  const pending: PendingNotification[] = [];

  for (const member of inSquad) {
    // BR-32: a guest, or anyone whose address is missing or blank, is skipped
    // before a message is built and before anything is written. The
    // `.trim()` matches `send-welcome.ts` and `send-promotion.ts` exactly,
    // and is load-bearing for the same reason: an email of `" "` is truthy,
    // and letting it through would produce a `queued` row and a
    // `no-recipient` result that nothing usefully acts on.
    const email = emailByPlayerId.get(member.playerId)?.trim() ?? "";
    if (member.isGuest || email === "") {
      guestsSkipped++;
      continue;
    }

    // A leave token, scoped to the Game rather than to this Fixture — same
    // reasoning as every other game-scoped notification (BR-22, §2.2).
    const leaveToken = await signLeaveToken(
      { gameId: game.id, playerId: member.playerId, expiresAt: leaveTokenExpiry(now).getTime() },
      responseTokenSecret,
    );

    // Non-null by the `inSquad` filter above.
    const team = member.team!;

    const rendered = renderTeamsEmail({
      playerName: member.name,
      gameName: game.name,
      venueName,
      whenLocal,
      yourSideName: names[team],
      lineUps,
      leaveUrl: `${SITE_ORIGIN}/leave/${leaveToken}`,
    });

    const dedupeKey = teamsKey(fixtureId, member.playerId, publishedAtIso);
    pending.push({
      logId: crypto.randomUUID(),
      dedupeKey,
      playerId: member.playerId,
      message: {
        channel: "email",
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        dedupeKey,
      },
    });
  }

  if (pending.length === 0) return { sent: 0, failed: 0, deferred: 0, guestsSkipped };

  const inserted = await insertQueuedLogRows(db, { fixtureId, notificationType: "n9" }, pending);
  if (inserted.length === 0) return { sent: 0, failed: 0, deferred: 0, guestsSkipped };

  let results;
  try {
    results = await notifier.send(inserted.map((entry) => entry.message));
  } catch (error) {
    // The notifier rejected — e.g. `QuotaNotifier.reserve()` hitting a D1
    // error mid-batch. Whether any message in this batch reached a provider
    // first is unknowable from here, so every row this batch inserted is left
    // `failed` (ambiguous, never retried), exactly as the sweep and
    // `send-promotion.ts` do with the same situation.
    const reason = error instanceof Error ? error.message : String(error);
    for (const entry of inserted) {
      await db
        .update(notificationLog)
        .set({ status: "failed", error: reason })
        .where(eq(notificationLog.id, entry.logId));
    }
    return { sent: 0, failed: inserted.length, deferred: 0, guestsSkipped };
  }

  // `results` and `inserted` are the same length, in the same order — the
  // Notifier contract (`src/notify/notifier.ts`) — so pairing by index never
  // drifts. The loop writes one row at a time and can abort part-way through;
  // `markOrphanedRowsFailed` closes the hole an aborted loop would otherwise
  // leave, exactly as `sendDueReminders` does for N-1.
  let sent = 0;
  let failed = 0;
  let deferred = 0;
  let applied = 0;
  try {
    for (; applied < inserted.length; applied++) {
      const entry = inserted[applied];
      const result = results[applied];
      if (!entry) continue;
      const outcome = await applySendResult(db, entry, result, now);
      if (outcome.kind === "sent") sent++;
      else if (outcome.kind === "deferred") deferred++;
      else failed++;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const orphaned = inserted.slice(applied);
    failed += orphaned.length;
    await markOrphanedRowsFailed(db, orphaned, `abandoned mid-apply: ${message}`);
  }

  return { sent, failed, deferred, guestsSkipped };
}
