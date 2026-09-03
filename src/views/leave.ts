import { DASHBOARD_PATH, gamePath, leaveOtherGamePath, SIGN_IN_PATH } from "../auth/paths.js";
import { escapeHtml, layout } from "./layout.js";
import { FIXTURE_STYLES_CSS, FORM_CSS, SQUAD_STYLES_CSS } from "./styles.js";

/**
 * The page behind `/leave/:token` (BR-22, task-2).
 *
 * Modelled on `src/views/cancel.ts`: a token-reached page with no session,
 * stating one destructive action plainly and putting it behind a real `<form
 * method="post">`, never a link or a button that a `GET` could trigger. The
 * `GET` that renders this performs no write on any path — the `POST` this
 * page's form submits to is what actually leaves the squad — see
 * `respond.ts`'s handler for why the `GET` staying writeless is the entire
 * point of this page.
 */
export interface LeavePageParams {
  token: string;
  gameName: string;
  /** "confirm" renders the button; none of the others do. */
  state: "confirm" | "sole-organiser" | "already-left" | "done";
  gameId: string;
  /** Task 4 fills this; absent means "no session, or not this player". */
  otherGames?: readonly { gameId: string; gameName: string }[];
  /**
   * Whether the person being offered this page organises the game. Only the
   * `confirm` state uses it, to warn that leaving gives the role up — see
   * `confirmBody`. A sole organiser is refused outright and never sees it.
   */
  isOrganiser?: boolean;
}

/**
 * The offer itself.
 *
 * **The organiser sentence is not decoration.** Leaving demotes the leaver to
 * a player in the same write that deactivates their membership, and rejoining
 * with the invite link comes back as a player too — so the only way back to
 * organising this game is another organiser handing the role over. That is
 * irreversible by the person tapping this button, alone, and they may well be
 * tapping it from an email to stop the reminders rather than to give up the
 * role. The owner-facing removal page already discloses exactly this about
 * somebody else ("Removing them takes that away too", `views/remove-member.ts`);
 * saying less to the person it happens *to* would be the wrong way round.
 */
function confirmBody(gameName: string, token: string, isOrganiser: boolean): string {
  const organiserWarning = isOrganiser
    ? `<p class="nudge">You're an organiser of ${gameName}. Leaving takes that away too, and only another organiser can give it back.</p>`
    : "";

  return `
    <p>Leaving means you'll stop getting email about ${gameName}, and your place in any fixture that's still open is freed for someone else.</p>
    ${organiserWarning}
    <!-- The escape is a sentence, not a link (M52). This page is reached from
         an email with a token and usually no session, so a "back to the game"
         link would bounce the visitor to sign-in — worse than none for someone
         who only wants to undo a mis-tap. Same idiom, and same reason, as the
         join-confirm page's "Not you?" line. -->
    <p class="read-only">Changed your mind? Just close this page — nothing happens unless you press the button.</p>
    <form method="post" action="/leave/${escapeHtml(token)}">
      <button class="button danger" type="submit">Leave this game</button>
    </form>
  `;
}

function soleOrganiserBody(gameName: string, gameId: string): string {
  return `
    <p>${gameName} needs an organiser, and you're the only one it has. Make someone else an organiser first, then come back here to leave.</p>
    <p><a href="${escapeHtml(gamePath(gameId))}">Go to ${gameName}</a></p>
  `;
}

function alreadyLeftBody(gameName: string): string {
  return `
    <p>You're already out of ${gameName} — there's nothing more to do here.</p>
  `;
}

function doneBody(gameName: string): string {
  return `
    <p>You're out of ${gameName}. You won't get any more email about it.</p>
    <p>An organiser can't add you back — you'd need to rejoin with the invite link.</p>
  `;
}

/**
 * "Your other squads" (M7a Task 4) — reachable only from a session whose
 * player matches the token's own, which is enforced by the caller, not here:
 * `otherGames` is `undefined` for every other visitor, including one signed
 * in as somebody else, and this function has no way to tell those two cases
 * apart from a mismatch. See `respond.ts`'s `GET /leave/:token` for the
 * identity check itself — the whole security property this task adds (BR-25).
 *
 * `undefined` renders a sign-in offer rather than nothing: a visitor with no
 * session has a genuine reason to want this (they may hold other squads too),
 * so the empty state is worded as something to gain, not as a refusal.
 */
