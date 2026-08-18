import { gamePath, memberRemovePath } from "../auth/paths.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { CANCEL_STYLES_CSS, FORM_CSS } from "./styles.js";

export interface RemoveMemberPageParams {
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
  gameId: string;
  /** The member being removed. In the form's `action`, so it cannot be omitted. */
  playerId: string;
  gameName: string;
  memberName: string;
  /** Whether the member being removed is an organiser. Changes the warning, not the outcome. */
  isOwner: boolean;
  /** What they hold on this game's open fixtures right now, from `countCommitments`. */
  commitments: { in: number; waitlisted: number };
}

/** "1 upcoming fixture" / "2 upcoming fixtures" — never "1 upcoming fixtures". */
function fixtures(count: number): string {
  return `${count} upcoming fixture${count === 1 ? "" : "s"}`;
}

/**
 * The removal confirmation (J6a §2).
 *
 * A served page and a real form post, not a `confirm()` dialog: removal is
 * destructive, the owner cannot undo it (only the removed player can rejoin,
 * via the invite link), and everything a person *must* be able to do has to
 * work with JavaScript off.
 *
 * The consequences are stated in specifics computed from live rows rather than
 * in general terms, because "this may affect upcoming fixtures" is exactly the
 * warning people click past. A member with nothing upcoming is told *that*,
 * rather than shown a sentence about freed places that quietly does not apply
 * to them.
 */
export function renderRemoveMemberPage(params: RemoveMemberPageParams): string {
  const { gameId, playerId, gameName, memberName, isOwner, commitments } = params;
  const name = escapeHtml(memberName);

  const consequences: string[] = [];
  if (commitments.in > 0) {
    // The waiting-list half is the consequence an owner most needs to see
    // (spec §2): freeing a place is not the end of it — somebody else is
    // moved into that place, and emailed about it (N-2), by this click.
    consequences.push(
      `<p>${name} holds a confirmed place in ${fixtures(commitments.in)}. Removing them frees ${
        commitments.in === 1 ? "it" : "them"
      } up, and the next person on each waiting list takes the place.</p>`,
    );
  }
  if (commitments.waitlisted > 0) {
    consequences.push(
      `<p>${name} is on the waiting list for ${fixtures(commitments.waitlisted)}. Those places on the list go.</p>`,
    );
  }
  if (consequences.length === 0) {
    consequences.push(`<p>${name} has no upcoming fixtures, so nothing else changes.</p>`);
  }

  const ownerWarning = isOwner
    ? `<p class="nudge">${name} is an organiser of this game. Removing them takes that away too.</p>`
    : "";

  const body = `
    <h1>Remove ${name}?</h1>
    <p>They'll be taken out of the squad for ${escapeHtml(gameName)} and told by email.</p>
    ${ownerWarning}
    ${consequences.join("\n    ")}
    <p>They can join again themselves with the invite link. You can't put them back.</p>
    <form method="post" action="${escapeHtml(memberRemovePath(gameId, playerId))}">
      <button class="button danger" type="submit">Remove ${name}</button>
    </form>
    <a class="button keep-link" href="${escapeHtml(gamePath(gameId))}">No, leave the squad as it is</a>
  `;

  // The `— Make The Team` suffix every other view uses; without it this is the
  // one page whose browser tab and bookmark do not say what site it belongs to.
  //
  // CANCEL_STYLES_CSS is here for .keep-link alone — the rest of it styles a
  // reason textarea this page does not have. Passed through `pageStyles`
  // rather than inlined into the body the way `cancel.ts` does it: a block
  // written at the call site is invisible to `PAGE_STYLE_BLOCKS`, which
  // `src/security/csp.ts` hashes for style-src, and the browser would drop it
  // with no fetch-level test noticing.
  //
  // Order is free here: no selector in CANCEL_STYLES_CSS is also declared in
  // FORM_CSS, so neither block can overwrite the other. It follows
  // PAGE_STYLE_BLOCKS' own order so nothing has to be re-derived to read it.
  return layout({
    nav: params.nav,
    title: `Remove ${memberName} — Make The Team`,
    body,
    pageStyles: [CANCEL_STYLES_CSS, FORM_CSS],
  });
}
