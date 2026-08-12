import { joinPath } from "../auth/paths.js";
import { redactName } from "../domain/redact-name.js";
import { escapeHtml, layout } from "./layout.js";
import { FORM_CSS } from "./styles.js";

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
 * - **No email address ever appears.** Not the joiner's, not a squad member's,
 *   not an organiser's. There is no parameter on either function that could
 *   carry one, which is the cheapest way to keep it true.
 *
 * Neither page takes a script. Joining is one form and one button, and a
 * stranger's first contact with this product must not depend on JavaScript
 * running (TR-4, TR-15).
 */

export interface InvitePageParams {
  gameName: string;
  venueName: string;
  /** Echoed into the form action so the POST lands on the same game. */
  inviteToken: string;
  /**
   * Active squad members' *full* names as stored. Redacted here rather than by
   * the caller, so a caller that forgets cannot leak one — `redactName` is
   * applied at the single point of interpolation below.
   */
  squad: ReadonlyArray<{ name: string }>;
  /** The next `scheduled` fixture, already formatted in the Game's timezone. */
  firstFixtureLocal: string | null;
  /** Preserved across a rejected submission so nobody retypes on a phone. */
  values?: { name?: string; email?: string };
  /** Shown above the form when a submission was refused. */
  error?: string;
}

/**
 * The invite page: what this game is, who is already in, and one form.
 *
 * The form's `action`, `method` and field names are the load-bearing part —
 * `test/routes/join.test.ts` derives its assertion from this rendered HTML
 * because a form posting to the wrong path, or carrying field names the
 * handler never reads, fails *identically* to a working one under server-side
 * testing: the handler is simply never called. See the `connect-src`
 * post-mortem in `docs/known-issues.md`.
 */
export function renderInvitePage(params: InvitePageParams): string {
  const { gameName, venueName, inviteToken, squad, firstFixtureLocal, values, error } = params;

  const squadItems = squad
    // BR-26. The one place a squad member's name is interpolated on a public
    // page, and it is redacted at that exact point.
    .map((member) => `<li>${escapeHtml(redactName(member.name))}</li>`)
    .join("");

  const whenLine =
    firstFixtureLocal === null
      ? `<p>No fixture is scheduled yet — you'll be emailed when the next one is.</p>`
      : `<p>Next up: ${escapeHtml(firstFixtureLocal)}.</p>`;

  // `.nudge` is one of `layout()`'s shared primitives, so this needs no
  // page-specific block of its own — every `<style>` this app emits has to be
  // a member of `PAGE_STYLE_BLOCKS` for the CSP to hash it, and the cheapest
  // way to satisfy that is to add no new block at all.
  const errorBlock = error === undefined ? "" : `<p class="nudge">${escapeHtml(error)}</p>`;

  const body = `
    <h1>Join ${escapeHtml(gameName)}</h1>
    <p>${escapeHtml(venueName)}</p>
    ${whenLine}

    <h2>Who's playing (${squad.length})</h2>
    <ul class="squad">${squadItems || "<li>Nobody has joined yet — you'd be first.</li>"}</ul>

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
      <p>We'll email you when there's a game on. That's the whole point of the address.</p>
      <div class="actions">
        <button class="button primary" type="submit">Join the squad</button>
      </div>
    </form>
  `;

  return layout({ title: `Join ${gameName} — Make The Team`, body, pageStyles: [FORM_CSS] });
}

export interface JoinOutcomePageParams {
  /** Straight from `JoinOutcome.kind` (`src/domain/join-squad.ts`). */
  kind: "joined" | "rejoined" | "already-member";
  gameName: string;
  venueName: string;
  /** The next `scheduled` fixture, already formatted in the Game's timezone. */
  firstFixtureLocal: string | null;
}

/**
 * What happened, in the terms the person in front of it needs.
 *
 * **BR-2 is stated here rather than glossed over.** Someone who joins after a
 * fixture has already opened is *not* in that fixture, so this page names the
 * next `scheduled` one as their first and never implies they are in a game
 * already underway. The N-6 welcome email says the same thing from the same
 * rule (`src/notify/send-welcome.ts`), so the page and the email cannot
 * disagree about which fixture is theirs.
 *
 * No email address and no squad list: there is nothing here that a forwarded
 * screenshot of this page could leak.
 */
export function renderJoinOutcomePage(params: JoinOutcomePageParams): string {
  const { kind, gameName, venueName, firstFixtureLocal } = params;

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

  // BR-2, said plainly rather than left to be discovered: the first fixture
  // named is the next *scheduled* one, and a fixture already being organised
  // is not one this person is in.
  const next =
    firstFixtureLocal === null
      ? `<p>There's no fixture scheduled yet. You'll get an email when the next one opens — nothing to do until then.</p>`
      : `<p>Your first game is ${escapeHtml(firstFixtureLocal)}. You'll get an email a few days before, with a way to say whether you're in.</p>
         <p>If a game is already being organised for this week, you're not in that one — you joined after the invitations went out.</p>`;

  const body = `
    <h1>${heading}</h1>
    ${opener}
    ${next}
  `;

  return layout({ title: `${gameName} — Make The Team`, body, pageStyles: [FORM_CSS] });
}
