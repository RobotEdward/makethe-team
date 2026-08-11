import { STYLES } from "./layout.js";

/**
 * Every page-specific inline `<style>` block this app can emit, in one place.
 *
 * `layout()`'s shared primitives (tokens, body, typography, buttons) live in
 * `STYLES` in `src/views/layout.ts` and go on every page. Everything a
 * *particular* page needs beyond that belongs in this file as its own named
 * export, added to `PAGE_STYLE_BLOCKS` below — never written as an inline
 * template literal at a `layout()` call site. `layout()`'s `pageStyles`
 * parameter is typed as `PageStyleBlock`, the union of exactly the blocks
 * listed in `PAGE_STYLE_BLOCKS`, so a block that exists but was never added
 * to the array fails to *compile* at the call site rather than silently
 * shipping.
 *
 * That compile failure is not decoration. The sibling M4 branch (unmerged as
 * of this file) adds a Content-Security-Policy whose `style-src` allows
 * inline styles by SHA-256 hash of their exact text — computed at runtime
 * from exported style constants, never pasted, so the header can't go stale
 * — with no `'unsafe-inline'` and no `'unsafe-hashes'`. Once merged,
 * `src/security/csp.ts` must hash every entry of `STYLE_BLOCKS` below (which
 * is `STYLES` plus every member of `PAGE_STYLE_BLOCKS`) rather than the two
 * hardcoded imports it has today, so a future block only has to be added
 * here to be covered automatically. A page-specific `<style>` block that is
 * not in this enumeration is invisible to that hashing: the browser drops
 * it, the page's CSS silently vanishes, and no fetch-level test — which
 * never runs a CSP engine — will fail. The type constraint above is what
 * turns "silently vanishes" into "does not compile".
 */

/**
 * The single-fixture page's display of a game — venue, kickoff time, status
 * badge, spots left, the viewer's own headline, the read-only notice, and
 * the two response buttons' layout. Also used by the dashboard (J7, BR-25),
 * which renders one of these per fixture using the *same* renderers
 * (`renderStatusLine`, `viewerHeadlineOpen` in `src/views/fixture.ts`) as the
 * single-fixture page, so it needs the identical CSS rather than a
 * second copy that could drift from it.
 */
export const FIXTURE_STYLES_CSS = `
  .venue, .kickoff { font-size: 0.95rem; }
  .kickoff { margin-bottom: 0.75rem; }

  .status-badge {
    display: inline-block; margin-top: 0.5rem;
    padding: 0.3rem 0.85rem; border-radius: 999px; border: 1px solid var(--line);
    font-weight: 600; font-size: 0.9rem; color: var(--fg);
  }
  .status-badge.status-confirmed { border-color: var(--accent); color: var(--accent); }
  .status-badge.status-short, .status-badge.status-cancelled { border-color: var(--warn); color: var(--warn); }
  .spots { margin-top: 0.4rem; font-size: 0.9rem; }

  .viewer-headline {
    margin-top: 1.5rem; font-size: 1.4rem; font-weight: 700; color: var(--fg); line-height: 1.3;
  }
  /* A waitlisted viewer must never read as confirmed (BR-5): same warn
     colour the squad list already uses for a waitlisted row, so it is
     visually distinct from the accent-coloured "confirmed" badge that can
     appear right below it. */
  .viewer-headline.warn { color: var(--warn); }

  .read-only {
    margin-top: 1.25rem; padding: 0.85rem 1rem; border-radius: 0.6rem;
    border: 1px dashed var(--line); color: var(--mut); font-size: 0.95rem; text-align: left;
  }

  /* Two big, unmistakable tap targets: stacked on a phone, side by side once
     there is room for both without cramping. */
  .responses {
    display: flex; flex-direction: column; gap: 0.75rem;
    margin: 1.5rem 0 0.5rem;
  }
  @media (min-width: 30rem) {
    .responses { flex-direction: row; }
  }
`;

/**
 * The squad list at the bottom of the single-fixture page. Not shared with
 * the dashboard: BR-25 keeps the dashboard to the viewer's own commitments
 * and it never renders another player's row at all (see `DashboardRow` in
 * `src/views/dashboard.ts`), so there is no list here for this CSS to style.
 *
 * "Squad" is the sanctioned domain term (see `SquadMember` in
 * `src/db/queries.ts`). This block used to be named `.roster` purely to keep
 * the word "squad" off the holding page, back when this whole stylesheet was
 * inlined into every page including that one — a workaround, not a naming
 * choice. Now that the holding page only ever receives `STYLES` from
 * `layout.ts` and none of the page-specific blocks below, that leak is gone
 * and the class is named for what it is again.
 */
