import { gameArchivePath, gamePath } from "../auth/paths.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { CANCEL_STYLES_CSS, FORM_CSS } from "./styles.js";

export interface ArchiveGamePageParams {
  nav: PageNav;
  gameId: string;
  gameName: string;
  /** Fixtures that have not happened yet, which archiving calls off. */
  upcomingCount: number;
  /** Distinct players holding or waiting for a place on those fixtures — who gets N-3. */
  playerCount: number;
}

/**
 * The owner's "are you sure" for archiving a game (M41). A served page and a
 * real form post, like removing a member: this calls off every upcoming
 * fixture and emails whoever was in, and a `confirm()` dialog cannot say
 * how many that is.
 */
export function renderArchiveGamePage(params: ArchiveGamePageParams): string {
  const { gameId, gameName, upcomingCount, playerCount } = params;
  const name = escapeHtml(gameName);
  const fixtures = `${upcomingCount} upcoming ${upcomingCount === 1 ? "fixture" : "fixtures"}`;
  const players = `${playerCount} ${playerCount === 1 ? "player" : "players"}`;

  const consequence =
    upcomingCount === 0
      ? `<p>There are no upcoming fixtures, so nobody needs telling.</p>`
      : playerCount === 0
        ? `<p>${fixtures} will be called off. Nobody has said they're in yet, so nobody is emailed.</p>`
        : `<p>${fixtures} will be called off, and ${players} who said they're in or are waiting will be emailed.</p>`;

  const body = `
    <h1>Archive ${name}?</h1>
    <p>No more fixtures will be scheduled, the invite link stops working, and nothing about the game can be changed. Everyone in the squad can still see its history.</p>
    ${consequence}
    <p>You can unarchive it later from the game page.</p>
    <form method="post" action="${escapeHtml(gameArchivePath(gameId))}">
      <button class="button danger" type="submit">Archive ${name}</button>
    </form>
    <a class="button keep-link" href="${escapeHtml(gamePath(gameId))}">No, keep it going</a>
  `;

  return layout({ nav: params.nav, title: `Archive ${gameName} — Make The Team`, body, pageStyles: [CANCEL_STYLES_CSS, FORM_CSS] });
}
