import { DASHBOARD_PATH, joinPath, PRIVACY_PATH } from "../auth/paths.js";
import { describeRecurrenceRule, parseRecurrenceRule } from "../domain/recurrence/parse.js";
import { redactName } from "../domain/redact-name.js";
import { escapeHtml, layout } from "./layout.js";
import { FORM_CSS, SQUAD_STYLES_CSS } from "./styles.js";

/**
 * The two pages behind the public invite link (J1, spec §4.4).
 *
 * **This is the only surface in the app a complete stranger can reach.**
 * Anyone holding the link — forwarded, screenshotted out of a group chat,
 * pasted into a public channel — sees exactly what these functions render, and
 * nothing else. Two consequences run through everything below:
 *
 * - Squad members go through `redactName` (BR-26): "Edward C.", never a full
 *   surname. `src/views/game-overview.ts` deliberately shows full names for
 *   the same squad, because that page is behind an owner entitlement check.
 *   The contrast is the point; do not copy that behaviour here.
 * - **The only address that can ever appear is the one the submitter has just
 *   typed**, echoed back to that same submitter in the form on a 422 so a
 *   fixable typo is visible. Never a squad member's, never an organiser's, and
 *   never on the outcome page at all — nothing here reads `players.email` and
 *   no parameter can carry another person's address. That echo is not a BR-26
 *   concern (it goes back to whoever sent it, in the response to their own
 *   request) but it does mean a 422 response body is *not* free of personal
 *   data: it must not be cached by a shared cache, logged, or treated as
 *   safe to forward. `/j/*` is served `private, no-store` in `src/app.ts`.
 *
 * Neither page takes a script. Joining is one form and one button, and a
 * stranger's first contact with this product must not depend on JavaScript
 * running (TR-4, TR-15).
 */

export interface InvitePageParams {
  gameName: string;
  venueName: string;
  /** Optional columns on the game row; omitted from the page when null. */
  venueAddress: string | null;
  /**
   * Rendered as a link, which is what `parseGameForm`'s scheme check exists
   * for: a `javascript:` URL is refused there precisely because it would land
   * in an `href` here, on the one page a stranger can reach.
   */
  venueUrl: string | null;
  /** The stored RRULE — described in words here (spec §4.3's "day"). */
  recurrenceRule: string;
  /** Wall-clock "HH:MM" *in `timezone`*, exactly as stored. */
  kickoffTime: string;
  durationMinutes: number;
  /** Named on the page, so "19:00" is unambiguous to someone reading elsewhere. */
  timezone: string;
  minPlayers: number;
  maxPlayers: number;
  /** Echoed into the form action so the POST lands on the same game. */
  inviteToken: string;
  /**
   * Active squad members' *full* names as stored. Redacted here rather than by
   * the caller, so a caller that forgets cannot leak one — `redactName` is
   * applied at the single point of interpolation below.
   */
  squad: ReadonlyArray<{ name: string }>;
  /** The next upcoming (`open` or `scheduled`) fixture, already formatted in the Game's timezone (BR-2′). */
  firstFixtureLocal: string | null;
  /**
   * Set only when the visitor is signed in **and** already an active member
   * of this game (M38) — the banner at the top of the page.
   *
   * `undefined` for a stranger, and the page is then byte-identical to what
   * it has always been: `test/routes/join-member-banner.test.ts` pins that,
   * because a banner that varied for a non-member would turn this public page
   * into a way of asking "is this address in that squad?".
   */
  viewer?: { email: string; gamePath: string };
  /** Preserved across a rejected submission so nobody retypes on a phone. */
  values?: { name?: string; email?: string };
  /** Shown above the form when a submission was refused. */
  error?: string;
}

