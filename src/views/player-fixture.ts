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
   * in the `past` tense: a played fixture is what this page is for, and
   * "hasn't been picked yet" is never a true sentence about one.
   */
  teams: PublishedTeams | null;
  squad: readonly SquadMember[] | null;
  inCount: number;
  viewerPlayerId: string;
  result: ResultPanelParams;
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

  const body = `
    <h1>${escapeHtml(gameName)}</h1>
    <p>${escapeHtml(venueName)}</p>
    ${addressLine}
    <p class="kickoff">${escapeHtml(kicksOffAtLocal)}</p>
    <p class="status-badge status-${escapeHtml(lifecycle)}">${escapeHtml(fixtureStatusWords(lifecycle))}</p>

    ${renderPublishedTeamsSection(teams, squad, "past")}

    <h2>Squad</h2>
    ${renderSquadSection(squad, inCount, viewerPlayerId)}

    ${renderResultPanel(result)}

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
