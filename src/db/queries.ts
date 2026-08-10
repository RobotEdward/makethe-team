import { and, asc, eq, ne } from "drizzle-orm";
import type { ResponseStatus } from "../domain/response-status.js";
import type { Db } from "./client.js";
import { fixtures, games, players, responses } from "./schema.js";

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
