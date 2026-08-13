import { countActiveOwners } from "../db/queries.js";
import type { Db } from "../db/client.js";

/**
 * J6a's one invariant, in one place: **a game always keeps at least one active
 * owner.**
 *
 * Both squad operations consult it — removing a member and demoting an owner —
 * so the three refusals it produces (demote the last owner, remove the last
 * owner, and therefore a solo owner removing themselves) share a single
 * implementation and cannot drift apart.
 *
 * Takes the member's role and active flag rather than re-reading them: every
 * caller has already loaded the membership to answer TR-18's entitlement
 * question, and a second read could see a different row.
 */
export async function isLastActiveOwner(
  db: Db,
  gameId: string,
  member: { role: "player" | "owner"; active: boolean },
): Promise<boolean> {
  // An ordinary player is never the last owner, and neither is an owner who is
  // already inactive — `countActiveOwners` does not count them, so treating
  // them as one would refuse an operation that changes nothing.
  if (member.role !== "owner" || !member.active) return false;
  return (await countActiveOwners(db, gameId)) <= 1;
}
