import {
  gameEditPath,
  gameMessagePath,
  joinPath,
  memberDetailPath,
  memberRemovePath,
  memberRolePath,
  ownerFixturePath,
} from "../auth/paths.js";
import { oddMaxWarning } from "../domain/game-form.js";
import type { Lifecycle } from "../domain/lifecycle.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { SITE_ORIGIN } from "../notify/delivery.js";
import { fixtureStatusWords } from "./fixture.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { qrSvg } from "./qr.js";
import { COPY_BUTTON_JS } from "./scripts.js";
import { FIXTURE_STYLES_CSS, FORM_CSS, INVITE_CSS, SQUAD_STYLES_CSS } from "./styles.js";

export interface GameOverviewParams {
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
  gameId: string;
  gameName: string;
  venueName: string;
  /** Optional on the game row, so optional here — omitted rather than blank. */
  venueAddress: string | null;
  timezone: string;
  maxPlayers: number;
  prefersEvenNumbers: boolean;
  inviteToken: string;
  squad: ReadonlyArray<{ playerId: string; name: string; role: "player" | "owner"; isGuest: boolean }>;
  /**
   * `lifecycle` is the stored enum, not a display string — the page maps it
   * through `fixtureStatusWords`. Typed as `Lifecycle` rather than `string`
   * so a caller cannot hand this page a value the mapping has no words for
   * and have it print the raw token at whoever is reading.
   */
  upcoming: ReadonlyArray<{ id: string; kicksOffAt: Date; lifecycle: Lifecycle; inCount: number }>;
  /** The id of the player viewing this page, so their row can be marked as "(you)". */
  viewerPlayerId: string;
  /** A refusal to explain on this page, e.g. J6a's last-organiser guard. Escaped and shown near the top. */
  problem?: string;
  /** The broadcast receipt (M20 B4), from `broadcastNoticeFrom` — never caller-chosen text. */
  broadcastNotice?: string;
}

/**
 * The owner's home for one game: how to share it, who is in the squad, and
 * what is coming up.
 *
 * The squad list shows full names — this page is behind an owner entitlement
 * check, and an owner already knows who is in their own squad. BR-26's
 * redaction applies to the *public* invite page (`src/views/join.ts`), which
 * strangers can reach.
 */
