import {
  fixtureMessagePath,
  pickerModePath,
  gamePath,
  joinPath,
  fixturePath,
  ownerGuestPath,
  ownerGuestRemovePath,
  ownerResponsePath,
  openFixturePath,
  inviteMemberPath,
  fixtureTimelinePath,
} from "../auth/paths.js";
import type { SquadMember } from "../db/queries.js";
import { RESPONSE_STATUSES } from "../domain/response-status.js";
import { displayName } from "../domain/display-name.js";
import { takingChanges, type FixtureView } from "../domain/fixture-view.js";
import { PICKER_MODES, type PickerMode } from "../domain/picker.js";
import { sideCounts, type TeamId } from "../domain/teams.js";
import { cancelledMessage, openMessageParts, teamsMessage } from "../domain/whatsapp-message.js";
import { SITE_ORIGIN } from "../notify/delivery.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { renderStatusLine } from "./fixture.js";
import { attribution, squadStatusLabel } from "./squad-row.js";
import { renderTeamPicker, renderTeamsReadOnly } from "./team-picker.js";
import { renderFreshness } from "./freshness.js";
import { renderInviteProgress, type InviteProgressParams } from "./invite-order.js";
import { renderResultPanel, type ResultPanelParams } from "./result.js";
import { COPY_BUTTON_JS, FRESHNESS_JS, TEAM_PICKER_JS, WHATSAPP_LINKS_JS, type PageScriptBlock } from "./scripts.js";
import {
  FIXTURE_STYLES_CSS,
  FORM_CSS,
  FRESHNESS_CSS,
  INVITE_ORDER_CSS,
  RESULT_CSS,
  SQUAD_STYLES_CSS,
  TEAM_PICKER_CSS,
  WHATSAPP_CSS,
} from "./styles.js";
import { renderWhatsAppCard, type WhatsAppMessage } from "./whatsapp.js";

