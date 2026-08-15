import { inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { listActiveMemberships } from "../db/queries.js";
import { games } from "../db/schema.js";
import { isLastActiveOwner } from "./last-owner.js";

/** A game an erasure cannot get past, with the name a page shows for it. */
export interface BlockingGame {
  gameId: string;
  gameName: string;
}

/**
 * The games this player is the last active organiser of — the set that blocks
 * an erasure, with the names every surface shows (§6).
 *
 * Asked exactly the way `erasePlayer` asks it (`listActiveMemberships`, then
 * `isLastActiveOwner` per game), and deliberately not a second implementation
 * of the rule: if a page's verdict and the erasure's could disagree, one of
 * them would be a lie — either an offer that the sweep then refuses, or a
 * refusal shown to someone who is not blocked at all.
 *
 * Lives in `domain/` rather than in `routes/account.ts`, where it started,
 * because three callers now need the same answer: the delete page, its `POST`,
 * and the dashboard banner that names what is holding an overdue erasure up.
 *
 * The names come from a single `inArray` join rather than a query per game,
 * and only for the blocking games: a player who is not blocked costs nothing.
 */
export async function blockingGamesFor(db: Db, playerId: string): Promise<BlockingGame[]> {
  const memberships = await listActiveMemberships(db, playerId);

  const blocked: string[] = [];
  for (const membership of memberships) {
    if (await isLastActiveOwner(db, membership.gameId, { role: membership.role, active: true })) {
      blocked.push(membership.gameId);
    }
  }
  if (blocked.length === 0) return [];

  return db
    .select({ gameId: games.id, gameName: games.name })
    .from(games)
    .where(inArray(games.id, blocked));
}
