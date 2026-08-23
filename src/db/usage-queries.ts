import { and, count, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { displayName } from "../domain/display-name.js";
import { dayKey } from "../notify/quota.js";
import type { Db } from "./client.js";
import {
  auditLog,
  emailQuota,
  fixtureResults,
  fixtures,
  games,
  memberships,
  notificationLog,
  players,
  pushSubscriptions,
  responses,
  session,
} from "./schema.js";

/**
 * How big the product is right now, for the operator's usage screen (M32).
 *
 * Stock, not flow: every field is a `count(*)` over current rows, so nothing
 * here has a time window and nothing here needs a clock passed in.
 */
export interface ScaleCounts {
  games: number;
  /** Squad places currently held. A member who left is not one. */
  activeMemberships: number;
  players: number;
  /** Of `players`: added by an organiser, with no contact details (BR-32). */
  guests: number;
  /** Of `players`: linked to a Better Auth user, so they have signed in. */
  signedIn: number;
  /** Of `players`: erased rows, which are no longer people (§3). */
  erased: number;
  /** Devices registered for push, across all players. */
  pushDevices: number;
}

/**
 * The four sub-counts of `players` are one query, not four.
 *
 * `sum(case …)` rather than four `count(*)` statements because the splits are
 * not disjoint — an erased player may also have been signed in — so they
 * cannot be derived from each other and four round trips would buy nothing.
 * `coalesce` because `sum` over no rows is null, and a null here would render
 * as an empty cell rather than a zero.
 */
async function playerCounts(db: Db) {
  const [row] = await db
    .select({
      players: count(),
      guests: sql<number>`coalesce(sum(case when ${players.isGuest} then 1 else 0 end), 0)`,
      signedIn: sql<number>`coalesce(sum(case when ${players.authUserId} is not null then 1 else 0 end), 0)`,
      erased: sql<number>`coalesce(sum(case when ${players.erasedAt} is not null then 1 else 0 end), 0)`,
    })
    .from(players);
  return row ?? { players: 0, guests: 0, signedIn: 0, erased: 0 };
}

export async function getScaleCounts(db: Db): Promise<ScaleCounts> {
  const [gameRows, membershipRows, deviceRows, people] = await Promise.all([
    db.select({ n: count() }).from(games),
    // `active` alone, with no second test on `left_at`: it is the predicate
    // every other read in `src/db/queries.ts` uses, and a count that applied a
    // stricter one would quietly disagree with every squad list in the app.
    db.select({ n: count() }).from(memberships).where(eq(memberships.active, true)),
    db.select({ n: count() }).from(pushSubscriptions),
    playerCounts(db),
  ]);

  return {
    games: gameRows[0]?.n ?? 0,
    activeMemberships: membershipRows[0]?.n ?? 0,
    ...people,
    pushDevices: deviceRows[0]?.n ?? 0,
  };
}

/**
 * What happened in a window, for the operator's usage screen (M32).
 *
 * Flow, not stock: every field counts rows whose relevant *instant* falls on
 * or after `since`, so the same function serves the page's 7-day and 28-day
 * columns.
 */
export interface ActivityCounts {
  gamesCreated: number;
  /** Fixtures the daily materialisation brought into being. */
  fixturesCreated: number;
  fixturesOpened: number;
  fixturesCancelled: number;
  /** Answers players actually gave. Not rows materialisation created. */
  responsesRecorded: number;
  /** Sessions minted — a magic link or passkey followed through to a session. */
  signIns: number;
}

export async function getActivityCounts(db: Db, since: Date): Promise<ActivityCounts> {
  const [gameRows, fixtureRows, responseRows, sessionRows] = await Promise.all([
    db.select({ n: count() }).from(games).where(gte(games.createdAt, since)),
    // One pass over `fixtures` for three counts. They overlap — a fixture
    // created, opened and cancelled inside one window contributes to all
    // three — so they are sums over cases, not three mutually exclusive
    // `where` clauses that could be added together.
    db
      .select({
        created: sql<number>`coalesce(sum(case when ${gte(fixtures.createdAt, since)} then 1 else 0 end), 0)`,
        opened: sql<number>`coalesce(sum(case when ${gte(fixtures.openedAt, since)} then 1 else 0 end), 0)`,
        cancelled: sql<number>`coalesce(sum(case when ${gte(fixtures.cancelledAt, since)} then 1 else 0 end), 0)`,
      })
      .from(fixtures),
    // `responded_at`, never `created_at`: materialisation writes one response
    // row per squad member at the moment a fixture appears, so counting
    // `created_at` here would report squad size as engagement and would rise
    // when nobody had answered anything.
    db.select({ n: count() }).from(responses).where(gte(responses.respondedAt, since)),
    db.select({ n: count() }).from(session).where(gte(session.createdAt, since)),
  ]);

  return {
    gamesCreated: gameRows[0]?.n ?? 0,
    fixturesCreated: fixtureRows[0]?.created ?? 0,
    fixturesOpened: fixtureRows[0]?.opened ?? 0,
    fixturesCancelled: fixtureRows[0]?.cancelled ?? 0,
    responsesRecorded: responseRows[0]?.n ?? 0,
    signIns: sessionRows[0]?.n ?? 0,
  };
}

/**
 * Whether fixtures in a window actually worked, for the usage screen (M32).
 *
 * The window is on **kickoff**, not on creation: the question this panel
 * answers is "of the games that were meant to happen, how many did", and a
 * fixture materialised months ahead would otherwise land in the wrong week.
 *
 * `played` is the denominator for the three quality counts below it. A
 * cancelled fixture is excluded from all three even when it had filled and
 * had teams published before it was called off — crediting it would let a
 * season of cancellations read as a season of well-run games.
 */
export interface OutcomeCounts {
  /** Every fixture that kicked off in the window, cancellations included. */
  total: number;
  cancelled: number;
  /** `total` less `cancelled`: the denominator for the three counts below. */
  played: number;
  reachedMin: number;
  teamsPublished: number;
  resultFiled: number;
}

export async function getOutcomeCounts(db: Db, from: Date, to: Date): Promise<OutcomeCounts> {
  // `fixture_results` by left join rather than a second query: the row is the
  // cached, locked result (M27), which is the only durable "a result exists"
  // signal — claims come and go while players change their minds.
  const notCancelled = sql`${fixtures.cancelledAt} is null`;
  const [row] = await db
    .select({
      total: count(),
      cancelled: sql<number>`coalesce(sum(case when ${fixtures.cancelledAt} is not null then 1 else 0 end), 0)`,
      played: sql<number>`coalesce(sum(case when ${notCancelled} then 1 else 0 end), 0)`,
      reachedMin: sql<number>`coalesce(sum(case when ${notCancelled} and ${fixtures.inCount} >= ${fixtures.minPlayers} then 1 else 0 end), 0)`,
      teamsPublished: sql<number>`coalesce(sum(case when ${notCancelled} and ${fixtures.teamsPublishedAt} is not null then 1 else 0 end), 0)`,
      resultFiled: sql<number>`coalesce(sum(case when ${notCancelled} and ${fixtureResults.fixtureId} is not null then 1 else 0 end), 0)`,
    })
    .from(fixtures)
    .leftJoin(fixtureResults, eq(fixtureResults.fixtureId, fixtures.id))
    .where(and(gte(fixtures.kicksOffAt, from), lt(fixtures.kicksOffAt, to)));

  return (
    row ?? { total: 0, cancelled: 0, played: 0, reachedMin: 0, teamsPublished: 0, resultFiled: 0 }
  );
}

/** How many days of `notification_log` the failure count looks back over. */
export const FAILURE_WINDOW_DAYS = 7;

/** One row of the usage screen's table-size list. */
export interface TableRowCount {
  /** The SQL table name, shown as-is: this list is for an operator. */
  table: string;
  rows: number;
}

/**
 * Headroom against the limits this deployment can actually run into (M32).
 *
 * Row counts, deliberately not a byte estimate. D1's 5 GB ceiling is on
 * storage, and nothing available to a Worker converts rows to bytes — a
 * number derived from an assumed row width would be a fabrication dressed as
 * a measurement, and an operator would size decisions on it.
 */
export interface LimitCounts {
  /** Today's `email_quota` row, which is what the daily ceiling reads. */
  emailsToday: number;
  /** Failed sends over the last `FAILURE_WINDOW_DAYS`. */
  notificationFailures: number;
  /**
   * Fixtures that reached kickoff while still unopened and uncancelled.
   *
   * Nothing legitimate produces one: the hourly sweep opens a fixture long
   * before its kickoff, so a non-zero count here means the sweep stopped
   * running. This is a smell test standing in for the real dead-man's switch
   * (M31), and it can only see failures that have already cost somebody a
   * game — it cannot warn.
   */
  unopenedPastFixtures: number;
  tableRows: readonly TableRowCount[];
}

/** The tables that grow with use. Lookup and settings tables are not here. */
const SIZED_TABLES = [
  { table: "responses", from: responses },
  { table: "notification_log", from: notificationLog },
  { table: "audit_log", from: auditLog },
  { table: "fixtures", from: fixtures },
  { table: "players", from: players },
  { table: "memberships", from: memberships },
] as const;

export async function getLimitCounts(db: Db, now: Date): Promise<LimitCounts> {
  const failuresSince = new Date(now.getTime() - FAILURE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [quotaRows, failureRows, unopenedRows, sizes] = await Promise.all([
    // `dayKey` rather than a date computed here, so this page reads the same
    // row `QuotaNotifier` writes rather than a neighbouring one.
    db.select({ n: emailQuota.sentCount }).from(emailQuota).where(eq(emailQuota.day, dayKey(now))),
    db
      .select({ n: count() })
      .from(notificationLog)
      .where(and(eq(notificationLog.status, "failed"), gte(notificationLog.createdAt, failuresSince))),
    db
      .select({ n: count() })
      .from(fixtures)
      .where(
        and(lt(fixtures.kicksOffAt, now), isNull(fixtures.openedAt), isNull(fixtures.cancelledAt)),
      ),
    Promise.all(
      SIZED_TABLES.map(async ({ table, from }) => {
        const [row] = await db.select({ n: count() }).from(from);
        return { table, rows: row?.n ?? 0 };
      }),
    ),
  ]);

  return {
    emailsToday: quotaRows[0]?.n ?? 0,
    notificationFailures: failureRows[0]?.n ?? 0,
    unopenedPastFixtures: unopenedRows[0]?.n ?? 0,
    tableRows: sizes,
  };
}

/** One game, as the usage screen's per-game table lists it (M32). */
export interface GameUsageRow {
  gameId: string;
  name: string;
  /**
   * The game's active owners, by display name, alphabetically.
   *
   * Plural because ownership is a membership role and nothing stops a game
   * having two; empty when every owner has left the squad, which the view
   * has to render rather than assume away.
   */
  owners: readonly string[];
  /** Active memberships, by the same predicate as `getScaleCounts`. */
  squadSize: number;
  /** Fixtures that kicked off inside the window, cancellations included. */
  recentFixtures: number;
  /** Response rows on those fixtures: the people who were asked. */
  invited: number;
  /** How many of `invited` actually answered. */
  responded: number;
  /**
   * The last time a human did anything here — the newest `responded_at` over
   * the game's whole history, or the game's creation if nobody ever has.
   *
   * Not windowed, unlike everything above it: a game whose last answer was
   * two months ago must sort below one answered yesterday, and windowing this
   * would flatten every dormant game to the same date and destroy the order.
   */
  lastActivityAt: Date;
}

/**
 * Every game with its usage, most recently active first.
 *
 * Four queries merged in memory rather than one join. Joining `memberships`
 * and `responses` to `games` in a single statement multiplies the two row
 * sets together, so every squad count would come out multiplied by the number
 * of responses — the classic fan-out, and one that looks plausible enough on
 * a small squad to ship.
 *
 * The sort and the limit are applied here rather than in SQL because
 * `lastActivityAt` comes from a different query than the row it orders. That
 * means reading every game to show 25 of them, which is fine at this
 * deployment's size and is the first thing to change if it stops being.
 */
export async function listGameUsage(
  db: Db,
  from: Date,
  to: Date,
  limit: number,
): Promise<GameUsageRow[]> {
  const [gameRows, squadRows, ownerRows, windowRows, activityRows] = await Promise.all([
    db.select({ id: games.id, name: games.name, createdAt: games.createdAt }).from(games),
    db
      .select({ gameId: memberships.gameId, n: count() })
      .from(memberships)
      .where(eq(memberships.active, true))
      .groupBy(memberships.gameId),
    // Names, not counts, so this one joins `players`. `erasedAt` comes with
    // them because an owner who erased their data must read as the placeholder
    // here too — §4 admits no per-page exception, admin screens included.
    db
      .select({
        gameId: memberships.gameId,
        name: players.name,
        erasedAt: players.erasedAt,
      })
      .from(memberships)
      .innerJoin(players, eq(players.id, memberships.playerId))
      .where(and(eq(memberships.active, true), eq(memberships.role, "owner"))),
    db
      .select({
        gameId: fixtures.gameId,
        // `count(distinct)` because the left join below repeats a fixture
        // once per response on it.
        fixtureCount: sql<number>`count(distinct ${fixtures.id})`,
        invited: sql<number>`coalesce(sum(case when ${responses.id} is not null then 1 else 0 end), 0)`,
        responded: sql<number>`coalesce(sum(case when ${responses.respondedAt} is not null then 1 else 0 end), 0)`,
      })
      .from(fixtures)
      .leftJoin(responses, eq(responses.fixtureId, fixtures.id))
      .where(and(gte(fixtures.kicksOffAt, from), lt(fixtures.kicksOffAt, to)))
      .groupBy(fixtures.gameId),
    db
      .select({ gameId: fixtures.gameId, lastAt: sql<number | null>`max(${responses.respondedAt})` })
      .from(fixtures)
      .innerJoin(responses, eq(responses.fixtureId, fixtures.id))
      .groupBy(fixtures.gameId),
  ]);

  const squads = new Map(squadRows.map((r) => [r.gameId, r.n]));
  const owners = new Map<string, string[]>();
  for (const row of ownerRows) {
    const names = owners.get(row.gameId) ?? [];
    names.push(displayName(row.name, row.erasedAt));
    owners.set(row.gameId, names);
  }
  const windows = new Map(windowRows.map((r) => [r.gameId, r]));
  const activity = new Map(activityRows.map((r) => [r.gameId, r.lastAt]));

  return gameRows
    .map((game) => {
      const inWindow = windows.get(game.id);
      const lastAt = activity.get(game.id);
      return {
        gameId: game.id,
        name: game.name,
        // Sorted here rather than in SQL: the placeholder an erased owner
        // renders as is decided above, so ordering by the stored name would
        // order by a string the page never shows.
        owners: (owners.get(game.id) ?? []).sort((a, b) => a.localeCompare(b)),
        squadSize: squads.get(game.id) ?? 0,
        recentFixtures: inWindow?.fixtureCount ?? 0,
        invited: inWindow?.invited ?? 0,
        responded: inWindow?.responded ?? 0,
        lastActivityAt: lastAt === null || lastAt === undefined ? game.createdAt : new Date(lastAt),
      };
    })
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
    .slice(0, limit);
}
