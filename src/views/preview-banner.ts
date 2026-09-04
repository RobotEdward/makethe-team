import { escapeHtml } from "./layout.js";

/**
 * The organiser's preview banner (M61), shared by `player-game.ts` and
 * `player-fixture.ts` so the two cannot word it differently or offer
 * different ways back.
 *
 * `undefined` on every ordinary member's page — the banner is only ever for
 * somebody who has another page to go back to. A member has none, and telling
 * them they are "seeing this as a player" would be telling them nothing.
 */
export interface PreviewParams {
  /** Where "Back to the organiser view" goes: the same URL without the flag. */
  backPath: string;
}

/**
 * The global `.nudge` primitive rather than a class of its own. Every
 * `<style>` block has to be hashed into `PAGE_STYLE_BLOCKS` to reach the
 * browser at all (`src/security/csp.ts`), and a one-rule block would be a
 * whole registration to keep in step for a banner that already looks the way
 * an advisory line on this site looks.
 */
export function renderPreviewBanner(preview: PreviewParams | undefined): string {
  if (preview === undefined) return "";
  // Two paragraphs, not one sentence carrying a link: at 390px the single
  // line wrapped mid-link, breaking "Back to the organiser view" across two
  // rows with "view" alone on the second. Each fits its own line.
  return `<div class="nudge">
    <p>You're seeing this as a player.</p>
    <p><a href="${escapeHtml(preview.backPath)}">Back to the organiser view</a></p>
  </div>`;
}