function otherGamesBody(otherGames: readonly { gameId: string; gameName: string }[] | undefined): string {
  if (otherGames === undefined) {
    return `
      <h2>Your other squads</h2>
      <p><a href="${escapeHtml(SIGN_IN_PATH)}">Sign in to see your other squads, and leave any of them from here too.</a></p>
    `;
  }

  if (otherGames.length === 0) return "";

  const items = otherGames
    .map(
      (game) => `
      <li>
        ${escapeHtml(game.gameName)}
        <form method="post" action="${escapeHtml(leaveOtherGamePath(game.gameId))}">
          <button class="button" type="submit">Leave</button>
        </form>
      </li>
    `,
    )
    .join("");

  // `ul.squad`, not a bare `ul`: without it this is the browser's default
  // bulleted list with a full-width 52px `.button` stacked under each game's
  // name, which at three squads is a column of identical red-adjacent slabs
  // and no way to scan the names. The class is the row shape the organiser's
  // squad list already uses — a name on the left, its one control on the
  // right — and this list is the same shape of thing.
  return `
    <h2>Your other squads</h2>
    <ul class="squad">${items}</ul>
  `;
}

/**
 * The way off this page, for a visitor who has somewhere to go.
 *
 * Only rendered when the other-squads lookup *succeeded* for a session this
 * page recognised as the token's own player, which is what a defined
 * `otherGames` means (see `otherGamesBody`). It is not quite the same as
 * "has a session": `resolveOtherGames` also degrades to `undefined` when the
 * list query throws for a correctly-identified session, so a database fault
 * costs that visitor this link as well as the list. Deliberate — the same
 * degradation the sign-in offer above already accepts, and one exit missing
 * is a better failure than a page that 500s over a nicety.
 *
 * Everyone else reaches this page from an email with no session, so
 * "Back to your games" would land them on sign-in; that page
 * already offers them sign-in above, in words that say what they get for it,
 * and one exit that works beats two that go to the same prompt.
 *
 * The dashboard and not the game itself, because this page can be read in the
 * state where the leave has already happened and the game is no longer theirs
 * to open.
 */
function backLink(hasSession: boolean): string {
  return hasSession
    ? `<p class="back-link"><a href="${escapeHtml(DASHBOARD_PATH)}">Back to your games</a></p>`
    : "";
}

export function renderLeavePage(params: LeavePageParams): string {
  const { token, gameId, state } = params;
  const gameName = escapeHtml(params.gameName);

  // The heading names the act, not just the game, in the one state that offers
  // it (M52): somebody who mis-taps the leave link in an email footer would
  // otherwise see their game's name over a red button and nothing saying where
  // they are. The other states are reports, not questions, so they keep the
  // plain name.
  const heading = state === "confirm" ? `Leave ${gameName}?` : gameName;

  const body = `
    <h1>${heading}</h1>
    ${
      state === "confirm"
        ? confirmBody(gameName, token, params.isOrganiser === true)
        : state === "sole-organiser"
          ? soleOrganiserBody(gameName, gameId)
          : state === "already-left"
            ? alreadyLeftBody(gameName)
            : doneBody(gameName)
    }
    ${otherGamesBody(params.otherGames)}
    ${backLink(params.otherGames !== undefined)}
  `;

  // SQUAD_STYLES_CSS FIRST, and the order is not cosmetic: it and FORM_CSS
  // both declare `ul.squad > li` at identical specificity (0,1,1), so the
  // later block in this array wins. FORM_CSS's grid is the one that must,
  // because a row here is a game's name plus a Leave button and `1fr auto`
  // pins both columns whatever the name's length. SQUAD_STYLES_CSS's flex
  // version lets a long name pull the button onto its own line while a short
  // one keeps it alongside — two rows of identical markup laid out
  // differently, a bug this product already shipped once (see the grid
  // comment in FORM_CSS). SQUAD_STYLES_CSS still earns its place: the list's
  // top border and its `text-align: left` are only there.
  //
  // FIXTURE_STYLES_CSS is for `.back-link` alone, the same way
  // `game-overview.ts` takes it.
  return layout({
    title: `Leave ${params.gameName} — Make The Team`,
    body,
    pageStyles: [SQUAD_STYLES_CSS, FORM_CSS, FIXTURE_STYLES_CSS],
  });
}
