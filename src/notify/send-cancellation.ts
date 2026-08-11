import type { Db } from "../db/client.js";
import type { CancellationRecipient } from "../domain/cancel-fixture.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { responseTokenExpiry, signResponseToken } from "../domain/token.js";
import { cancellationKey } from "./dedupe-key.js";
import {
  applySendResult,
  insertQueuedLogRows,
  markOrphanedRowsFailed,
  SITE_ORIGIN,
  type PendingNotification,
} from "./delivery.js";
import type { Notifier } from "./notifier.js";
import { renderCancellationEmail } from "./templates/cancellation.js";

/**
 * What one N-3 send pass did, in counts an owner-facing page and a log line
 * can both be built from. Every branch is a number rather than a throw: this
 * runs *after* the cancellation is already committed to D1, so there is no
 * caller left who could usefully undo anything — but the owner in front of
 * the page, and whoever reads the logs later, both need to know what actually
 * went out.
 */
export interface CancellationSendSummary {
  /** Handed to the notifier and accepted; row `sent`. */
  sent: number;
  /** Refused by the daily send ceiling (TR-31); row removed, so a retry is possible — but nothing retries it today. See the route. */
  deferred: number;
  /** A provider error or a rejected notifier; row left `failed`, never retried (BR-19). */
  failed: number;
  /** A recipient with no usable address. Permanent, not an error, and deliberately no log row (BR-32). */
  skippedNoRecipient: number;
  /** A `notification_log` row for this exact key already existed — this player has already been told. */
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
  game: { name: string; venueName: string; timezone: string };
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
    failed: 0,
    skippedNoRecipient: 0,
    alreadyLogged: 0,
    failures: [],
  };

  const kicksOffAtLocal = formatLocalDateTime(fixture.kicksOffAt, game.timezone);
  const venueName = fixture.venueOverride ?? game.venueName;

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
    // nothing left to accept or decline — so this is a *response* token, for
    // `/leave/:token`, and is signed with the response secret accordingly.
    // It is emphatically not a cancel token: nothing in an email sent to the
    // whole squad may carry the authority to cancel anything.
    const token = await signResponseToken(
      {
        playerId: recipient.playerId,
        fixtureId: fixture.id,
        expiresAt: responseTokenExpiry(fixture.kicksOffAt).getTime(),
      },
      responseTokenSecret,
    );

    const rendered = renderCancellationEmail({
      playerName: recipient.name,
      gameName: game.name,
      venueName,
      kicksOffAtLocal,
      reason,
      leaveUrl: `${SITE_ORIGIN}/leave/${token}`,
    });

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
    summary.failed += inserted.length;
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
      if (outcome.kind === "sent") summary.sent++;
      else if (outcome.kind === "deferred") summary.deferred++;
      else {
        summary.failed++;
        summary.failures.push(outcome.reason);
      }
    }
  } catch (error) {
    // Mid-apply abort. The rows this loop never reached are poison if left
    // `queued`: their dedupe keys are taken, so nothing would ever tell those
    // players, mark them failed, or count them.
    const message = error instanceof Error ? error.message : String(error);
    const orphaned = inserted.slice(applied);
    await markOrphanedRowsFailed(db, orphaned, `abandoned mid-apply: ${message}`);
    summary.failed += orphaned.length;
    summary.failures.push(`${message} (${orphaned.length} row(s) left unapplied and marked failed)`);
  }

  return summary;
}
