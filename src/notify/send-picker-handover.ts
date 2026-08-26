import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { fixtures, games, notificationLog, players } from "../db/schema.js";
import { pickerPagePath } from "../auth/paths.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { leaveTokenExpiry, signLeaveToken } from "../domain/token.js";
import { pickerHandoverKey, pushKey } from "./dedupe-key.js";
import {
  applySendResult,
  insertQueuedLogRows,
  playersWithPushSubscriptions,
  SITE_ORIGIN,
  type PendingNotification,
} from "./delivery.js";
import type { Notifier } from "./notifier.js";
import { loadNotificationSettings } from "./notification-settings.js";
import { PUSH_COPY } from "./push-copy.js";
import { renderPickerHandoverEmail } from "./templates/picker-handover.js";

/**
 * What the N-13 send attempt did. Every branch is a value rather than a
 * throw, for the reason `PromotionSendOutcome` gives at length: this runs
 * after the hand-over is already committed and after the organiser's redirect
 * has gone out, so there is no caller left who could handle an exception —
 * only a reader of logs who needs to know which of these happened.
 */
export type PickerHandoverOutcome =
  | { kind: "sent" }
  | { kind: "skipped-no-recipient" }
  | { kind: "deferred" }
  | { kind: "failed"; reason: string }
  | { kind: "already-logged" }
  | { kind: "fixture-not-found" }
  | { kind: "player-not-found" };

