import { eq } from "drizzle-orm";
import { DASHBOARD_PATH } from "../auth/paths.js";
import type { Db } from "../db/client.js";
import { games, notificationLog, players } from "../db/schema.js";
import { pushKey, removalKey } from "./dedupe-key.js";
import {
  applySendResult,
  insertQueuedLogRows,
  playersWithPushSubscriptions,
  SITE_ORIGIN,
  type PendingNotification,
} from "./delivery.js";
import type { Notifier } from "./notifier.js";
import { PUSH_COPY } from "./push-copy.js";
import { renderRemovedEmail } from "./templates/removed.js";

/**
 * What the N-7 send attempt did. Every branch is a value rather than a throw,
 * for the same reason as N-6: this runs *after* the removal is committed, so
 * there is no caller left who could usefully handle an exception — but there
 * is a reader of logs who needs to know which of these happened. An email that
 * never arrives must never be what undoes a removal.
 */
export type RemovedSendOutcome =
  | { kind: "sent" }
  | { kind: "deferred" }
  | { kind: "failed"; reason: string }
  | { kind: "already-logged" }
  | { kind: "skipped-no-recipient" };

export interface SendRemovedEmailParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier` — never a raw provider. */
  notifier: Notifier;
  gameId: string;
  playerId: string;
  /** From `RemoveMemberResult`. Part of the dedupe key, with `leftAt`. */
  membershipId: string;
  /** The `memberships.left_at` this removal wrote. Part of the dedupe key — see `removalKey`. */
  leftAt: Date;
  now: Date;
}

/**
 * Tell a player they have been removed from a squad (N-7, J6a §5).
 *
 * N-6's send path with a different key, template and type, and deliberately no
 * other differences — read `src/notify/send-welcome.ts` for the reasoning
 * behind each step, which applies here unchanged:
 *
 * - `fixtureId: null`, because a removal is about a *membership*.
 * - The dedupe key carries `leftAt`, so a rejoin and a second removal are a
 *   second email rather than one the unique index silently drops.
 * - The ordering is the sweep's (BR-19): `queued` row first, send second,
 *   result recorded third — inheriting the retryability asymmetry, where a
 *   ceiling refusal removes the row so a later attempt is possible and a
 *   provider error leaves it `failed` forever, because an ambiguous failure
 *   may already have reached the inbox.
 */
export async function sendRemovedEmail(params: SendRemovedEmailParams): Promise<RemovedSendOutcome> {
  const { db, notifier, gameId, playerId, membershipId, leftAt, now } = params;

  const [player] = await db
    .select({ name: players.name, email: players.email, isGuest: players.isGuest })
    .from(players)
    .where(eq(players.id, playerId));

  // BR-32: a guest, or anyone whose address is missing or blank, is skipped
  // before a message is built and before anything is written. The `.trim()`
  // matches every other sender's and is load-bearing for the same reason: an
  // email of `" "` is truthy, and letting it through would produce a `queued`
  // row and a `no-recipient` result nothing usefully acts on.
  const email = player?.email?.trim() ?? "";
  if (player === undefined || player.isGuest || email === "") return { kind: "skipped-no-recipient" };

  const [game] = await db.select({ name: games.name }).from(games).where(eq(games.id, gameId));
  // Unreachable in practice — the caller has just updated a membership row
  // whose FK points at this game — so it is reported rather than branched on.
  if (!game) return { kind: "failed", reason: "game-not-found" };

  const emailPayload = { playerName: player.name, gameName: game.name };
  const rendered = renderRemovedEmail(emailPayload);

  const dedupeKey = removalKey(membershipId, leftAt.toISOString());
  const pending: PendingNotification[] = [
    {
      logId: crypto.randomUUID(),
      dedupeKey,
      playerId,
      message: {
        channel: "email",
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        dedupeKey,
      },
    },
  ];

  // Only a player with at least one registered device gets a `PushMessage`
  // (M14 Task 13, spec §9.3 rule 1) — otherwise a player without a phone
  // would accumulate a `no-recipient` row per removal, forever.
  const subscribed = await playersWithPushSubscriptions(db, [playerId]);
  if (subscribed.has(playerId)) {
    const copy = PUSH_COPY.n7(emailPayload);
    pending.push({
      logId: crypto.randomUUID(),
      dedupeKey: pushKey(dedupeKey),
      playerId,
      message: {
        channel: "push",
        to: playerId,
        title: copy.title,
        body: copy.body,
        // N-7 has no fixture, and no other URL, behind it
        // (`RemovedEmailPayload` carries none): the dashboard is the only
        // sensible destination left for a tap.
        url: `${SITE_ORIGIN}${DASHBOARD_PATH}`,
        // Sharpened to the real membership id (review fix — an earlier
        // version of this report claimed no id was available here, which
        // was wrong: `membershipId` is a parameter this function already
        // receives and already uses for `removalKey`, and the tag is set at
        // this call site, not inside `PUSH_COPY`, so sharpening it needs no
        // change to the email payload and touches no TR-20 boundary — same
        // as n1-n4's sharpening). `PUSH_COPY`'s gameName approximation
        // collapses two removals from different squads that happen to
        // share a name — "Thursday 7-a-side" is not a rare one — and a
        // membership id never does.
        tag: `n7:${membershipId}`,
        dedupeKey: pushKey(dedupeKey),
      },
    });
  }

  const inserted = await insertQueuedLogRows(db, { fixtureId: null, notificationType: "n7" }, pending);
  const emailEntry = inserted.find((entry) => entry.message.channel === "email");
  // `inserted.length === 0`, not `!emailEntry`: the email key can conflict
  // (already logged) while the push key does not — a repeat call after the
  // player registers a device between two attempts — and that push row was
  // inserted and must still be sent, not left `queued` forever with nothing
  // to reap it (review fix, Important 3). `emailOutcome` below stays
  // `undefined` in that case, so the function still reports `already-logged`
  // for the email leg even though the push row was sent.
  if (inserted.length === 0) return { kind: "already-logged" };

  let results;
  try {
    results = await notifier.send(inserted.map((entry) => entry.message));
  } catch (error) {
    // The notifier rejected — e.g. `QuotaNotifier.reserve()` hitting a D1
    // error. Whether the message reached a provider first is unknowable from
    // here, so every row this batch inserted is left `failed` (ambiguous,
    // never retried), exactly as every other sender does with the same
    // situation.
    const reason = error instanceof Error ? error.message : String(error);
    for (const entry of inserted) {
      await db
        .update(notificationLog)
        .set({ status: "failed", error: reason })
        .where(eq(notificationLog.id, entry.logId));
    }
    // If no email row was ever inserted this call (only a push row was —
    // see the guard above), the email leg itself is untouched by this
    // rejection; reporting `failed` would misattribute a push-only failure
    // to the email.
    return emailEntry ? { kind: "failed", reason } : { kind: "already-logged" };
  }

  // See `send-promotion.ts` for why every row's own result is applied but
  // the function's return value tracks only the email leg.
  let emailOutcome: RemovedSendOutcome | undefined;
  for (let i = 0; i < inserted.length; i++) {
    const entry = inserted[i];
    if (!entry) continue;
    const outcome = await applySendResult(db, entry, results[i], now);
    if (entry === emailEntry) {
      emailOutcome =
        outcome.kind === "sent"
          ? { kind: "sent" }
          : outcome.kind === "deferred"
            ? { kind: "deferred" }
            : { kind: "failed", reason: outcome.reason };
    }
  }
  return emailOutcome ?? { kind: "already-logged" };
}
