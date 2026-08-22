import { fixturePath } from "../auth/paths.js";
import { takingChanges, type FixtureView } from "../domain/fixture-view.js";
import type { PickerMode } from "../domain/picker.js";
import type { TeamId } from "../domain/teams.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { renderStatusLine } from "./fixture.js";
import { renderTeamPicker, renderTeamsReadOnly, type TeamPickerParams } from "./team-picker.js";
import { TEAM_PICKER_JS, type PageScriptBlock } from "./scripts.js";
import { FIXTURE_STYLES_CSS, FORM_CSS, TEAM_PICKER_CSS } from "./styles.js";

/**
 * The team picker on a page of its own (M29), for somebody who is picking the
 * teams but does not run the game.
 *
 * **Not the organiser's fixture page with the controls removed.** That page
 * carries the squad list with a mark-in/mark-out segment on every row, the
 * guest form, the WhatsApp cards, the broadcast link and the result panel —
 * every one of them an act only an owner may perform. Rendering it for a
 * delegate and hiding the parts they may not use would make the page's markup
 * the entitlement boundary, and the first control anybody forgot to hide
 * would be a capability leak with a test suite that still passed. This page
 * renders the picker and the fixture's own facts, and there is nothing on it
 * to hide.
 *
 * It reuses `TEAM_PICKER_CSS`, `FIXTURE_STYLES_CSS` and `FORM_CSS` rather than
 * declaring a style block of its own, so there is nothing new to register in
 * `PAGE_STYLE_BLOCKS` (`src/security/csp.ts`) and no way for this page's CSS
 * to be silently dropped by the hash-only `style-src`.
 */
export interface PickerPageParams {
  nav: PageNav;
  gameId: string;
  fixtureId: string;
  gameName: string;
  venueName: string;
  kicksOffAtLocal: string;
  view: FixtureView;
  waitlistCount: number;
  teamNames: Record<TeamId, string>;
  /** Only `in` players, exactly as the organiser's picker shows them. */
  members: TeamPickerParams["members"];
  counts: { a: number; b: number };
  uneven: boolean;
  published: boolean;
  needsAnotherLook: boolean;
  announcementOutstanding: boolean;
  teamsEmailEnabled: boolean;
  canPublish: boolean;
  /** Which mode put this viewer here, which is what the opening line explains. */
  mode: PickerMode;
  unassignedProblem?: readonly string[];
  problem?: string;
}

/**
 * Why this page is in front of this person.
 *
 * Worth a sentence rather than a heading alone: a squad member who follows a
 * link from an email into a screen full of radio buttons has no other way to
 * know whether the job is theirs specifically or going spare, and the two
 * carry different obligations — a delegate who ignores it leaves the fixture
 * unpicked, whereas somebody in an open game can reasonably assume a
 * teammate will get to it.
 */
function renderWhy(mode: PickerMode): string {
  if (mode === "delegate") {
    return `<p class="team-note">The organiser has asked you to pick the teams for this fixture.</p>`;
  }
  if (mode === "open") {
    return `<p class="team-note">The organiser has left the teams for anyone in the squad to pick, so this one is going spare.</p>`;
  }
  // `organiser` reaching this page is the owner following the picker's own
  // URL rather than the copy on their fixture page. They know why they are
  // here; the sentence would be telling them what they just did.
  return "";
}

export function renderPickerPage(params: PickerPageParams): string {
  const {
    gameId,
    fixtureId,
    gameName,
    venueName,
    kicksOffAtLocal,
    view,
    waitlistCount,
    teamNames,
    members,
  } = params;

  // The same gate the organiser's page uses, and it is reachable here for the
  // same reason it is reachable there: a fixture can close between the page
  // being rendered and being read. The pick is still worth showing — this is
  // where a picker was sent to look at it.
  const teams = takingChanges(view)
    ? renderTeamPicker({
        gameId,
        fixtureId,
        names: teamNames,
        members,
        counts: params.counts,
        uneven: params.uneven,
        unassignedProblem: params.unassignedProblem,
        published: params.published,
        needsAnotherLook: params.needsAnotherLook,
        announcementOutstanding: params.announcementOutstanding,
        teamsEmailEnabled: params.teamsEmailEnabled,
        canPublish: params.canPublish,
      })
    : renderTeamsReadOnly({
        names: teamNames,
        members: members.filter((member) => member.team !== null),
      });

  const pageScripts: PageScriptBlock[] = [];
  if (takingChanges(view)) pageScripts.push(TEAM_PICKER_JS);

  const body = `
    <h1>${escapeHtml(gameName)}</h1>
    ${params.problem === undefined ? "" : `<p class="problem">${escapeHtml(params.problem)}</p>`}
    ${renderWhy(params.mode)}
    <p class="kickoff">${escapeHtml(kicksOffAtLocal)}</p>
    <p class="venue">${escapeHtml(venueName)}</p>
    ${renderStatusLine(view, waitlistCount)}

    ${teams}

    <p class="back-link"><a href="${escapeHtml(fixturePath(gameId, fixtureId))}">Back to the fixture</a></p>
  `;

  return layout({
    nav: params.nav,
    title: `Pick the teams — ${gameName} — Make The Team`,
    body,
    // FORM_CSS before TEAM_PICKER_CSS, matching the order
    // `src/views/owner-fixture.ts` gives the same pair and the order
    // `PAGE_STYLE_BLOCKS` holds them in: the picker's rules are written
    // expecting the form rules to be underneath them.
    pageStyles: [FIXTURE_STYLES_CSS, FORM_CSS, TEAM_PICKER_CSS],
    pageScripts,
  });
}