/**
 * The invite page: what this game is, one form, and who is already in.
 *
 * The form sits *above* the squad. Someone who has just scanned the QR code
 * on a poster is standing up with a phone in one hand, and a squad of
 * fourteen between them and the two fields they came for is fourteen names
 * of scrolling before anything can be typed. The list stays on the page —
 * seeing that others are already in is why some people join — but as social
 * proof at the foot, not as an obstacle.
 *
 * The form's `action`, `method` and field names are the load-bearing part —
 * `test/routes/join.test.ts` derives its assertion from this rendered HTML
 * because a form posting to the wrong path, or carrying field names the
 * handler never reads, fails *identically* to a working one under server-side
 * testing: the handler is simply never called. See the `connect-src`
 * post-mortem in `docs/known-issues.md`.
 */
export function renderInvitePage(params: InvitePageParams): string {
  const {
    gameName, venueName, venueAddress, venueUrl, recurrenceRule, kickoffTime,
    durationMinutes, timezone, minPlayers, maxPlayers,
    inviteToken, squad, firstFixtureLocal, values, error, viewer,
  } = params;

  const addressLine = venueAddress === null ? "" : `<p>${escapeHtml(venueAddress)}</p>`;

  // The scheme is already restricted to http/https at the form boundary
  // (`parseGameForm`), which is what makes an `href` safe here at all;
  // `escapeHtml` handles the attribute quoting on top of that.
  const venueLink =
    venueUrl === null
      ? ""
      : `<p><a href="${escapeHtml(venueUrl)}" rel="noopener noreferrer">More about the venue</a></p>`;

  // No `Intl` and no conversion: `kickoffTime` is already a wall-clock reading
  // *in* `timezone` (that is how the column is defined), so the honest thing to
  // do is print it and name the zone. Anything that genuinely needs converting
  // — `firstFixtureLocal` — was formatted by `src/domain/time/zone.ts` in the
  // route before it got here.
  const scheduleLine =
    `<p>${escapeHtml(describeRecurrenceRule(parseRecurrenceRule(recurrenceRule)))} at ` +
    `${escapeHtml(kickoffTime)} (${escapeHtml(timezone)}), for ${durationMinutes} minutes.</p>`;

  const sizeLine = `<p>${minPlayers} to ${maxPlayers} players.</p>`;

  const squadChips = squad
    // BR-26. The one place a squad member's name is interpolated on a public
    // page, and it is redacted at that exact point.
    .map((member) => `<li class="chip">${escapeHtml(redactName(member.name))}</li>`)
    .join("");

  // Chips, not rows: nothing on this page acts on a person, so this is a list
  // to scan. Plain `.chip` with no status modifier — a colour here would
  // assert an answer to a fixture that this page does not know.
  //
  // The wrapper is a `div`, never a `ul`: a chip is an `li` too, and
  // `FORM_CSS`/`SQUAD_STYLES_CSS`'s `ul.squad > li` row layout would then
  // reach it (see the comment on `SQUAD_STYLES_CSS`).
  //
  // The empty state is a sentence, so it is written as one rather than
  // dressed as a chip nobody can be.
  const squadBlock =
    squad.length === 0
      ? `<p>Nobody has joined yet — you'd be first.</p>`
      : `<div class="squad"><ul class="chips">${squadChips}</ul></div>`;

  const whenLine =
    firstFixtureLocal === null
      ? `<p>No fixture is scheduled yet — you'll be emailed when the next one is.</p>`
      : `<p>Next up: ${escapeHtml(firstFixtureLocal)}.</p>`;

  // `.nudge` is one of `layout()`'s shared primitives, so this needs no
  // page-specific block of its own — every `<style>` this app emits has to be
  // a member of `PAGE_STYLE_BLOCKS` for the CSP to hash it, and the cheapest
  // way to satisfy that is to add no new block at all.
  const errorBlock = error === undefined ? "" : `<p class="nudge">${escapeHtml(error)}</p>`;

  // Same `.nudge` primitive as the error above, for the same reason: no new
  // `<style>` block means nothing to forget in `STYLE_BLOCKS`.
  //
  // A banner rather than a redirect to the game. An organiser previewing
  // their own invite link — or scanning the QR code `/g/:id` renders from it
  // — is signed in and is a member, and bouncing them would make their own
  // invite page unreachable without a private window, silently, in a way that
  // reads as a broken link.
  const viewerBlock =
    viewer === undefined
      ? ""
      : `<p class="nudge">You're already in this squad, signed in as ${escapeHtml(viewer.email)}. ` +
        `<a href="${escapeHtml(viewer.gamePath)}">Go to the game</a>.</p>`;

  const body = `
    ${viewerBlock}
    <h1>Join ${escapeHtml(gameName)}</h1>
    <p>${escapeHtml(venueName)}</p>
    ${addressLine}
    ${venueLink}
    ${scheduleLine}
    ${sizeLine}
    ${whenLine}

    <h2>Join the squad</h2>
    ${errorBlock}
    <form method="post" action="${escapeHtml(joinPath(inviteToken))}">
      <div class="field">
        <label for="name">Your name</label>
        <input id="name" name="name" type="text" autocomplete="name" required
               value="${escapeHtml(values?.name ?? "")}">
      </div>
      <div class="field">
        <label for="email">Your email address</label>
        <input id="email" name="email" type="email" autocomplete="email" inputmode="email"
               autocapitalize="off" spellcheck="false" required
               value="${escapeHtml(values?.email ?? "")}">
      </div>
      <p>We'll add you to the squad and email you when there's a game on.</p>
      <p><a href="${PRIVACY_PATH}">Privacy</a></p>
      <div class="actions">
        <button class="button primary" type="submit">Join the squad</button>
      </div>
    </form>

    <h2>Who's playing (${squad.length})</h2>
    ${squadBlock}
  `;

  // SQUAD_STYLES_CSS first, FORM_CSS second. Both blocks declare
  // `ul.squad > li` at the same specificity and `layout()` emits them in array
  // order, so on the organiser's page (`src/views/game-overview.ts`) the order
  // decides whether a squad row is FORM_CSS's grid or SQUAD_STYLES_CSS's flex.
  // *This* page renders no `ul.squad` at all — the squad is
  // `div.squad > ul.chips > li.chip`, the empty state a bare `<p>` — so that
  // rule matches nothing here and the pin changes nothing rendered today. It
  // is kept pre-emptively, and only for that: an edit that reintroduces a
  // `ul.squad` on this page inherits the settled order instead of whichever
  // block a future caller happens to list last.
  //
  // What *is* live here is the block-level `.squad {}` collision, because the
  // chips' wrapper is a `div.squad`. Both blocks declare `.squad` at (0,1,0):
  // SQUAD_STYLES_CSS sets `list-style`, `margin`, `padding`, `text-align` and
  // `border-top`; FORM_CSS sets only `list-style` and `padding`, to the same
  // values. So FORM_CSS wins the two it repeats and wins nothing by it, and
  // the three it never mentions survive from SQUAD_STYLES_CSS whatever the
  // order. The one with a visible effect on a `div` is `border-top` — the rule
  // above the chip cluster. Reversing these two would render this page
  // identically; do not read the pin as protecting the border.
  return layout({ title: `Join ${gameName} — Make The Team`, body, pageStyles: [SQUAD_STYLES_CSS, FORM_CSS] });
}

