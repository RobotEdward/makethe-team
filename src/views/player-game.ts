import { fixtureAnswerPath, fixturePath, gamePastFixturesPath, gamePath } from "../auth/paths.js";
import type { SquadMember } from "../db/queries.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import type { FixtureView } from "../domain/fixture-view.js";
import type { Lifecycle } from "../domain/lifecycle.js";
import type { ResponseStatus } from "../domain/response-status.js";
import type { PublishedTeams } from "../domain/teams.js";
import {
  answerStateOf,
  fixtureStatusWords,
  renderFullWarning,
  renderPublishedTeamsSection,
  renderResponseButtons,
  renderSquadSection,
  renderStatusLine,
  viewerHeadlineOpen,
} from "./fixture.js";
import type { LeagueRow } from "../domain/league-table.js";
import { renderFreshness } from "./freshness.js";
import { renderStandingsSection } from "./league-table.js";
import { renderMuteControls, type MuteControlsOptions } from "./mute-controls.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { FRESHNESS_JS } from "./scripts.js";
import {
  FIXTURE_STYLES_CSS,
  FORM_CSS,
  FRESHNESS_CSS,
  INVITE_CSS,
  LEAGUE_CSS,
  MUTE_CSS,
  RESULT_CSS,
  SQUAD_STYLES_CSS,
  TEAM_PICKER_CSS,
} from "./styles.js";

