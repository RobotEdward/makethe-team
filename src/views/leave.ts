import { gamePath, leaveOtherGamePath, SIGN_IN_PATH } from "../auth/paths.js";
import { escapeHtml, layout } from "./layout.js";
import { FORM_CSS } from "./styles.js";

/**
 * The page behind `/leave/:token` (BR-22, task-2).
 *
 * Modelled on `src/views/cancel.ts`: a token-reached page with no session,
 * stating one destructive action plainly and putting it behind a real `<form
 * method="post">`, never a link or a button that a `GET` could trigger. The
 * route that renders this performs no write on any path — see
 * `respond.ts`'s handler for why that is the entire point of this page.
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
    <form method="post" action="/leave/${escapeHtml(token)}">
      <button class="button primary" type="submit">Leave this game</button>
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

  return `
    <h2>Your other squads</h2>
    <ul>${items}</ul>
  `;
}

export function renderLeavePage(params: LeavePageParams): string {
  const { token, gameId, state } = params;
  const gameName = escapeHtml(params.gameName);

  const body = `
    <h1>${gameName}</h1>
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
  `;

  return layout({ title: `Leave ${params.gameName} — Make The Team`, body, pageStyles: [FORM_CSS] });
}
