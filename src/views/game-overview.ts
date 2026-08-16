import { gameEditPath, joinPath, memberRemovePath, memberRolePath, ownerFixturePath } from "../auth/paths.js";
import { oddMaxWarning } from "../domain/game-form.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { SITE_ORIGIN } from "../notify/delivery.js";
import { escapeHtml, layout } from "./layout.js";
import { qrSvg } from "./qr.js";
import { COPY_INVITE_JS } from "./scripts.js";
import { FORM_CSS } from "./styles.js";

export interface GameOverviewParams {
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
  upcoming: ReadonlyArray<{ id: string; kicksOffAt: Date; lifecycle: string; inCount: number }>;
  /** The id of the player viewing this page, so their row can be marked as "(you)". */
  viewerPlayerId: string;
  /** A refusal to explain on this page, e.g. J6a's last-organiser guard. Escaped and shown near the top. */
  problem?: string;
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
          <form method="post" action="${escapeHtml(memberRolePath(gameId, member.playerId))}">
            <input type="hidden" name="role" value="${nextRole}">
            <button class="button" type="submit">${roleLabel}</button>
          </form>
          <a href="${escapeHtml(memberRemovePath(gameId, member.playerId))}">Remove</a>
        </details>
      </li>`;
    })
    .join("");

  const fixtureItems = upcoming
    .map(
      (fixture) =>
        `<li><a href="${escapeHtml(ownerFixturePath(gameId, fixture.id))}">${escapeHtml(formatLocalDateTime(fixture.kicksOffAt, timezone))}</a> — ${escapeHtml(fixture.lifecycle)}, ${fixture.inCount} in</li>`,
    )
    .join("");

  const body = `
    <h1>${escapeHtml(gameName)}</h1>
    ${problem}
    <p>${escapeHtml(venueName)}</p>
    ${addressLine}
    ${oddMax}
    <p><a href="${escapeHtml(gameEditPath(gameId))}">Edit this game</a></p>

    <h2>Invite people</h2>
    <p>Share this link in your group chat, or let people scan the code.</p>
    <div class="invite-link">
      <input id="invite-url" type="text" readonly value="${escapeHtml(inviteUrl)}">
      <button class="button" type="button" id="invite-copy" hidden>Copy</button>
    </div>
    <div class="qr">${qrSvg(inviteUrl)}</div>
    <form method="post" action="${escapeHtml(`/g/${gameId}/invite/rotate`)}">
      <button class="button" type="submit">Replace this link</button>
    </form>

    <h2>Squad (${squad.length})</h2>
    <ul class="squad">${squadItems || "<li>Nobody has joined yet.</li>"}</ul>

    <h2>Coming up</h2>
    <ul class="squad">${fixtureItems || "<li>No fixtures scheduled.</li>"}</ul>
  `;

  return layout({
    title: `${gameName} — Make The Team`,
    body,
    pageStyles: [FORM_CSS],
    pageScripts: [COPY_INVITE_JS],
  });
}
