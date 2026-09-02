import type { LeagueRow } from "../domain/league-table.js";
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
 * The name goes in a span with a `title`, because the column is capped so that
 * all eight columns fit a 390px screen. Uncapped, one long name pushed Points
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
): string {
  if (standings === null || standings.length === 0) return "";

  const rows = standings
    .map((row) => {
      // Marked, not reordered. `class="you"` on the row rather than a badge in
      // the cell: the whole line is the thing being pointed at.
      const you = row.playerId === viewerPlayerId ? ` class="you"` : "";
      return `
      <tr${you}>
        <td class="league-player"><span class="league-name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span></td>
        <td class="count">${escapeHtml(String(row.played))}</td>
        <td class="count">${escapeHtml(String(row.won))}</td>
        <td class="count">${escapeHtml(String(row.lost))}</td>
        <td class="count">${escapeHtml(String(row.drawn))}</td>
        <td class="count">${escapeHtml(goalDifferenceWords(row.goalDifference))}</td>
        <td class="count">${escapeHtml(winPercentWords(row.winPercent))}</td>
        <td class="count">${escapeHtml(String(row.points))}</td>
      </tr>`;
    })
    .join("");

  return `
    <h2>Standings</h2>
    <div class="league-scroll">
      <table class="league">
        <thead>
          <tr>
            <th scope="col" class="league-player">Player</th>
            <th scope="col" class="count"><abbr title="Played">P</abbr></th>
            <th scope="col" class="count"><abbr title="Won">W</abbr></th>
            <th scope="col" class="count"><abbr title="Lost">L</abbr></th>
            <th scope="col" class="count"><abbr title="Drawn">D</abbr></th>
            <th scope="col" class="count"><abbr title="Goal difference">GD</abbr></th>
            <th scope="col" class="count"><abbr title="Win percentage">Win%</abbr></th>
            <th scope="col" class="count"><abbr title="Points">Pts</abbr></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="league-note">Three points for a win, one for a draw. Win% is of the games that settled. GD only counts games with an agreed score, so it covers fewer games than the rest of the row.</p>`;
}
