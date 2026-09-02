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
    .sort(
      (left, right) =>
        right.points - left.points ||
        right.goalDifference - left.goalDifference ||
        right.won - left.won ||
        left.name.localeCompare(right.name) ||
        (left.playerId < right.playerId ? -1 : left.playerId > right.playerId ? 1 : 0),
    );
}
