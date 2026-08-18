import { eq } from "drizzle-orm";
import { SIGN_IN_PATH } from "../auth/paths.js";
import type { Db } from "../db/client.js";
import { notificationLog, players } from "../db/schema.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { erasureScheduledKey, pushKey } from "./dedupe-key.js";
import {
  applySendResult,
  insertQueuedLogRows,
  playersWithPushSubscriptions,
  SITE_ORIGIN,
  type PendingNotification,
} from "./delivery.js";
import type { Notifier } from "./notifier.js";
import { PUSH_COPY } from "./push-copy.js";
import { renderErasureScheduledEmail } from "./templates/erasure-scheduled.js";

/**
 * What the N-8 send attempt did. The same outcome union as N-6
 * (`WelcomeSendOutcome`), for the same reason: this runs after `erases_at`
 * has already been committed to `players`, so there is no caller left who
 * could usefully handle an exception — but there is very much a reader of
 * logs who needs to know which of these happened. An announcement that never
 * arrives must never be what stops someone from being able to notice, and
 * cancel, an erasure they didn't ask for.
 *
 * - `sent` — delivered (or at least accepted by the provider); row `sent`.
 * - `skipped-no-recipient` — no usable address (BR-32). Not an error and
 *   **not a log row**, for the same reason as N-6: nothing a later run could
 *   retry, so a row that would then have to be cleaned up would be pure
 *   noise. Also how a player id that no longer resolves is reported.
 * - `deferred` — refused by the daily ceiling; row removed, so a later
 *   attempt is legitimate.
 * - `failed` — a provider error (row left `failed`, never retried — it may
 *   have been delivered) or a notifier that rejected outright.
 * - `already-logged` — a row with this exact dedupe key already existed. The
 *   unique index on `notification_log.dedupe_key`, not any cleverness here,
 *   is what makes concurrent attempts safe.
 */
export type ErasureSendOutcome =
  | { kind: "sent" }
  | { kind: "deferred" }
  | { kind: "failed"; reason: string }
  | { kind: "already-logged" }
  | { kind: "skipped-no-recipient" };

export interface SendErasureScheduledEmailParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier`. */
  notifier: Notifier;
  playerId: string;
  /** The deadline just written to `players.erases_at`. Part of the dedupe key. */
  erasesAt: Date;
  now: Date;
}

/**
 * Announce a player's own request to erase their data (N-8, BR-34).
 *
 * Like N-6 (`sendWelcomeEmail`), this is not about a fixture: it calls
 * `insertQueuedLogRows` with `{ fixtureId: null, notificationType: "n8" }`,
 * because there is no fixture behind an account-level request.
 *
 * **Its dedupe key must survive a cancel-and-retry.** The key is
 * `erasureScheduledKey(playerId, erasesAt.toISOString())`, not the player id
 * alone — see the doc comment on `erasureScheduledKey` for why a request,
 * cancel, and second request must not collide.
 *
 * The ordering is the sweep's (BR-19, §2.4), reused rather than
 * reimplemented: `insertQueuedLogRows` writes the `queued` row first, the
 * message is sent second, `applySendResult` records the outcome third.
 */
export async function sendErasureScheduledEmail(
  params: SendErasureScheduledEmailParams,
): Promise<ErasureSendOutcome> {
  const { db, notifier, playerId, erasesAt, now } = params;

  const [player] = await db
    .select({ name: players.name, email: players.email, isGuest: players.isGuest })
    .from(players)
    .where(eq(players.id, playerId));

  // BR-32: a guest, or anyone whose address is missing or blank, is skipped
  // before a message is built and before anything is written. The `.trim()`
  // matches `send-welcome.ts`'s and is load-bearing for the same reason: an
  // email of `" "` is truthy, and letting it through would produce a `queued`
  // row and a `no-recipient` result that nothing usefully acts on. A player
  // id that resolves to nothing lands here too — no row, no address, nothing
  // to retry.
  const email = player?.email?.trim() ?? "";
  if (player === undefined || player.isGuest || email === "") return { kind: "skipped-no-recipient" };

  const signInUrl = `${SITE_ORIGIN}${SIGN_IN_PATH}`;
  const emailPayload = {
    playerName: player.name,
    // Not scoped to a game, so there is no game timezone to format in.
    // `Europe/London` — the only zone this product has any right to assume
    // for a person, absent a game to ask — beats the alternative, a bare UTC
    // ISO string, which is unreadable to a person deciding whether to act.
    whenLocal: formatLocalDateTime(erasesAt, "Europe/London"),
    // Built here, from `SITE_ORIGIN` — never from anything in the request.
    // Sign-in, not a token link: only the account's real owner can cancel.
    signInUrl,
  };
  const rendered = renderErasureScheduledEmail(emailPayload);

  const dedupeKey = erasureScheduledKey(playerId, erasesAt.toISOString());
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
  // would accumulate a `no-recipient` row per erasure request, forever.
  const subscribed = await playersWithPushSubscriptions(db, [playerId]);
  if (subscribed.has(playerId)) {
    const copy = PUSH_COPY.n8(emailPayload);
    pending.push({
      logId: crypto.randomUUID(),
      dedupeKey: pushKey(dedupeKey),
      playerId,
      message: {
        channel: "push",
        to: playerId,
        title: copy.title,
        body: copy.body,
        url: signInUrl,
        // N-8 has no fixture behind it at all (account-level, like N-6's
        // membership scope but without even a first fixture to name) — left
        // as `PUSH_COPY`'s own fixed tag; there is no id anywhere in this
        // caller to sharpen it with.
        tag: copy.tag,
        dedupeKey: pushKey(dedupeKey),
      },
    });
  }

  const inserted = await insertQueuedLogRows(db, { fixtureId: null, notificationType: "n8" }, pending);
  const emailEntry = inserted.find((entry) => entry.message.channel === "email");
  if (!emailEntry) return { kind: "already-logged" };

  let results;
  try {
    results = await notifier.send(inserted.map((entry) => entry.message));
  } catch (error) {
    // The notifier rejected — e.g. `QuotaNotifier.reserve()` hitting a D1
    // error. Whether the message reached a provider first is unknowable from
    // here, so every row this batch inserted is left `failed` (ambiguous,
    // never retried), exactly as `send-welcome.ts` does with the same
    // situation.
    const reason = error instanceof Error ? error.message : String(error);
    for (const entry of inserted) {
      await db
        .update(notificationLog)
        .set({ status: "failed", error: reason })
        .where(eq(notificationLog.id, entry.logId));
    }
    return { kind: "failed", reason };
  }

  // See `send-promotion.ts` for why every row's own result is applied but
  // the function's return value tracks only the email leg.
  let emailOutcome: ErasureSendOutcome | undefined;
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
