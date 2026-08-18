import { and, desc, eq } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import type { AuditAction, AuditEntityType } from "../domain/audit.js";
import type { NotificationType } from "./dedupe-key.js";

/**
 * The collapse window for sweep-driven ceiling deferrals (N-1, N-4). A
 * sustained ceiling would otherwise write one row per sweep tick — at the
 * project's 5-minute cron cadence, roughly 288 identical rows a day per
 * fixture — into a table nothing prunes. One row per hour still lets an
 * operator see the condition is *ongoing* (a fresh `created_at` every hour it
 * persists) rather than collapsing to a single "it happened once" row, while
 * cutting the worst case by more than an order of magnitude.
 */
export const CEILING_DEFERRAL_COLLAPSE_WINDOW_MS = 60 * 60 * 1000;

/**
 * The durable half of TR-31's owner-visible ceiling warning: one `audit_log`
 * row recording a message the daily send ceiling refused (BR-27, §2.8).
 *
 * **Why this exists at all.** A ceiling refusal *deletes* its
 * `notification_log` row — see `applySendResult` in `src/notify/delivery.ts`,
 * which is deliberate and is not changing: the message provably never reached
 * a provider, so deleting the row is what keeps a retry possible. The side
 * effect is that the deletion is also the erasure of the only evidence that
 * anybody was ever owed the message. Three separate reviews in this milestone
 * arrived at the same gap from different directions (N-2's promoted player
 * who was never told and cannot be retried because `promotedAt` is persisted
 * nowhere; N-3's squad turning up to a cancelled game; N-4's warning being
 * blocked by the very condition it warns about), and all three need the same
 * thing: a row that survives, in a table nothing prunes, naming the fixture
 * and the players.
 *
 * **Why it is not an email.** Because the condition being reported is "email
 * is not going out". Any warning that travels by email is refused by the
 * ceiling exactly when it matters most. The N-4 email does carry a
 * ceiling line (`AttentionEmailPayload.ceilingReached`) as best-effort
 * context for an owner lucky enough to receive it, but the signal an operator
 * is expected to act on is this row plus the `console.error` beside it.
 *
 * Built through `buildAuditInsert` rather than a hand-rolled insert so this
 * writer and `cancelFixture`'s produce byte-identical rows.
 *
 * Deliberately **not** wrapped in a `try`/`catch` here: every caller already
 * runs inside one that is reporting a failure, and swallowing a D1 error at
 * this depth would reintroduce exactly the silence this row exists to break.
 *
 * **`collapseWindowMs`.** N-2 and N-3 call this once per route invocation —
 * a promotion or a cancellation happens once, so the row count is already
 * bounded by user action. N-1 and N-4 call this from the sweep, which
 * re-evaluates every tick; under a sustained ceiling they would otherwise
 * write one row per tick forever. Passing `collapseWindowMs` makes this
 * write a no-op if the most recent row for the same `(entityId, action)`
 * pair is younger than the window, so a persistent condition still produces
 * a fresh row periodically (proving it is ongoing) rather than either
 * flooding the table or collapsing to a single ever-row that looks identical
 * to a one-off blip.
 *
 * This is a read-then-write and therefore has the same race window as the
 * `alreadyLogged` pre-check the brief warns against reintroducing — but
 * unlike that guarantee, nothing here needs to be exact. Losing the race
 * produces one extra row in the same window, not a missed signal, so a
 * best-effort collapse is the right level of guarantee for a *volume*
 * control, as opposed to `notification_log`'s unique index, which guards a
 * *correctness* property (at-most-once delivery).
 */
export async function recordCeilingDeferral(
  db: Db,
  params: {
    action: Extract<AuditAction, `${string}_email_deferred`>;
    notificationType: NotificationType;
    /**
     * What the deferred message was about. `fixture` for every N-1/N-2/N-3/N-4/N-9
     * caller so far; `game` for N-10's game-scoped broadcast, which has no
     * fixture to key on. Widened from a hard-coded `"fixture"` (M15) so a
     * caller with no fixture is not forced to invent one.
     */
    entityType: AuditEntityType;
    entityId: string;
    /** Everyone whose copy of the message was refused. One row per event, not per player. */
    playerIds: readonly string[];
    /**
     * N-10 only: which broadcast this was, since `entityId` is the *game*
     * for that caller, not a per-message id — without this, two broadcasts
     * deferred on the same game in the same day would be indistinguishable
     * in this row. Omitted entirely (not merely `undefined`) for every other
     * caller, whose `entityId` already names the one fixture the message was
     * about.
     */
    broadcastId?: string;
    now: Date;
    /** See "`collapseWindowMs`" above. Omit for a route call that already fires at most once. */
    collapseWindowMs?: number;
  },
): Promise<void> {
  if (params.collapseWindowMs !== undefined) {
    const [mostRecent] = await db
      .select({ createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, params.entityType),
          eq(auditLog.entityId, params.entityId),
          eq(auditLog.action, params.action),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    if (mostRecent && params.now.getTime() - mostRecent.createdAt.getTime() < params.collapseWindowMs) {
      return;
    }
  }

  await buildAuditInsert(db, {
    // No actor: a ceiling refusal is a system condition, not something any
    // player or owner did — even when the send that hit it was triggered by
    // someone's request.
    actorPlayerId: null,
    entityType: params.entityType,
    entityId: params.entityId,
    action: params.action,
    after: {
      notificationType: params.notificationType,
      playerIds: [...params.playerIds],
      ...(params.broadcastId !== undefined ? { broadcastId: params.broadcastId } : {}),
    },
    now: params.now,
  });
}
