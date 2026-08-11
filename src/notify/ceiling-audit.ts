import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import type { AuditAction } from "../domain/audit.js";
import type { NotificationType } from "./dedupe-key.js";

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
 */
export async function recordCeilingDeferral(
  db: Db,
  params: {
    action: Extract<AuditAction, `${string}_email_deferred`>;
    notificationType: NotificationType;
    fixtureId: string;
    /** Everyone whose copy of the message was refused. One row per event, not per player. */
    playerIds: readonly string[];
    now: Date;
  },
): Promise<void> {
  await buildAuditInsert(db, {
    // No actor: a ceiling refusal is a system condition, not something any
    // player or owner did — even when the send that hit it was triggered by
    // someone's request.
    actorPlayerId: null,
    entityType: "fixture",
    entityId: params.fixtureId,
    action: params.action,
    after: { notificationType: params.notificationType, playerIds: [...params.playerIds] },
    now: params.now,
  });
}
