import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { DASHBOARD_PATH } from "../auth/paths.js";
import { loadAdminNotificationSwitches } from "../domain/app-settings.js";
import type { Db } from "../db/client.js";
import { fixtures, games, notificationLog, players } from "../db/schema.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { leaveTokenExpiry, signLeaveToken } from "../domain/token.js";
import { pushKey, welcomeKey } from "./dedupe-key.js";
import {
  applySendResult,
  insertQueuedLogRows,
  playersWithPushSubscriptions,
  SITE_ORIGIN,
  type PendingNotification,
} from "./delivery.js";
import type { Notifier } from "./notifier.js";
import { PUSH_COPY } from "./push-copy.js";
import { renderWelcomeEmail } from "./templates/welcome.js";

/**
 * What the N-6 send attempt did. Every branch is a value rather than a throw,
 * for the same reason as N-2: this runs *after* the join is committed and
 * after the joiner's page has been decided, so there is no caller left who
 * could usefully handle an exception — but there is very much a reader of logs
 * who needs to know which of these happened. A welcome that never arrives must
 * never be what stops someone joining a squad.
 *
 * - `sent` — delivered (or at least accepted by the provider); row `sent`.
 * - `skipped-no-recipient` — no usable address (BR-32). Not an error and
 *   **not a log row**: nothing a later run could retry, so a row that would
 *   then have to be cleaned up would be pure noise. Also how a player id that
 *   no longer resolves is reported — there is no address, so there is nothing
 *   to send and nothing to retry.
 * - `deferred` — refused by the daily ceiling; row removed, so a later attempt
 *   is legitimate.
 * - `failed` — a provider error (row left `failed`, never retried — it may
 *   have been delivered), a notifier that rejected outright, or the game
 *   having vanished between the join and this read (`game-not-found`, no row
 *   written).
 * - `already-logged` — a row with this exact dedupe key already existed. The
 *   unique index on `notification_log.dedupe_key`, not any cleverness here, is
 *   what makes concurrent attempts safe.
 * - `switched-off` — the administrator has turned N-6 off on every channel
 *   (M37). Checked before the player row's address is even read, and not a
 *   log row: there is nothing queued and nothing to retry.
 */
export type WelcomeSendOutcome =
  | { kind: "sent" }
  | { kind: "deferred" }
  | { kind: "failed"; reason: string }
  | { kind: "already-logged" }
  | { kind: "skipped-no-recipient" }
  | { kind: "switched-off" };

