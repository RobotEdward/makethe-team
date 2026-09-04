import { displayName } from "./display-name.js";
import type { PlayerRecord } from "./record.js";

/**
 * One squad member's raw counts, as the database groups them (M49).
 *
 * `goalsFor` and `goalsAgainst` are summed over a **strictly smaller** set of
 * fixtures than `won`/`lost`/`drawn`: a result may legitimately be "outcome
 * agreed, score not" (`fixture_results.score_a` is nullable and that is a
 * recordable state, not a gap), and a player with no side has neither. So a
 * full record with a goal difference of nought is an ordinary reading, not a
 * squad that keeps drawing — which is why the page captions it rather than
 * leaving the column to speak for itself.
 */
export interface LeagueTally extends PlayerRecord {
  playerId: string;
  /** `players.name`, still the raw column — see `name` on `LeagueRow`. */
  name: string;
  /** `players.erased_at`, so the row below can be labelled rather than named. */
  erasedAt: Date | null;
  goalsFor: number;
  goalsAgainst: number;
}

/** One line of the standings, ready to render. */
export interface LeagueRow extends PlayerRecord {
  playerId: string;
  /** Already through `displayName`: safe to put on a screen. */
  name: string;
  goalDifference: number;
  /** 3 for a win, 1 for a draw. */
  points: number;
  /**
   * Wins as a percentage of *settled* games, or null when none have settled.
   *
   * Null rather than nought, because the two say different things: a player
   * whose four games all went unrecorded has not won none of them, and a
   * column reading "0%" beside a blank record is the page inventing a fact.
   */
  winPercent: number | null;
}

const POINTS_FOR_A_WIN = 3;
const POINTS_FOR_A_DRAW = 1;

/**
 * The standings for one squad, best first (M49).
 *
 * Points and the win percentage are derived here rather than in the query
 * precisely because the *order* depends on them: a `SUM(CASE …)` cannot be
 * sorted on without repeating itself in the `ORDER BY`, and the two copies are
 * what would eventually disagree.
 *
 * Win percentage is taken over settled games — `won + lost + drawn` — not over
 * everything played. In this product a fixture whose result nobody filed is
 * common, and counting those in the denominator would quietly drag every
 * player's percentage down in proportion to how diligent their organiser is,
 * which is a fact about the organiser rather than about the player.
 *
 * The sort is the league convention — points, then goal difference, then wins
 * — and then name and player id. Those last two are not decoration: the
 * comparator has to be *total*, or `Array.prototype.sort` falls through to its
 * own handling of equal elements and the order becomes whatever order the rows
 * arrived in, which traces back to SQLite row order and is not guaranteed. Two
 * players genuinely level on all three would then swap places between
 * reloads. Player id is the final step because two squad members really can
 * share a name.
 */
export function buildLeagueTable(tallies: readonly LeagueTally[]): LeagueRow[] {
  return tallies
    .map((tally): LeagueRow => {
      const settled = tally.won + tally.lost + tally.drawn;
      return {
        playerId: tally.playerId,
        // Every read of a player's name for display goes through here (§4).
        name: displayName(tally.name, tally.erasedAt),
        played: tally.played,
        won: tally.won,
        lost: tally.lost,
        drawn: tally.drawn,
        goalDifference: tally.goalsFor - tally.goalsAgainst,
        points: tally.won * POINTS_FOR_A_WIN + tally.drawn * POINTS_FOR_A_DRAW,
        winPercent: settled === 0 ? null : (tally.won / settled) * 100,
      };
    })
    .sort(byLeagueOrder);
}

/**
 * The league order itself: points, goal difference, wins, then name and
 * player id to make the comparator total (see `buildLeagueTable`).
 *
 * Named rather than inline because `sortStandings` runs it underneath every
 * other column. Two copies of a league's tiebreak are two things that can
 * disagree, and the disagreement would show as a row that moves when the
 * column it is sorted on says it should not.
 */
function byLeagueOrder(left: LeagueRow, right: LeagueRow): number {
  return (
    right.points - left.points ||
    right.goalDifference - left.goalDifference ||
    right.won - left.won ||
    left.name.localeCompare(right.name) ||
    (left.playerId < right.playerId ? -1 : left.playerId > right.playerId ? 1 : 0)
  );
}

