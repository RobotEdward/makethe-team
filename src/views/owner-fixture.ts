import { gamePath, ownerFixturePath, ownerGuestPath, ownerGuestRemovePath, ownerResponsePath } from "../auth/paths.js";
import type { SquadMember } from "../db/queries.js";
import { displayName } from "../domain/display-name.js";
import type { FixtureView } from "../domain/fixture-view.js";
import { escapeHtml, layout } from "./layout.js";
import { renderStatusLine } from "./fixture.js";
import { attribution, squadStatusLabel } from "./squad-row.js";
import { FORM_CSS, SQUAD_STYLES_CSS } from "./styles.js";

export interface OwnerFixtureParams {
  gameId: string;
  gameName: string;
  fixtureId: string;
  /** Already formatted for display in the game's timezone by the caller. */
  kicksOffAtLocal: string;
  venueName: string;
  inCount: number;
  maxPlayers: number;
  view: FixtureView;
  squad: readonly SquadMember[];
  /** The owner viewing this page, so their own row (if any) could be marked. */
  viewerPlayerId: string;
  /** Task 5's confirmation banner, after a mark-in that waitlisted or exceeded capacity. */
  confirm?: { playerId: string | null; name: string; intent: "in" };
  /** A refusal to explain near the top, e.g. Task 6's guard. Escaped and shown. */
  problem?: string;
}

/**
 * BR-8's required visibility, on the page the organiser reads: an owner has
 * deliberately gone past `max_players`, and the exact counts explain why the
 * squad below is longer than the game's own limit.
 */
function renderOverCapacity(view: FixtureView, inCount: number, maxPlayers: number): string {
  if (!view.flags.includes("over_capacity")) return "";
  return `<p class="problem">Over capacity — ${inCount} in, ${maxPlayers} places.</p>`;
}

/**
 * Whether this fixture is still taking changes — the one predicate the
 * per-row controls and the add-a-guest form both gate on, so they cannot
 * disagree about when an organiser can still act. A cancelled or played
 * fixture is history, and a merely scheduled one is not yet asking anybody
 * anything; in all three cases there is no capacity write for a control to
 * make, and the Durable Object would refuse it.
 */
function takingChanges(view: FixtureView): boolean {
  return view.status !== "cancelled" && view.status !== "played" && view.status !== "scheduled";
}

/** One squad row's controls: remove, for a guest; mark in or out, for a member. */
function renderMemberControls(gameId: string, fixtureId: string, member: SquadMember): string {
  if (member.isGuest) {
    return `<form method="post" action="${escapeHtml(ownerGuestRemovePath(gameId, fixtureId, member.playerId))}"><button class="button" type="submit">Remove</button></form>`;
  }
  return `<form method="post" action="${escapeHtml(ownerResponsePath(gameId, fixtureId, member.playerId))}">
             <button class="button" type="submit" name="intent" value="in">Mark in</button>
             <button class="button" type="submit" name="intent" value="out">Mark out</button>
           </form>`;
}

function renderSquadList(
  gameId: string,
  fixtureId: string,
  squad: readonly SquadMember[],
  showControls: boolean,
): string {
  if (squad.length === 0) return `<p class="muted">No players yet.</p>`;

  const items = squad
    .map((member) => {
      const guest = member.isGuest ? " (guest)" : "";
      // The squad and everyone's state still render on a fixture that has
      // closed — only the controls go, because there is nothing left to change.
      const controls = showControls ? renderMemberControls(gameId, fixtureId, member) : "";
      // `displayName`, never `member.name` — see `src/views/fixture.ts` and §4.
      return `<li><span class="name">${escapeHtml(displayName(member.name, member.erasedAt))}${guest}</span><span class="status status-${member.status}">${escapeHtml(squadStatusLabel(member))}</span>${attribution(member)}${controls}</li>`;
    })
    .join("");

  return `<ul class="squad">${items}</ul>`;
}

/**
 * BR-8's over-capacity confirmation (§4.2): a banner above the squad asking
 * the owner to confirm a mark-in that would take the fixture past
 * `max_players`, or (Task 6) adding a guest that would do the same.
 *
 * `confirm.playerId === null` is Task 6's guest case — wired here so the
 * banner is written once, even though the guest route itself is not built
 * yet.
 */
function renderConfirm(gameId: string, fixtureId: string, params: OwnerFixtureParams): string {
  if (params.confirm === undefined) return "";
  const { confirm, gameName, inCount, maxPlayers } = params;

  return `<div class="confirm">
           <p>${escapeHtml(`${gameName} is full (${inCount} of ${maxPlayers}). Add ${confirm.name} anyway?`)}</p>
           <form method="post" action="${escapeHtml(
             confirm.playerId === null
               ? ownerGuestPath(gameId, fixtureId)
               : ownerResponsePath(gameId, fixtureId, confirm.playerId),
           )}">
             <input type="hidden" name="intent" value="in">
             <input type="hidden" name="override" value="1">
             ${confirm.playerId === null ? `<input type="hidden" name="name" value="${escapeHtml(confirm.name)}">` : ""}
             <button class="button primary" type="submit">Add them anyway</button>
           </form>
           <p><a href="${escapeHtml(ownerFixturePath(gameId, fixtureId))}">No, leave it</a></p>
         </div>`;
}

/**
 * One fixture, as its organiser sees it (J6b §3): the squad, everyone's
 * current state, and the controls to change it (Task 5).
 *
 * Reuses `renderStatusLine` from `src/views/fixture.ts` rather than restating
 * its wording, so the status badge reads identically on the player's page and
 * the organiser's. No `<script>` anywhere — every control here is a plain
 * form, so the page works with JavaScript off.
 */
/**
 * The add-a-guest form (§5), shown only while the fixture is still open —
 * once it's cancelled, played, or merely scheduled (not yet accepting
 * answers), there is no capacity write for it to make.
 */
function renderGuestForm(gameId: string, fixtureId: string, params: OwnerFixtureParams): string {
  if (!takingChanges(params.view)) return "";
  return `<h2>Add a guest</h2>
          <p>Someone playing just this once. They won't be emailed — you'll need to tell them yourself.</p>
          <form method="post" action="${escapeHtml(ownerGuestPath(gameId, fixtureId))}" class="guest-form">
            <label for="guest-name">Their name</label>
            <input id="guest-name" name="name" type="text" maxlength="80" required>
            <button class="button" type="submit">Add guest</button>
          </form>`;
}

export function renderOwnerFixturePage(params: OwnerFixtureParams): string {
  const { gameId, fixtureId, gameName, kicksOffAtLocal, venueName, inCount, maxPlayers, view, squad } = params;

  const problem = params.problem === undefined ? "" : `<p class="problem">${escapeHtml(params.problem)}</p>`;

  const body = `
    <h1>${escapeHtml(gameName)}</h1>
    ${problem}
    <p class="kickoff">${escapeHtml(kicksOffAtLocal)}</p>
    <p class="venue">${escapeHtml(venueName)}</p>
    ${renderStatusLine(view)}
    ${renderOverCapacity(view, inCount, maxPlayers)}
    ${renderConfirm(gameId, fixtureId, params)}

    <h2>Squad</h2>
    ${renderSquadList(gameId, fixtureId, squad, takingChanges(view))}

    ${renderGuestForm(gameId, fixtureId, params)}

    <p><a href="${escapeHtml(gamePath(gameId))}">Back to the game</a></p>
  `;

  return layout({
    title: `${gameName} — Make The Team`,
    body,
    pageStyles: [FORM_CSS, SQUAD_STYLES_CSS],
  });
}
