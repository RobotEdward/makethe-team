import type { Db } from "../db/client.js";
import type { CancellationRecipient } from "../domain/cancel-fixture.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { leaveTokenExpiry, signLeaveToken } from "../domain/token.js";
import { cancellationKey, pushKey } from "./dedupe-key.js";
import {
  applySendResult,
  insertQueuedLogRows,
  markOrphanedRowsFailed,
  playersWithPushSubscriptions,
  SITE_ORIGIN,
  type PendingNotification,
} from "./delivery.js";
import type { Notifier } from "./notifier.js";
import { renderCancellationEmail } from "./templates/cancellation.js";
import { PUSH_COPY } from "./push-copy.js";

/**
 * What one N-3 send pass did, in counts an owner-facing page and a log line
 * can both be built from. Every branch is a number rather than a throw: this
 * runs *after* the cancellation is already committed to D1, so there is no
 * caller left who could usefully undo anything — but the owner in front of
 * the page, and whoever reads the logs later, both need to know what actually
 * went out.
 */
export interface CancellationSendSummary {
  /**
   * Handed to the notifier and accepted; row `sent`. **Email only.**
   * `src/routes/cancel.ts` builds `emailed`/`notEmailed` straight off this
   * field ("N players have been emailed" / "let them know another way"), so
   * it must count exactly the emails that went out — a push row folded in
   * here would inflate the emailed count for a squad with phones and, worse,
   * could send `recipients.length - sent` negative and silently hide the
   * "couldn't be emailed" warning from an owner who still has people to
   * ring. See `pushSent` for the push leg's own count.
   */
  sent: number;
  /** Refused by the daily send ceiling (TR-31); row removed, so a retry is possible — but nothing retries it today. See the route. Email only — the push leg has no daily ceiling and can never produce this outcome. */
  deferred: number;
  /**
   * Exactly who those deferrals were for. Carried out of here rather than
   * left as a bare count because the route writes them into `audit_log`
   * (`fixture.cancellation_email_deferred`): the deleted `notification_log`
   * rows are otherwise the only record of who was never told a game was off,
   * and "how many" does not answer "which of my squad do I have to ring".
   */
  deferredPlayerIds: string[];
  /** A provider error or a rejected notifier; row left `failed`, never retried (BR-19). **Email only** — see `sent`'s doc comment for why the two channels must not be summed together. See `pushFailed` for the push leg's own count. */
  failed: number;
  /** The push leg's own `sent` count — informational only, never fed into `cancel.ts`'s "N players have been emailed" arithmetic. */
  pushSent: number;
  /** The push leg's own `failed` count — informational only. Also where a push `NO_RECIPIENT_REASON` or (hypothetically) `deferred` outcome lands, since neither has a meaningful place in the email-only fields above. */
  pushFailed: number;
  /** A recipient with no usable address. Permanent, not an error, and deliberately no log row (BR-32). */
  skippedNoRecipient: number;
  /** A `notification_log` row for this exact key already existed — this player has already been told. Counts rows of either channel: a conflict on the push key alone, with the email key free, is `send-cancellation.ts`'s own concern (both rows are always attempted in the same batch here — see the module doc comment), not a silent gap like the single-recipient senders'. */
  alreadyLogged: number;
  /** One representative reason per distinct failure, for the caller's log line. Never shown to a user. */
  failures: string[];
}

export interface SendCancellationEmailsParams {
  db: Db;
  /** Always the quota-wrapped notifier from `createNotifier` — never a raw provider. */
  notifier: Notifier;
  /** Read by the caller, which needs the same row to render its page — never re-read here. */
  fixture: { id: string; kicksOffAt: Date; venueOverride: string | null };
  game: { id: string; name: string; venueName: string; timezone: string };
  /** Exactly what `cancelFixture` handed back. */
  recipients: readonly CancellationRecipient[];
  /** Exactly what the owner typed, including empty — the template decides what an empty reason means. */
  reason: string;
  now: Date;
  responseTokenSecret: string;
}

