import { eq } from "drizzle-orm";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import type { Db } from "../db/client.js";
import { notificationLog } from "../db/schema.js";
import type { NotificationType } from "./dedupe-key.js";
import type { Message, SendResult } from "./notifier.js";
import { DAILY_CEILING_REASON, NOTIFIER_CONTRACT_VIOLATION_REASON } from "./quota.js";

/**
 * The insert-before-send mechanics shared by every notification the product
 * sends (§2.8, BR-19), extracted from `src/sweep/open-and-remind.ts` when the
 * N-2 promotion email became its second caller.
 *
 * Nothing here decides *who* to mail or *what* to say — that stays with each
 * caller. What lives here is the part that must not be reimplemented twice:
 * the `queued` row that lands before a message is handed to a provider, and
 * the deliberately asymmetric interpretation of the result that comes back.
 */

/**
 * The site's own origin, used to build the absolute links every notification
 * email carries. There is no `BASE_URL` binding (see `src/env.ts`) — the
 * Worker is only ever deployed at this custom domain (`wrangler.jsonc`), and
 * every test in the repo that needs an absolute URL already hardcodes this
 * same string (e.g. `test/routes/respond-get.test.ts`). If a second
 * environment with a different origin ever exists, this is the one place
 * that needs to change.
 */
export const SITE_ORIGIN = "https://makethe.team";

/** One message that has a `notification_log` row reserved for it, ready to send. */
export interface PendingNotification {
  logId: string;
  dedupeKey: string;
  playerId: string;
  message: Message;
}

/**
 * What applying one `SendResult` did. `deferred` is reserved for the daily
 * ceiling alone; every other non-success is a `failed`, carrying the reason
 * so the caller can report it, and saying whether the row was cleaned up for
 * a later retry or left `failed` forever.
 */
export type ApplyOutcome = { kind: "sent" } | { kind: "deferred" } | { kind: "failed"; reason: string };

/**
 * Insert-before-send (BR-19): every row lands as `queued` before this
 * function returns, and only rows that actually landed (an `onConflictDoNothing`
 * against the unique `dedupe_key` index handles a concurrent run
 * choosing the same player) are sent. A crash between this insert and the
 * send leaves a `queued` row that a later run will not retry — lost, not
 * duplicated, which is the safe direction (§2.4).
 *
 * The unique index on `dedupe_key` — not the caller's key-building — is the
 * actual guarantee against a double send: two concurrent requests that build
 * the same key both reach here, and exactly one of them gets a row back.
 */
export async function insertQueuedLogRows(
  db: Db,
  params: { fixtureId: string; notificationType: NotificationType },
  pending: PendingNotification[],
): Promise<PendingNotification[]> {
  const insertedIds = new Set<string>();

  for (const batch of chunk(pending, INSERT_CHUNK_SIZE)) {
    const inserted = await db
      .insert(notificationLog)
      .values(
        batch.map((entry) => ({
          id: entry.logId,
          dedupeKey: entry.dedupeKey,
          notificationType: params.notificationType,
          fixtureId: params.fixtureId,
          playerId: entry.playerId,
          channel: "email" as const,
          status: "queued" as const,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: notificationLog.id });
    inserted.forEach((row) => insertedIds.add(row.id));
  }

  return pending.filter((entry) => insertedIds.has(entry.logId));
}

/**
 * Apply one `SendResult` to its `notification_log` row, and report what
 * happened.
 *
 * The asymmetry here is the point: a `SendResult` reports genuinely
 * different situations, and treating them the same either loses a real
 * message or sends one twice.
 *
 * - **Sent.** Recorded `sent` with the provider id.
 * - **Refused by the daily ceiling** (`DAILY_CEILING_REASON`) — the message
 *   never left `QuotaNotifier`, so nothing can have reached a real inbox. It
 *   is therefore safe to retry, and the `queued` row is *removed* rather than
 *   marked `failed`, so a later run's "already logged" check does not see this
 *   player and tries again. Deleting after the attempt, rather than never
 *   inserting the row at all, is what insert-before-send protects — the row
 *   existed for the whole duration of the attempt, so a crash between the two
 *   writes below still leaves a `queued` row a future run will not double-send
 *   against, just an unreachable one it can safely clean up and retry rather
 *   than one that blocks it. This is the *only* outcome reported as
 *   `deferred`, because `deferred` is what `handleScheduled` turns into its
 *   ceiling warning.
 * - **Contract violation** (`NOTIFIER_CONTRACT_VIOLATION_REASON`) — the
 *   notifier returned no result at all for this slot. Every implementation
 *   in the repo builds its results by mapping over its own input, so a
 *   missing slot means nothing was attempted: the row is removed and retried
 *   like the ceiling case. Unlike the ceiling case it is still counted and
 *   reported as a *failure*, because it is a bug in a notifier, not the
 *   expected behaviour of a cost control.
 * - **No usable recipient** (`NO_RECIPIENT_REASON` in `notify/quota.ts`) —
 *   deliberately *not* special-cased here, so it falls to the ambiguous
 *   branch below and is left `failed` forever. It is a permanent condition,
 *   not a transient one, and every caller is expected to trim and skip such a
 *   recipient before a message is ever built. Treating it as retryable is
 *   what turned a `players.email` of `" "` into an every-five-minutes loop of
 *   token signing and row churn, under a false daily-ceiling alarm.
 * - **Ambiguous** (any other `ok: false`, e.g. a real provider error) — the
 *   message *may* have reached the provider before the failure was
 *   reported. Recorded `failed` and left alone: retrying an ambiguous
 *   failure risks sending the same message twice, which BR-19 treats as
 *   strictly worse than the player missing one.
 */
export async function applySendResult(
  db: Db,
  entry: PendingNotification,
  result: SendResult | undefined,
  now: Date,
): Promise<ApplyOutcome> {
  if (result?.ok) {
    await db
      .update(notificationLog)
      .set({ status: "sent", providerMessageId: result.providerMessageId, sentAt: now })
      .where(eq(notificationLog.id, entry.logId));
    return { kind: "sent" };
  }

  const reason = result?.error ?? NOTIFIER_CONTRACT_VIOLATION_REASON;

  if (reason === DAILY_CEILING_REASON) {
    await db.delete(notificationLog).where(eq(notificationLog.id, entry.logId));
    return { kind: "deferred" };
  }

  if (reason === NOTIFIER_CONTRACT_VIOLATION_REASON) {
    await db.delete(notificationLog).where(eq(notificationLog.id, entry.logId));
    return { kind: "failed", reason };
  }

  await db
    .update(notificationLog)
    .set({ status: "failed", error: reason })
    .where(eq(notificationLog.id, entry.logId));
  return { kind: "failed", reason };
}
