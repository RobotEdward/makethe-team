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
  .squad .set-by { display: block; font-size: 0.85rem; color: var(--mut); }
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
/**
 * The cancellation confirmation form. Lives here rather than in
 * `src/views/cancel.ts` because every page-specific block must be a member of
 * `PAGE_STYLE_BLOCKS` — `src/security/csp.ts` hashes exactly that set, and a
 * block defined outside it is silently dropped by the browser. This one
 * arrived from M4, which had its own two-hash CSP and no enumeration to join;
 * the merge caught it because the CSP test checks what each page actually
 * renders rather than the header string.
 */
export const CANCEL_STYLES_CSS = `
  .cancel-form { margin-top: 1.5rem; text-align: left; }
  .cancel-form label { display: block; margin-bottom: 0.4rem; color: var(--fg); font-weight: 600; }
  .cancel-form textarea {
    width: 100%; min-height: 6rem; padding: 0.7rem 0.85rem;
    border-radius: 0.6rem; border: 1px solid var(--line);
    background: var(--bg); color: var(--fg); font: inherit; font-size: 1rem;
  }
  .cancel-form textarea:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .cancel-form .hint { margin-top: 0.4rem; font-size: 0.85rem; }
  .cancel-form .button.danger {
    margin-top: 1.25rem; width: 100%;
    background: var(--warn-bg); border-color: var(--warn); color: var(--warn);
  }
  .form-error {
    margin-top: 1rem; padding: 0.7rem 1rem; border-radius: 0.6rem;
    background: var(--warn-bg); color: var(--warn); font-size: 0.95rem; text-align: left;
  }
  .cancel-heading { text-align: center; margin-top: 0; color: var(--warn); }
`;

/**
 * Forms and owner pages: left-aligned, wider than the shared 30rem column,
 * with real labels above real inputs.
 *
 * The shared `STYLES` block centres `main` and sets `text-align: center`,
 * which is right for the single-purpose pages it was written for and wrong
 * for anything with more than three fields. This overrides both rather than
 * loosening the shared block, so no existing page moves.
 */
export const FORM_CSS = `
  main { max-width: 40rem; text-align: left; }
  h1 { text-align: left; }
  .field { margin: 1.1rem 0; }
  .field label { display: block; font-weight: 600; margin-bottom: 0.3rem; }
  .field input, .field select {
    width: 100%; padding: 0.6rem 0.7rem; font: inherit;
    color: var(--fg); background: var(--bg);
    border: 2px solid var(--line); border-radius: 0.5rem;
  }
  .field input:focus-visible, .field select:focus-visible {
    outline: 3px solid var(--accent); outline-offset: 1px;
  }
  .field .error { display: block; margin-top: 0.3rem; color: var(--warn); font-size: 0.9rem; }
  .field-invalid input, .field-invalid select { border-color: var(--warn); }
  .row { display: flex; gap: 1rem; }
  .row .field { flex: 1; }
  details { margin: 1.5rem 0; border-top: 1px solid var(--line); padding-top: 1rem; }
  summary { cursor: pointer; font-weight: 600; }
  .actions { display: flex; gap: 0.75rem; margin-top: 1.75rem; }
  .qr { margin: 1rem 0; max-width: 240px; }
  .invite-link { display: flex; gap: 0.5rem; align-items: center; }
  .invite-link input { flex: 1; font-family: ui-monospace, monospace; font-size: 0.85rem; }
  .squad { list-style: none; padding: 0; }
  .squad li { padding: 0.5rem 0; border-bottom: 1px solid var(--line); }
  /* A squad row is a name plus two controls, one of which is a block-level
     form element. Without a layout they stack into three lines per member and
     the list reads as a mess. The form's own margin is zeroed because it is a
     block-level element and carries one.
     (No literal tag written here — test/routes/join.test.ts parses the first
     form element out of a rendered page, and a tag inside a style block is
     indistinguishable from a real one to that parser.)

     Grid, not flex. Flex wrapping made the row's shape depend on how long the
     member's name happened to be: at 390px a short name pulled the button up
     onto its line and pushed the Remove link down alone, while a longer name
     took a line of its own with both controls beneath — two rows of identical
     markup laid out differently, which reads as broken. Found by the browser
     suite's visual capture; no string assertion could see it. Grid fixes the
     columns, so every row has the same shape whatever the name. */
  .squad li {
    display: grid; grid-template-columns: 1fr auto auto;
    align-items: center; gap: 0.5rem 0.75rem;
  }
  .squad li form { margin: 0; }
  /* The shared 52px tap target is kept — this only stops the button growing
     to the row's full width the way it does inside .responses / .actions. */
  .squad li .button { width: auto; font-size: 0.95rem; padding: 0.6rem 1rem; }
  /* Below this width the name and a button like "Make an ordinary member"
     cannot share a line without squeezing one of them. Rather than let that
     happen per-name, the name takes the whole first line for every member and
     the two controls sit together beneath it — one shape for every row. */
  @media (max-width: 30rem) {
    .squad li { grid-template-columns: 1fr auto; }
    .squad li .member { grid-column: 1 / -1; }
  }
  .problem { margin-top: 1rem; padding: 0.7rem 1rem; border-radius: 0.6rem; background: var(--warn-bg); color: var(--warn); font-size: 0.95rem; text-align: left; }
`;