export const SQUAD_STYLES_CSS = `
  .squad {
    list-style: none; margin: 0; padding: 0; text-align: left;
    border-top: 1px solid var(--line);
  }
  .squad li {
    display: flex; align-items: baseline; justify-content: space-between; gap: 1rem;
    padding: 0.6rem 0.1rem; border-bottom: 1px solid var(--line);
  }
  .squad .name { color: var(--fg); }
  .squad .status { font-size: 0.85rem; color: var(--mut); white-space: nowrap; }
  .squad .status-in { color: var(--accent); font-weight: 600; }
  .squad .status-waitlisted { color: var(--warn); font-weight: 600; }
`;

/**
 * Cards for the dashboard's list of fixtures (J7, BR-25). Each one repeats
 * the single-fixture page's own stack of elements (heading, kickoff, venue,
 * status badge, headline, buttons — styled by `FIXTURE_STYLES_CSS` above) at
 * a smaller scale, so the two pages read as one product rather than two
 * visual languages.
 *
 * "Fixture" is the sanctioned domain term. This block used to be named
 * `.game-list`/`.game-card` — a workaround for the same holding-page leak
 * `SQUAD_STYLES_CSS` describes, from back when this CSS was unconditionally
 * inlined into the public holding page too and so had to dodge every word
 * `test/routes/access.test.ts` forbids there. It is dashboard-only CSS now,
 * never reaching that page, so the workaround is gone with it.
 */
export const DASHBOARD_STYLES_CSS = `
  .fixture-list { list-style: none; margin: 1.5rem 0 0; padding: 0; }
  .fixture-card {
    padding: 1.1rem 1rem 1.25rem; margin-bottom: 1rem;
    border: 1px solid var(--line); border-radius: 0.75rem;
  }
  .fixture-card h2 { margin: 0 0 0.25rem; font-size: 1.25rem; text-align: center; }
  .fixture-card .viewer-headline { margin-top: 0.9rem; font-size: 1.1rem; }
  .fixture-card .responses { margin-bottom: 0; }
`;

/**
 * The sign-in page's email form. Nowhere else needs it: the refusal pages
 * and the "check your inbox" page in `src/views/signin.ts` only ever use the
 * global `.nudge`/`.button`/`.signout` primitives.
 *
 * The same stacked, full-width, big-tap-target shape as `.button` and
 * `.responses`, so this page and the response pages read as one product. The
 * input borrows the button's border, radius and height rather than
 * introducing a second control style.
 */
export const SIGNIN_STYLES_CSS = `
  .signin { display: flex; flex-direction: column; gap: 0.6rem; margin: 1.5rem 0 0.5rem; }
  .signin label { text-align: left; font-size: 0.95rem; color: var(--mut); }
  .signin input {
    width: 100%; min-height: 52px; padding: 0.85rem 1rem;
    border-radius: 0.65rem; border: 2px solid var(--line);
    background: var(--bg); color: var(--fg); font: inherit; font-size: 1.05rem;
  }
  .signin input:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .signin .button { margin-top: 0.25rem; }
`;

/**
 * The passkey affordance, on the two pages that have one: the sign-in page's
 * "sign in with a passkey" button and `/app/passkeys`' "add a passkey" button
 * plus its list of the ones already registered.
 *
 * Its own block rather than an extension of `SIGNIN_STYLES_CSS` because the
 * passkeys page has no email form and the sign-in page has no list, so
 * sharing one block would ship each page rules it cannot use.
 *
 * Both affordances ship `hidden` and are revealed by script
 * (`src/views/scripts.ts`). Nothing here reserves space for them or draws a
 * separator above them, so a browser that never runs that script sees a page
 * indistinguishable from the one before passkeys existed — which is also why
 * `[hidden] { display: none !important; }` is in `STYLES`: `.passkey`'s
 * `display: flex` would otherwise beat the UA default and reveal a button to
 * exactly the people who cannot use it.
 */
export const PASSKEY_STYLES_CSS = `
  .passkey { display: flex; flex-direction: column; gap: 0.6rem; margin: 1.5rem 0 0.5rem; }
  .passkey p { font-size: 0.95rem; }

  .passkey-list {
    list-style: none; margin: 1.25rem 0 0; padding: 0; text-align: left;
    border-top: 1px solid var(--line);
  }
  .passkey-list li {
    padding: 0.6rem 0.1rem; border-bottom: 1px solid var(--line); color: var(--fg);
  }
`;

/**
 * Every page-specific block, for `layout()`'s `pageStyles` parameter to be
 * typed against. See the module comment above for what enforces membership.
 */
export const PAGE_STYLE_BLOCKS = [
  FIXTURE_STYLES_CSS,
  SQUAD_STYLES_CSS,
  DASHBOARD_STYLES_CSS,
  SIGNIN_STYLES_CSS,
  PASSKEY_STYLES_CSS,
] as const;

export type PageStyleBlock = (typeof PAGE_STYLE_BLOCKS)[number];

/**
 * The complete set of `<style>` blocks the app can ever emit — `STYLES` plus
 * every page-specific block above. This is the one value a CSP's
 * `style-src` hashing should map over (see the module comment).
 */
export const STYLE_BLOCKS = [STYLES, ...PAGE_STYLE_BLOCKS] as const;
