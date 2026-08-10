import type { ResponseIntent } from "../capacity/types.js";
import type { SquadMember } from "../db/queries.js";
import type { ResponseStatus } from "../domain/response-status.js";
import type { FixtureView } from "../domain/fixture-view.js";
import { escapeHtml, layout } from "./layout.js";

export interface FixturePageOptions {
  gameName: string;
  venueName: string;
  /** Already formatted for display in the game's timezone by the caller. */
  kicksOffAtLocal: string;
  view: FixtureView;
  squad: readonly SquadMember[];
  /** The player this page is being rendered for, identified by their token. */
  viewer: { playerId: string; status: ResponseStatus; waitlistRank?: number | null };
  /** Echoed into the form action so the POST carries the same token. */
  token: string;
  /** From `?intent=`. Emphasises one button with CSS. Never records anything. */
  intent: ResponseIntent | null;
  /** Set when the fixture is played or cancelled: render read-only, no buttons. */
  readOnlyReason?: "played" | "cancelled";
}

const STATUS_LABEL: Record<FixtureView["status"], string> = {
  scheduled: "Not open yet",
  open: "Open for responses",
  short: "Needs more players",
  confirmed: "Confirmed — the game is on",
  cancelled: "Cancelled",
  played: "Played",
};

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function viewerHeadline(viewer: FixturePageOptions["viewer"]): string {
  switch (viewer.status) {
    case "in":
      return "You're in.";
    case "waitlisted": {
      const rank = viewer.waitlistRank ?? null;
      return rank === null
        ? "You're on the waitlist."
        : `You're on the waitlist — ${ordinal(rank)} in line.`;
    }
    case "out":
      return "You said you can't make it.";
    case "pending":
      return "Can you make it?";
    case "withdrawn":
      // Not expected to reach the page for a withdrawn viewer, but a plain
      // fallback is safer than throwing on a display path.
      return "You're no longer in this squad.";
  }
}

function squadStatusLabel(member: SquadMember): string {
  switch (member.status) {
    case "in":
      return "In";
    case "waitlisted":
      return member.waitlistRank === null ? "Waitlisted" : `Waitlisted (${ordinal(member.waitlistRank)})`;
    case "pending":
      return "Not yet responded";
    case "out":
      return "Can't make it";
    case "withdrawn":
      return "Withdrawn";
  }
}

function renderSquadList(squad: readonly SquadMember[]): string {
  if (squad.length === 0) return `<p class="muted">No players yet.</p>`;

  const items = squad
    .map(
      (member) =>
        `<li><span class="name">${escapeHtml(member.name)}</span><span class="status status-${member.status}">${escapeHtml(squadStatusLabel(member))}</span></li>`,
    )
    .join("");

  return `<ul class="squad">${items}</ul>`;
}

function renderNudge(view: FixtureView): string {
  if (!view.flags.includes("uneven")) return "";
  return `<p class="nudge">The squad has an odd number of players in — one more would even it up.</p>`;
}

function renderStatusLine(view: FixtureView): string {
  const label = STATUS_LABEL[view.status];
  const spots =
    view.status === "cancelled" || view.status === "played"
      ? ""
      : `<p class="spots">${view.spotsLeft} ${view.spotsLeft === 1 ? "spot" : "spots"} left</p>`;
  return `<p class="status-badge status-${view.status}">${escapeHtml(label)}</p>${spots}`;
}

function renderButtons(options: FixturePageOptions): string {
  const { token, intent } = options;
  const action = `/r/${encodeURIComponent(token)}`;
  const inClass = intent === "in" ? "button primary" : "button";
  const outClass = intent === "out" ? "button primary" : "button";

  return `
    <form method="post" action="${escapeHtml(action)}" class="responses">
      <button type="submit" class="${inClass}" name="intent" value="in">I'm in</button>
      <button type="submit" class="${outClass}" name="intent" value="out">Can't make it</button>
    </form>`;
}

function renderReadOnlyNotice(reason: "played" | "cancelled"): string {
  const message =
    reason === "played"
      ? "This game has already been played. Responses are closed."
      : "This fixture was cancelled. Responses are closed.";
  return `<p class="read-only">${escapeHtml(message)}</p>`;
}

/**
 * Render the page a player sees when they tap their response link.
 *
 * Server-rendered only — no `<script>`, no auto-submit (TR-4, TR-15). Both
 * response actions are ordinary form submits; `intent` only changes which
 * button carries the `primary` CSS class, never what gets recorded.
 */
export function renderFixturePage(options: FixturePageOptions): string {
  const { gameName, venueName, kicksOffAtLocal, view, squad, viewer, readOnlyReason } = options;

  const body = `
    <h1>${escapeHtml(gameName)}</h1>
    <p class="venue">${escapeHtml(venueName)}</p>
    <p class="kickoff">${escapeHtml(kicksOffAtLocal)}</p>
    ${renderStatusLine(view)}
    ${renderNudge(view)}
    <p class="viewer-headline">${escapeHtml(viewerHeadline(viewer))}</p>
    ${readOnlyReason ? renderReadOnlyNotice(readOnlyReason) : renderButtons(options)}
    <h2>Squad</h2>
    ${renderSquadList(squad)}
  `;

  return layout({ title: `${gameName} — Make The Team`, body });
}
