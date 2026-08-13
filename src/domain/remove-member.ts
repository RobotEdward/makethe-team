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
  | {
      /**
       * The membership was already inactive, so only the per-fixture half ran.
       * This is the resume of a removal that failed partway through its loop
       * (§3.3) — same shape as `removed` so the caller needs no second branch.
       */
      kind: "resumed";
      membershipId: string;
      /**
       * The **original** `left_at`, re-read rather than re-written. N-7's
       * dedupe key is `n7:<membershipId>:<leftAt>`, so reusing it means the
       * resend attempt hits the `notification_log` unique index and returns
       * `already-logged` instead of emailing the person a second time.
       */
      leftAt: Date;
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
 * **That retry is a real path, not a claim.** Called again on a membership
 * that is already inactive, this skips the batch and the audit row (there is
 * nothing left to write, and a second `membership.removed` row would assert a
 * second removal that never happened) and re-runs only the fixture loop,
 * returning `resumed` with the *original* `leftAt`. The route accepts that
 * outcome exactly as it accepts `removed`, so re-submitting the failed POST —
 * which is what a browser's reload does — finishes the job.
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
  // Never in this squad at all: the caller answers 404 (TR-18). An *inactive*
  // membership is a different thing and is handled below, not folded in here.
  if (member === null) return { kind: "not-a-member" };

  if (!member.active) {
    // The resume. Nothing to deactivate, nothing to audit — only the
    // per-fixture half, which is the half that can have failed.
    const promotions = await withdrawFromOpenFixtures(db, gameId, withdraw);
    return {
      kind: "resumed",
      membershipId: member.membershipId,
      // `removeMember` always writes `active` and `left_at` in the same batch,
      // so an inactive row without a `left_at` cannot be produced by this
      // module; only a hand-written or hand-seeded row can be in that state.
      // `now` keeps N-7's key well formed rather than throwing on it.
      leftAt: member.leftAt ?? now,
      promotions,
    };
  }

  if (await isLastActiveOwner(db, gameId, member)) return { kind: "refused", reason: "last-owner" };

  await db.batch([
    // **The demotion is not cosmetic.** `active: false` alone leaves
    // `role = 'owner'` on the row, and `joinSquad`'s reactivation path would
    // then hand ownership of the game back to anyone who submits the public
    // invite form with the removed organiser's address. `joinSquad` forces
    // `role: 'player'` on reactivation for the same reason; the two halves
    // guard different things and both are needed. The confirmation page tells
    // the owner that removing an organiser "takes that away too" — this is
    // what makes that sentence true.
    db
      .update(memberships)
      .set({ active: false, leftAt: now, role: "player" })
      .where(eq(memberships.id, member.membershipId)),
    buildAuditInsert(db, {
      actorPlayerId,
      entityType: "membership",
      entityId: member.membershipId,
      action: "membership.removed",
      // BR-27 wants the previous value, and for an organiser the role change
      // is the consequential half of this write — so it is named on both
      // sides rather than copied unchanged from `before` to `after`.
      before: { active: true, leftAt: null, role: member.role },
      after: { active: false, leftAt: now.toISOString(), role: "player" },
      now,
    }),
  ]);

  const promotions = await withdrawFromOpenFixtures(db, gameId, withdraw);

  return { kind: "removed", membershipId: member.membershipId, leftAt: now, promotions };
}

/**
 * BR-3's per-fixture half, shared by the first attempt and the resume so the
 * two cannot walk different sets of fixtures.
 *
 * Sequential, not concurrent: each call takes a different object's lock, and a
 * squad's open fixtures number in the low single digits. Firing them together
 * would buy nothing and would make a partial failure harder to read in the
 * logs.
 */
async function withdrawFromOpenFixtures(
  db: Db,
  gameId: string,
  withdraw: (fixtureId: string) => Promise<WithdrawMemberOutcome>,
): Promise<FixturePromotion[]> {
  const promotions: FixturePromotion[] = [];
  for (const fixtureId of await listOpenFixtureIds(db, gameId)) {
    const outcome = await withdraw(fixtureId);
    if (outcome.kind === "removed" && outcome.promoted) {
      promotions.push({ fixtureId, promoted: outcome.promoted });
    }
  }
  return promotions;
}
