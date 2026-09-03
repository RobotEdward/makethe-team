import { fixturePath, ownerGuestPath } from "../auth/paths.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { FORM_CSS } from "./styles.js";

export interface AddGuestPageParams {
  nav: PageNav;
  gameId: string;
  fixtureId: string;
  gameName: string;
  /** Already formatted in the game's timezone by the caller (TR-5). */
  kicksOffAtLocal: string;
  /** How many places are left, or null when the fixture is already full. */
  spotsLeft: number | null;
}

/**
 * Adding a guest, on a page of its own (M52).
 *
 * It was a form at the foot of the organiser's fixture page — which the M52
 * design review measured at 3954px on a phone once the capture finally showed
 * a busy fixture. Adding a guest is a rare act, and it was costing every
 * organiser who never does it a scroll past it to reach the two footer
 * actions; the organiser who does do it was hunting for it at the bottom of
 * the longest page in the product, usually at the side of a pitch.
 *
 * A page reached from a link beside the squad is one tap, and the tap is at the
 * top of the page rather than two thousand pixels down.
 *
 * **The capacity warning is stated here, before the name is typed**, because
 * this is the last screen before the write. Going over the limit is allowed —
 * BR-8 lets an organiser do it deliberately — so this says what will happen
 * rather than refusing.
 */
export function renderAddGuestPage(params: AddGuestPageParams): string {
  const { gameId, fixtureId, gameName, kicksOffAtLocal, spotsLeft } = params;

  const capacity =
    spotsLeft === null
      ? `<p class="nudge">This fixture is already full. Adding a guest puts it over the limit — which is allowed, and everyone will see that you did it deliberately.</p>`
      : spotsLeft === 1
        ? `<p>One place left.</p>`
        : `<p>${spotsLeft} places left.</p>`;

  const body = `
    <div class="prose">
    <h1>Add a guest</h1>
    <p>${escapeHtml(gameName)} — ${escapeHtml(kicksOffAtLocal)}</p>
    <p>Someone playing just this once. They won't be emailed — you'll need to tell them yourself, and they keep no place in the squad afterwards.</p>
    ${capacity}
    </div>
    <form method="post" action="${escapeHtml(ownerGuestPath(gameId, fixtureId))}" class="guest-form">
      <div class="field">
        <label for="guest-name">Their name</label>
        <input id="guest-name" name="name" type="text" maxlength="80" required autofocus>
      </div>
      <button class="button primary" type="submit">Add guest</button>
    </form>
    <p class="back-link"><a href="${escapeHtml(fixturePath(gameId, fixtureId))}">Back to the fixture</a></p>
  `;

  return layout({
    nav: params.nav,
    title: `Add a guest — ${gameName} — Make The Team`,
    body,
    pageStyles: [FORM_CSS],
  });
}
