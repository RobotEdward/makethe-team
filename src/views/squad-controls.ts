import {
  addGuestPath,
  inviteMemberPath,
  ownerGuestPath,
  ownerGuestRemovePath,
  ownerResponsePath,
} from "../auth/paths.js";
import type { SquadMember } from "../db/queries.js";
import { displayName } from "../domain/display-name.js";
import { RESPONSE_STATUSES } from "../domain/response-status.js";
import { escapeHtml } from "./layout.js";
import { attribution, squadStatusLabel } from "./squad-row.js";

/**
 * The squad list with its per-row controls, the over-capacity confirmation
 * and the guest link — the roster controls, shared between the organiser's
 * fixture page (`src/views/owner-fixture.ts`) and the standalone picker page
 * (`src/views/picker-page.ts`) since M66 let a delegate keep the roster
 * straight on the fixture they are picking.
 *
 * Extracted rather than copied for the reason `src/views/squad-row.ts` gives
 * for the words: two copies of the segment drifted once already at the level
 * of a waitlist rank, and a control that posts to a route the other page's
 * copy does not would be a worse drift than wording. Each page still owns its
 * page — what surrounds the roster, and *whether* the controls show — and
 * calls here only for the rows.
 *
 * Nothing here decides entitlement. The routes these forms post to re-ask it
 * (`loadRosterTarget` in `src/routes/games.ts`), so a control rendered for the
 * wrong person is a dead button, never a capability.
 */

/**
 * One squad row's controls: remove, for a guest; a segmented mark-in/mark-out
 * for a member.
 *
 * The segment displays the member's current answer as well as setting it
 * (M10 §3.3), which is what lets the status text come off the row — fourteen
 * members previously meant twenty-eight full-width buttons, and at 390px the
 * labels wrapped. Two submits in one form, exactly as before: nothing here
 * needs JavaScript.
 *
 * `aria-pressed` carries the same fact the fill does, so the state is not
 * stated in colour alone.
 */
export function renderMemberControls(
  gameId: string,
  fixtureId: string,
  member: SquadMember,
  canInvite: boolean,
): string {
  // Every branch returns its controls inside one `.row-controls` element, a
  // guest's single Remove form included. The row's grid pins each *direct
  // child* form to one cell, so two forms there overlap and the first is
  // invisible (see FORM_CSS); wrapping only the two-control case would leave
  // the rule that prevents it depending on how many controls a row happens to
  // have, which is how it would come back.
  if (member.isGuest) {
    return `<span class="row-controls"><form method="post" action="${escapeHtml(ownerGuestRemovePath(gameId, fixtureId, member.playerId))}"><button class="button" type="submit">Remove</button></form></span>`;
  }
  // A waitlisted member is neither in nor out, and the first half of the
  // segment says so rather than offering a pressed "In" (M46). It used to:
  // the reading was "the organiser marked them in and capacity queued them",
  // which is true of how the row got there and useless as a control — the
  // owner's actual question is "can I move this person up?", and a button
  // already showing as pressed answers "you have". Neither half is pressed
  // here, because neither is the state they are in; `renderStatusSpan` keeps
  // the rank beside the name, which is the fact the label cannot carry.
  const waiting = member.status === "waitlisted";
  const isIn = member.status === "in";
  const isOut = member.status === "out";
  // Only on a row the invite order has not reached (M46). Rendered before the
  // segment rather than inside it: the segment's two halves are one question
  // with two answers, and a third button that does something else entirely
  // would read as a third answer to it.
  const invite = canInvite
    ? `<form method="post" action="${escapeHtml(inviteMemberPath(gameId, fixtureId, member.playerId))}"><button class="button" type="submit">Invite now</button></form>`
    : "";
  return `<span class="row-controls">${invite}<form method="post" action="${escapeHtml(ownerResponsePath(gameId, fixtureId, member.playerId))}" class="segment">
             <button class="seg${isIn ? " on" : ""}" type="submit" name="intent" value="in" aria-pressed="${isIn}">${waiting ? "Promote" : "In"}</button>
             <button class="seg${isOut ? " out" : ""}" type="submit" name="intent" value="out" aria-pressed="${isOut}">Out</button>
           </form></span>`;
}

/**
 * The status span beside a member's name — or nothing, when the segment
 * (`renderMemberControls`) already states the same fact (M10 §3.3: "this
 * makes the control display it instead of repeating it beside the control").
 *
 * Three deliberate exceptions keep the span alive rather than dropping it for
 * everyone:
 *  - `waitlisted`: since M46 the segment's first half reads "Promote" and
 *    neither half is pressed, so the segment now states what the owner can
 *    *do* and nothing at all about where in the queue this player is. Only
 *    this label carries the rank. Not an oversight — leave it.
 *  - a guest: `renderMemberControls` gives a guest a Remove button, never a
 *    segment, so nothing else on the row ever states a guest's status.
 *  - a closed fixture (`!showControls`): no control of any kind renders —
 *    segment or Remove — so this is the only place left that states anyone's
 *    status, guest or member, at any status.
 */