export interface SendPickerHandoverParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier` — never a raw provider. */
  notifier: Notifier;
  fixtureId: string;
  /** The new delegate. */
  playerId: string;
  /** `fixtures.team_picker_set_at` as just written — the dedupe key is built from it. */
  setAt: Date;
  /** The request's `now`, used for `sent_at` and the leave token's expiry. */
  now: Date;
  responseTokenSecret: string;
  /**
   * Whether each channel may be attempted (M37). Resolved by the caller; a
   * ceiling, never a promise. `src/routes/games.ts`'s picker handler always
   * supplies it.
   *
   * Optional only so that `test/notify/notification-invariants.test.ts`'s
   * n13 driver — which calls this function directly, bypassing the route
   * that normally resolves it, and is committed fixed scaffolding this task
   * may not edit — still exercises the owner and administrator switches:
   * when omitted, resolved here from the game's own settings instead of
   * trusting an absent ceiling to mean "send everything".
   */
  channels?: { email: boolean; push: boolean };
}

/**
 * Tell one player that this fixture's teams are theirs to pick (N-13, M29).
 *
 * **Only that player.** Nobody else hears anything — not the squad, and not
 * the organiser who just handed it over; they were on the page that did it.
 *
 * There is no notification for `open` mode, and that is a decision rather
 * than an omission: a message to a whole squad asking somebody, anybody, to
 * pick the teams is one no individual owns, and it doubles the mail a squad
 * receives per fixture. Open mode surfaces on the fixture page instead.
 *
 * No response token is signed here, unlike N-2. The picker page is behind the
 * ordinary session guard (`requirePlayer`) and its entitlement is re-asked on
 * every request from the delegate's live membership — so a bare link is the
 * right link, and minting a token would hand out a bearer credential for a
 * capability that can send mail to the whole squad. The leave link is still
 * a token, because BR-22 requires one that works from an inbox.
 *
 * Ordering is the sweep's, reused rather than reimplemented, so this path
 * inherits its retryability asymmetry unchanged: a ceiling refusal removes
 * the row so a later attempt is possible, while a provider error leaves it
 * `failed` forever, because an ambiguous failure may already have reached the
 * inbox and BR-19 treats a duplicate as worse than a miss.
 */
export async function sendPickerHandover(params: SendPickerHandoverParams): Promise<PickerHandoverOutcome> {
  const { db, notifier, fixtureId, playerId, setAt, now, responseTokenSecret } = params;

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
    .where(eq(players.id, playerId));
  if (!player) return { kind: "player-not-found" };

  // See `SendPickerHandoverParams.channels`'s doc comment: every real caller
  // supplies this, so the settings load below runs only for the one direct
  // test caller that predates the route's own resolution.
  const channels =
    params.channels ??
    (await (async () => {
      const settings = await loadNotificationSettings(db, [game.id]);
      return {
        email: settings.isEnabled(game.id, "n13", "email"),
        push: settings.isEnabled(game.id, "n13", "push"),
      };
    })());

  // BR-32, and the same `.trim()` the other senders carry for the same
  // reason: an email of `" "` is truthy, and letting it through produces a
  // `queued` row and a `no-recipient` result nothing usefully acts on. The
  // hand-over route refuses a guest before it gets here, so this is the
  // belt to that braces rather than the only guard. Guests are excluded on
  // every channel, unconditionally — that has never been switch-dependent.
  const email = player.email?.trim() ?? "";
  const canEmail = channels.email && email !== "";

  // Only a player with a registered device, so somebody without a phone does
  // not accumulate a `no-recipient` row per hand-over (spec §9.3 rule 1).
  // Fetched before the "nothing to send" check below, since a device-only
  // recipient (email off, or no address) still needs this to know whether
  // there is anything left to attempt.
  const subscribed = await playersWithPushSubscriptions(db, [playerId]);
  const canPush = channels.push && subscribed.has(playerId);

  if (player.isGuest || (!canEmail && !canPush)) return { kind: "skipped-no-recipient" };

  const leaveToken = await signLeaveToken(
    { gameId: game.id, playerId, expiresAt: leaveTokenExpiry(now).getTime() },
    responseTokenSecret,
  );

  // Built here from `SITE_ORIGIN` and the path helper, never from anything in
  // the request that triggered it.
  const pickerUrl = `${SITE_ORIGIN}${pickerPagePath(game.id, fixtureId)}`;
  const emailPayload = {
    playerName: player.name,
    gameName: game.name,
    venueName: fixture.venueOverride ?? game.venueName,
    // The single permitted place cross-zone formatting happens (TR-5).
    whenLocal: formatLocalDateTime(fixture.kicksOffAt, game.timezone),
    pickerUrl,
    leaveUrl: `${SITE_ORIGIN}/leave/${leaveToken}`,
  };

  const dedupeKey = pickerHandoverKey(fixtureId, playerId, setAt.toISOString());
  const pending: PendingNotification[] = [];

  if (canEmail) {
    const rendered = renderPickerHandoverEmail(emailPayload);
    pending.push({
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
    });
  }

  if (canPush) {
    const copy = PUSH_COPY.n13(emailPayload);
    pending.push({
      logId: crypto.randomUUID(),
      dedupeKey: pushKey(dedupeKey),
      playerId,
      message: {
        channel: "push",
        to: playerId,
        title: copy.title,
        body: copy.body,
        url: pickerUrl,
        // The real fixture id, sharper than PUSH_COPY's name+date stand-in,
        // now that this caller holds one.
        tag: `n13:${fixtureId}`,
        dedupeKey: pushKey(dedupeKey),
      },
    });
  }

  const inserted = await insertQueuedLogRows(db, { fixtureId, notificationType: "n13" }, pending);
  const emailEntry = inserted.find((entry) => entry.message.channel === "email");
  // `inserted.length === 0`, not `!emailEntry`: the email key can conflict
  // while the push key does not — a repeat call after the delegate registers
  // a device between two attempts — and that push row was inserted and must
  // still be sent rather than left `queued` forever with nothing to reap it.
  if (inserted.length === 0) return { kind: "already-logged" };

  let results;
  try {
    results = await notifier.send(inserted.map((entry) => entry.message));
  } catch (error) {
    // Whether anything reached a provider before the rejection is unknowable
    // from here, so every row this batch inserted is left `failed` —
    // ambiguous, never retried — exactly as the sweep does.
    const reason = error instanceof Error ? error.message : String(error);
    for (const entry of inserted) {
      await db
        .update(notificationLog)
        .set({ status: "failed", error: reason })
        .where(eq(notificationLog.id, entry.logId));
    }
    return emailEntry ? { kind: "failed", reason } : { kind: "already-logged" };
  }

  // `results` and `inserted` are the same length in the same order (the
  // Notifier contract). Every row's own result is applied, so a push failure
  // is recorded on the push row; this function's return value tracks the
  // email leg alone, so a device-side failure never reports as a failed
  // hand-over email.
  let emailOutcome: PickerHandoverOutcome | undefined;
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
