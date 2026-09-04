import {
  DEFAULT_STANDINGS_SORT,
  leaguePositions,
  sortStandings,
  type LeagueRow,
  type StandingsSort,
} from "../domain/league-table.js";
import { escapeHtml } from "./layout.js";

/**
 * The goal difference as a league table writes it: signed, and nought when
 * level.
 *
 * A minus sign (U+2212), not a hyphen: at the size a table cell is read, a
 * hyphen beside a digit is close to invisible, and "5" where "−5" was meant is
 * a two-place error in the standings rather than a typographic quibble.
 */
function goalDifferenceWords(difference: number): string {
  if (difference > 0) return `+${difference}`;
  if (difference < 0) return `−${Math.abs(difference)}`;
  return "0";
}

/**
 * The win percentage, or an em dash when there is nothing to take it over.
 *
 * Whole numbers below 10% would round to nothing useful, so one decimal place
 * survives only where it says something: 37.5% stays, 50.0% becomes 50%.
 */
function winPercentWords(percent: number | null): string {
  if (percent === null) return "—";
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/**
 * The three columns a phone drops (M60): each carries `record-col`, which the
 * one narrow-screen rule hides, and `col-<key>`, which the restore rule below
 * selects on. Both classes are needed on every one of the six cells — three
 * headings and three counts a row — or a column half disappears.
 */
const RECORD_CELL_CLASS = {
  won: "count record-col col-won",
  lost: "count record-col col-lost",
  drawn: "count record-col col-drawn",
} as const;

/**
 * The table's own class, naming the sorted column when it is one a phone would
 * otherwise hide (M60).
 *
 * A player who sorted by wins and then opened the page on a phone would be
 * looking at a table ordered by a column that is not on the screen, which
 * reads as no order at all. `LEAGUE_CSS` pairs each of these with a rule that
 * puts that one column back below 40rem — seven columns for that one sort,
 * still fewer than the eight that fitted before M60.
 *
 * Nothing is added for a sort a phone shows anyway, so the common table
 * carries no class it does not use.
 */
function tableClass(sort: StandingsSort): string {
  return sort === "won" || sort === "lost" || sort === "drawn" ? `league sorted-${sort}` : "league";
}

/**
 * One column heading: a link to sort by it, or plain text when it is already
 * the sort (M59).
 *
 * The active heading is deliberately not a link. A link that reloads the page
 * you are on says "this does something" and then does nothing, and the way
 * back to the league order is the Pts heading, which is a link whenever it is
 * not the sort.
 *
 * `aria-sort` goes on the `th` and the arrow beside it is `aria-hidden`: the
 * two say the same thing, and a screen reader announcing "down arrow" after
 * "sorted descending" is the same fact twice.
 *
 * The label keeps its `abbr`, so "W" is still expandable to "Won" whether or
 * not the column is the one being sorted on. It is markup, and the only
 * interpolation on this page that is not escaped — every caller is a literal
 * a few lines below, and nothing player-supplied may ever be passed here.
 */
function sortableHeading(
  column: StandingsSort,
  label: string,
  columnClass: string,
  active: StandingsSort,
): string {
  const ascending = column === "player";
  if (column === active) {
    const arrow = ascending ? "\u25b2" : "\u25bc";
    return `<th scope="col" class="${escapeHtml(columnClass)}" aria-sort="${ascending ? "ascending" : "descending"}">${label}<span class="sort-mark" aria-hidden="true">${arrow}</span></th>`;
  }
  return `<th scope="col" class="${escapeHtml(columnClass)}"><a class="sort-link" href="${escapeHtml(`?sort=${column}`)}">${label}</a></th>`;
}

/**
 * "Standings" — the squad's league table (M49), shared by the member's game
 * page and the organiser's so the two roles cannot come to rank one squad two
 * ways.
 *
 * **`null` means the viewer may not see this**, and is not the same as an
 * empty table. `standingsForViewer` (`src/domain/squad-visibility.ts`) is what
 * decides; this function only renders what it is handed, and renders nothing
 * for either reason — a heading over an empty table reads as a broken page,
 * and a heading over a table a player is not entitled to would advertise that
 * something is being kept from them.
 *
 * The viewer's own row is marked rather than moved: a league table whose
 * fourth place is printed at the top is no longer a league table.
 *
 * **Sorted by whichever column the viewer picked (M59), but numbered from the
 * league order.** Under the default sort the position column is
 * `leaguePositions` — shared places and all, for the reason that function
 * gives. Under any other it is the row number: a position column reading 3, 1,
 * 5 beside rows ordered by appearances is two orderings printed on one table,
 * and the reader has no way to tell which one the page means.
 *
 * **Six columns on a phone (M55, M60).** All nine fit a laptop; 390px fits
 * about six, so `LEAGUE_CSS` hides W, L and D below 40rem and keeps `#`,
 * Player, P, GD, Win% and Pts. The three that go are each one *part* of a
 * record the four that stay already summarise — Pts is W and D weighted, Win%
 * is W over the games that settled — which is the argument the other way round
 * from M55's, when it was Win% that stepped aside. The exception is the column
 * being sorted on: see `tableClass`. Nothing is dropped on a screen with room
 * for it.
 *
 * The name goes in a span with a `title`, because the column is capped so that
 * the columns fit a 390px screen. Uncapped, one long name pushed Points
 * — the number the table exists to report — off the right-hand edge behind a
 * scroll nobody would think to try. The title is what makes the truncation
 * recoverable rather than lossy.
 *
 * Every name is already through `displayName` by the time it arrives — see
 * `buildLeagueTable`, which is where §4's rule about erased players is
 * honoured. Nothing here may re-derive a name.
 */
export function renderStandingsSection(
  standings: readonly LeagueRow[] | null,
  viewerPlayerId: string,
  sort: StandingsSort = DEFAULT_STANDINGS_SORT,
): string {
  if (standings === null || standings.length === 0) return "";

  // Positions come off the league order, always, and the rows off the sorted
  // copy — which is why this reads `standings` before re-sorting it.
  const positions =
    sort === DEFAULT_STANDINGS_SORT
      ? leaguePositions(standings).map(String)
      : standings.map((_row, index) => String(index + 1));

  const rows = sortStandings(standings, sort)
    .map((row, index) => {
      // Marked, not reordered. `class="you"` on the row rather than a badge in
      // the cell: the whole line is the thing being pointed at.
      const you = row.playerId === viewerPlayerId ? ` class="you"` : "";
      return `
      <tr${you}>
        <td class="rank">${escapeHtml(positions[index] ?? "")}</td>
        <td class="league-player"><span class="league-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span></td>
        <td class="count">${escapeHtml(String(row.played))}</td>
        <td class="${RECORD_CELL_CLASS.won}">${escapeHtml(String(row.won))}</td>
        <td class="${RECORD_CELL_CLASS.lost}">${escapeHtml(String(row.lost))}</td>
        <td class="${RECORD_CELL_CLASS.drawn}">${escapeHtml(String(row.drawn))}</td>
        <td class="count">${escapeHtml(goalDifferenceWords(row.goalDifference))}</td>
        <td class="count win-pct">${escapeHtml(winPercentWords(row.winPercent))}</td>
        <td class="count">${escapeHtml(String(row.points))}</td>
      </tr>`;
    })
    .join("");

  return `
    <h2>Standings</h2>
    <div class="league-scroll">
      <table class="${escapeHtml(tableClass(sort))}">
        <thead>
          <tr>
            <th scope="col" class="rank"><abbr title="Position">#</abbr></th>
            ${sortableHeading("player", "Player", "league-player", sort)}
            ${sortableHeading("played", `<abbr title="Played">P</abbr>`, "count", sort)}
            ${sortableHeading("won", `<abbr title="Won">W</abbr>`, RECORD_CELL_CLASS.won, sort)}
            ${sortableHeading("lost", `<abbr title="Lost">L</abbr>`, RECORD_CELL_CLASS.lost, sort)}
            ${sortableHeading("drawn", `<abbr title="Drawn">D</abbr>`, RECORD_CELL_CLASS.drawn, sort)}
            ${sortableHeading("gd", `<abbr title="Goal difference">GD</abbr>`, "count", sort)}
            ${sortableHeading("winpct", `<abbr title="Win percentage">Win%</abbr>`, "count win-pct", sort)}
            ${sortableHeading("points", `<abbr title="Points">Pts</abbr>`, "count", sort)}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="league-note">Three points for a win, one for a draw. Players level on points, goal difference and wins share a place. Win% is of the games that settled. GD only counts games with an agreed score, so it covers fewer games than the rest of the row.</p>`;
}
