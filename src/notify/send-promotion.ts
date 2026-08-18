import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { fixtures, games, notificationLog, players } from "../db/schema.js";
import type { WaitlistPromotion } from "../capacity/types.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { leaveTokenExpiry, responseTokenExpiry, signLeaveToken, signResponseToken } from "../domain/token.js";
import { promotionKey, pushKey } from "./dedupe-key.js";
import {
  applySendResult,
  insertQueuedLogRows,
  playersWithPushSubscriptions,
  SITE_ORIGIN,
  type PendingNotification,
} from "./delivery.js";
import type { Notifier } from "./notifier.js";
import { PUSH_COPY } from "./push-copy.js";
import { renderPromotionEmail } from "./templates/promotion.js";

/**
 * What the N-2 send attempt did. Every branch is a value rather than a throw:
 * this runs *after* the player's response has already been recorded and, in
 * the route, after their page has been returned, so there is no caller left
 * who could usefully handle an exception — but there is very much a reader of
 * logs who needs to know which of these happened.
 *
 * - `sent` — delivered (or at least accepted by the provider); row `sent`.
 * - `skipped-no-recipient` — the promoted player is a guest, or has no usable
 *   address. Not an error and **not a log row**: unlike a ceiling refusal
 *   there is nothing here that a later run could retry, so writing a row that
 *   would then have to be cleaned up would be pure noise (BR-32).
 * - `deferred` — refused by the daily ceiling; row removed, so a future
 *   promotion pass or backfill could legitimately try again.
 * - `failed` — a provider error (row left `failed`, never retried — it may
 *   have been delivered) or a notifier that rejected outright.
 * - `already-logged` — a row with this exact dedupe key already existed. The
 *   unique index on `notification_log.dedupe_key`, not any cleverness here,
 *   is what makes concurrent attempts safe.
 * - `fixture-not-found` / `player-not-found` — the row vanished between the
 *   Durable Object returning and this read. Reported, never thrown.
 */
export type PromotionSendOutcome =
  | { kind: "sent" }
  | { kind: "skipped-no-recipient" }
  | { kind: "deferred" }
  | { kind: "failed"; reason: string }
  | { kind: "already-logged" }
  | { kind: "fixture-not-found" }
  | { kind: "player-not-found" };

