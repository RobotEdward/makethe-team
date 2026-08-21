import type { SquadMember } from "../db/queries.js";
import type { Lifecycle } from "../domain/lifecycle.js";
import type { PublishedTeams } from "../domain/teams.js";
import { fixtureStatusWords, renderPublishedTeamsSection, renderSquadSection } from "./fixture.js";
import { renderFreshness } from "./freshness.js";
import { renderResultPanel, type ResultPanelParams } from "./result.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { FRESHNESS_JS } from "./scripts.js";
import { FIXTURE_STYLES_CSS, FORM_CSS, FRESHNESS_CSS, RESULT_CSS, SQUAD_STYLES_CSS } from "./styles.js";

/**
 * A player's own view of one fixture, past or present (M25).
 *
 * The first per-fixture URL a player has ever had.
 *
 * Until M25 their only stable per-fixture link was `/r/:token`, out of an
 * email — and `/g/:id` shows only the *open* fixture, so the published teams
 * vanished from a player's view the moment `retirePastFixtures` flipped it to
 * `played`. "I lost the email, which side am I on?" had an answer for about
 * two hours a week.
 */
export interface PlayerFixtureParams {
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
  gameName: string;
  venueName: string;
  venueAddress: string | null;
  /** Already through `formatLocalDateTime` (TR-5). */
  kicksOffAtLocal: string;
  /**
   * The stored enum, not a display string — mapped through
   * `fixtureStatusWords`, whose fallback is why this page cannot 500 on a
   * lifecycle value the schema's missing CHECK constraint let through.
   */
  lifecycle: Lifecycle;
  /**
   * From `publishedTeamsFor` — `null` until the organiser publishes. Rendered
   * in the `past` tense only once the fixture has been played (see `lifecycle`
   * above and `renderPublishedTeamsSection`'s own comment) — before that,
   * "hasn't been picked yet" is exactly the sentence Definition of Done #5
   * requires for a promoted player with no side yet, and `past` tense is the
   * one tense that suppresses it (M25 review fix, I2).
   */
  teams: PublishedTeams | null;
  squad: readonly SquadMember[] | null;
  inCount: number;
  viewerPlayerId: string;
  /** Set only by a refusal re-render (Task 9's write routes); a plain `GET` never sets it. */
  problem?: string;
  /**
   * `undefined` for anything but a `played` fixture (M25 review fix, I1) —
   * matching `OwnerFixtureParams.result`, whose own comment gives the reason:
   * an open, scheduled or cancelled fixture has nothing to have a result
   * about, and spec §15 excludes a cancelled one from results entirely. Before
   * this fix the panel rendered unconditionally and told a player looking at
   * next week's fixture "No result recorded yet" about a game that had not
   * happened.
   */
  result?: ResultPanelParams;
  /**
   * This page's own path, for the freshness bar's refresh link (M24). Task 8
   * supplies it once the route exists — this view has no opinion on its
   * shape.
   */
  fixturePath: string;
}

export function renderPlayerFixturePage(params: PlayerFixtureParams): string {
  const {
    gameName,
    venueName,
    venueAddress,
    kicksOffAtLocal,
    lifecycle,
    teams,
    squad,
    inCount,
    viewerPlayerId,
    result,
    fixturePath,
  } = params;

  const addressLine = venueAddress === null ? "" : `<p>${escapeHtml(venueAddress)}</p>`;
  const problem = params.problem === undefined ? "" : `<p class="problem">${escapeHtml(params.problem)}</p>`;

  const body = `
    <h1>${escapeHtml(gameName)}</h1>
    ${problem}
    <p>${escapeHtml(venueName)}</p>
    ${addressLine}
    <p class="kickoff">${escapeHtml(kicksOffAtLocal)}</p>
    <p class="status-badge status-${escapeHtml(lifecycle)}">${escapeHtml(fixtureStatusWords(lifecycle))}</p>

    ${renderPublishedTeamsSection(teams, squad, lifecycle === "played" ? "past" : "future")}

    <h2>Squad</h2>
    ${renderSquadSection(squad, inCount, viewerPlayerId)}

    ${result === undefined ? "" : renderResultPanel(result)}

    ${renderFreshness(fixturePath)}
  `;

  return layout({
    nav: params.nav,
    title: `${gameName} — Make The Team`,
    body,
    pageStyles: [FIXTURE_STYLES_CSS, SQUAD_STYLES_CSS, FORM_CSS, RESULT_CSS, FRESHNESS_CSS],
    pageScripts: [FRESHNESS_JS],
  });
}
