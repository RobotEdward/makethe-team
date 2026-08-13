import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { games, notificationLog, players } from "../db/schema.js";
import { removalKey } from "./dedupe-key.js";
import { applySendResult, insertQueuedLogRows, type PendingNotification } from "./delivery.js";
import type { Notifier } from "./notifier.js";
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

  const rendered = renderRemovedEmail({ playerName: player.name, gameName: game.name });

  const dedupeKey = removalKey(membershipId, leftAt.toISOString());
  const pending: PendingNotification = {
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
  };

  const [inserted] = await insertQueuedLogRows(db, { fixtureId: null, notificationType: "n7" }, [pending]);
  if (!inserted) return { kind: "already-logged" };

  let results;
  try {
    results = await notifier.send([inserted.message]);
  } catch (error) {
    // The notifier rejected — e.g. `QuotaNotifier.reserve()` hitting a D1
    // error. Whether the message reached a provider first is unknowable from
    // here, so the row is left `failed` (ambiguous, never retried), exactly as
    // every other sender does with the same situation.
    const reason = error instanceof Error ? error.message : String(error);
    await db
      .update(notificationLog)
      .set({ status: "failed", error: reason })
      .where(eq(notificationLog.id, inserted.logId));
    return { kind: "failed", reason };
  }

  return applySendResult(db, inserted, results[0], now);
}