export function renderStatusSpan(member: SquadMember, showControls: boolean): string {
  // A fourth case, and the one that is not a design decision: a status this
  // build has never heard of. The segment cannot be "already saying it",
  // because it renders neither half pressed — exactly what it renders for
  // `pending` — so dropping the span would quietly read as "hasn't answered
  // yet" about a row nothing is known about. `RESPONSE_STATUSES` is the
  // canonical list, and `responses.status` has no CHECK constraint behind it.
  const knownToTheSegment = (RESPONSE_STATUSES as readonly string[]).includes(member.status);
  const segmentAlreadySaysIt =
    showControls && !member.isGuest && knownToTheSegment && member.status !== "waitlisted";
  if (segmentAlreadySaysIt) return "";
  // The stored value reaches a class attribute, so it is escaped like every
  // other interpolation (Constraint 6) — the same hole closed in
  // `renderStatusLine`. For a status this build knows the output is unchanged;
  // for one it does not, the value is a database string and not markup.
  return `<span class="status status-${escapeHtml(member.status)}">${escapeHtml(squadStatusLabel(member))}</span>`;
}

export function renderSquadList(
  gameId: string,
  fixtureId: string,
  squad: readonly SquadMember[],
  showControls: boolean,
  /**
   * Whether this Game runs an invite order (BR-39). Without it every row on an
   * ungated fixture would sprout an "invite now" button — the whole squad is
   * unstamped there, because nothing ever stamps them.
   */
  gatedInvites: boolean,
): string {
  if (squad.length === 0) return `<p class="muted">No players yet.</p>`;

  const items = squad
    .map((member) => {
      const guest = member.isGuest ? " (guest)" : "";
      // The squad and everyone's state still render on a fixture that has
      // closed — only the controls go, because there is nothing left to change.
      const canInvite = gatedInvites && !member.isGuest && member.invitedAt === null;
      const controls = showControls ? renderMemberControls(gameId, fixtureId, member, canInvite) : "";
      const status = renderStatusSpan(member, showControls);
      // `displayName`, never `member.name` — see `src/views/fixture.ts` and §4.
      return `<li><span class="name">${escapeHtml(displayName(member.name, member.erasedAt))}${guest}</span>${status}${attribution(member)}${controls}</li>`;
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
export interface ConfirmBannerParams {
  gameId: string;
  fixtureId: string;
  gameName: string;
  inCount: number;
  maxPlayers: number;
  /** `playerId === null` is the guest case: the banner reposts the name it is holding. */
  confirm: { playerId: string | null; name: string; intent: "in" };
  /**
   * Where "No, leave it" goes: the page the person came from. The organiser's
   * fixture page for the organiser, the picker page for a delegate (M66) — a
   * delegate sent to the fixture page is dispatched by role to the player's
   * view of it, which is a strange place to land after deciding not to do
   * something.
   */
  leaveHref: string;
}

export function renderConfirm(params: ConfirmBannerParams): string {
  const { gameId, fixtureId, confirm, gameName, inCount, maxPlayers } = params;

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
           <p><a href="${escapeHtml(params.leaveHref)}">No, leave it</a></p>
         </div>`;
}

/**
 * The M64 note above the squad: the fixture is over, but the record is not
 * yet final. Says when it will be, so nobody discovers the deadline by
 * hitting it. `deadlineLocal` is null once the deadline has passed with
 * nothing filed, when the first claim is what will lock the record.
 */
export function renderCorrectionNote(correction: { deadlineLocal: string | null } | undefined): string {
  if (correction === undefined) return "";
  const until =
    correction.deadlineLocal === null ? "until someone records a result" : `until ${correction.deadlineLocal}`;
  return `<p class="nudge">This game has been played. You can still correct who played and which side they were on ${escapeHtml(until)}.</p>`;
}

/**
 * The link to the add-a-guest page (§5, moved off the fixture page in M52).
 * The caller decides whether the fixture is taking roster changes at all —
 * once it is cancelled, played past its window, or merely scheduled there is
 * no capacity write for the page to make.
 *
 * A link rather than the form it used to be. The form sat at the foot of the
 * longest page in the product — 3954px at 390px once the M52 capture finally
 * showed a busy fixture — so every organiser who never adds a guest scrolled
 * past it to reach the footer actions, and the one who does add a guest was
 * hunting for it at the bottom, usually pitchside. It sits beside the squad
 * now, which is what it is about.
 */
export function renderGuestLink(gameId: string, fixtureId: string): string {
  return `<p class="actions"><a class="button" href="${escapeHtml(addGuestPath(gameId, fixtureId))}">Add a guest</a></p>`;
}