export function renderGameOverviewPage(params: GameOverviewParams): string {
  const { gameId, gameName, venueName, venueAddress, timezone, inviteToken, squad, upcoming, viewerPlayerId } = params;
  const inviteUrl = `${SITE_ORIGIN}${joinPath(inviteToken)}`;

  // BR-29's nudge, re-derived from the *saved* row rather than threaded through
  // the 303 from create/edit. It is advisory and it stays true until the
  // configuration changes, so it is shown for as long as it is true rather than
  // once, as a toast, at the moment of saving. `oddMaxWarning` is shared with
  // `parseGameForm` so this page and the form cannot word it differently.
  const oddMax =
    params.prefersEvenNumbers && params.maxPlayers % 2 === 1
      ? `<p class="nudge">${escapeHtml(oddMaxWarning(params.maxPlayers))}</p>`
      : "";

  const addressLine = venueAddress === null ? "" : `<p>${escapeHtml(venueAddress)}</p>`;

  const problem = params.problem === undefined ? "" : `<p class="problem">${escapeHtml(params.problem)}</p>`;

  // One row per member, each carrying its two controls behind a
  // `<details>` disclosure (M10 §3.8): most of a fourteen-person squad is
  // read, not managed, and both controls together on every row outweighed
  // the squad itself. `<details>`/`<summary>` is a native element, so the
  // controls need no script to reach — the remove link still goes to a
  // confirmation page rather than posting straight away, because removal is
  // destructive and must be confirmable with JavaScript off.
  const squadItems = squad
    .map((member) => {
      const name = escapeHtml(member.name);
      const you = member.playerId === viewerPlayerId ? " (you)" : "";
      const guest = member.isGuest ? " (guest)" : "";
      const organiser = member.role === "owner" ? " — organiser" : "";
      const isOwner = member.role === "owner";
      const nextRole = isOwner ? "player" : "owner";
      const roleLabel = isOwner ? "Make an ordinary member" : "Make an organiser";
      return `<li>
        <span class="member">${name}${organiser}${guest}${you}</span>
        <details class="member-actions">
          <summary>Manage</summary>
          <p><a href="${escapeHtml(memberDetailPath(gameId, member.playerId))}">View details</a></p>
          <form method="post" action="${escapeHtml(memberRolePath(gameId, member.playerId))}">
            <input type="hidden" name="role" value="${nextRole}">
            <button class="button" type="submit">${roleLabel}</button>
          </form>
          <a class="danger-link" href="${escapeHtml(memberRemovePath(gameId, member.playerId))}">Remove</a>
        </details>
      </li>`;
    })
    .join("");

  // One row per fixture. The state is `fixtureStatusWords`, never the stored
  // lifecycle value itself: this page is reachable by an organiser who is also
  // just a player, and "open" is an internal token, not something to tell them.
  // The words come from the same table the single-fixture page reads, so the
  // two pages cannot end up naming a fixture's state differently.
  const fixtureItems = upcoming
    .map(
      (fixture) =>
        `<li>
        <a href="${escapeHtml(ownerFixturePath(gameId, fixture.id))}">${escapeHtml(formatLocalDateTime(fixture.kicksOffAt, timezone))}</a>
        <span class="detail">${escapeHtml(fixtureStatusWords(fixture.lifecycle))} — ${fixture.inCount} in</span>
      </li>`,
    )
    .join("");

  const body = `
    <h1>${escapeHtml(gameName)}</h1>
    ${problem}
    ${params.broadcastNotice === undefined ? "" : `<p class="nudge ok">${escapeHtml(params.broadcastNotice)}</p>`}
    <p>${escapeHtml(venueName)}</p>
    ${addressLine}
    ${oddMax}
    <p><a href="${escapeHtml(gameEditPath(gameId))}">Edit this game</a></p>

    <h2>Coming up</h2>
    <ul class="fixtures">${fixtureItems || "<li>No fixtures scheduled.</li>"}</ul>

    <h2>Squad (${squad.length})</h2>
    <ul class="squad">${squadItems || "<li>Nobody has joined yet.</li>"}</ul>

    <div class="card">
      <h2>Invite people</h2>
      <p>Share this link in your group chat, or let people scan the code.</p>
      <div class="invite-link">
        <input id="invite-url" type="text" readonly value="${escapeHtml(inviteUrl)}">
        <button class="button" type="button" id="invite-copy" data-copy="invite-url" hidden>Copy</button>
      </div>
      <details class="qr-toggle">
        <summary>Show the QR code</summary>
        <div class="qr">${qrSvg(inviteUrl)}</div>
      </details>
      <form class="actions" method="post" action="${escapeHtml(`/g/${gameId}/invite/rotate`)}">
        <button class="button" type="submit">Replace this link</button>
      </form>
    </div>

    <!-- Outside the invite card, and outside the rotate form: messaging the
         squad has nothing to do with replacing the invite link, and nesting it
         in that form read as one of its controls. -->
    <p class="actions"><a class="button" href="${escapeHtml(gameMessagePath(gameId))}">Message everyone</a></p>

  `;

  return layout({
    nav: params.nav,
    title: `${gameName} — Make The Team`,
    body,
    // The order here is load-bearing, not alphabetical. SQUAD_STYLES_CSS and
    // FORM_CSS both write `ul.squad > li` at identical specificity, so
    // whichever is passed last wins: SQUAD_STYLES_CSS lays a squad row out as
    // flex with align-items: baseline, FORM_CSS as a grid. The grid is
    // deliberate — flex wrapping made a row's shape depend on how long the
    // member's name happened to be, so two rows of identical markup laid out
    // differently (M10 whole-branch review). Passing SQUAD_STYLES_CSS *after*
    // FORM_CSS silently reinstates that, and no string assertion can see it.
    // It goes first so FORM_CSS's grid wins and the only thing that lands is
    // the container rule FORM_CSS lacks: the list's top border, which is what
    // was making the squad read as the unstyled list next to .fixtures.
    //
    // FIXTURE_STYLES_CSS is here for .back-link alone. Everything else it
    // carries is selected by a class this page never renders, so nothing
    // already on the page changes appearance by adding it.
    pageStyles: [SQUAD_STYLES_CSS, FORM_CSS, INVITE_CSS, FIXTURE_STYLES_CSS],
    pageScripts: [COPY_BUTTON_JS],
  });
}
