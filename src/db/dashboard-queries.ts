import { and, asc, eq, ne, notInArray, type SQL } from "drizzle-orm";
import { TERMINAL_LIFECYCLES, type Lifecycle } from "../domain/lifecycle.js";
import type { ResponseStatus } from "../domain/response-status.js";
import type { Db } from "./client.js";
import { fixtures, games, memberships, responses } from "./schema.js";

/**
 * One row of the player dashboard: a fixture the viewer is entitled to see,
 * plus **their own** response and nothing about anybody else's.
 *
 * There is deliberately no squad, no other player's name and no waitlist
 * *rank* here. Rank is a fixture-local computation over every currently
 * waitlisted player's stored position (see `getFixtureWithSquad` and spec
 * amendment 5), so producing it for a cross-fixture list would mean either a
 * second query per fixture — the N+1 this module exists to avoid — or reading
 * other players' rows for every game the viewer belongs to, on a page whose
 * whole remit (BR-25) is the viewer's own commitments. The fixture page, which
 * is already about one fixture and one squad, keeps the number.
 */
export interface DashboardFixture {
  fixtureId: string;
  /** The game this fixture belongs to, so the page can link to it. */
  gameId: string;
  gameName: string;
  /** The fixture's venue override if it has one, else the game's (§2.8). */
  venueName: string;
  /** IANA zone of the *game*, for `formatLocalDateTime` (TR-5). */
  timezone: string;
  kicksOffAt: Date;
  lifecycle: Lifecycle;
  inCount: number;
  minPlayers: number;
  maxPlayers: number;
  prefersEvenNumbers: boolean;
  shortWarningOffsetHours: number;
  /** The viewer's own response. Never anybody else's. */
  myStatus: ResponseStatus;
}

/**
 * The entitlement predicate, in one place, used by both the read and the
 * write path.
 *
 * **This is a security control, not a display filter (TR-18).** The session
 * middleware established *who* is asking and stopped there; every membership
 * question has to be re-asked against the database by the handler. Three
 * conditions carry that weight:
 *
 * - `memberships.active` — a player who left a Game keeps their history but
 *   loses their standing in it. Dropping this condition would let anyone who
 *   was *ever* in a squad keep seeing and changing that squad's fixtures.
 * - `responses.player_id = :viewer` — the join starts from the viewer's own
 *   response rows, so no row for another player can be reached at all, whether
 *   to display or to write.
 * - a non-terminal lifecycle — `played` and `cancelled` fixtures are closed to
 *   everyone (BR-15), so they are neither listed nor actionable.
 *
 * `withdrawn` is excluded for the same reason `getFixtureWithSquad` excludes
 * it: a withdrawn player is not a squad member any more (spec amendment 5).
 *
 * "Upcoming" is defined by lifecycle rather than by comparing `kicks_off_at`
 * against a clock: the retire sweep is what moves a finished fixture to
 * `played`, and a fixture still `open` an hour after its nominal kickoff is
 * genuinely still open to respond to. A clock comparison here would hide it
 * and would make the page's contents depend on an instant D1 and the Durable
 * Object can disagree about. Past fixtures as a *feature* — a history view —
 * are out of scope for this milestone.
 *
 * **Driving the join from `responses` has a consequence worth stating out
 * loud: a player who joins a Game *after* a fixture has already opened has no
 * `responses` row for it, so that fixture never appears on their dashboard and
 * cannot be answered here.** This is not a bug. BR-1/BR-2 fix the eligible
 * squad, and therefore the set of players a fixture mints a response row for,
 * at the moment it opens; `/r/:token` behaves identically for the same
 * player — no token was ever minted for them either, so they have no way to
 * reach that fixture from a reminder email — and this route re-uses that same
 * eligible set rather than inventing a second one. No later milestone is
 * expected to need to revisit this: it would require retroactively minting a
 * response row (and a token) for a fixture that has already opened, which is
 * a change to BR-1/BR-2's eligibility rule, not to this query.
 */
function entitledTo(playerId: string, extra?: SQL): SQL | undefined {
  return and(
    eq(responses.playerId, playerId),
    eq(memberships.active, true),
    ne(responses.status, "withdrawn"),
    notInArray(fixtures.lifecycle, [...TERMINAL_LIFECYCLES]),
    ...(extra ? [extra] : []),
  );
}

/**
 * The single statement behind both callers.
 *
 * Every column the page needs comes back in one round trip: the fixture, the
 * game it belongs to and the viewer's own response are joined, rather than
 * listing fixtures and then asking about each one — which would be an N+1
 * across every game the viewer belongs to. The membership join is what turns
 * the predicate above into part of the query plan rather than a filter someone
 * can forget to apply afterwards.
 */
function selectEntitledFixtures(db: Db, playerId: string, extra?: SQL) {
  return db
    .select({
      fixtureId: fixtures.id,
      gameId: games.id,
      gameName: games.name,
      gameVenueName: games.venueName,
      venueOverride: fixtures.venueOverride,
      timezone: games.timezone,
      kicksOffAt: fixtures.kicksOffAt,
      lifecycle: fixtures.lifecycle,
      inCount: fixtures.inCount,
      minPlayers: fixtures.minPlayers,
      maxPlayers: fixtures.maxPlayers,
      prefersEvenNumbers: fixtures.prefersEvenNumbers,
      shortWarningOffsetHours: fixtures.shortWarningOffsetHours,
      myStatus: responses.status,
    })
    .from(responses)
    .innerJoin(fixtures, eq(fixtures.id, responses.fixtureId))
    .innerJoin(games, eq(games.id, fixtures.gameId))
    .innerJoin(
      memberships,
      and(eq(memberships.gameId, fixtures.gameId), eq(memberships.playerId, responses.playerId)),
    )
    .where(entitledTo(playerId, extra));
}

type EntitledRow = Awaited<ReturnType<typeof selectEntitledFixtures>>[number];

function toDashboardFixture(row: EntitledRow): DashboardFixture {
  const { gameVenueName, venueOverride, ...rest } = row;
  return { ...rest, venueName: venueOverride ?? gameVenueName };
}

/**
 * Every fixture the viewer may see, soonest first (J7, BR-25).
 *
 * One statement, no matter how many games the viewer belongs to.
 */
export async function listDashboardFixtures(db: Db, playerId: string): Promise<DashboardFixture[]> {
  const rows = await selectEntitledFixtures(db, playerId).orderBy(asc(fixtures.kicksOffAt));
  return rows.map(toDashboardFixture);
}

/**
 * The one fixture a posted form names, **if** the viewer is entitled to act on
 * it — the write path's re-check of exactly the predicate the read path used.
 *
 * `null` means "no", without distinguishing "no such fixture" from "not
 * yours": the caller answers 404 either way, so a fixture id cannot be probed
 * for existence (TR-18).
 */
export async function findActionableFixture(
  db: Db,
  playerId: string,
  fixtureId: string,
): Promise<DashboardFixture | null> {
  const [row] = await selectEntitledFixtures(db, playerId, eq(fixtures.id, fixtureId)).limit(1);
  return row ? toDashboardFixture(row) : null;
}