export interface SendWelcomeEmailParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier` — never a raw provider. */
  notifier: Notifier;
  gameId: string;
  playerId: string;
  /** From `JoinOutcome`. Part of the dedupe key, with `joinedAt`. */
  membershipId: string;
  /**
   * From `JoinOutcome` — the `memberships.joined_at` this join or rejoin
   * wrote. Part of the dedupe key; see the doc comment below for why the
   * membership id alone is not enough.
   */
  joinedAt: Date;
  /** The request's `now`. Used for `sent_at` and for "which fixture is ahead of them". */
  now: Date;
  responseTokenSecret: string;
}

/**
 * Welcome someone to a squad they have just joined (N-6, §4.4).
 *
 * Two things make this unlike every other sender in `src/notify/`, and both
 * are load-bearing rather than incidental:
 *
 * - **It is not about a fixture.** N-6 is the only entry in the catalogue
 *   whose subject is a *membership*, so it calls `insertQueuedLogRows` with
 *   `{ fixtureId: null, notificationType: "n6" }`. `notification_log.fixture_id`
 *   has always been nullable in §2.8 for exactly this row; this is its first
 *   caller. Inventing a fixture id — the first one ahead of them, say — would
 *   make the row a lie and would break the "one welcome per join" key below.
 * - **Its dedupe key must survive a rejoin.** The key is
 *   `welcomeKey(membershipId, joinedAt.toISOString())`. `UNIQUE (game_id,
 *   player_id)` on `memberships` forces a rejoin to reactivate the existing
 *   row rather than insert a second one, so the membership id *alone* is the
 *   same string on both joins and the unique index on `dedupe_key` would
 *   silently drop the second welcome. `joinSquad` resets `joined_at` on
 *   reactivation precisely so this key differs (see `src/domain/join-squad.ts`).
 *
 * **BR-2′ lives here too.** The fixture this email names is the next
 * upcoming one, `open` included: the join flow backfills a `pending` row for
 * every open fixture before this send is queued, so a game already being
 * organised is one the joiner is in, and the copy promises the N-1
 * invitation that the same background task is sending. A squad with nothing
 * upcoming is normal (it may have been created minutes ago), and the
 * template says so rather than rendering a blank date.
 *
 * The ordering is the sweep's (BR-19, §2.4), reused rather than
 * reimplemented: `insertQueuedLogRows` writes the `queued` row first, the
 * message is sent second, `applySendResult` records the outcome third. That
 * inherits the deliberate retryability asymmetry unchanged — a ceiling refusal
 * removes the row so a later attempt is possible, while a provider error
 * leaves it `failed` forever, because an ambiguous failure may already have
 * reached the inbox and BR-19 treats a duplicate as worse than a miss.
 */
export async function sendWelcomeEmail(params: SendWelcomeEmailParams): Promise<WelcomeSendOutcome> {
  const { db, notifier, gameId, playerId, membershipId, joinedAt, now, responseTokenSecret } = params;

  const [player] = await db
    .select({ name: players.name, email: players.email, isGuest: players.isGuest })
    .from(players)
    .where(eq(players.id, playerId));

  // M37: the administrator's switches mask the whole send before any address
  // is even looked at — off on both channels means nobody sees N-6 at all,
  // regardless of what the player's own row could otherwise support.
  const admin = await loadAdminNotificationSwitches(db);
  const channels = { email: admin.isOn("n6", "email"), push: admin.isOn("n6", "push") };
  if (!channels.email && !channels.push) return { kind: "switched-off" };

  // BR-32: a guest, or a player id that resolves to nothing, is skipped
  // outright on every channel — that has never been conditional on a switch.
  const email = player?.email?.trim() ?? "";
  if (player === undefined || player.isGuest) return { kind: "skipped-no-recipient" };

  // Only a player with at least one registered device gets a `PushMessage`
  // (M14 Task 13, spec §9.3 rule 1) — otherwise a player without a phone
  // would accumulate a `no-recipient` row per join, forever.
  const subscribed = await playersWithPushSubscriptions(db, [playerId]);

  // BR-32 (M37): "no usable address" is decided per leg, once the admin
  // switches have narrowed which legs are even in play — a player with no
  // address but a registered device must still get the push when the email
  // channel alone is off. The `.trim()` matches every other sender's and is
  // load-bearing for the same reason: an email of `" "` is truthy, and
  // letting it through would produce a `queued` row and a `no-recipient`
  // result nothing usefully acts on. If the only enabled channel is email and
  // there is no address, this is exactly the pre-M37 skip.
  const canEmail = channels.email && email !== "";
  const canPush = channels.push && subscribed.has(playerId);
  if (!canEmail && !canPush) return { kind: "skipped-no-recipient" };

  const [game] = await db
    .select({ name: games.name, venueName: games.venueName, timezone: games.timezone })
    .from(games)
    .where(eq(games.id, gameId));
  // Unreachable in practice — the caller has just written a membership row
  // whose FK points at this game — so it is reported rather than branched on
  // by anything: `failed` with a nameable reason, and no row written.
  if (!game) return { kind: "failed", reason: "game-not-found" };

  // BR-2′: their first fixture is the next upcoming one ahead of `now`,
  // `open` included — the join flow backfilled their `pending` row before
  // queueing this send, so an open fixture is genuinely theirs. A fixture in
  // the past would be a sweep that has not run, and naming it would be wrong.
  const [firstFixture] = await db
    .select({
      id: fixtures.id,
      kicksOffAt: fixtures.kicksOffAt,
      venueOverride: fixtures.venueOverride,
      lifecycle: fixtures.lifecycle,
    })
    .from(fixtures)
    .where(
      and(
        eq(fixtures.gameId, gameId),
        inArray(fixtures.lifecycle, ["open", "scheduled"]),
        gte(fixtures.kicksOffAt, now),
      ),
    )
    .orderBy(asc(fixtures.kicksOffAt))
    .limit(1);

  // A leave token, scoped to this Game rather than to any Fixture — the same
  // reason N-6 has no Fixture behind it at all (see the module doc comment).
  const leaveToken = await signLeaveToken(
    { gameId, playerId, expiresAt: leaveTokenExpiry(now).getTime() },
    responseTokenSecret,
  );

  const dashboardUrl = `${SITE_ORIGIN}${DASHBOARD_PATH}`;
  const emailPayload = {
    playerName: player.name,
    gameName: game.name,
    venueName: firstFixture?.venueOverride ?? game.venueName,
    // The single permitted place cross-zone formatting happens. `null` when
    // there is nothing scheduled yet — the template has copy for that.
    whenLocal: firstFixture ? formatLocalDateTime(firstFixture.kicksOffAt, game.timezone) : null,
    firstGameAlreadyOpen: firstFixture?.lifecycle === "open",
    // Built here, from `SITE_ORIGIN` — never from anything in the request.
    dashboardUrl,
    leaveUrl: `${SITE_ORIGIN}/leave/${leaveToken}`,
  };
  const rendered = renderWelcomeEmail(emailPayload);

  const dedupeKey = welcomeKey(membershipId, joinedAt.toISOString());
  const pending: PendingNotification[] = [];
  if (canEmail) {
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
    const copy = PUSH_COPY.n6(emailPayload);
    pending.push({
      logId: crypto.randomUUID(),
      dedupeKey: pushKey(dedupeKey),
      playerId,
      message: {
        channel: "push",
        to: playerId,
        title: copy.title,
        body: copy.body,
        url: dashboardUrl,
        // Sharpened to the real fixture id when there is a first fixture to
        // name (Task 13) — two welcomes about the same upcoming fixture then
        // collapse in the tray. N-6 is not fixture-scoped itself (see the
        // module doc comment), so a squad with nothing `scheduled` yet keeps
        // `PUSH_COPY`'s gameName approximation; there is no id to sharpen it
        // with.
        tag: firstFixture ? `n6:${firstFixture.id}` : copy.tag,
        dedupeKey: pushKey(dedupeKey),
      },
    });
  }

  const inserted = await insertQueuedLogRows(db, { fixtureId: null, notificationType: "n6" }, pending);
  const emailEntry = inserted.find((entry) => entry.message.channel === "email");
  const pushEntry = inserted.find((entry) => entry.message.channel === "push");
  // The leg this function's return value tracks. Ordinarily the email leg
  // (matching `send-promotion.ts`'s reasoning below) — but M37 lets the
  // administrator switch email off while push stays on, and there is then no
  // email leg at all to report on, so the push leg stands in for it. Fixed
  // once here, before either leg's outcome is known, so it cannot drift
  // between the reject branch below and the apply loop after it.
  const primaryEntry = canEmail ? emailEntry : pushEntry;
  // `inserted.length === 0`, not `!primaryEntry`: the email key can conflict
  // (already logged) while the push key does not — a repeat call after the
  // player registers a device between two attempts — and that push row was
  // inserted and must still be sent, not left `queued` forever with nothing
  // to reap it (review fix, Important 3). `primaryOutcome` below stays
  // `undefined` in that case, so the function still reports `already-logged`
  // for the tracked leg even though the other row was sent.
  if (inserted.length === 0) return { kind: "already-logged" };

  let results;
  try {
    results = await notifier.send(inserted.map((entry) => entry.message));
  } catch (error) {
    // The notifier rejected — e.g. `QuotaNotifier.reserve()` hitting a D1
    // error. Whether the message reached a provider first is unknowable from
    // here, so every row this batch inserted is left `failed` (ambiguous,
    // never retried), exactly as the sweep and `send-promotion.ts` do with the
    // same situation.
    const reason = error instanceof Error ? error.message : String(error);
    for (const entry of inserted) {
      await db
        .update(notificationLog)
        .set({ status: "failed", error: reason })
        .where(eq(notificationLog.id, entry.logId));
    }
    // If the tracked leg was never inserted this call (its key already
    // conflicted, or the other leg alone was inserted), the tracked leg
    // itself is untouched by this rejection; reporting `failed` would
    // misattribute the other leg's failure to it.
    return primaryEntry ? { kind: "failed", reason } : { kind: "already-logged" };
  }

  // See `send-promotion.ts` for why every row's own result is applied but
  // the function's return value tracks only the one leg.
  let primaryOutcome: WelcomeSendOutcome | undefined;
  for (let i = 0; i < inserted.length; i++) {
    const entry = inserted[i];
    if (!entry) continue;
    const outcome = await applySendResult(db, entry, results[i], now);
    if (entry === primaryEntry) {
      primaryOutcome =
        outcome.kind === "sent"
          ? { kind: "sent" }
          : outcome.kind === "deferred"
            ? { kind: "deferred" }
            : { kind: "failed", reason: outcome.reason };
    }
  }
  return primaryOutcome ?? { kind: "already-logged" };
}
