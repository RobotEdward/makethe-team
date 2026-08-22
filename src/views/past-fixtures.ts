import { fixturePath, gamePath, gamePastFixturesPath } from "../auth/paths.js";
import type { Lifecycle } from "../domain/lifecycle.js";
import { fixtureStatusWords } from "./fixture.js";
import { renderFreshness } from "./freshness.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { FRESHNESS_JS } from "./scripts.js";
import { DASHBOARD_STYLES_CSS, FIXTURE_STYLES_CSS, FRESHNESS_CSS, RESULT_CSS } from "./styles.js";

/**
 * One row of a game's past-fixtures list (M27).
 *
 * **No other player appears here, by name or otherwise** — the same rule
 * `DashboardRow` and `AccountFixtureRow` state, for the same reason: this is
 * a list of fixtures, and the squad belongs to the fixture page. The type has
 * nowhere to put a roster, which is what stops one creeping in.
 */
export interface PastFixtureRow {
  fixtureId: string;
  /** Already formatted in the game's timezone by the caller (TR-5). */
  kicksOffAtLocal: string;
  /**
   * The stored enum, not a display string — mapped here through
   * `fixtureStatusWords`, whose fallback is why a lifecycle value the
   * schema's missing CHECK constraint let through cannot 500 this page
   * (see CLAUDE.md and `test/stored-lookups.test.ts`).
   */
  lifecycle: Lifecycle;
  /** How many were in. Rendered as a number, never as names. */
  inCount: number;
  /**
   * The result summary — "Reds won 3–2", "Draw" — set only once this
   * fixture's 48-hour window has locked (BR-37), exactly as
   * `AccountFixtureRow.resultWords` is: a tally still inside its window is
   * openly arguable and must not read as settled.
   */
  resultWords?: string;
}

export interface PastFixturesPageParams {
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
  gameId: string;
  gameName: string;
  rows: readonly PastFixtureRow[];
  /**
   * Whether the viewer is looking at this as the game's organiser. It changes
   * one sentence — the empty state and the note about what the list contains
   * — because the two roles genuinely see different sets: an organiser sees
   * every fixture that has been and gone, cancelled ones included, and a
   * member sees the played ones they were in (M27). A page that showed a
   * member a filtered list while describing the organiser's would be lying
   * quietly.
   */
  owner: boolean;
}

function renderRow(gameId: string, row: PastFixtureRow): string {
  return `
    <li class="fixture-card">
      <h2><a href="${escapeHtml(fixturePath(gameId, row.fixtureId))}">${escapeHtml(row.kicksOffAtLocal)}</a></h2>
      <p class="status-badge status-${escapeHtml(row.lifecycle)}">${escapeHtml(fixtureStatusWords(row.lifecycle))}</p>
      <p class="venue">${escapeHtml(String(row.inCount))} in</p>
      ${row.resultWords === undefined ? "" : `<p class="result-final">${escapeHtml(row.resultWords)}</p>`}
    </li>`;
}

/**
 * A game's fixtures that have been and gone (M27), for whichever of the two
 * roles asked.
 *
 * The list itself is the whole page: the date is the heading of each row and
 * the link to the fixture, because the fixture page is where everything this
 * page deliberately omits — the squad, the teams, the result panel — already
 * lives.
 *
 * Cards rather than the one-line `ul.fixtures` rows the game page's "Coming
 * up" uses. A row here carries a date, a state, a headcount *and* often a
 * result, and that list is a non-wrapping flex line: at 390px the fourth item
 * pushed the row past the viewport and the page scrolled sideways. This is
 * the same `.fixture-card` idiom the account page's history already uses for
 * rows of the same shape.
 */
export function renderPastFixturesPage(params: PastFixturesPageParams): string {
  const { gameId, gameName, rows, owner } = params;

  const empty = owner
    ? `<p class="read-only">This game has no fixtures in the past yet.</p>`
    : `<p class="read-only">You haven't played a game here yet. Once you have, it'll show up here.</p>`;

  // A plain paragraph, deliberately not `.read-only` like the empty state
  // below it: that class is a filled box, which reads as a notice about
  // something being wrong. This line is a caption for the list under it.
  const note = owner
    ? `<p>Every fixture that has been and gone, cancelled ones included.</p>`
    : `<p>The games you were in the squad for.</p>`;

  const body = `
    <h1>Past fixtures</h1>
    <p>${escapeHtml(gameName)}</p>
    ${rows.length === 0 ? empty : note}
    ${rows.length === 0 ? "" : `<ul class="fixture-list">${rows.map((row) => renderRow(gameId, row)).join("")}</ul>`}

    <p class="back-link"><a href="${escapeHtml(gamePath(gameId))}">Back to the game</a></p>

    ${renderFreshness(gamePastFixturesPath(gameId))}
  `;

  return layout({
    nav: params.nav,
    title: `Past fixtures — ${gameName} — Make The Team`,
    body,
    // No block here is new and none of them collide: DASHBOARD_STYLES_CSS
    // carries `.fixture-list`/`.fixture-card`, FIXTURE_STYLES_CSS the status
    // badge and `.back-link`, RESULT_CSS the namespaced `.result-final`.
    // Order is therefore not load-bearing on this page, and it matches the
    // order `PAGE_STYLE_BLOCKS` (src/views/styles.ts) already holds them in.
    pageStyles: [FIXTURE_STYLES_CSS, DASHBOARD_STYLES_CSS, RESULT_CSS, FRESHNESS_CSS],
    pageScripts: [FRESHNESS_JS],
  });
}
