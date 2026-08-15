import { DASHBOARD_PATH } from "../auth/paths.js";
import type { SquadMember } from "../db/queries.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import type { FixtureView } from "../domain/fixture-view.js";
import type { PublishedTeams } from "../domain/teams.js";
import { renderPublishedTeamsSection, renderSquadSection, renderStatusLine } from "./fixture.js";
import { escapeHtml, layout } from "./layout.js";
import { FORM_CSS, SQUAD_STYLES_CSS, TEAM_PICKER_CSS } from "./styles.js";

export interface PlayerGameParams {
  gameName: string;
  venueName: string;
  venueAddress: string | null;
  timezone: string;
  /** The open fixture, or null when none is open. */
  openFixture: {
    kicksOffAtLocal: string;
    view: FixtureView;
    inCount: number;
    squad: readonly SquadMember[] | null;
    /**
     * From `publishedTeamsFor` — `null` until the organiser publishes, which
     * is what keeps a saved pick invisible here as well as on `/r/:token`
     * (BR-35). This page and that one are the two surfaces a player can reach,
     * and a pick that showed on one but not the other would be a feature
     * half the squad never sees.
     */
    teams: PublishedTeams | null;
  } | null;
  upcoming: readonly { kicksOffAt: Date; lifecycle: string }[];
  viewerPlayerId: string;
}

/**
 * A squad member's own view of a game (§4, §4.1, §4.2): the open fixture, if
 * there is one, and what's coming up. Deliberately its own module rather than
 * a shared template with the owner's page: the owner's page carries the
 * invite link and its QR code, and that link is a capability — anyone
 * holding it can add themselves, or someone else, to the squad. A shared
 * renderer with an `isOwner` conditional is how that capability ends up on
 * this page by accident; a separate renderer with no such parameter makes it
 * impossible to write that mistake at all.
 *
 * No invite link, no QR code, no controls, no edit link, no
 * squad-management anything. No `<script>` — every part of this page is
 * plain markup, so it works with JavaScript off.
 */
export function renderPlayerGamePage(params: PlayerGameParams): string {
  const { gameName, venueName, venueAddress, timezone, openFixture, upcoming } = params;

  const addressLine = venueAddress === null ? "" : `<p>${escapeHtml(venueAddress)}</p>`;

  const fixtureSection =
    openFixture === null
      ? `<p>Nothing open yet — you'll get an email the day before the next game.</p>`
      : `
        <p class="kickoff">${escapeHtml(openFixture.kicksOffAtLocal)}</p>
        ${renderStatusLine(openFixture.view)}
        ${renderSquadSection(openFixture.squad, openFixture.inCount)}
        ${renderPublishedTeamsSection(openFixture.teams, openFixture.squad)}
      `;

  const upcomingItems = upcoming
    .map(
      (fixture) =>
        `<li>${escapeHtml(formatLocalDateTime(fixture.kicksOffAt, timezone))} — ${escapeHtml(fixture.lifecycle)}</li>`,
    )
    .join("");

  const body = `
    <h1>${escapeHtml(gameName)}</h1>
    <p>${escapeHtml(venueName)}</p>
    ${addressLine}

    ${fixtureSection}

    <h2>Coming up</h2>
    <ul class="squad">${upcomingItems || "<li>No fixtures scheduled.</li>"}</ul>

    <p><a href="${DASHBOARD_PATH}">Back to your games</a></p>
  `;

  return layout({
    title: `${gameName} — Make The Team`,
    body,
    // `TEAM_PICKER_CSS` for the published line-ups — see the same import on
    // the `/r/:token` page for why the owner's block is the right one to
    // reuse rather than a second block styling identical markup.
    pageStyles: [FORM_CSS, SQUAD_STYLES_CSS, TEAM_PICKER_CSS],
  });
}
