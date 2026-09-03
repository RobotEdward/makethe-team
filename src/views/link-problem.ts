import { SIGN_IN_PATH } from "../auth/paths.js";
import { layout } from "./layout.js";

/**
 * One shared "this link isn't working" page for every way a player's link can
 * fail to do anything useful: a token that will not verify, a fixture that no
 * longer exists, and — via `app.onError` — an unexpected server fault on the
 * same path.
 *
 * Deliberately not branching on the reason (bad signature, expired,
 * malformed, fixture-not-found, D1 error, `LocalTimeError`): distinguishing
 * them would turn the page into an oracle that tells a prober which guesses
 * were closer to a real token, and would leak internals to a player who can
 * do nothing with them. The real reason always goes to `console.error` for
 * operators instead. Because the body is a constant with no inputs, the
 * byte-identical property the route tests pin holds by construction.
 *
 * It lives in `views/` rather than inside the route module because the error
 * handler in `src/app.ts` needs it too, and the one thing this page must
 * never become is two pages that drift apart.
 *
 * **The first thing it offers is something the reader can do alone.** Until
 * M55 both routes off this page went through somebody else: ask the organiser
 * for a fresh link, or contact them directly. Most people who land here have
 * an account already — the link they tapped was emailed to it — and signing
 * in reaches the same fixture with no link at all. Sending them to interrupt
 * a volunteer for a page they can open themselves was the wrong order.
 * `SIGN_IN_PATH` is a module constant, so the body is still constant and the
 * byte-identical property above still holds by construction.
 *
 * The *status* is the caller's choice, and the two callers differ on purpose
 * — see `renderLinkProblemPage`'s users. An expected token failure answers
 * 200 (the link the player tapped is not gone or malformed from HTTP's point
 * of view, and neither their mail client nor a prefetcher ahead of them
 * should see an error status for an ordinary page). An unexpected throw
 * answers 500, because something really did break server-side and both
 * Cloudflare's metrics and any future alerting must record it as such.
 */
export function renderLinkProblemPage(): string {
  const body = `
    <h1>This link isn't working</h1>
    <p>It may have expired, already been used for a fixture that's since finished, or been copied incorrectly.</p>
    <p>If you have an account, <a href="${SIGN_IN_PATH}">sign in</a> — your games are all there, and you can answer a fixture from one without needing a link at all.</p>
    <p>If you don't, ask whoever organises your game to send you a fresh link, or get in touch with them directly.</p>
  `;
  return layout({ title: "This link isn't working — Make The Team", body, centred: true });
}