export interface SendPromotionEmailParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier` — never a raw provider. */
  notifier: Notifier;
  fixtureId: string;
  /** Exactly what `setResponse` handed back out of the capacity lock. */
  promoted: WaitlistPromotion;
  /** The request's `now`. Used for `sent_at`; the dedupe key uses `promoted.promotedAt`. */
  now: Date;
  responseTokenSecret: string;
}

/**
 * Tell the one player who was promoted off the waitlist that a spot came free
 * and is theirs (N-2, BR-7, J4).
 *
 * **Only that player.** Nobody else hears anything — not the player whose
 * dropping out freed the slot, not the rest of the squad.
 *
 * The ordering is the sweep's (BR-19, §2.4) and is reused rather than
 * reimplemented: `insertQueuedLogRows` writes the `queued` row first, the
 * message is sent second, and `applySendResult` records the outcome third —
 * both from `src/notify/delivery.ts`, which is where those two functions were
 * extracted to when this became their second caller. That means this path
 * inherits the sweep's deliberate retryability asymmetry unchanged: a ceiling
 * refusal removes the row so a later attempt is possible, while a provider
 * error leaves it `failed` forever, because an ambiguous failure may already
 * have reached the inbox and BR-19 treats a duplicate as worse than a miss.
 *
 * The dedupe key is `promotionKey(fixtureId, playerId, <promotedAt as ISO>)` —
 * keyed to *this promotion*, not merely to this player, so a player who is
 * promoted, drops out, and is promoted again is told twice. `promotedAt` is
 * the caller's `now` echoed back by the Durable Object, which is exactly one
 * promotion per `setResponse` call today; see the warning on `promotionKey`
 * before writing a multi-slot promotion pass.
 */
export async function sendPromotionEmail(params: SendPromotionEmailParams): Promise<PromotionSendOutcome> {
  const { db, notifier, fixtureId, promoted, now, responseTokenSecret } = params;

  const [row] = await db
    .select({ fixture: fixtures, game: games })
    .from(fixtures)
    .innerJoin(games, eq(fixtures.gameId, games.id))
    .where(eq(fixtures.id, fixtureId));
  if (!row) return { kind: "fixture-not-found" };
  const { fixture, game } = row;

  const [player] = await db
    .select({ name: players.name, email: players.email, isGuest: players.isGuest })
    .from(players)
    .where(eq(players.id, promoted.playerId));
  if (!player) return { kind: "player-not-found" };

  // BR-32: a guest, or anyone whose address is missing or blank, is skipped
  // before a message is built and before anything is written. The `.trim()`
  // matches the sweep's and is load-bearing for the same reason: an email of
  // `" "` is truthy, and letting it through would produce a `queued` row and
  // a `no-recipient` result that nothing usefully acts on.
  const email = player.email?.trim() ?? "";
  if (player.isGuest || email === "") return { kind: "skipped-no-recipient" };

  const token = await signResponseToken(
    {
      playerId: promoted.playerId,
      fixtureId,
      expiresAt: responseTokenExpiry(fixture.kicksOffAt).getTime(),
    },
    responseTokenSecret,
  );

  // A leave token, not the response token above: leaving is scoped to the
  // Game, not this one Fixture, and it must keep working long after this
  // response token has expired (BR-22, §2.2).
  const leaveToken = await signLeaveToken(
    { gameId: game.id, playerId: promoted.playerId, expiresAt: leaveTokenExpiry(now).getTime() },
    responseTokenSecret,
  );

  const respondInUrl = `${SITE_ORIGIN}/r/${token}?intent=in`;
  const emailPayload = {
    playerName: player.name,
    gameName: game.name,
    venueName: fixture.venueOverride ?? game.venueName,
    // The single permitted place cross-zone formatting happens.
    kicksOffAtLocal: formatLocalDateTime(fixture.kicksOffAt, game.timezone),
    // Every URL is built here, from `SITE_ORIGIN` and a token this function
    // just signed — never from anything in the request that triggered it.
    respondInUrl,
    respondOutUrl: `${SITE_ORIGIN}/r/${token}?intent=out`,
    leaveUrl: `${SITE_ORIGIN}/leave/${leaveToken}`,
  };
  const rendered = renderPromotionEmail(emailPayload);

  const dedupeKey = promotionKey(fixtureId, promoted.playerId, new Date(promoted.promotedAt).toISOString());
  const pending: PendingNotification[] = [
    {
      logId: crypto.randomUUID(),
      dedupeKey,
      playerId: promoted.playerId,
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
  // would accumulate a `no-recipient` row per promotion, forever.
  const subscribed = await playersWithPushSubscriptions(db, [promoted.playerId]);
  if (subscribed.has(promoted.playerId)) {
    const copy = PUSH_COPY.n2(emailPayload);
    pending.push({
      logId: crypto.randomUUID(),
      dedupeKey: pushKey(dedupeKey),
      playerId: promoted.playerId,
      message: {
        channel: "push",
        to: promoted.playerId,
        title: copy.title,
        body: copy.body,
        url: respondInUrl,
        // Sharpened from PUSH_COPY's gameName+kickoff approximation (Task 9)
        // to the real fixture id, now that this caller holds one (Task 13).
        tag: `n2:${fixtureId}`,
        dedupeKey: pushKey(dedupeKey),
      },
    });
  }

  const inserted = await insertQueuedLogRows(db, { fixtureId, notificationType: "n2" }, pending);
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
    // never retried), exactly as the sweep does with the same situation.
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

  // `results` and `inserted` are the same length, in the same order — the
  // Notifier contract (`src/notify/notifier.ts`). Apply every row's own
  // result (so a push failure is recorded on the push row, never silently
  // dropped), but this function's own return value tracks the email leg
  // only — the push leg has no `PromotionSendOutcome` branch of its own, and
  // a device-side failure must never turn into a `failed` promotion email
  // for a caller that never touches push at all.
  let emailOutcome: PromotionSendOutcome | undefined;
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
