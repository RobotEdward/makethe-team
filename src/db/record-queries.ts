import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import type { LeagueTally } from "../domain/league-table.js";
import type { PlayerRecord } from "../domain/record.js";
import { fixtureResults, fixtures, games, memberships, players, responses } from "./schema.js";

/** One game's line of the viewer's playing record (M48). */
export interface GameRecord extends PlayerRecord {
  gameId: string;
  gameName: string;
}

/**
 * The viewer's played/won/lost/drawn in every game they have ever played in,
 * most played first (M48).
 *
 * **Two deliberate departures from the rest of this codebase, both scoped to
 * this one read.**
 *
 * *It reads `fixture_results` rather than deriving from the claims.* Every
 * page that shows a single result derives it, and `src/sweep/result-cache.ts`
 * says plainly that nothing reads its table to decide anything. Nothing here
 * decides anything either — no refusal and no write turns on this number — and
 * a lifetime aggregate cannot derive: it would mean loading every claim on
 * every fixture the viewer has ever played, which is unbounded and runs
 * straight into the 100-bound-parameter ceiling that already forced
 * `RESULTS_NEEDED_CANDIDATE_LIMIT` on the neighbouring module. The cached row
 * is also the *right* answer to fit a total on, for the reason its own schema
 * comment gives: it is the derivation pinned to the instant the window froze,
 * so a future change to the tie-break rule cannot silently rewrite a season's
 * record. The cost is a lag — a fixture that has locked but has not been swept
 * yet counts as played and as nothing else, until the next run moves it — and
 * that resolves itself without anyone doing anything.
 *
 * *It does not require an active membership.* `entitledTo` in
 * `dashboard-queries.ts` does, deliberately: leaving a game gives up your
 * standing in it, and its fixtures leave your history with you. A lifetime
 * record is the one thing that reading of "history" gets wrong — a squad you
 * played two seasons for is exactly what a career total is made of — so this
 * query is rooted at the viewer's own response rows and nothing else. That is
 * still a real boundary and not a weaker one: `responses.player_id = :viewer`
 * means there is no other player's row to reach, in any game, whatever else
 * changes here. What it gives up is only the *game-scoped* half of the
 * predicate, and it gives it up over rows that are already the viewer's own.
 * Kept in its own module rather than added as a fourth caller of
 * `selectEntitledFixtures` so that widening cannot leak into the three readers
 * that must not have it.
 *
 * A win is `fixture_results.outcome` naming the side the viewer was on. A
 * fixture with no cached result, or no `responses.team` because the organiser
 * never picked sides, is played and nothing else — including when the outcome
 * was a draw, which is no more attributable to a player with no side than a
 * win would be. So `played` is an upper bound on `won + lost + drawn`, and the
 * page says why (`renderRecordSection`).
 *
 * `outcome` is `text` with no CHECK constraint behind it (see CLAUDE.md), so a
 * value outside the enum is possible in principle. It cannot break this: the
 * comparisons below are total, and an unrecognised outcome simply falls into
 * none of the three buckets and shows up in the played-but-not-settled gap.
 *
 * One statement whatever the size of the history: the aggregate returns one
 * row per game, not one per fixture, so there is no list to bound.
 */
export async function playerRecordByGame(db: Db, playerId: string): Promise<GameRecord[]> {
  return db
    .select({
      gameId: games.id,
      gameName: games.name,
      played: sql<number>`count(*)`,
      won: sql<number>`coalesce(sum(case when ${fixtureResults.outcome} = ${responses.team} then 1 else 0 end), 0)`,
      lost: sql<number>`coalesce(sum(case when ${responses.team} is not null and ${fixtureResults.outcome} in ('a', 'b') and ${fixtureResults.outcome} <> ${responses.team} then 1 else 0 end), 0)`,
      drawn: sql<number>`coalesce(sum(case when ${responses.team} is not null and ${fixtureResults.outcome} = 'draw' then 1 else 0 end), 0)`,
    })
    .from(responses)
    .innerJoin(fixtures, eq(fixtures.id, responses.fixtureId))
    .innerJoin(games, eq(games.id, fixtures.gameId))
    .leftJoin(fixtureResults, eq(fixtureResults.fixtureId, fixtures.id))
    .where(
      and(
        eq(responses.playerId, playerId),
        eq(responses.status, "in"),
        eq(fixtures.lifecycle, "played"),
      ),
    )
    .groupBy(games.id)
    // Most played first: the squad you turn out for weekly is the record you
    // came to look at. `games.name` then `games.id` break the tie, because
    // SQLite is free to order equal counts however it likes and a table whose
    // rows swapped places between reloads would read as a bug.
    .orderBy(sql`count(*) desc, ${games.name} asc, ${games.id} asc`);
}

