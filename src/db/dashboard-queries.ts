import { and, asc, desc, eq, ne, notInArray, type SQL } from "drizzle-orm";
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
  /**
   * How many are on the waitlist right now (M10 §3.4/whole-branch review
   * Important 2) — `fixtures.waitlist_count`, selected here for the same
   * reason `inCount` already is: the page needs it whether or not it also
   * shows names, and a required field on `DashboardRow` cannot be quietly
   * omitted by a future caller the way an optional one could.
   */
  waitlistCount: number;
  minPlayers: number;
  maxPlayers: number;
  prefersEvenNumbers: boolean;
  shortWarningOffsetHours: number;
  /** The viewer's own response. Never anybody else's. */
  myStatus: ResponseStatus;
}

/**
 * The entitlement predicate, in one place, used by every read and write path.
 *
 * **This is a security control, not a display filter (TR-18).** The session
 * middleware established *who* is asking and stopped there; every membership
 * question has to be re-asked against the database by the handler. Three
 * conditions carry that weight:
 *
 * - `memberships.active` — a player who left a Game keeps their history but
 *   loses their standing in it. Dropping this condition would let anyone who
 *   was *ever* in a squad keep seeing that squad's fixtures. The visible
 *   consequence, stated so nobody "fixes" it later: leaving a game removes its
 *   fixtures from the account page's history too.
 * - `responses.player_id = :viewer` — the join starts from the viewer's own
 *   response rows, so no row for another player can be reached at all, whether
 *   to display or to write.
 * - `withdrawn` is excluded for the reason `getFixtureWithSquad` excludes it:
 *   a withdrawn player is not a squad member any more (spec amendment 5).
 *
 * **The lifecycle filter is deliberately *not* here (M11).** It used to be,
 * and it was the one condition in this function that is a question of scope
 * rather than of entitlement: the dashboard is a to-do list so it excludes
 * `played` and `cancelled`, and the account page is a history so it includes
 * them. Passing it in keeps the three security conditions in exactly one place
 * while letting a caller widen what it *shows* without touching what it may
 * *reach*. A caller that widened this function's `notInArray` instead would
 * have silently widened the dashboard's write path with it.
 *
 * **Driving the join from `responses` is safe precisely because eligibility
 * is a row, not a rule evaluated here.** BR-1 mints the response rows when a
 * fixture opens, and BR-2′ (M21) backfills one when a player joins while a
 * fixture is open — so a late joiner *does* see the open fixture on their
 * dashboard, because the join flow wrote their `pending` row before this
 * query could run. `/r/:token` agrees for the same reason: their N-1, with a
 * freshly minted token, is sent by the same join. Anyone without a row —
 * removed mid-fixture, or missed by the narrow join/open race noted in
 * docs/known-issues.md — is invisible here, which is the intended reading of
 * the eligible set, not a query bug.
 */
function entitledTo(playerId: string, extra?: SQL): SQL | undefined {
  return and(
    eq(responses.playerId, playerId),
    eq(memberships.active, true),
    ne(responses.status, "withdrawn"),
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
      waitlistCount: fixtures.waitlistCount,
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
 * The lifecycle scope the *dashboard* uses: a fixture nobody can act on any
 * more is not a thing to do this week.
 *
 * "Upcoming" is defined by lifecycle rather than by comparing `kicks_off_at`
 * against a clock: the retire sweep is what moves a finished fixture to
 * `played`, and a fixture still `open` an hour after its nominal kickoff is
 * genuinely still open to respond to. A clock comparison here would hide it
 * and would make the page's contents depend on an instant D1 and the Durable
 * Object can disagree about.
 */
const NOT_FINISHED = notInArray(fixtures.lifecycle, [...TERMINAL_LIFECYCLES]);

/**
 * Every fixture the viewer may still act on, soonest first (J7, BR-25).
 *
 * One statement, no matter how many games the viewer belongs to.
 */
export async function listDashboardFixtures(db: Db, playerId: string): Promise<DashboardFixture[]> {
  const rows = await selectEntitledFixtures(db, playerId, NOT_FINISHED).orderBy(
    asc(fixtures.kicksOffAt),
  );
  return rows.map(toDashboardFixture);
}

/**
 * The one fixture a posted form names, **if** the viewer is entitled to act on
 * it — the write path's re-check of exactly the predicate the read path used.
 *
 * `null` means "no", without distinguishing "no such fixture" from "not
 * yours": the caller answers 404 either way, so a fixture id cannot be probed
 * for existence (TR-18). Keeping `NOT_FINISHED` here is what locks a `played`
 * fixture (BR-15) against a replayed form.
 */
export async function findActionableFixture(
  db: Db,
  playerId: string,
  fixtureId: string,
): Promise<DashboardFixture | null> {
  const [row] = await selectEntitledFixtures(
    db,
    playerId,
    and(NOT_FINISHED, eq(fixtures.id, fixtureId)),
  ).limit(1);
  return row ? toDashboardFixture(row) : null;
}

/**
 * The viewer's own fixtures, most recent first, across every game they are
 * still an active member of (M11, the account page).
 *
 * Two deliberate differences from `listDashboardFixtures`, and nothing else:
 *
 * 1. **No lifecycle filter at all.** `played` and `cancelled` fixtures are the
 *    history — excluding them, as the dashboard does, would leave this list
 *    showing exactly what the dashboard already shows.
 * 2. **`desc` and a `limit`.** Most recent first, so an upcoming fixture sorts
 *    above a played one and the list is a timeline rather than a to-do list.
 *    `fixtures.id` is a tiebreaker on `kicksOffAt`: two fixtures across
 *    different squads can share a kickoff instant, and without a second sort
 *    key SQLite is free to order them however it likes, which would also make
 *    the twenty-row cut arbitrary whenever a tied pair straddles it.
 *
 * Everything that keeps one player out of another's rows is untouched: this
 * goes through `selectEntitledFixtures`, whose join is rooted at
 * `responses.player_id = :viewer`, so there is no other player's row for it to
 * reach even if a future caller passed a hostile `limit`.
 */
export async function listPlayerFixtureHistory(
  db: Db,
  playerId: string,
  limit: number,
): Promise<DashboardFixture[]> {
  const rows = await selectEntitledFixtures(db, playerId)
    .orderBy(desc(fixtures.kicksOffAt), asc(fixtures.id))
    .limit(limit);
  return rows.map(toDashboardFixture);
}