export interface OwnerFixtureParams {
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
  /**
   * The invite-order panel (M34), or absent for an ungated Game.
   *
   * Absent rather than an empty panel: an ungated fixture has no invite order
   * to report on, and a panel there would advertise a feature the owner has
   * switched off.
   */
  inviteProgress?: InviteProgressParams;
  /**
   * Whether this Game runs an invite order (BR-39), for the "open it now"
   * copy (M46).
   *
   * Carried separately rather than read off `inviteProgress`, which is built
   * only for an *open* fixture: on the `scheduled` page the button lives on,
   * that panel is always absent, so deriving gating from it would show every
   * owner the ungated sentence.
   */
  gatedInvites: boolean;
  gameId: string;
  gameName: string;
  /**
   * The game's current `invite_token`, for the WhatsApp card's "someone new"
   * link (M38). Read from the game row the route already loaded, never
   * rebuilt — rotating the token has to change this link in the same breath.
   */
  inviteToken: string;
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
  /** From `teamNames(game)` — what this game calls each side (BR-35). */
  teamNames: Record<TeamId, string>;
  /**
   * The game's own parity preference, carried so the picker can say when the
   * two sides are uneven. Advisory only — BR-29 never refuses a pick over it.
   */
  prefersEvenNumbers: boolean;
  /** Task 5's confirmation banner, after a mark-in that waitlisted or exceeded capacity. */
  confirm?: { playerId: string | null; name: string; intent: "in" };
  /** A refused publish's list of names with no side yet, shown on the picker. */
  unassignedProblem?: readonly string[];
  /**
   * Whether an announcement has *ever* gone out for this fixture
   * (`teams_published_at` is set). Never cleared, so this stays true after a
   * later save — which is what keeps a re-picked fixture distinguishable from
   * one nobody has published.
   */
  teamsPublished: boolean;
  /**
   * From `teamsNeedAnotherLook` over the *unfiltered* assignment rows — which
   * is why it arrives as a boolean rather than being derived here from
   * `squad`: the page's squad excludes `withdrawn` rows, and a withdrawn
   * player still carrying a side is one of the two ways a published pick goes
   * stale (see `src/domain/teams.ts`).
   */
  teamsNeedAnotherLook: boolean;
  /**
   * From `announcementOutstanding` — the squad is holding an email that no
   * longer describes the pick, either because the pick was saved after it went
   * out or because the roster has moved since. Only ever true when
   * `teamsPublished` is.
   */
  announcementOutstanding: boolean;
  /** Whether publishing emails the squad for this game (N-9's switch, M26). */
  teamsEmailEnabled: boolean;
  /**
   * Who picks this fixture's teams, and who could (M29).
   *
   * Absent on a fixture that is no longer taking changes: there is nothing to
   * hand over on a game that has been played or called off, and the control
   * would be an act with no effect.
   */
  picker?: PickerControlParams;
  /** A refusal to explain near the top, e.g. Task 6's guard. Escaped and shown. */
  problem?: string;
  /** The broadcast receipt (M20 B4), from `broadcastNoticeFrom` — never caller-chosen text. */
  broadcastNotice?: string;
  /**
   * `fixtures.cancellation_reason`, for the WhatsApp cancellation message
   * (M22). Required rather than optional so a caller cannot forget it and
   * silently post "is cancelled." with the reason the organiser typed left
   * off; `null` is the honest "there wasn't one".
   */
  cancellationReason: string | null;
  /**
   * The result panel (M25 Task 6), shared verbatim with the player's own
   * fixture page (`src/views/player-fixture.ts`) — never forked or given an
   * owner-only variant. `undefined` on anything but a `played` fixture: an
   * open one has nothing to have a result about, and `src/routes/results.ts`
   * 404s a write to it, so a panel with live forms here would offer controls
   * the server refuses. The caller (`ownerFixtureParams` in
   * `src/routes/games.ts`) is what enforces the `played`-only rule; this view
   * only renders what it is given.
   */
  result?: ResultPanelParams;
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
function renderMemberControls(
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
function renderStatusSpan(member: SquadMember, showControls: boolean): string {
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

function renderSquadList(
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
           <p><a href="${escapeHtml(fixturePath(gameId, fixtureId))}">No, leave it</a></p>
         </div>`;
}

/**
 * One fixture, as its organiser sees it (J6b §3): the squad, everyone's
 * current state, and the controls to change it (Task 5).
 *
 * Reuses `renderStatusLine` from `src/views/fixture.ts` rather than restating
 * its wording, so the status badge reads identically on the player's page and
 * the organiser's. Every control here is a plain form, so the page works with
 * JavaScript off — including the team picker, whose one script
 * (`TEAM_PICKER_JS`, Task 7) only sets radios this page would have posted
 * anyway. Nothing an organiser must be able to do depends on it.
 */
/**
 * The add-a-guest form (§5), shown only while the fixture is still open —
 * once it's cancelled, played, or merely scheduled (not yet accepting
 * answers), there is no capacity write for it to make.
 */
/*
 * The name box is wrapped in `.field`, not left as a bare label and input:
 * this page loads `FORM_CSS` and `.guest-form` has no rules of its own, so
 * without the wrapper the only free-text box on the organiser's fixture page
 * rendered as the browser's default — a hairline box a third of the width of
 * every other input in the app, sitting on its own label's line. Found by
 * looking at the M12 capture; no string assertion can see an unstyled input.
 */
function renderGuestForm(gameId: string, fixtureId: string, params: OwnerFixtureParams): string {
  if (!takingChanges(params.view)) return "";
  return `<h2>Add a guest</h2>
          <p>Someone playing just this once. They won't be emailed — you'll need to tell them yourself.</p>
          <form method="post" action="${escapeHtml(ownerGuestPath(gameId, fixtureId))}" class="guest-form">
            <div class="field">
              <label for="guest-name">Their name</label>
              <input id="guest-name" name="name" type="text" maxlength="80" required>
            </div>
            <button class="button" type="submit">Add guest</button>
          </form>`;
}

/**
 * What the "who picks the teams?" control needs to know (M29).
 *
 * `candidates` is the squad the organiser may hand the job to: active
 * members, guests excluded. A guest has no way to sign in — they were added
 * by name from this very page — so offering one would produce a delegation
 * whose holder can never reach the picker, and an N-13 with nowhere to send.
 */
export interface PickerControlParams {
  mode: PickerMode;
  /** The current delegate, or null. Null in `organiser` and `open` mode. */
  delegatePlayerId: string | null;
  /** Already formatted date-only, or undefined when nobody holds the job. */
  handedOverOnLocal?: string;
  candidates: readonly { playerId: string; name: string }[];
}

/**
 * The organiser's hand-over control: themselves, one named player, or the
 * squad at large.
 *
 * Three radios and a select rather than one select with the members inlined
 * among the modes. The modes and the people are different kinds of thing —
 * "anyone in the squad" is not a person — and a single list mixing them makes
 * the delegate case indistinguishable from the other two at a glance, which
 * is the case an organiser most needs to read back correctly before they walk
 * away from it.
 *
 * The select is not `disabled` when another radio is chosen: disabling it
 * needs script, this page must work without any (see this file's own comment
 * on the picker), and a submitted `delegate` mode with no name posts back a
 * refusal that says so. What a person sees is a select that is only consulted
 * when the radio beside it is the one chosen — which is what the route does
 * with it.
 */
function renderPickerControl(gameId: string, fixtureId: string, params: OwnerFixtureParams): string {
  const picker = params.picker;
  if (picker === undefined) return "";

  const label: Record<PickerMode, string> = {
    organiser: "Just me",
    delegate: "One of the squad",
    open: "Anyone in the squad",
  };

  const radios = PICKER_MODES.map(
    (mode) => `<label class="picker-choice">
                 <input type="radio" name="mode" value="${escapeHtml(mode)}"${
                   picker.mode === mode ? " checked" : ""
                 }>
                 <span>${escapeHtml(label[mode])}</span>
               </label>`,
  ).join("");

  // No "nobody" option: the select is only read when the `delegate` radio is
  // chosen, and choosing that mode without naming anybody is the thing the
  // route refuses. A blank first option would look like a fourth mode.
  const options = picker.candidates
    .map(
      (candidate) =>
        `<option value="${escapeHtml(candidate.playerId)}"${
          candidate.playerId === picker.delegatePlayerId ? " selected" : ""
        }>${escapeHtml(candidate.name)}</option>`,
    )
    .join("");

  // Said only when somebody actually holds it: "handed over on ..." beside
  // "Just me" would be describing a hand-over that never happened.
  const held =
    picker.mode === "delegate" && picker.handedOverOnLocal !== undefined
      ? `<p class="team-note">${escapeHtml(`Handed over on ${picker.handedOverOnLocal}.`)}</p>`
      : "";

  const empty =
    picker.candidates.length === 0
      ? `<p class="team-note">There is nobody else in the squad to hand this to yet.</p>`
      : "";

  return `<h2>Who picks the teams?</h2>
          ${held}
          ${empty}
          <form method="post" action="${escapeHtml(pickerModePath(gameId, fixtureId))}" class="picker-control">
            ${radios}
            <div class="field">
              <label for="picker-delegate">Hand it to</label>
              <select id="picker-delegate" name="delegate">${options}</select>
            </div>
            <button class="button" type="submit">Save who picks</button>
          </form>`;
}

/**
 * The teams section (BR-35): the picker while the fixture is still taking
 * changes, the pick read-only once it is not, and nothing at all when no pick
 * was ever made on a fixture that has closed.
 *
 * Gated on the same `takingChanges` predicate the squad's controls and the
 * guest form use, so the three cannot disagree about when an organiser can
 * still act. `sideCounts` and the `in` filter both come from the domain
 * rather than being recounted here — a count on this page that disagreed
 * with the one the publish guard reads would be worse than no count.
 */
function renderTeams(params: OwnerFixtureParams): string {
  const { gameId, fixtureId, squad, view, teamNames, prefersEvenNumbers, unassignedProblem } = params;
  const playing = squad.filter((member) => member.status === "in");
  const counts = sideCounts(squad);

  if (!takingChanges(view)) {
    // Only players who are both `in` and placed: a dropout keeps their side
    // on purpose, and showing them here would claim they played.
    return renderTeamsReadOnly({ names: teamNames, members: playing.filter((member) => member.team !== null) });
  }

  return renderTeamPicker({
    gameId,
    fixtureId,
    names: teamNames,
    members: playing,
    counts,
    uneven: prefersEvenNumbers && counts.a !== counts.b,
    unassignedProblem,
    published: params.teamsPublished,
    needsAnotherLook: params.teamsNeedAnotherLook,
    announcementOutstanding: params.announcementOutstanding,
    teamsEmailEnabled: params.teamsEmailEnabled,
    // Always, whatever the fixture's picking mode: `mayPublish` restricts a
    // member picking in `open` mode, never the person whose game it is (M29).
    canPublish: true,
  });
}

/**
 * What the organiser can post to their WhatsApp group for this fixture
 * (M22), derived from the same state the rest of the page shows so the
 * numbers in the message are the numbers on the page above it.
 *
 * Nothing for a `scheduled` fixture (not open yet — there is nothing to
 * announce, and opening it early is a click away) or a `played` one. Teams
 * come first once published because that is the newer news; the numbers
 * message stays beside it since a published pick does not close the squad.
 * Only players who are `in` and placed are listed — a dropout keeps their
 * side on purpose (`renderTeams`), and naming them here would claim they
 * are playing.
 */
function whatsappMessages(params: OwnerFixtureParams): WhatsAppMessage[] {
  const { gameName, kicksOffAtLocal, venueName, view, squad, teamNames } = params;
  const gameUrl = `${SITE_ORIGIN}${gamePath(params.gameId)}`;
  const inviteUrl = `${SITE_ORIGIN}${joinPath(params.inviteToken)}`;

  if (view.status === "cancelled") {
    return [
      {
        id: "whatsapp-cancelled",
        label: "Cancelled",
        text: cancelledMessage({ gameName, kicksOffAtLocal, reason: params.cancellationReason }),
      },
    ];
  }
  if (view.status === "scheduled" || view.status === "played") return [];

  const messages: WhatsAppMessage[] = [];
  if (params.teamsPublished) {
    const playing = squad.filter((member) => member.status === "in");
    const lineUps = (["a", "b"] as const).map((side) => ({
      name: teamNames[side],
      players: playing.filter((member) => member.team === side).map((member) => displayName(member.name, member.erasedAt)),
    }));
    messages.push({ id: "whatsapp-teams", label: "Teams", text: teamsMessage({ gameName, kicksOffAtLocal, lineUps }) });
  }
  const open = openMessageParts({
    gameName,
    venueName,
    kicksOffAtLocal,
    inCount: view.inCount,
    minPlayers: view.minPlayers,
    maxPlayers: view.maxPlayers,
    gameUrl,
    inviteUrl,
  });
  messages.push({
    id: "whatsapp-open",
    label: "Numbers",
    // Every option's line is in `text` already — the switches subtract. See
    // `WhatsAppMessage.options`.
    text: [open.fixed, ...open.options.map((option) => option.line)].join("\n"),
    options: open.options,
  });
  return messages;
}

/**
 * The owner's "open it now" control, on a `scheduled` fixture only (M46, BR-11).
 *
 * The copy says what the press actually does, because the two halves are easy
 * to assume and wrong: it fixes the eligible set at this moment (BR-1), and it
 * does **not** bring the day-before reminder forward — N-1 still goes at its
 * scheduled instant, which is what stops an early open leaving the fixture
 * silent until kickoff.
 *
 * `gated` changes only the sentence. An ungated Game's press mails nobody; a
 * gated one's releases the first group, so promising that here would be a lie
 * on half the fixtures this renders.
 */
function renderOpenNow(gameId: string, fixtureId: string, view: FixtureView, gated: boolean): string {
  if (view.status !== "scheduled") return "";

  const consequence = gated
    ? "The first group is invited straight away; the rest wait their turn as usual."
    : "Nobody is emailed yet — the day-before reminder still goes at its usual time.";

  return `
    <section class="open-now">
      <p>${escapeHtml(`This fixture opens for answers on its own nearer the day. ${consequence}`)}</p>
      <form method="post" action="${escapeHtml(openFixturePath(gameId, fixtureId))}">
        <button class="button primary" type="submit">Open it now</button>
      </form>
    </section>`;
}

export function renderOwnerFixturePage(params: OwnerFixtureParams): string {
  const { gameId, fixtureId, gameName, kicksOffAtLocal, venueName, inCount, maxPlayers, view, squad } = params;

  const problem = params.problem === undefined ? "" : `<p class="problem">${escapeHtml(params.problem)}</p>`;

  // Counted from the squad this page is about to list, not read from the
  // stored `fixtures.waitlist_count` column — deliberately, so do not "unify"
  // the two without reading this. The owner is shown the roster and the number
  // side by side, and a number that disagreed with the rows immediately below
  // it is the one error they cannot be asked to reconcile. `squad` is already
  // the authority for what this page displays; the column is the authority for
  // `src/views/player-game.ts`, which has no roster to count when the
  // organiser has squad visibility off. Each surface counts what it shows.
  const waitlistCount = squad.filter((member) => member.status === "waitlisted").length;

  // Above the squad and the teams (M27), matching the player's page — see
  // `renderPlayerFixturePage` for the reasoning and for why this is a
  // TypeScript comment rather than one in the template.
  const resultPanel = params.result === undefined ? "" : renderResultPanel(params.result);

  const whatsapp = whatsappMessages(params);

  // The copy script only when there is a Copy button for it to reveal; the
  // picker's drag enhancement only where the picker is (see `renderTeams`).
  const pageScripts: PageScriptBlock[] = [];
  if (takingChanges(view)) pageScripts.push(TEAM_PICKER_JS);
  if (whatsapp.length > 0) pageScripts.push(COPY_BUTTON_JS);
  // Only when a message actually has switches — an all-cancelled card has
  // none, and a block that finds nothing to do is a hash in the CSP for
  // nothing.
  if (whatsapp.some((message) => message.options !== undefined)) pageScripts.push(WHATSAPP_LINKS_JS);
  pageScripts.push(FRESHNESS_JS);

  const body = `
    <h1>${escapeHtml(gameName)}</h1>
    ${problem}
    ${params.broadcastNotice === undefined ? "" : `<p class="nudge ok">${escapeHtml(params.broadcastNotice)}</p>`}
    <p class="kickoff">${escapeHtml(kicksOffAtLocal)}</p>
    <p class="venue">${escapeHtml(venueName)}</p>
    ${renderStatusLine(view, waitlistCount)}
    ${renderOpenNow(gameId, fixtureId, view, params.gatedInvites)}
    ${renderOverCapacity(view, inCount, maxPlayers)}
    ${renderConfirm(gameId, fixtureId, params)}

    ${resultPanel}

    <h2>Squad</h2>
    ${renderSquadList(gameId, fixtureId, squad, takingChanges(view), params.gatedInvites)}

    ${params.inviteProgress === undefined ? "" : renderInviteProgress(params.inviteProgress)}

    ${renderTeams(params)}

    ${renderPickerControl(gameId, fixtureId, params)}

    ${renderGuestForm(gameId, fixtureId, params)}

    ${whatsapp.length === 0 ? "" : renderWhatsAppCard({ messages: whatsapp })}

    <div class="actions">
      <a class="button" href="${escapeHtml(fixtureMessagePath(gameId, fixtureId))}">Message players</a>
      <a class="button" href="${escapeHtml(fixtureTimelinePath(gameId, fixtureId))}">What has happened</a>
    </div>

    <p class="back-link"><a href="${escapeHtml(gamePath(gameId))}">Back to the game</a></p>

    ${renderFreshness(fixturePath(gameId, fixtureId))}
  `;

  return layout({
    nav: params.nav,
    title: `${gameName} — Make The Team`,
    body,
    // `FIXTURE_STYLES_CSS` because this page renders `renderStatusLine` —
    // without it the status badge and the capacity bar are markup with no
    // rules behind them, and a bar whose track has no height is invisible
    // rather than broken, so nothing here fails loudly.
    //
    // The order is load-bearing, not alphabetical, and this is the page it
    // matters most on: it renders the only squad rows in the app that carry
    // per-member controls. `SQUAD_STYLES_CSS` and `FORM_CSS` both declare
    // `ul.squad > li` at identical specificity, so whichever `layout()` emits
    // last wins — SQUAD_STYLES_CSS lays the row out as flex, FORM_CSS as a
    // `1fr auto` grid. SQUAD_STYLES_CSS goes first so the grid wins, and it
    // still contributes the container rule FORM_CSS lacks: the list's top
    // border. `src/views/game-overview.ts` pins the same pair the same way.
    //
    // Measured in a browser rather than reasoned about, because a row here is
    // not the two-part row that rule was first written for. It is a name,
    // sometimes a status, sometimes an attribution line, and a control — up
    // to four children. SQUAD_STYLES_CSS's flex row does not wrap, so at
    // 390px a row carrying all four ran 50px past the viewport: the page
    // scrolled sideways and the Out half of the segment sat off-screen. Under
    // FORM_CSS's grid the same row wraps onto a second line and the page
    // stays 390px wide. The trade is real and worth naming: a waitlisted
    // member's row and a guest's row are two lines here rather than one. Two
    // lines that fit beat one line that is partly off the screen.
    //
    // WHATSAPP_CSS and RESULT_CSS are each namespaced (`.whatsapp`, `.result-*`)
    // and collide with nothing, so their position is not load-bearing; both
    // stay out of the pair above, in the same relative order `PAGE_STYLE_BLOCKS`
    // (src/views/styles.ts) holds them.
    pageStyles: [
      SQUAD_STYLES_CSS,
      FIXTURE_STYLES_CSS,
      FORM_CSS,
      TEAM_PICKER_CSS,
      WHATSAPP_CSS,
      RESULT_CSS,
      FRESHNESS_CSS,
      // Last, and it declares no selector any block above declares — M34's
      // classes are all `invite-` prefixed for exactly that reason.
      INVITE_ORDER_CSS,
    ],
    pageScripts,
  });
}
