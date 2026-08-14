import type { ResponseIntent } from "../capacity/types.js";
import type { SquadMember } from "../db/queries.js";
import type { ResponseStatus } from "../domain/response-status.js";
import type { FixtureView } from "../domain/fixture-view.js";
import { escapeHtml, layout } from "./layout.js";
import { attribution, ordinal, squadStatusLabel } from "./squad-row.js";
import { FIXTURE_STYLES_CSS, SQUAD_STYLES_CSS } from "./styles.js";

/**
 * Why this page is read-only, if it is.
 *
 * `played`/`cancelled` describe the fixture: it is finished, for everyone.
 * `not-eligible` describes the viewer alone — a token that verifies
 * cryptographically fine, for a player who is no longer on the squad (most
 * likely removed after their link was sent). The fixture itself may still be
 * wide open; only this viewer's ability to act on it is closed. Keeping this
 * distinct from `played`/`cancelled` is what stops a removed player being
 * told a truthful "confirmed" status right above an unrelated "cancelled"
 * notice, and is why it needs its own headline/notice text below.
 *
 * `not-open` is a `scheduled` fixture: responses are not open yet (BR-1), so
 * there is nothing this viewer — or anyone — can do here regardless of
 * eligibility. In practice a token should only ever exist for a fixture that
 * has already opened, so this is expected to be unreachable; it exists so a
 * stray or hand-crafted request against a not-yet-open fixture still gets an
 * honest explanation instead of a silently-ignored tap.
 */
export type ReadOnlyReason = "played" | "cancelled" | "not-eligible" | "not-open";

export interface FixturePageOptions {
  gameName: string;
  venueName: string;
  /** Already formatted for display in the game's timezone by the caller. */
  kicksOffAtLocal: string;
  view: FixtureView;
  /** `null` when the organiser has kept the squad private from players (BR-33). */
  squad: readonly SquadMember[] | null;
  /**
   * How many are in, independent of whether `squad` names them. Needed
   * because when `squad` is `null` that count is no longer implied by a
   * list's length.
   */
  inCount: number;
  /** The player this page is being rendered for, identified by their token. */
  viewer: { playerId: string; status: ResponseStatus; waitlistRank?: number | null };
  /** Echoed into the form action so the POST carries the same token. */
  token: string;
  /** From `?intent=`. Emphasises one button with CSS. Never records anything. */
  intent: ResponseIntent | null;
  /** Set when there is nothing this viewer can do here: render read-only, no buttons. */
  readOnlyReason?: ReadOnlyReason;
}

const STATUS_LABEL: Record<FixtureView["status"], string> = {
  scheduled: "Not open yet",
  open: "Open for responses",
  short: "Needs more players",
  confirmed: "Confirmed — the game is on",
  cancelled: "Cancelled",
  played: "Played",
};

function viewerHeadline(
  viewer: FixturePageOptions["viewer"],
  readOnlyReason: ReadOnlyReason | undefined,
): string {
  if (readOnlyReason === "not-eligible" || readOnlyReason === "not-open") {
    // No headline about the viewer's own response status makes sense here —
    // for `not-eligible` they have none that means anything any more; for
    // `not-open` nobody has one yet. The read-only notice below already says
    // why. Never fall through to a question ("Can you make it?") or a
    // past-tense claim ("You were in") that isn't true of this viewer.
    return "";
  }
  return readOnlyReason ? viewerHeadlineClosed(viewer, readOnlyReason) : viewerHeadlineOpen(viewer);
}

/**
 * The headline while the fixture can still be responded to.
 *
 * Exported because the dashboard says the same sentences about the same
 * statuses (J7, BR-25) and a second set of wordings would be two places for
 * "You're in." and "You're on the waitlist." to drift apart — and BR-5's whole
 * point is that a waitlisted player must never read as confirmed. A caller
 * with no waitlist rank to hand (the dashboard: see `DashboardFixture` for why
 * it deliberately has none) passes `waitlistRank: null` and gets the
 * unnumbered wording.
 *
 * Takes only the two fields it reads, not the whole `FixturePageOptions`
 * `viewer` shape — so a caller with no `playerId` to hand (the dashboard,
 * which never has another player's id and has no reason to echo the
 * viewer's own) has nothing to fabricate a dummy value for.
 */