export interface JoinConfirmPageParams { gameName: string; venueName: string; name: string; action: string }

/**
 * M39, BR-50. The `GET` behind a confirmation link: one sentence and one
 * button. A `GET` that joined would let every mail scanner that follows
 * links join squads on people's behalf.
 */
export function renderJoinConfirmPage({ gameName, venueName, name, action }: JoinConfirmPageParams): string {
  const body = `
    <h1>Join the squad as ${escapeHtml(name)}?</h1>
    <p>${escapeHtml(gameName)} at ${escapeHtml(venueName)}.</p>
    <form method="post" action="${escapeHtml(action)}">
      <div class="actions"><button class="button primary" type="submit">Yes, join the squad</button></div>
    </form>
    <p>Not you? Just close this page — nothing happens unless you press the button.</p>
  `;
  return layout({ title: `Join ${gameName} — Make The Team`, body, pageStyles: [FORM_CSS] });
}

export interface CheckInboxPageParams {
  gameName: string;
  email: string;
}

/**
 * M39. Shown for every one of `sendJoinConfirmation`'s non-failing outcomes
 * (`sent`, `already-sent-today`, `switched-off`) so a resubmit or a
 * switched-off N-14 cannot be told apart from a fresh send (BR-47). Shows the
 * submitter their own address back (as the 422 branch already does) and
 * nothing about the squad — nothing has been written yet.
 */
