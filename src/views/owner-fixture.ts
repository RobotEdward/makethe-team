import { gamePath } from "../auth/paths.js";
import type { SquadMember } from "../db/queries.js";
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

function renderSquadList(squad: readonly SquadMember[]): string {
  if (squad.length === 0) return `<p class="muted">No players yet.</p>`;

  const items = squad
    .map((member) => {
      const guest = member.isGuest ? " (guest)" : "";
      return `<li><span class="name">${escapeHtml(member.name)}${guest}</span><span class="status status-${member.status}">${escapeHtml(squadStatusLabel(member))}</span>${attribution(member)}</li>`;
    })
    .join("");

  return `<ul class="squad">${items}</ul>`;
}

/**
 * One fixture, as its organiser sees it (J6b §3): the squad, everyone's
 * current state, and (from Task 5 onward) the controls to change it.
 *
 * Read-only for now — no `<script>`, no controls yet. Reuses
 * `renderStatusLine` from `src/views/fixture.ts` rather than restating its
 * wording, so the status badge reads identically on the player's page and the
 * organiser's.
 */
export function renderOwnerFixturePage(params: OwnerFixtureParams): string {
  const { gameId, gameName, kicksOffAtLocal, venueName, inCount, maxPlayers, view, squad } = params;

  const problem = params.problem === undefined ? "" : `<p class="problem">${escapeHtml(params.problem)}</p>`;

  const body = `
    <h1>${escapeHtml(gameName)}</h1>
    ${problem}
    <p class="kickoff">${escapeHtml(kicksOffAtLocal)}</p>
    <p class="venue">${escapeHtml(venueName)}</p>
    ${renderStatusLine(view)}
    ${renderOverCapacity(view, inCount, maxPlayers)}

    <h2>Squad</h2>
    ${renderSquadList(squad)}

    <p><a href="${escapeHtml(gamePath(gameId))}">Back to the game</a></p>
  `;

  return layout({
    title: `${gameName} — Make The Team`,
    body,
    pageStyles: [FORM_CSS, SQUAD_STYLES_CSS],
  });
}