export function viewerHeadlineOpen(viewer: Pick<FixturePageOptions["viewer"], "status" | "waitlistRank">): string {
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

/**
 * The headline once the fixture is played or cancelled.
 *
 * Never a question — asking "Can you make it?" about a game that has already
 * happened or been called off is exactly the contradiction a confused,
 * never-responded player must not see. `pending` gets no headline at all: the
 * read-only notice already explains why responses are closed, and there is
 * nothing this player's own (non-)response adds. Every other status is put in
 * the past tense so it reads correctly next to that notice.
 */
function viewerHeadlineClosed(
  viewer: FixturePageOptions["viewer"],
  reason: "played" | "cancelled",
): string {
  const cancelledSuffix = reason === "cancelled" ? " before it was cancelled" : "";
  switch (viewer.status) {
    case "in":
      return `You were in${cancelledSuffix}.`;
    case "waitlisted":
      return `You were on the waitlist${cancelledSuffix}.`;
    case "out":
      return "You said you couldn't make it.";
    case "pending":
      return "";
    case "withdrawn":
      return "You're no longer in this squad.";
  }
}

function renderSquadList(squad: readonly SquadMember[]): string {
  if (squad.length === 0) return `<p class="muted">No players yet.</p>`;

  const items = squad
    .map(
      (member) =>
        `<li><span class="name">${escapeHtml(member.name)}${member.isGuest ? " (guest)" : ""}</span><span class="status status-${member.status}">${escapeHtml(squadStatusLabel(member))}</span>${attribution(member)}</li>`,
    )
    .join("");

  return `<ul class="squad">${items}</ul>`;
}

/**
 * The squad, or a count when the organiser has kept it private (BR-33).
 *
 * The count stays deliberately. "Are there enough players this week?" is the
 * question the whole product exists to answer, and hiding names is not a
 * reason to stop answering it.
 *
 * Exported so the dashboard (task 4) can render the same sentence for the
 * same setting rather than retyping it — two copies of this wording is how
 * they drift apart.
 */
export function renderSquadSection(squad: readonly SquadMember[] | null, inCount: number): string {
  if (squad === null) {
    return `<p class="muted">Who's playing isn't shown for this game. ${inCount} in so far.</p>`;
  }
  return renderSquadList(squad);
}

function renderNudge(view: FixtureView): string {
  if (!view.flags.includes("uneven")) return "";
  return `<p class="nudge">The squad has an odd number of players in — one more would even it up.</p>`;
}

/**
 * BR-8's required visibility, on the page a player actually reads. An owner
 * has deliberately gone past `max_players`, and a player looking at a squad
 * longer than the game's own limit deserves to be told why rather than left
 * to count.
 */
function renderOverCapacity(view: FixtureView): string {
  if (!view.flags.includes("over_capacity")) return "";
  return `<p class="nudge">There are more players in than there are places — the organiser has added someone over the limit.</p>`;
}

/**
 * The status badge and the spots-left line, from `fixtureView` alone.
 *
 * Exported for the dashboard, which shows the same derived status for each of
 * the viewer's fixtures — one renderer, so `short`/`confirmed`/`full` can only
 * ever be worded and coloured one way across the product (BR-12).
 */
export function renderStatusLine(view: FixtureView): string {
  const label = STATUS_LABEL[view.status];
  const spots =
    view.status === "cancelled" || view.status === "played"
      ? ""
      : `<p class="spots">${view.spotsLeft} ${view.spotsLeft === 1 ? "spot" : "spots"} left</p>`;
  return `<p class="status-badge status-${view.status}">${escapeHtml(label)}</p>${spots}`;
}

function renderButtons(options: FixturePageOptions): string {
  const { token, intent, viewer } = options;
  const action = `/r/${encodeURIComponent(token)}`;
  // The emphasised button must reflect what actually got recorded, not what
  // was tapped: after a full fixture waitlists the player, `intent` is still
  // "in" from the form submit, but echoing that onto the "I'm in" button
  // would show a solid, filled confirmation to someone who is, in fact, not
  // in (BR-5). Neither button is emphasised for a waitlisted viewer — the
  // warn-coloured headline above is what tells them what happened.
  const effectiveIntent = viewer.status === "waitlisted" ? null : intent;
  const inClass = effectiveIntent === "in" ? "button primary" : "button";
  const outClass = effectiveIntent === "out" ? "button primary" : "button";

  return `
    <form method="post" action="${escapeHtml(action)}" class="responses">
      <button type="submit" class="${inClass}" name="intent" value="in">I'm in</button>
      <button type="submit" class="${outClass}" name="intent" value="out">Can't make it</button>
    </form>`;
}

function renderReadOnlyNotice(reason: ReadOnlyReason): string {
  const message =
    reason === "played"
      ? "This game has already been played. Responses are closed."
      : reason === "cancelled"
        ? "This fixture was cancelled. Responses are closed."
        : reason === "not-open"
          ? "Responses for this fixture aren't open yet. Check back closer to kick-off."
          : "You're no longer on the squad for this game, so there's nothing to respond to here. If that doesn't sound right, check with whoever organises it.";
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
  const { gameName, venueName, kicksOffAtLocal, view, squad, inCount, viewer, readOnlyReason } = options;

  const headline = viewerHeadline(viewer, readOnlyReason);
  // A waitlisted viewer's headline gets the same warn treatment the roster
  // already uses for a waitlisted row, so it reads as unmistakably different
  // from the accent-coloured "confirmed" badge that may sit right below it
  // (BR-5) — and is placed above that badge, not below, so it is the first
  // thing read, not a correction to something read already.
  const headlineClass = `viewer-headline${viewer.status === "waitlisted" ? " warn" : ""}`;

  const body = `
    <h1>${escapeHtml(gameName)}</h1>
    <p class="venue">${escapeHtml(venueName)}</p>
    <p class="kickoff">${escapeHtml(kicksOffAtLocal)}</p>
    ${headline ? `<p class="${headlineClass}">${escapeHtml(headline)}</p>` : ""}
    ${renderStatusLine(view)}
    ${renderNudge(view)}
    ${renderOverCapacity(view)}
    ${readOnlyReason ? renderReadOnlyNotice(readOnlyReason) : renderButtons(options)}
    <h2>Squad</h2>
    ${renderSquadSection(squad, inCount)}
  `;

  return layout({
    title: `${gameName} — Make The Team`,
    body,
    pageStyles: [FIXTURE_STYLES_CSS, SQUAD_STYLES_CSS],
  });
}
