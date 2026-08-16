import type { ResponseIntent } from "../capacity/types.js";
import type { SquadMember } from "../db/queries.js";
import { displayName } from "../domain/display-name.js";
import type { ResponseStatus } from "../domain/response-status.js";
import type { FixtureView } from "../domain/fixture-view.js";
import type { PublishedTeams } from "../domain/teams.js";
import { escapeHtml, layout } from "./layout.js";
import { ordinal } from "./squad-row.js";
import { renderTeamSides } from "./team-picker.js";
import { FIXTURE_STYLES_CSS, SQUAD_STYLES_CSS, TEAM_PICKER_CSS } from "./styles.js";

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
  /**
   * How many are on the waitlist right now, so the page can say what place a
   * yes would take (M10 §3.4). Beside `inCount` and for the same reason: a
   * count the page must be able to state whether or not the squad's names are
   * visible to this viewer (BR-33).
   *
   * Required. An optional field here would let a new caller drop the warning
   * from a full fixture with nothing failing — which is the exact misreading
   * ("0 spots left" as "you can't come") this exists to prevent.
   */
  waitlistCount: number;
  /** The player this page is being rendered for, identified by their token. */
  viewer: { playerId: string; status: ResponseStatus; waitlistRank?: number | null };
  /** Echoed into the form action so the POST carries the same token. */
  token: string;
  /**
   * From `?intent=`. No longer affects rendering. It was the button's only
   * source of emphasis until `renderResponseButtons` took that job over from
   * `viewer.status` instead (M10 §3.1) — `intent` exists on exactly one
   * render, the one right after a submit, so a player opening their link days
   * later saw two identical buttons. Left on this type because the route
   * still parses it from the querystring and other tests reference it.
   */
  intent: ResponseIntent | null;
  /**
   * From `publishedTeamsFor` — `null` whenever this fixture's teams have not
   * been published, which is the whole of the "a saved pick is invisible"
   * rule as far as this page is concerned (BR-35). Required, and `null` is the
   * way to say "nothing to show": every caller of this page has a fixture in
   * hand and so can answer the question, and an optional field would let a new
   * one silently omit a published pick from a player's page.
   */
  teams: PublishedTeams | null;
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

/** The four groups a player-facing squad is read in, in this order. */
const SQUAD_GROUPS: readonly { status: ResponseStatus; label: string }[] = [
  { status: "in", label: "In" },
  { status: "waitlisted", label: "Waiting" },
  { status: "out", label: "Out" },
  { status: "pending", label: "No reply" },
];

/**
 * The squad, grouped by answer, as chips (M10 §3.5).
 *
 * Fourteen identical rows made "are my mates in?" a question you had to read
 * every line to answer, and left the waitlist order implied only by position.
 * Grouping answers the first; the rank inside a waiting chip answers the
 * second out loud.
 *
 * A group with nobody in it renders nothing at all — a heading over an empty
 * list reads as a broken page rather than an honest empty state, which is the
 * same rule `renderOwnedGamesSection` follows on the dashboard.
 *
 * BR-27's attribution moves to a sentence beneath its group rather than onto
 * the chip, which could not carry it without becoming a row again. It is kept
 * because no email tells a player that somebody answered for them, so this is
 * the only place they can ever find out.
 *
 * `viewerPlayerId` is nullable so a future caller with no viewer identity to
 * hand has nothing to fabricate — every current caller has one, but the type
 * does not assume that stays true. When it matches a member, that member's
 * chip gets `chip-you` (M10 §3.5: "the viewer's own chip filled in the
 * group's colour so they can see themselves counted") — a colour cue, not a
 * text change: the chip keeps the player's real name (`displayName`, never
 * "You") because `squadRow`/`squadChip` locators in the browser suite find
 * the viewer's own chip by that name on their own response page.
 */
function renderSquadList(squad: readonly SquadMember[], viewerPlayerId: string | null): string {
  if (squad.length === 0) return `<p class="muted">No players yet.</p>`;

  const groups = SQUAD_GROUPS.map(({ status, label }) => {
    const members = squad.filter((member) => member.status === status);
    if (members.length === 0) return "";

    const chips = members
      .map((member) => {
        // `displayName`, never `member.name` (BR-34) — an erased player stays
        // in a played fixture's squad, which is what keeps its numbers honest.
        const name = displayName(member.name, member.erasedAt);
        const guest = member.isGuest ? " (guest)" : "";
        const rank = status === "waitlisted" && member.waitlistRank !== null ? ` · ${ordinal(member.waitlistRank)}` : "";
        const isYou = viewerPlayerId !== null && member.playerId === viewerPlayerId;
        return `<li class="chip chip-${status}${isYou ? " chip-you" : ""}">${escapeHtml(`${name}${guest}${rank}`)}</li>`;
      })
      .join("");

    return `<div class="squad-group">
        <p class="group-head"><span class="group-label">${label}</span> <span class="group-count">${members.length}</span></p>
        <ul class="chips">${chips}</ul>
        ${renderGroupAttribution(members)}
      </div>`;
  }).join("");

  return `<div class="squad">${groups}</div>`;
}

