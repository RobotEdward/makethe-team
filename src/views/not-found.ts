import { layout } from "./layout.js";

/**
 * The page behind every 404 a person can land on by following a link (M38).
 *
 * Replaces `c.text("Not found", 404)` on the GET routes a shared link
 * actually reaches — `/g/:id` and its fixture pages, and `/j/:token`.
 *
 * **Not the app-wide `notFound` fallback**, which this comment claimed until
 * M52 and never covered. That one stays a bare string on purpose: an unrouted
 * path is reached by a scanner rather than by a person tapping a link, and an
 * HTML page titled "Make The Team" would tell a probe the product and the
 * stack. `test/routes/not-found.test.ts` pins it, with five scanner paths
 * beside it. The POST handlers keep the bare text too: nobody arrives at one
 * by tapping a link in a group chat, and somebody who submitted a form whose
 * token died mid-session is not who this page is written for.
 *
 * **The body is a constant, and that is the security property.** TR-18 makes
 * a refusal a 404 rather than a 403 so that a game id cannot be probed:
 * `findGameForOwner` collapses "no such game", "not a member", "not an owner"
 * and "membership deactivated" into one answer, and this page must not undo
 * that by wording the four differently. It says the same thing when the game
 * does not exist as when it exists and the reader is not in it — which is
 * also why it can only *suggest* causes rather than name one. Same reasoning,
 * and the same byte-identical property, as `renderLinkProblemPage`.
 *
 * What it adds over "Not found" is the two things that actually recover the
 * situation, both learned from a real report: an organiser pasted a `/g/`
 * status link into a WhatsApp group as a sign-up link, and the one person not
 * yet in the squad hit this route and was told nothing at all. So the page
 * names the invite link's distinct shape, and it names the wrong-address case
 * — `requirePlayer` catches a session with no Player at all and says so
 * (`src/auth/session.ts`), but somebody signed in under a second address that
 * *does* have a Player elsewhere falls past that guard into this page.
 */
export function renderNotFoundPage(): string {
  // Three short lines, not three paragraphs of explanation. `p` has no margin
  // (`layout()`'s base sheet), so every seam between paragraphs here reads as
  // one block of prose — and `centred` is documented for pages that say one
  // thing. Adding a `<style>` block to space them out would mean another
  // entry in `STYLE_BLOCKS` to forget; shorter copy is the cheaper answer and
  // the better one.
  const body = `
    <h1>We can't find that page</h1>
    <p>This link may be for a game you're not in, or you may be signed in with a different email address from the one your squad knows.</p>
    <p>Invited to a squad? Ask for the invite link &mdash; it has a <strong>/j/</strong> in it and needs no sign-in.</p>
    <p><a href="/">Back to Make The Team</a></p>
  `;
  return layout({ title: "We can't find that page — Make The Team", body, centred: true });
}