/**
 * Tell everyone who held or wanted a slot that the fixture is off (N-3,
 * BR-20, J4).
 *
 * The ordering is the sweep's (BR-19, §2.4) and is reused rather than
 * reimplemented: `insertQueuedLogRows` writes every `queued` row first, the
 * batch is sent second, and `applySendResult` records each outcome third —
 * all three from `src/notify/delivery.ts`. That means this path inherits the
 * deliberate retryability asymmetry unchanged: a ceiling refusal removes the
 * row so a later attempt is possible, while a provider error leaves it
 * `failed` forever, because an ambiguous failure may already have reached the
 * inbox.
 *
 * The dedupe key is `cancellationKey(fixtureId, playerId)` and carries **no
 * timestamp**, unlike N-2's: a fixture is cancelled once as far as its squad
 * is concerned, and the unique index on `notification_log.dedupe_key` is what
 * makes that true even if this function is somehow entered twice for the same
 * fixture (a double POST that raced past the lifecycle guard, a retry, a
 * future backfill). Nothing here counts on being called once.
 *
 * Throws nothing for an ordinary failure — but it can still throw on a D1
 * error, and its caller awaits it *after* the cancellation is durable, so it
 * must be wrapped there rather than allowed to turn a completed cancellation
 * into a 500.
 */