export interface PlayerGameParams {
  /**
   * The squad's league table, or `null` when this game hides its squad from
   * players (M49) — `standingsForViewer` decides, never this page.
   */
  standings: readonly LeagueRow[] | null;
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
  /**
   * The player's auto-decline switch for this squad (M28). Rendered under the
   * fixture rather than beside the header: it is a thing to reach for after
   * reading "can I make this one?", not a page-level setting.
   */
  mute: MuteControlsOptions;
  /** Only so the freshness bar can link back at this page (M24). */
  gameId: string;
  /** Formatted for the game's zone when archived (M41); null for a live game. */
  archivedOn: string | null;
  gameName: string;
  venueName: string;
  venueAddress: string | null;
  timezone: string;
  /** The open fixture, or null when none is open. */
  openFixture: {
    /** For the answer form's action (M52) — see `fixtureAnswerPath`. */
    fixtureId: string;
    /**
     * The viewer's own answer, so this page can offer and show it (M52).
     * Passed in rather than read out of `squad`, which is `null` whenever the
     * organiser hides the list — the viewer's own answer is theirs to see on
     * every game, hidden squad or not.
     */
    myStatus: ResponseStatus;
    kicksOffAtLocal: string;
    view: FixtureView;
    inCount: number;
    /**
     * Passed in rather than counted from `squad`: `squad` is `null` whenever
     * the organiser has squad visibility off, and the headcount line shows
     * either way — deriving it here would drop the waiting count on exactly
     * the games that hide the list.
     */
    waitlistCount: number;
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
  /**
   * `lifecycle` is the stored enum, not a display string — the page maps it
   * through `fixtureStatusWords`, the same table the organiser's page reads.
   * Typed as `Lifecycle` rather than the `string` it used to be so a caller
   * cannot hand this page a value the mapping has no words for; the narrowing
   * costs no route change, because `listUpcomingFixtures` already returns
   * `Lifecycle` and both pages are fed from it.
   *
   * The type is not what keeps this page up, though — see `fixtureStatusWords`
   * for why the column can hold a value outside the union whatever this says.
   */
  upcoming: readonly { kicksOffAt: Date; lifecycle: Lifecycle }[];
  /**
   * The game's most recently played fixture and its result, or `null` when
   * there is nothing to show — no fixture has been played yet, or one has
   * but nobody has filed a claim on it (M25 Task 13, BR-37). A link, never a
   * form: see `lastResultFor` in `src/routes/games.ts` for why this page
   * carries no result panel.
   */
  lastResult: { fixtureId: string; words: string } | null;
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
/**
 * The answer block, identical in parts to the dashboard card's (M52).
 *
 * Until M52 this page showed an open fixture and offered no way to answer it,
 * while being the target of the largest link on every dashboard card. The
 * headline, the buttons and the full warning are all imported from
 * `./fixture.js` rather than restated, so a waitlisted player cannot read as
 * confirmed here and not there (BR-5) — the same reason the dashboard imports
 * them.
 *
 * `false` for read-only, matching the dashboard card: this page renders an
 * open fixture or nothing, so there is no read-only reason to carry.
 */
function renderAnswerBlock(
  gameId: string,
  openFixture: NonNullable<PlayerGameParams["openFixture"]>,
): string {
  const headline = viewerHeadlineOpen({ status: openFixture.myStatus, waitlistRank: null });
  const headlineClass = `viewer-headline${openFixture.myStatus === "waitlisted" ? " warn" : ""}`;

  return `
    <section class="answer answer-${answerStateOf(openFixture.myStatus, false)}">
      ${headline ? `<p class="${headlineClass}">${escapeHtml(headline)}</p>` : ""}
      ${renderResponseButtons(fixtureAnswerPath(gameId, openFixture.fixtureId), openFixture.myStatus)}
      ${renderFullWarning(openFixture.view, { status: openFixture.myStatus }, openFixture.waitlistCount)}
    </section>`;
}

export function renderPlayerGamePage(params: PlayerGameParams): string {
  const { gameId, gameName, venueName, venueAddress, timezone, openFixture, upcoming, viewerPlayerId } = params;

  const addressLine = venueAddress === null ? "" : `<p>${escapeHtml(venueAddress)}</p>`;

  const fixtureSection =
    openFixture === null
      ? `<p>Nothing open yet — you'll get an email the day before the next game.</p>`
      : `
        <p class="kickoff">${escapeHtml(openFixture.kicksOffAtLocal)}</p>
        ${renderStatusLine(openFixture.view, openFixture.waitlistCount)}
        ${renderAnswerBlock(gameId, openFixture)}
        ${renderPublishedTeamsSection(openFixture.teams, openFixture.squad)}
        <h2>Squad</h2>
        ${renderSquadSection(openFixture.squad, openFixture.inCount, viewerPlayerId)}
      `;

  // `ul.fixtures`, never `ul.squad` (spec §4 P1), matching the sibling page
  // `src/views/game-overview.ts`. This is a list of fixtures, not of people:
  // sharing the squad class means the next rule written for a squad row
  // silently restyles the fixture list too, which is exactly what had
  // happened — these rows were wearing the organiser's person-row layout.
  // The rules are already in `INVITE_CSS`, added to `pageStyles` below.
  //
  // The state in words, never the stored lifecycle: this row used to print
  // "open" or "scheduled" — a database value — at a player, which is the same
  // defect the organiser's page had. `fixtureStatusWords` rather than a second
  // table here, so the two pages cannot come to call one fixture two things.
  const upcomingItems = upcoming
    .map(
      (fixture) =>
        `<li>${escapeHtml(formatLocalDateTime(fixture.kicksOffAt, timezone))} — ${escapeHtml(fixtureStatusWords(fixture.lifecycle))}</li>`,
    )
    .join("");

  // A link, never a form (see `PlayerGameParams.lastResult`'s own comment):
  // this page carries no result panel, only a way to the fixture that does.
  const lastResultLine =
    params.lastResult === null
      ? ""
      : `<p class="result-final"><a href="${escapeHtml(fixturePath(gameId, params.lastResult.fixtureId))}">${escapeHtml(params.lastResult.words)}</a></p>`;

  const body = `
    <h1>${escapeHtml(gameName)}</h1>
    <p>${escapeHtml(venueName)}</p>
    ${addressLine}
    ${params.archivedOn === null ? "" : `<div class="nudge archived-banner"><p>This game was archived on ${escapeHtml(params.archivedOn)}. No more fixtures will be scheduled; what's here is its history.</p></div>`}
    ${lastResultLine}

    ${params.archivedOn === null ? fixtureSection : ""}

    ${params.archivedOn === null ? renderMuteControls(params.mute) : ""}

    <h2>Coming up</h2>
    <ul class="fixtures">${upcomingItems || "<li>No fixtures scheduled.</li>"}</ul>

    ${renderStandingsSection(params.standings, viewerPlayerId)}

    <p><a href="${escapeHtml(gamePastFixturesPath(gameId))}">Games you've played</a></p>

    ${renderFreshness(gamePath(gameId))}

  `;

  return layout({
    nav: params.nav,
    title: `${gameName} — Make The Team`,
    body,
    // `FIXTURE_STYLES_CSS` because this page renders `renderStatusLine` —
    // without it the status badge and the capacity bar are markup with no
    // rules behind them, and a bar whose track has no height is invisible
    // rather than broken, so nothing here fails loudly.
    //
    // `TEAM_PICKER_CSS` for the published line-ups — see the same import on
    // the `/r/:token` page for why the owner's block is the right one to
    // reuse rather than a second block styling identical markup.
    //
    // `INVITE_CSS` for `ul.fixtures` and nothing else: its other selectors
    // (`.card`, `.qr-toggle`) are the organiser's invite panel, which this
    // page never renders, so adding it changes nothing already on the page.
    //
    // `SQUAD_STYLES_CSS` before `FORM_CSS`, the order every other page in the
    // app now uses. It is inert here — this page's squad is a `div.squad` of
    // chips, never a `ul.squad`, so the row rule the two blocks fight over
    // matches nothing, and the `.squad` container properties they share carry
    // identical values. Pinned so the page is not the one place a reader
    // finds the rule written backwards.
    // `RESULT_CSS` for `.result-final` alone (M25 Task 13) — an all-new
    // selector (see that block's own comment in `src/views/styles.ts`), so
    // nothing already on this page changes appearance by adding it.
    pageStyles: [
      SQUAD_STYLES_CSS,
      FORM_CSS,
      INVITE_CSS,
      FIXTURE_STYLES_CSS,
      TEAM_PICKER_CSS,
      RESULT_CSS,
      FRESHNESS_CSS,
      // All-new selectors (see the block's own comment), so its position at
      // the end of this list changes nothing already on the page.
      MUTE_CSS,
      // Likewise: every selector namespaced under `.league` (M49).
      LEAGUE_CSS,
    ],
    pageScripts: [FRESHNESS_JS],
  });
}
