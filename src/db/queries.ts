import { and, asc, desc, eq, gte, ne } from "drizzle-orm";
import type { ResponseStatus } from "../domain/response-status.js";
import type { Db } from "./client.js";
import { fixtures, games, memberships, players, responses } from "./schema.js";

export interface SquadMember {
  playerId: string;
  name: string;
  status: ResponseStatus;
  /** Rank among current waitlisted members, 1-based. Null unless waitlisted.
   *  Computed here, never the stored column — see spec amendment 5. */
  waitlistRank: number | null;
}

export interface FixtureWithSquad {
  fixture: typeof fixtures.$inferSelect;
  game: typeof games.$inferSelect;
  squad: SquadMember[];
}

// Display order (spec: in, then waitlisted by rank, then pending, then out).
// `withdrawn` never appears — it is filtered out of the query below — but the
// map needs an entry for every ResponseStatus to satisfy the indexed-access
// check, so it is given a value that is simply never read.
const SQUAD_ORDER: Record<ResponseStatus, number> = {
  in: 0,
  waitlisted: 1,
  pending: 2,
  out: 3,
  withdrawn: 4,
};

/**
 * Load a fixture, its game and the current squad in display order.
 *
 * `responses` is joined to `players` for names and filtered to exclude
 * `withdrawn` — a withdrawn player is not a squad member any more, and
 * nothing downstream should ever see them (spec amendment 5).
 *
 * Reads only, straight to D1 — never touches the FixtureCapacity Durable
 * Object (TR-11).
 */
export async function getFixtureWithSquad(db: Db, fixtureId: string): Promise<FixtureWithSquad | null> {
  const [row] = await db
    .select({ fixture: fixtures, game: games })
    .from(fixtures)
    .innerJoin(games, eq(fixtures.gameId, games.id))
    .where(eq(fixtures.id, fixtureId));

  if (!row) return null;

  const rows = await db
    .select({
      playerId: responses.playerId,
      name: players.name,
      status: responses.status,
      waitlistPosition: responses.waitlistPosition,
    })
    .from(responses)
    .innerJoin(players, eq(responses.playerId, players.id))
    .where(and(eq(responses.fixtureId, fixtureId), ne(responses.status, "withdrawn")))
    .orderBy(asc(responses.respondedAt), asc(responses.createdAt));

  // Waitlist rank is computed here, at render time, never read from the
  // stored `waitlistPosition` column — that column is permanent and never
  // reused, so it develops gaps once people leave the waitlist. Order the
  // currently waitlisted members by their stored position ascending and
  // number them 1, 2, 3 (spec amendment 5).
  const waitlistRanks = new Map<string, number>();
  rows
    .filter((r) => r.status === "waitlisted")
    .sort((a, b) => (a.waitlistPosition ?? 0) - (b.waitlistPosition ?? 0))
    .forEach((r, index) => waitlistRanks.set(r.playerId, index + 1));

  const squad: SquadMember[] = rows.map((r) => ({
    playerId: r.playerId,
    name: r.name,
    status: r.status,
    waitlistRank: waitlistRanks.get(r.playerId) ?? null,
  }));

  squad.sort((a, b) => {
    const byStatus = SQUAD_ORDER[a.status] - SQUAD_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.status === "waitlisted") return (a.waitlistRank ?? 0) - (b.waitlistRank ?? 0);
    // Within `in`, `pending` and `out`, the SQL ORDER BY already put rows in
    // response-time order; Array#sort is stable, so returning 0 preserves it.
    return 0;
  });

  return { fixture: row.fixture, game: row.game, squad };
}

/**
 * The game, if and only if this player is an active Owner of it (TR-18).
 *
 * Returns `null` for "no such game", "not a member", "a member but not an
 * owner" and "an owner whose membership was deactivated" alike — the caller
 * answers 404 for all four, so a game id cannot be probed for existence and a
 * demoted owner learns nothing from the difference.
 *
 * This is the entitlement check for every `/g/:id` route. Middleware cannot do
 * it: which row to check depends on which row the handler is about.
 */
export async function findGameForOwner(
  db: Db,
  gameId: string,
  playerId: string,
): Promise<typeof games.$inferSelect | null> {
  const [row] = await db
    .select({ game: games })
    .from(games)
    .innerJoin(memberships, eq(memberships.gameId, games.id))
    .where(
      and(
        eq(games.id, gameId),
        eq(games.active, true),
        eq(memberships.playerId, playerId),
        eq(memberships.role, "owner"),
        eq(memberships.active, true),
      ),
    )
    .limit(1);
  return row?.game ?? null;
}

/** Active squad members, owners first then alphabetical. */
export async function listSquad(
  db: Db,
  gameId: string,
): Promise<Array<{ playerId: string; name: string; role: "player" | "owner"; isGuest: boolean }>> {
  return db
    .select({
      playerId: players.id,
      name: players.name,
      role: memberships.role,
      isGuest: players.isGuest,
    })
    .from(memberships)
    .innerJoin(players, eq(players.id, memberships.playerId))
    .where(and(eq(memberships.gameId, gameId), eq(memberships.active, true)))
    .orderBy(desc(memberships.role), players.name);
}

/** Non-terminal fixtures from `now` onward, soonest first. */
export async function listUpcomingFixtures(
  db: Db,
  gameId: string,
  now: Date,
): Promise<Array<{ id: string; kicksOffAt: Date; lifecycle: string; inCount: number }>> {
  return db
    .select({
      id: fixtures.id,
      kicksOffAt: fixtures.kicksOffAt,
      lifecycle: fixtures.lifecycle,
      inCount: fixtures.inCount,
    })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), gte(fixtures.kicksOffAt, now)))
    .orderBy(fixtures.kicksOffAt);
}