export async function sendCancellationEmails(
  params: SendCancellationEmailsParams,
): Promise<CancellationSendSummary> {
  const { db, notifier, fixture, game, recipients, reason, now, responseTokenSecret } = params;

  const summary: CancellationSendSummary = {
    sent: 0,
    deferred: 0,
    deferredPlayerIds: [],
    failed: 0,
    pushSent: 0,
    pushFailed: 0,
    skippedNoRecipient: 0,
    alreadyLogged: 0,
    failures: [],
  };

  const kicksOffAtLocal = formatLocalDateTime(fixture.kicksOffAt, game.timezone);
  const venueName = fixture.venueOverride ?? game.venueName;

  // Only a player with at least one registered device gets a `PushMessage`
  // (M14 Task 13, spec §9.3 rule 1) — otherwise every player without a phone
  // would accumulate a `no-recipient` row per cancellation, forever. Fetched
  // once for the whole batch rather than per recipient.
  const subscribed = await playersWithPushSubscriptions(
    db,
    recipients.map((recipient) => recipient.playerId),
  );

  const pending: PendingNotification[] = [];
  for (const recipient of recipients) {
    // BR-32: a recipient with no usable address is skipped before a message
    // is built and before anything is written — no message, no log row, not a
    // failure. `cancelFixture` excludes guests already; this catches the
    // non-guest with a missing or blank address, which is a data anomaly
    // rather than a category. The `.trim()` is load-bearing for the reason
    // the sweep documents at length: an email of `" "` is truthy, and letting
    // it through produces a `queued` row and a `no-recipient` result that
    // nothing usefully acts on.
    const email = recipient.email?.trim() ?? "";
    if (email === "") {
      summary.skippedNoRecipient++;
      continue;
    }

    // The only action an N-3 offers is leaving the Game (BR-22) — there is
    // nothing left to accept or decline. A leave token, scoped to the Game
    // rather than this one Fixture, and signed with the response secret
    // accordingly (it is emphatically not a cancel token: nothing in an email
    // sent to the whole squad may carry the authority to cancel anything).
    const leaveToken = await signLeaveToken(
      { gameId: game.id, playerId: recipient.playerId, expiresAt: leaveTokenExpiry(now).getTime() },
      responseTokenSecret,
    );
    const leaveUrl = `${SITE_ORIGIN}/leave/${leaveToken}`;

    const emailPayload = {
      playerName: recipient.name,
      gameName: game.name,
      venueName,
      kicksOffAtLocal,
      reason,
      leaveUrl,
    };
    const rendered = renderCancellationEmail(emailPayload);

    const dedupeKey = cancellationKey(fixture.id, recipient.playerId);
    pending.push({
      logId: crypto.randomUUID(),
      dedupeKey,
      playerId: recipient.playerId,
      message: {
        channel: "email",
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        dedupeKey,
      },
    });

    if (subscribed.has(recipient.playerId)) {
      const copy = PUSH_COPY.n3(emailPayload);
      pending.push({
        logId: crypto.randomUUID(),
        dedupeKey: pushKey(dedupeKey),
        playerId: recipient.playerId,
        message: {
          channel: "push",
          to: recipient.playerId,
          title: copy.title,
          body: copy.body,
          url: leaveUrl,
          // Sharpened from `PUSH_COPY`'s gameName+kickoff approximation
          // (Task 9) to the real fixture id, now that this caller holds one
          // (M14 Task 13). Two cancellation pushes about the same fixture
          // collapse in the tray; two about different fixtures never do.
          tag: `n3:${fixture.id}`,
          dedupeKey: pushKey(dedupeKey),
        },
      });
    }
  }

  if (pending.length === 0) return summary;

  const inserted = await insertQueuedLogRows(db, { fixtureId: fixture.id, notificationType: "n3" }, pending);
  summary.alreadyLogged = pending.length - inserted.length;
  if (inserted.length === 0) return summary;

  let results;
  try {
    results = await notifier.send(inserted.map((entry) => entry.message));
  } catch (error) {
    // The notifier itself rejected — e.g. `QuotaNotifier.reserve()` hitting a
    // D1 error mid-batch. Whether any message reached a provider first is
    // unknowable from here, so every row is left `failed` (ambiguous, never
    // retried), exactly as the sweep does with the same situation.
    const message = error instanceof Error ? error.message : String(error);
    await markOrphanedRowsFailed(db, inserted, message);
    // Split by channel — see `CancellationSendSummary.sent`'s doc comment
    // for why `failed` must count only the email rows.
    for (const entry of inserted) {
      if (entry.message.channel === "email") summary.failed++;
      else summary.pushFailed++;
    }
    summary.failures.push(message);
    return summary;
  }

  // `results` and `inserted` are the same length in the same order, per the
  // Notifier contract (`src/notify/notifier.ts`); the database write is still
  // keyed by `entry.logId`, never by the index, so a notifier that violated
  // the contract could misapply an outcome to the wrong message but never to
  // the wrong row.
  let applied = 0;
  try {
    for (; applied < inserted.length; applied++) {
      const entry = inserted[applied];
      if (!entry) continue;
      const outcome = await applySendResult(db, entry, results[applied], now);
      const isEmail = entry.message.channel === "email";
      if (outcome.kind === "sent") {
        if (isEmail) summary.sent++;
        else summary.pushSent++;
      } else if (outcome.kind === "deferred") {
        // The push leg has no daily ceiling (`PushNotifier`'s doc comment),
        // so this can only legitimately happen for the email row — but a
        // push landing here regardless is folded into `pushFailed` rather
        // than `deferred`/`deferredPlayerIds`, which drive the
        // cancellation-deferral audit row and are documented as email-only.
        if (isEmail) {
          summary.deferred++;
          summary.deferredPlayerIds.push(entry.playerId);
        } else {
          summary.pushFailed++;
        }
      } else {
        if (isEmail) {
          summary.failed++;
          summary.failures.push(outcome.reason);
        } else {
          summary.pushFailed++;
        }
      }
    }
  } catch (error) {
    // Mid-apply abort. The rows this loop never reached are poison if left
    // `queued`: their dedupe keys are taken, so nothing would ever tell those
    // players, mark them failed, or count them.
    const message = error instanceof Error ? error.message : String(error);
    const orphaned = inserted.slice(applied);
    await markOrphanedRowsFailed(db, orphaned, `abandoned mid-apply: ${message}`);
    // Split by channel, same as the whole-batch rejection above.
    for (const entry of orphaned) {
      if (entry.message.channel === "email") summary.failed++;
      else summary.pushFailed++;
    }
    summary.failures.push(`${message} (${orphaned.length} row(s) left unapplied and marked failed)`);
  }

  return summary;
}
