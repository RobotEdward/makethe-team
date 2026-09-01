import type { SquadMember } from "../db/queries.js";
import type { Lifecycle } from "../domain/lifecycle.js";
import type { PublishedTeams } from "../domain/teams.js";
import { fixtureStatusWords, renderPublishedTeamsSection, renderSquadSection } from "./fixture.js";
import { renderFreshness } from "./freshness.js";
import { renderMuteControls, type MuteControlsOptions } from "./mute-controls.js";
import { renderResultPanel, type ResultPanelParams } from "./result.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { FRESHNESS_JS } from "./scripts.js";
import { FIXTURE_STYLES_CSS, FORM_CSS, FRESHNESS_CSS, MUTE_CSS, RESULT_CSS, SQUAD_STYLES_CSS } from "./styles.js";

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
/**
 * The way in to the picker, for a member who may use it (M29).
 *
 * Worded by mode, because the two carry different obligations: a delegate who
 * ignores the link leaves the fixture unpicked, while a member in an open
 * game can reasonably expect a teammate to get to it. One sentence and one
 * link either way — this is not the page the job gets done on.
 *
 * A plain `<p>` and not `.team-note`: that class is declared in
 * `TEAM_PICKER_CSS`, which this page does not load, and pulling the whole
 * block in for one rule would also bring its `.teams` selectors onto a page
 * that already renders a published-teams list — exactly the kind of
 * equal-specificity collision `test/views/style-cascade.test.ts` exists to
 * catch. An unstyled class is invisible in every string assertion, so the
 * safe shape is to not use one.
 */
function renderPickerLink(params: PlayerFixtureParams): string {
  const picker = params.picker;
  if (picker === undefined) return "";
  const words =
    picker.mode === "delegate"
      ? "The organiser has asked you to pick the teams for this one."
      : "The teams are open for anyone in the squad to pick.";
  return `<p>${escapeHtml(words)}</p>
          <p><a class="button" href="${escapeHtml(picker.path)}">Pick the teams</a></p>`;
}

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
   * Set when this viewer may pick this fixture's teams (M29), carrying the
   * mode that lets them — `undefined` for everyone else, which is almost
   * everyone almost always.
   *
   * A link rather than the picker itself. The picker is a long form of radio
   * groups and belongs on a page whose whole subject is the pick; putting it
   * inline here would bury a player's own "am I playing?" question under
   * somebody else's job.
   */
  picker?: { mode: "delegate" | "open"; path: string };
  /**
   * The player's auto-decline switch for this squad (M28), or `undefined` on
   * a render where it does not belong. It is a squad-level control shown on a
   * fixture page, so it sits at the foot, below the squad — a reader here came
   * for one fixture, and a settings panel above the line-ups would answer a
   * question they did not ask.
   */
  mute?: MuteControlsOptions;
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
  /**
   * True when this Game asks in priority order (M34) and this viewer's tier
   * has not been released yet.
   *
   * Sets copy and nothing else — no control is disabled anywhere on the
   * strength of it. They may still answer, and are still told they may:
   * BR-40a holds an uninvited "I'm in" on the waitlist, it does not refuse it.
   * What the flag changes is the promise made to them, which since M43 is a
   * place in the queue rather than a slot.
   */
  notYetInvited?: boolean;
  /**
   * True when this viewer has already said they are in and is waitlisted by
   * the invite order rather than by a full fixture (BR-40a).
   *
   * A flag from the route rather than something read off `squad`, which is
   * null on a Game whose roster is hidden — deriving it there would give the
   * wrong sentence on exactly the pages that show the reader least.
   */
  heldByInviteOrder?: boolean;
}

/**
 * "The core group is being asked first" (M34, BR-40a).
 *
 * Two sentences, because by M43 there are two states behind this flag and
 * telling a player who has already volunteered that they "haven't been asked"
 * reads as though their answer went nowhere.
 *
 * Only on a fixture still taking answers: on a played or cancelled one there
 * is no spot left to open up, and either sentence would be a promise about a
 * game that is over.
 */
function renderNotYetInvited(params: PlayerFixtureParams): string {
  if (params.notYetInvited !== true) return "";
  if (params.lifecycle !== "open" && params.lifecycle !== "scheduled") return "";

  if (params.heldByInviteOrder === true) {
    return `
      <p class="nudge">You're in as soon as the core group has been asked. They get first
      refusal — if a spot is still going when that's done, it's yours.</p>`;
  }
  return `
    <p class="nudge">You haven't been asked yet. The core group is being asked first —
    we'll let you know if a spot opens up.</p>`;
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

  // Before the teams and the squad (M27), not after them: on a played fixture
  // both of those are history, and the panel is either the thing the viewer
  // was just nudged here to fill in or the score they came to read. Below
  // them it sat under two full lists, a long scroll away on a phone. A
  // template comment would say this in the page itself, where it ships to the
  // browser as content and turns unrelated "this string is absent" tests red.
  const resultPanel = result === undefined ? "" : renderResultPanel(result);

  const body = `
    <h1>${escapeHtml(gameName)}</h1>
    ${problem}
    <p>${escapeHtml(venueName)}</p>
    ${addressLine}
    <p class="kickoff">${escapeHtml(kicksOffAtLocal)}</p>
    <p class="status-badge status-${escapeHtml(lifecycle)}">${escapeHtml(fixtureStatusWords(lifecycle))}</p>

    ${renderNotYetInvited(params)}

    ${resultPanel}

    ${renderPickerLink(params)}

    ${renderPublishedTeamsSection(teams, squad, lifecycle === "played" ? "past" : "future")}

    <h2>Squad</h2>
    ${renderSquadSection(squad, inCount, viewerPlayerId)}

    ${params.mute === undefined ? "" : renderMuteControls(params.mute)}

    ${renderFreshness(fixturePath)}
  `;

  return layout({
    nav: params.nav,
    title: `${gameName} — Make The Team`,
    body,
    // `MUTE_CSS` unconditionally, though the panel is not: a stylesheet that
    // appeared and disappeared with a page's state is harder to reason about
    // than a few unused rules, the same call `/r/:token` makes for its push
    // block. Its selectors are all new, so its position here changes nothing.
    pageStyles: [FIXTURE_STYLES_CSS, SQUAD_STYLES_CSS, FORM_CSS, RESULT_CSS, FRESHNESS_CSS, MUTE_CSS],
    pageScripts: [FRESHNESS_JS],
  });
}