/**
 * The position each row occupies, for a table already in `buildLeagueTable`
 * order (M55).
 *
 * **Standard competition ranking, on the sporting keys only.** Players level
 * on points, goal difference and wins share a position, and the next position
 * skips the places they used up — the convention every published league table
 * follows. That is not a nicety: the comparator above breaks a remaining tie
 * on name and then player id, and it says in its own comment that those two
 * exist to make the sort *total*, not to rank anybody. Numbering the rendered
 * order 1..n would take that alphabetical accident and print it as fourth and
 * fifth place, which is the table asserting something nobody measured.
 *
 * Takes the rows already sorted, and depends on it: the first row matching a
 * given triple is that triple's position only because equal rows are adjacent.
 */
export function leaguePositions(standings: readonly LeagueRow[]): number[] {
  return standings.map(
    (row) =>
      standings.findIndex(
        (other) =>
          other.points === row.points &&
          other.goalDifference === row.goalDifference &&
          other.won === row.won,
      ) + 1,
  );
}

/**
 * The column a player has the standings sorted by (M59).
 *
 * `points` is the league order — the table as `buildLeagueTable` leaves it —
 * so it is the default and the value the Pts heading links back to. There is
 * no separate key for the position column: a sort by position *is* a sort by
 * points, and a second name for it would be a second thing to keep in step.
 */
export const STANDINGS_SORTS = [
  "points",
  "player",
  "played",
  "won",
  "lost",
  "drawn",
  "gd",
  "winpct",
] as const;

export type StandingsSort = (typeof STANDINGS_SORTS)[number];

export const DEFAULT_STANDINGS_SORT: StandingsSort = "points";

/**
 * A stored or submitted sort, or the league order when it is not one we know.
 *
 * `players.standings_sort` is `text` with no CHECK constraint, so its
 * TypeScript type is a claim about the schema and not about the rows: a value
 * written by a release that offered a column this one has dropped is an
 * ordinary reading, and so is a hand-typed query string. Both land on the
 * default rather than throwing on a page somebody is only looking at.
 *
 * A `Set.has` rather than a lookup object, for the reason `CHANNEL_WORDING`
 * in `src/routes/games.ts` gives: `"toString"` and `"__proto__"` resolve on an
 * object literal's prototype chain and would be waved through.
 */
const KNOWN_SORTS: ReadonlySet<string> = new Set(STANDINGS_SORTS);

/** Whether a submitted value names a column this table has. */
export function isStandingsSort(value: string): value is StandingsSort {
  return KNOWN_SORTS.has(value);
}

export function standingsSortOrDefault(value: string | null | undefined): StandingsSort {
  return value !== null && value !== undefined && isStandingsSort(value)
    ? value
    : DEFAULT_STANDINGS_SORT;
}

/**
 * What each column is worth to the sort. Higher sorts first — which is why
 * `winpct` maps a player with nothing settled to `-1` rather than to nought:
 * null means "no games settled" and nought means "settled and won none", and
 * sorting the first as the second would rank a blank record above a real one.
 */
const SORT_VALUE: Record<Exclude<StandingsSort, "player" | "points">, (row: LeagueRow) => number> = {
  played: (row) => row.played,
  won: (row) => row.won,
  lost: (row) => row.lost,
  drawn: (row) => row.drawn,
  gd: (row) => row.goalDifference,
  winpct: (row) => row.winPercent ?? -1,
};

/**
 * The standings re-sorted by one column, best first (M59).
 *
 * A copy: the caller's array is the league order, and the position column is
 * still numbered from it.
 *
 * Every column sorts downwards — most played, most wins, most *losses* — bar
 * the player's name, which reads A to Z. That is not an inconsistency to
 * tidy: a player clicking L is asking who loses most, and a name column
 * sorted Z to A is nobody's question.
 *
 * The league order runs underneath all of them, so the comparator stays total
 * for the reason `buildLeagueTable`'s does — two players level on the sorted
 * column must not swap places between reloads.
 */
export function sortStandings(
  standings: readonly LeagueRow[],
  sort: StandingsSort,
): LeagueRow[] {
  const rows = [...standings];
  if (sort === "points") return rows.sort(byLeagueOrder);
  if (sort === "player") {
    return rows.sort((left, right) => left.name.localeCompare(right.name) || byLeagueOrder(left, right));
  }
  const value = SORT_VALUE[sort];
  return rows.sort((left, right) => value(right) - value(left) || byLeagueOrder(left, right));
}
