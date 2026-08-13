import { eq } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { findMembershipInGame, listOpenFixtureIds } from "../db/queries.js";
import { memberships } from "../db/schema.js";
import type { WaitlistPromotion, WithdrawMemberOutcome } from "../capacity/types.js";
import { isLastActiveOwner } from "./last-owner.js";

/** One fixture on which this removal promoted a waitlisted player (BR-7). */
export interface FixturePromotion {
  fixtureId: string;
  promoted: WaitlistPromotion;
}

export interface RemoveMemberParams {
  db: Db;
  gameId: string;
  playerId: string;
  /** The owner performing the removal. */
  actorPlayerId: string;
  now: Date;
  /**
   * Applies BR-3 to one fixture. Injected rather than reached for, so this
   * module holds no Workers binding: the route passes
   * `(id) => env.FIXTURE_CAPACITY.getByName(id).withdrawMember({...})`.
   */
  withdraw: (fixtureId: string) => Promise<WithdrawMemberOutcome>;
}

export type RemoveMemberResult =
  | {
      kind: "removed";
      membershipId: string;
      /** The `left_at` written. Part of N-7's dedupe key — see `removalKey`. */
      leftAt: Date;
      /** Every promotion this removal caused. The caller sends the N-2s. */
      promotions: FixturePromotion[];
    }
  | { kind: "refused"; reason: "last-owner" }
  | { kind: "not-a-member" };

/**
 * Remove a player from a squad, with BR-3's full consequence pass (J6a §3.3).
 *
 * **The order of the two writes is the design.** A removal spans one
 * membership row and N open fixtures, each behind its own Durable Object, and
 * D1 has no cross-object transaction — so the operation cannot be made atomic
 * and this chooses resumability instead:
 *
 * 1. The membership is deactivated **first**, in one `db.batch()` with its
 *    audit row. From that instant the player is out of the squad: they are not
 *    eligible when the next fixture opens (BR-2), and no later failure can
 *    leave them half-in.
 * 2. Only then are the open fixtures walked. `withdrawMember` is idempotent —
 *    a second call finds no row and returns `no-op` — so a failure partway
 *    through leaves *work a retry would finish*, not a corrupted state.
 *
 * It **sends nothing**. Promotions are returned for the caller to notify, for
 * the same reason `FixtureCapacity` returns them: a mail provider's latency
 * must not sit inside a lock, and a mail failure must not roll back a
 * membership change.
 *
 * It does not send N-4 either. If a removal drops a fixture below
 * `min_players`, the owner-attention email is the cron sweep's job, and BR-31
 * caps it at one per fixture ever — so on a fixture already warned about there
 * is no second warning (§3.4).
 */
export async function removeMember(params: RemoveMemberParams): Promise<RemoveMemberResult> {
  const { db, gameId, playerId, actorPlayerId, now, withdraw } = params;

  const member = await findMembershipInGame(db, gameId, playerId);
  // An inactive membership is reported as `not-a-member` too: they are already
  // out of the squad, and the caller answers 404 for both (TR-18).
  if (member === null || !member.active) return { kind: "not-a-member" };

  if (await isLastActiveOwner(db, gameId, member)) return { kind: "refused", reason: "last-owner" };

  await db.batch([
    db.update(memberships).set({ active: false, leftAt: now }).where(eq(memberships.id, member.membershipId)),
    buildAuditInsert(db, {
      actorPlayerId,
      entityType: "membership",
      entityId: member.membershipId,
      action: "membership.removed",
      before: { active: true, leftAt: null, role: member.role },
      after: { active: false, leftAt: now.toISOString(), role: member.role },
      now,
    }),
  ]);

  // Sequential, not concurrent: each call takes a different object's lock, and
  // a squad's open fixtures number in the low single digits. Firing them
  // together would buy nothing and would make a partial failure harder to read
  // in the logs.
  const promotions: FixturePromotion[] = [];
  for (const fixtureId of await listOpenFixtureIds(db, gameId)) {
    const outcome = await withdraw(fixtureId);
    if (outcome.kind === "removed" && outcome.promoted) {
      promotions.push({ fixtureId, promoted: outcome.promoted });
    }
  }

  return { kind: "removed", membershipId: member.membershipId, leftAt: now, promotions };
}
