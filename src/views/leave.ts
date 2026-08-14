import { gamePath } from "../auth/paths.js";
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
}

function confirmBody(gameName: string, token: string): string {
  return `
    <p>Leaving means you'll stop getting email about ${gameName}, and your place in any fixture that's still open is freed for someone else.</p>
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
    <p>If you change your mind, an organiser can add you back.</p>
  `;
}

export function renderLeavePage(params: LeavePageParams): string {
  const { token, gameId, state } = params;
  const gameName = escapeHtml(params.gameName);

  const body = `
    <h1>${gameName}</h1>
    ${
      state === "confirm"
        ? confirmBody(gameName, token)
        : state === "sole-organiser"
          ? soleOrganiserBody(gameName, gameId)
          : state === "already-left"
            ? alreadyLeftBody(gameName)
            : doneBody(gameName)
    }
  `;

  return layout({ title: `Leave ${params.gameName} — Make The Team`, body, pageStyles: [FORM_CSS] });
}
