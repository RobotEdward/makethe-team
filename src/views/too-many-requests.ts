import { layout } from "./layout.js";

/**
 * What a throttled caller gets from `src/security/rate-limit.ts`.
 *
 * A sibling of `renderLinkProblemPage` rather than a reuse of it, because the
 * advice has to differ. That page tells a player their link may have expired
 * and to ask their organiser for a fresh one. For a throttle that is wrong on
 * both counts: the link is fine, and a new one would behave identically —
 * following the advice wastes the player's time and puts the support burden on
 * an organiser who cannot do anything about it.
 *
 * Says nothing about which limit was hit, for the same reason
 * `renderLinkProblemPage` does not branch on why a token failed: a page that
 * distinguished "this link is busy" from "your address is busy" would tell a
 * prober which of the two dimensions they had tripped, and a player can act on
 * neither.
 *
 * Passes no `pageStyles`, so it emits no `<style>` block of its own and needs
 * no entry in `PAGE_STYLE_BLOCKS` — see `src/security/csp.ts` and the note in
 * `CLAUDE.md` about blocks that are silently dropped in production.
 */
export function renderTooManyRequestsPage(): string {
  const body = `
    <h1>Too many requests</h1>
    <p>This link has been used a lot in the last minute, so we've paused it briefly.</p>
    <p>Wait a moment and try again — your link still works, and nothing you've already done has been lost.</p>
  `;
  return layout({ title: "Too many requests — Make The Team", body, centred: true });
}