/**
 * BR-27's attribution for a whole group, in one sentence.
 *
 * `attribution` in `src/views/squad-row.ts` renders it per row and is still
 * what the organiser's page uses. This says the same thing about a set, so a
 * group of chips can carry it without every chip growing a second line.
 *
 * A group can contain members set by different organisers, and mixed
 * statuses cannot occur inside one group (the group *is* a status), so
 * `verb` is safe to take from the first member.
 */
function renderGroupAttribution(members: readonly SquadMember[]): string {
  const set = members.filter((member) => member.source === "owner" && member.setBy !== null);
  if (set.length === 0) return "";

  const verb = set[0]!.status === "out" ? "marked out" : "marked in";
  // §4: never `setBy.name` directly — an organiser who has since erased
  // themselves leaves this line behind on every response they set.
  const by = [...new Set(set.map((member) => displayName(member.setBy!.name, member.setBy!.erasedAt)))];
  const names = set.map((member) => displayName(member.name, member.erasedAt));
  return `<p class="set-by">${escapeHtml(`${listSentence(names)} ${names.length === 1 ? "was" : "were"} ${verb} by ${listSentence(by)}.`)}</p>`;
}

/** "a", "a and b", "a, b and c" — the Oxford comma deliberately omitted. */
function listSentence(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
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
 *
 * `viewerPlayerId` is threaded straight through to `renderSquadList` to
 * highlight the viewer's own chip; nullable for the same reason it is there —
 * a future caller with no viewer to hand passes `null` rather than a made-up
 * id.
 */
export function renderSquadSection(
  squad: readonly SquadMember[] | null,
  inCount: number,
  viewerPlayerId: string | null,
): string {
  if (squad === null) {
    return `<p class="muted">Who's playing isn't shown for this game. ${inCount} in so far.</p>`;
  }
  return renderSquadList(squad, viewerPlayerId);
}

/**
 * The published teams, as a player sees them (BR-35 §5).
 *
 * Nothing at all unless `teams` is non-null — `publishedTeamsFor`
 * (`src/domain/teams.ts`) has already applied the only gate there is,
 * `teams_published_at`, and no page re-decides it. A saved-but-unpublished
 * pick is invisible here for the same reason it sends no email: an organiser
 * must be able to try an arrangement without announcing one.
 *
 * The two halves, in the order the N-9 email states them:
 *
 *  1. **Your own side, first and plainly** — the same "You're on X." sentence
 *     the email leads with, deliberately worded identically, because a player
 *     holding the email and looking at this page must not have to work out
 *     whether the two agree.
 *  2. **The line-ups, if this game shows players to each other.** `squad` is
 *     whatever `squadForViewer` handed the page — the same list the squad
 *     section above renders, so there is no second visibility rule here and
 *     nothing this section can leak that the section above would not. `null`
 *     means hidden, and hidden renders *nothing*, never an empty line-up,
 *     which would read as "nobody else is playing".
 *
 * Only players who are both `in` and placed are listed: a dropout keeps their
 * `team` on purpose (see `src/domain/teams.ts`), and naming them under a side
 * would claim they are playing.
 *
 * A viewer who is `in` with no side yet — promoted off the waitlist after the
 * announcement — gets a sentence of their own instead. Without it they read a
 * Teams heading and both line-ups with nothing anywhere about themselves,
 * which is the one thing Definition of Done #5 says must not happen.
 *
 * Returns "" when there is neither an own side nor a visible line-up — a
 * pending player in a game that hides its squad, and equally a published pick
 * whose squad has since emptied. A bare "Teams" heading over nothing (or over
 * "Nobody." twice) tells them a pick exists without telling them anything
 * about it, which is worse than silence. `renderTeamsReadOnly` drops out on
 * the same emptiness for the same reason.
 */
export function renderPublishedTeamsSection(
  teams: PublishedTeams | null,
  squad: readonly SquadMember[] | null,
): string {
  if (teams === null) return "";

  const yourSide =
    teams.yourSide !== null
      ? `<p class="your-side">You're on ${escapeHtml(teams.names[teams.yourSide])}.</p>`
      : teams.awaitingSide
        ? `<p class="your-side">Your side hasn't been picked yet.</p>`
        : "";
  const placed = squad === null ? [] : squad.filter((member) => member.status === "in" && member.team !== null);
  const sides = placed.length === 0 ? "" : renderTeamSides(teams.names, placed);

  if (yourSide === "" && sides === "") return "";
  return `<h2>Teams</h2>${yourSide}${sides}`;
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

/**
 * The two response buttons, with the viewer's current answer shown in the
 * control itself rather than only in a sentence above it (M10 §3.1).
 *
 * Driven by `status` — what the server recorded — and never by `?intent=`,
 * which is what the player *tapped* and exists on exactly one render. Those
 * two differ in the case that matters: a player who taps "I'm in" on a full
 * fixture is recorded `waitlisted`, and echoing their intent would show them a
 * solid green confirmation of a place they do not have (BR-5). The waitlisted
 * state gets its own amber treatment and its own label, so it is a positive
 * signal rather than the absence of one.
 *
 * Shared with the dashboard's cards, which post the same two intents to a
 * different action with a hidden fixture id. One renderer, because two copies
 * of "what does 'in' look like" is how the two pages start disagreeing.
 */
export function renderResponseButtons(action: string, status: ResponseStatus, hidden = ""): string {
  const inClass = status === "in" ? "button chosen-in" : status === "waitlisted" ? "button chosen-waiting" : "button";
  const outClass = status === "out" ? "button chosen-out" : "button";
  const inLabel = status === "waitlisted" ? "I'm in · waiting" : "I'm in";
  // A tick only on the settled answer. A waitlisted player has not got what
  // they asked for, so nothing here may read as a confirmation.
  const tick = status === "in" ? `<span aria-hidden="true">✓</span> ` : "";

  return `
    <form method="post" action="${escapeHtml(action)}" class="responses">${hidden}
      <button type="submit" class="${inClass}" name="intent" value="in" aria-pressed="${status === "in" || status === "waitlisted"}">${tick}${escapeHtml(inLabel)}</button>
      <button type="submit" class="${outClass}" name="intent" value="out" aria-pressed="${status === "out"}">Can't make it</button>
    </form>`;
}

function renderButtons(options: FixturePageOptions): string {
  return renderResponseButtons(`/r/${encodeURIComponent(options.token)}`, options.viewer.status);
}

/**
 * What answering yes would actually do, on a fixture with no room left.
 *
 * Shown where the tap happens rather than as a status line above it, and only
 * to a viewer who could still take that place: `pending`, or `out` and
 * entitled to change their mind. Someone already `in` is not going to join a
 * waitlist, and someone already `waitlisted` has a headline saying precisely
 * where they are — offering to put them on it would read as though they were
 * not on it.
 */
function renderFullWarning(view: FixtureView, viewer: FixturePageOptions["viewer"], waitlistCount: number): string {
  if (view.spotsLeft > 0) return "";
  if (viewer.status !== "pending" && viewer.status !== "out") return "";
  return `<p class="full-warning">The squad is full — answering yes puts you ${ordinal(waitlistCount + 1)} on the waitlist.</p>`;
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
 * response actions are ordinary form submits; the button that carries the
 * viewer's answer is decided by `viewer.status`, not by `?intent=` — see
 * `renderResponseButtons`.
 */
export function renderFixturePage(options: FixturePageOptions): string {
  const { gameName, venueName, kicksOffAtLocal, view, squad, inCount, viewer, readOnlyReason } = options;
  const teams = options.teams ?? null;

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
    ${readOnlyReason ? renderReadOnlyNotice(readOnlyReason) : renderButtons(options) + renderFullWarning(view, viewer, options.waitlistCount)}
    ${renderPublishedTeamsSection(teams, squad)}
    <h2>Squad</h2>
    ${renderSquadSection(squad, inCount, viewer.playerId)}
  `;

  return layout({
    title: `${gameName} — Make The Team`,
    body,
    // `TEAM_PICKER_CSS` is the owner picker's block, reused here because the
    // line-ups a player reads are rendered by the same `renderTeamSides` the
    // owner's read-only view uses — a second block styling the same markup is
    // how the two pages start looking like different products. Included
    // unconditionally: a stylesheet that appeared and disappeared with the
    // fixture's publish state is a harder thing to reason about than a few
    // unused rules.
    pageStyles: [FIXTURE_STYLES_CSS, SQUAD_STYLES_CSS, TEAM_PICKER_CSS],
  });
}
