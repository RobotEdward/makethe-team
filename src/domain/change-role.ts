import { eq } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { findMembershipInGame } from "../db/queries.js";
import { memberships } from "../db/schema.js";
import { isLastActiveOwner } from "./last-owner.js";

export type MemberRole = "player" | "owner";

/**
 * The submitted role, or `null`.
 *
 * Exact-match only — no case folding, no trimming. The value comes from a
 * `<select>` this application rendered, so anything else is a hand-built
 * request and gets a 400 rather than a guess at what was meant.
 */
export function parseRole(value: unknown): MemberRole | null {
  return value === "owner" || value === "player" ? value : null;
}

export type ChangeRoleResult =
  | { kind: "changed"; role: MemberRole }
  | { kind: "unchanged"; role: MemberRole }
  | { kind: "refused"; reason: "last-owner" }
  | { kind: "not-a-member" };

/**
 * Promote a player to organiser, or demote one back (J6a §4).
 *
 * One function for both directions, deliberately: promotion and demotion
 * differ only in the target value, and two functions would eventually
 * disagree about the guard. The guard is the project's one squad invariant —
 * a game always keeps at least one active owner — which here refuses exactly
 * the demotion of the last owner.
 *
 * Promotion is unrestricted in the other direction. One-way promotion was
 * considered and rejected: promote the wrong person with no way back and the
 * mistake is permanent short of a hand edit of D1.
 */
export async function changeMemberRole(params: {
  db: Db;
  gameId: string;
  playerId: string;
  actorPlayerId: string;
  role: MemberRole;
  now: Date;
}): Promise<ChangeRoleResult> {
  const { db, gameId, playerId, actorPlayerId, role, now } = params;

  const member = await findMembershipInGame(db, gameId, playerId);
  if (member === null || !member.active) return { kind: "not-a-member" };
  if (member.role === role) return { kind: "unchanged", role };

  // Only a demotion can break the invariant; `isLastActiveOwner` is false for
  // anyone who is not an active owner, so a promotion never reaches a refusal.
  if (role === "player" && (await isLastActiveOwner(db, gameId, member))) {
    return { kind: "refused", reason: "last-owner" };
  }

  await db.batch([
    db.update(memberships).set({ role }).where(eq(memberships.id, member.membershipId)),
    buildAuditInsert(db, {
      actorPlayerId,
      entityType: "membership",
      entityId: member.membershipId,
      action: "membership.role_changed",
      before: { role: member.role },
      after: { role },
      now,
    }),
  ]);

  return { kind: "changed", role };
}