/**
 * Every current squad member's raw playing counts in one game, ungrouped by
 * anything but the player (M49) — the standings before they are standings.
 *
 * Reads `fixture_results` for the reasons `playerRecordByGame` gives above,
 * which apply harder here: this aggregates a whole squad's history at once, so
 * deriving from claims would mean every claim on every fixture the game has
 * ever played, not just one viewer's.
 *
 * Who gets a row is decided entirely by the joins, so no caller can widen it:
 * `memberships.active` keeps it to the current squad, `players.is_guest`
 * excludes the one-off guests who occupy a slot but are not part of the
 * standing squad, and grouping over `played` fixtures the player was `in` for
 * means a member who has never turned out simply has no rows — no zero line to
 * filter out afterwards, and no way to accidentally keep one.
 *
 * **Goals come from the player's own side of the scoreline**, which is why
 * this cannot be `scoreA`/`scoreB` summed directly: a 3-1 is three for and one
 * against to the side that won it, and the reverse to the other. Both are
 * `null` unless a score was actually agreed, so a result recorded as "outcome
 * agreed, score not" contributes to `won` and to neither goal column — the
 * asymmetry `LeagueTally` documents and the page captions.
 *
 * Returns the counts and the erasure date, never a display name: what to call
 * an erased player is §4's business and belongs to `displayName`, reached
 * through `buildLeagueTable`. A query that returned a ready-made name would be
 * a second place that decides, which is what §4 forbids.
 *
 * One statement, one row per member, whatever the length of the history.
 */
export async function squadLeagueTally(db: Db, gameId: string): Promise<LeagueTally[]> {
  // Both `null` unless a score was agreed, so `coalesce` outside is what keeps
  // an outcome-only result from turning the whole sum null.
  const goalsFor = sql`case when ${responses.team} = 'a' then ${fixtureResults.scoreA} when ${responses.team} = 'b' then ${fixtureResults.scoreB} end`;
  const goalsAgainst = sql`case when ${responses.team} = 'a' then ${fixtureResults.scoreB} when ${responses.team} = 'b' then ${fixtureResults.scoreA} end`;

  return db
    .select({
      playerId: players.id,
      name: players.name,
      erasedAt: players.erasedAt,
      played: sql<number>`count(*)`,
      won: sql<number>`coalesce(sum(case when ${fixtureResults.outcome} = ${responses.team} then 1 else 0 end), 0)`,
      lost: sql<number>`coalesce(sum(case when ${responses.team} is not null and ${fixtureResults.outcome} in ('a', 'b') and ${fixtureResults.outcome} <> ${responses.team} then 1 else 0 end), 0)`,
      drawn: sql<number>`coalesce(sum(case when ${responses.team} is not null and ${fixtureResults.outcome} = 'draw' then 1 else 0 end), 0)`,
      goalsFor: sql<number>`coalesce(sum(coalesce(${goalsFor}, 0)), 0)`,
      goalsAgainst: sql<number>`coalesce(sum(coalesce(${goalsAgainst}, 0)), 0)`,
    })
    .from(responses)
    .innerJoin(fixtures, eq(fixtures.id, responses.fixtureId))
    .innerJoin(players, eq(players.id, responses.playerId))
    .innerJoin(
      memberships,
      and(eq(memberships.gameId, fixtures.gameId), eq(memberships.playerId, responses.playerId)),
    )
    .leftJoin(fixtureResults, eq(fixtureResults.fixtureId, fixtures.id))
    .where(
      and(
        eq(fixtures.gameId, gameId),
        eq(fixtures.lifecycle, "played"),
        eq(responses.status, "in"),
        eq(memberships.active, true),
        eq(players.isGuest, false),
      ),
    )
    .groupBy(players.id);
}
