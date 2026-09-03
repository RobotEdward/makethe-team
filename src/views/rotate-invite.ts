import { gameInviteRotatePath, gamePath } from "../auth/paths.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { CANCEL_STYLES_CSS, FORM_CSS } from "./styles.js";

export interface RotateInvitePageParams {
  nav: PageNav;
  gameId: string;
  gameName: string;
  /** Active members, who are the people the rotation does *not* affect. */
  squadSize: number;
}

/**
 * The owner's "are you sure" for replacing a game's invite link (M52).
 *
 * A served page and a real form post, like archiving and like removing a
 * member. Until M52 this was a single full-width button sitting directly under
 * the invite URL — heavier-looking than the `Copy` beside it — and pressing it
 * killed the old link immediately. That link is, by the time anyone presses
 * anything, already pasted in a group chat and possibly printed on a QR code
 * held up at training. It was the one destructive action in the product with
 * no confirmation, and the design review found it as such.
 *
 * **It cannot count the damage, and it says so rather than inventing a
 * number.** Archiving can promise "5 fixtures called off, 12 players emailed"
 * because the rows exist to be counted. Nobody knows how many people hold an
 * invite link: it has been forwarded, screenshotted and pinned in places this
 * app has no visibility of, which is the whole point of it. A page here that
 * printed a confident figure would be describing only the people who already
 * joined — precisely the group rotation does *not* affect. So it names the
 * consequence in words and states the one number it actually knows.
 */
export function renderRotateInvitePage(params: RotateInvitePageParams): string {
  const { gameId, gameName, squadSize } = params;
  const name = escapeHtml(gameName);

  // The reassuring half, and the only count on the page. It matters because
  // the fear this page exists to address — "will I lock my squad out?" — has
  // the answer "no", and saying so plainly is what lets an owner rotate a
  // leaked link without hesitating.
  const unaffected =
    squadSize === 0
      ? `<p>Nobody has joined yet, so nobody loses access.</p>`
      : `<p>The ${squadSize} ${squadSize === 1 ? "person" : "people"} already in the squad ${
          squadSize === 1 ? "is" : "are"
        } not affected — they stay in, and nothing about their place changes.</p>`;

  const body = `
    <div class="prose">
    <h1>Replace the invite link for ${name}?</h1>
    <p>The link you have now stops working the moment you press this, and there is no way to bring it back.</p>
    <p>Anyone holding it — in a group chat, in a forwarded message, or on a printed QR code — will not be able to join with it. You will need to share the new link with anybody still waiting to join.</p>
    ${unaffected}
    </div>
    <form method="post" action="${escapeHtml(gameInviteRotatePath(gameId))}">
      <button class="button danger" type="submit">Replace the link</button>
    </form>
    <a class="button keep-link" href="${escapeHtml(gamePath(gameId))}">No, keep the link I have</a>
  `;

  return layout({
    nav: params.nav,
    title: `Replace the invite link for ${gameName} — Make The Team`,
    body,
    pageStyles: [CANCEL_STYLES_CSS, FORM_CSS],
  });
}