export function renderCheckInboxPage({ gameName, email }: CheckInboxPageParams): string {
  const body = `
    <h1>Check your inbox</h1>
    <p>We've sent an email to <strong>${escapeHtml(email)}</strong> to confirm you want to join ${escapeHtml(gameName)}.</p>
    <p>Tap the button in it and you're in. If it hasn't arrived in a few minutes, check your spam folder — and check the address above is right. If it isn't, go back and try again.</p>
  `;
  return layout({ title: `Join ${gameName} — Make The Team`, body, pageStyles: [FORM_CSS] });
}

export interface JoinOutcomePageParams {
  /** Straight from `JoinOutcome.kind` (`src/domain/join-squad.ts`). */
  kind: "joined" | "rejoined" | "already-member";
  gameName: string;
  venueName: string;
  /**
   * The next upcoming fixture, already formatted in the Game's timezone. The
   * lifecycle decides the wording: `open` means this person was just
   * backfilled into it (BR-2′) and their invitation email is already on its
   * way, while `scheduled` is announced nearer the time.
   */
  firstFixture: { local: string; lifecycle: "open" | "scheduled" } | null;
}

/**
 * What happened, in the terms the person in front of it needs.
 *
 * **BR-2′ is stated here in the joiner's favour.** Someone who joins while a
 * fixture is open was just backfilled into it, so this page names that game
 * as their first and says the invitation email is on its way. The N-6
 * welcome email says the same thing from the same rule
 * (`src/notify/send-welcome.ts`), so the page and the email cannot disagree
 * about which fixture is theirs.
 *
 * No email address and no squad list: there is nothing here that a forwarded
 * screenshot of this page could leak.
 */
export function renderJoinOutcomePage(params: JoinOutcomePageParams): string {
  const { kind, gameName, venueName, firstFixture } = params;

  const heading =
    kind === "joined"
      ? "You're in"
      : kind === "rejoined"
        ? "Welcome back"
        : "You're already in this squad";

  const opener =
    kind === "already-member"
      ? `<p>Nothing has changed — you were already on the squad for ${escapeHtml(gameName)} at ${escapeHtml(venueName)}.</p>`
      : `<p>You're on the squad for ${escapeHtml(gameName)} at ${escapeHtml(venueName)}.</p>`;

  // BR-2′: an `open` fixture is one this person was just backfilled into, so
  // it is named as theirs and the invitation is promised — it was handed to
  // the same background task as the welcome email before this page rendered.
  const next =
    firstFixture === null
      ? `<p>There's no fixture scheduled yet. You'll get an email when the next one opens — nothing to do until then.</p>`
      : firstFixture.lifecycle === "open"
        ? `<p>A game is being organised right now for ${escapeHtml(firstFixture.local)} — and you're in the running. Check your email: your invitation is on its way, with a way to say whether you're playing.</p>`
        : `<p>Your first game is ${escapeHtml(firstFixture.local)}. You'll get an email a few days before, with a way to say whether you're in.</p>`;

  // The dashboard is where the "Get set up" card lives (M19) — install,
  // notifications, passkey all need a session, so this page's job is only to
  // make the trip worth taking. `.actions`/`.button` are layout() primitives;
  // no new style block, so nothing new to register for the CSP.
  const getSetUp = `
    <h2>Get set up</h2>
    <p>Your dashboard has the rest: add the app to your home screen, turn on notifications so you hear about games first, and set up a passkey to sign in faster.</p>
    <div class="actions"><a class="button primary" href="${DASHBOARD_PATH}">Open your dashboard</a></div>
  `;

  const body = `
    <h1>${heading}</h1>
    ${opener}
    ${next}
    ${getSetUp}
  `;

  return layout({ title: `${gameName} — Make The Team`, body, pageStyles: [FORM_CSS] });
}