/**
 * The team picker on the owner's fixture page (BR-35, M9).
 *
 * Every row is a radio group, and the whole picker is one form, because the
 * page must work with JavaScript off — so this block only has to make a
 * stack of radios readable, never to fake a drag-and-drop affordance. Task
 * 7's enhancement layers on top of exactly this markup and must not need the
 * layout to change underneath it.
 *
 * `fieldset`/`legend` are reset to nothing visual: the fieldset is here so
 * that a screen reader announces the player's name before the two side
 * choices, not for the browser's default box, which would put a border round
 * every member of the squad.
 */
export const TEAM_PICKER_CSS = `
  .teams { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
  .teams li { border-bottom: 1px solid var(--line); }
  .teams fieldset { margin: 0; padding: 0.4rem 0.1rem; border: 0; }
  /* Floated so the name sits on the text flow above the choices rather than
     in the fieldset's default notched border position, which several
     browsers place inconsistently once the border is removed. */
  .teams legend { float: left; width: 100%; padding: 0; font-weight: 600; }
  .teams .sides { clear: both; display: flex; flex-wrap: wrap; gap: 0.25rem 0.9rem; }
  /* A 44px-tall hit area for each choice, so a side can be picked on a phone
     without hitting the radio dot itself. */
  .teams .sides label {
    display: inline-flex; align-items: center; gap: 0.35rem;
    min-height: 44px; font-size: 0.95rem; color: var(--mut);
  }
  .teams .sides input { width: 1.1rem; height: 1.1rem; accent-color: var(--accent); }
  /* The drag-and-drop columns (Task 7). They ship hidden and only
     TEAM_PICKER_JS reveals them, so the default here must be display: none.
     An unconditional display: flex would beat the user-agent rule that makes
     the hidden attribute mean anything, and every scripting-off visitor would
     be shown two empty boxes they cannot put a name into. */
  .team-columns { display: none; }
  .team-columns:not([hidden]) { display: flex; gap: 1rem; margin: 0.75rem 0; }
  .team-column { flex: 1 1 0; min-width: 0; }
  .team-column h3 { margin: 0 0 0.25rem; font-size: 1rem; }
  /* Tall enough to be a target while empty — a drop area with no height is a
     side an organiser cannot pick until somebody is already on it. */
  .team-drop { min-height: 3.5rem; }
  .teams li.dragging { opacity: 0.5; }
  .teams.over { outline: 2px dashed var(--accent); outline-offset: 2px; }
  .team-counts { display: flex; gap: 1.25rem; margin: 0.75rem 0; font-weight: 600; }
  .team-counts .count { color: var(--mut); font-weight: 400; }
  .team-note { margin: 0.5rem 0; color: var(--mut); font-size: 0.95rem; }
  /* The one line a player must not be able to miss: which side they are on
     (BR-35 §5). Given the accent colour and the weight the response headline
     uses, because it is the same kind of statement — what is true of you —
     and it has to survive being read next to two full line-ups. */
  .your-side { margin: 1rem 0 0.5rem; font-size: 1.2rem; font-weight: 700; color: var(--accent); }
`;

export const PAGE_STYLE_BLOCKS = [
  FIXTURE_STYLES_CSS,
  TEAM_PICKER_CSS,
  SQUAD_STYLES_CSS,
  DASHBOARD_STYLES_CSS,
  SIGNIN_STYLES_CSS,
  PASSKEY_STYLES_CSS,
  CANCEL_STYLES_CSS,
  FORM_CSS,
] as const;

export type PageStyleBlock = (typeof PAGE_STYLE_BLOCKS)[number];

/**
 * The complete set of `<style>` blocks the app can ever emit — `STYLES` plus
 * every page-specific block above. This is the one value a CSP's
 * `style-src` hashing should map over (see the module comment).
 */
export const STYLE_BLOCKS = [STYLES, ...PAGE_STYLE_BLOCKS] as const;
