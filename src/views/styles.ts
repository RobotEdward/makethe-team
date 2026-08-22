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
 * badge, the capacity bar, the viewer's own headline, the read-only notice, and
 * the two response buttons' layout. Also used by the dashboard (J7, BR-25),
 * which renders one of these per fixture using the *same* renderers
 * (`renderStatusLine`, `viewerHeadlineOpen` in `src/views/fixture.ts`) as the
 * single-fixture page, so it needs the identical CSS rather than a
 * second copy that could drift from it.
 */
export const FIXTURE_STYLES_CSS = `
  .venue, .kickoff { font-size: var(--t-body); }
  .kickoff { margin-bottom: 0.75rem; }

  .status-badge {
    display: inline-block; margin-top: 0.5rem;
    padding: 0.3rem 0.85rem; border-radius: 999px; border: 1px solid var(--line);
    font-weight: 600; font-size: var(--t-support); color: var(--fg);
  }
  .status-badge.status-confirmed { border: none; background: var(--ok-fg); color: var(--ok-bg); }
  .status-badge.status-short { border: none; background: var(--ok-bg); color: var(--ok-fg); }
  .status-badge.status-cancelled { border: none; background: var(--accent-mut); color: var(--warn); }
  .status-badge.status-open { border: none; background: var(--ok-bg); color: var(--ok-fg); }
  .status-badge.status-played, .status-badge.status-scheduled { border: none; background: var(--field); color: var(--mut); }
  /* The headcount as a proportion rather than a countdown (M12 §3.1): a bar
     whose fill is who is there, with the numbers under it so nothing is lost
     when the CSS does not load. */
  .capacity { margin-top: 0.6rem; }
  .capacity .track { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
  .capacity .fill { display: block; height: 100%; background: var(--ok); }
  .capacity .fill.short { background: var(--wait); }
  .capacity .spots { margin-top: 0.35rem; font-size: var(--t-support); color: var(--mut); }
  .capacity .count { font-family: var(--mono); }

  /* The width is a class, never a style attribute. style-src is hashes plus
     one font origin and no unsafe-hashes, so a style attribute cannot be
     authorised by a hash: the browser would drop it, the bar would render at
     zero width, and no fetch-level test — none of which run a CSP engine —
     would notice. Generated rather than typed so these twenty-one rules
     cannot drift from the twenty-one 5% steps the renderer can emit. */
${Array.from({ length: 21 }, (_, i) => `  .capacity .fill.w-${i * 5} { width: ${i * 5}%; }`).join("\n")}

  /* The answer block (M20 B7): the viewer's own state — headline, controls or
     the closed-page sentence, and the pre-tap warning — in one card, so it is
     read once rather than picked out of a run of fixture facts. Each tint
     follows the state class, so a colour change never needs a markup change:
     waiting is amber, going is the settled green, closed is the quiet field
     grey, and open and declined keep the plain raised card. */
  .answer {
    margin: 1rem 0; padding: 1.1rem 1.25rem;
    border-radius: 1.25rem; background: var(--card-raised);
  }
  .answer .viewer-headline { margin-top: 0; }
  .answer .responses { margin-top: 1rem; }
  .answer.answer-waiting { background: var(--warn-bg); }
  .answer.answer-going { background: var(--ok-bg); }
  .answer.answer-closed { background: var(--field); }
  /* Inside an amber block the amber "waiting" button would disappear into its
     own background, so it takes the stronger wait fill there. */
  .answer.answer-waiting .button.chosen-waiting { background: var(--wait); color: var(--wait-fg); }
  /* The closed block is already the card, so the notice inside it drops the
     second panel it would otherwise draw. */
  .answer.answer-closed .read-only { margin-top: 0; padding: 0; background: none; }

  .viewer-headline {
    margin-top: 1.5rem; font-size: var(--t-lead); font-weight: 700; color: var(--fg); line-height: 1.3;
  }
  /* A waitlisted viewer must never read as confirmed (BR-5): same warn
     colour the squad list already uses for a waitlisted row, so it is
     visually distinct from the accent-coloured "confirmed" badge that can
     appear right below it. */
  .viewer-headline.warn { color: var(--warn); }

  .read-only {
    margin-top: 1.25rem; padding: 0.85rem 1rem; border-radius: 1.25rem;
    border: none; background: var(--card-raised); color: var(--mut); font-size: var(--t-body); text-align: left;
  }

  /* Paragraphs get zero margin by default (the layout's base rule), so a
     closing paragraph that follows a .read-only box — which carries no
     bottom margin of its own — would otherwise butt straight up against it
     and read as one run of text. Spacing is opt-in per paragraph, the same
     way .viewer-headline and .kickoff already are above, rather than a
     change to the base rule that would ripple through every other page. */
  .back-link { margin-top: 1.5rem; }

  /* Two big, unmistakable tap targets: stacked on a phone, side by side once
     there is room for both without cramping. */
  .responses {
    display: flex; flex-direction: column; gap: 0.75rem;
    margin: 1.5rem 0 0.5rem;
  }
  @media (min-width: 30rem) {
    .responses { flex-direction: row; }
  }

  /* The answer, in the control that set it (M10 §3.1). Each state is a fill
     plus a distinct label or glyph, never colour alone -- the tick on
     "chosen-in" and the "· waiting" on "chosen-waiting" are what make the
     three states tellable apart without seeing colour at all. */
  .button.chosen-in {
    background: var(--accent); color: var(--accent-fg);
  }
  .button.chosen-waiting {
    background: var(--warn-bg); color: var(--warn);
  }
  .button.chosen-out {
    background: var(--line); color: var(--fg);
  }

  .full-warning { margin: 0.5rem 0 0; font-size: var(--t-support); color: var(--mut); }
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
  /* Rows: the organiser's fixture page only (still a ul.squad). The player's
     page groups into chips below — the organiser is acting on individuals, not
     scanning — and its own squad wrapper is a div, not a ul, precisely so a
     bare ".squad li" cannot also select a chip: a chip is an li too
     (li.chip inside ul.chips inside div.squad), and would otherwise inherit
     this row's flex/justify-content/border layout. Scoped to ul.squad > li so
     only the organiser's rows are ever selected. */
  ul.squad > li {
    display: flex; align-items: baseline; justify-content: space-between; gap: 1rem;
    padding: 0.6rem 0.1rem; border-bottom: 1px solid var(--line);
  }
  .squad .name { color: var(--fg); }
  .squad .status { font-size: var(--t-support); color: var(--mut); white-space: nowrap; }
  .squad .status-in { color: var(--accent); font-weight: 600; }
  .squad .status-waitlisted { color: var(--warn); font-weight: 600; }
  .squad .set-by { display: block; font-size: var(--t-support); color: var(--mut); }

  /* Chips: the player's fixture page (M10 §3.5). */
  .squad-group { margin: 0 0 1.1rem; }
  .group-head { display: flex; align-items: baseline; gap: 0.5rem; margin: 0 0 0.4rem; }
  .group-label { font-weight: 600; color: var(--fg); font-size: var(--t-support); }
  .group-count { font-family: var(--mono); font-size: var(--t-support); color: var(--mut); }
  .chips { list-style: none; display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0; padding: 0; }
  .chip {
    padding: 0.3rem 0.65rem; border-radius: 999px;
    font-size: var(--t-support); background: var(--field); color: var(--mut);
  }
  .chip-in { background: var(--accent-mut); color: var(--accent); }
  .chip-waitlisted { background: var(--warn-bg); color: var(--warn); }
  /* The viewer's own chip (M10 §3.5): a solid fill of the group's own colour
     family, so "am I counted?" is answered by colour, not by hunting for a
     name. chip-in and chip-waitlisted each have an accent family above to
     invert to a solid version of; chip-out and chip-pending have none —
     both fall back to the plain neutral chip tint above without their own
     rule — so they get an explicit solid fg/bg inversion instead of
     silently keeping the unhighlighted tint. Text stays the player's real
     name throughout; this is a colour cue only. */
  .chip-in.chip-you, .chip-waitlisted.chip-you, .chip-out.chip-you, .chip-pending.chip-you {
    background: var(--fg); color: var(--bg); font-weight: 600;
  }
  .set-by { display: block; margin: 0.4rem 0 0; font-size: var(--t-support); color: var(--mut); }
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
    border: none; border-radius: 1.25rem; background: var(--card-raised);
  }
  .fixture-card h2 { margin: 0 0 0.25rem; font-size: var(--t-lead); }
  /* Still 0.9rem for the account page's history row, which wears this same
     card class with a bare headline and no answer block around it. */
  .fixture-card .viewer-headline { margin-top: 0.9rem; font-size: var(--t-lead); }
  /* The dashboard's own card puts that headline inside the answer block, whose
     padding is the gap — so the block's reset must win here. It cannot win on
     order: this file's rule above and the .answer .viewer-headline rule in
     FIXTURE_STYLES_CSS are both (0,2,0), and this block loads second, so the
     0.9rem would silently take a stacked margin inside the block's padding.
     Three classes is the deliberate resolution, and it holds whichever order
     the two blocks are listed in. */
  .fixture-card .answer .viewer-headline { margin-top: 0; }
  .fixture-card .responses { margin-bottom: 0; }

  /* The owned-games section: one row per game the viewer organises, each a
     link into it (M12 §3.5).

     No comment here may quote that section's heading verbatim. This block is
     rendered into the page, so a quoted heading is indistinguishable from the
     real one to the tests that assert an owner-less dashboard never shows it
     — which is exactly how this comment first broke three of them.

     Without a rule here this is the browser's default bulleted list — discs
     and a UA indent — sitting directly under a column of bordered fixture
     cards. It was the last one left in the app: every other list here is
     either a styled row or a chip.

     The row shape is restated rather than borrowed. Widening ul.squad > li to
     reach this markup is banned outright (M10 whole-branch review, Critical
     1): a bare descendant selector is (0,1,1) and beats a chip's own (0,1,0)
     .chip whatever the block order, and this app nests li inside li. Reusing
     the .squad class instead would be the same mistake by another route — a
     game is not a squad member, so the next rule written for a squad row
     would silently restyle this list too.

     Not .fixture-card either: a card up there carries a heading, a status
     badge, a headline and two response buttons, and a row down here is a name
     and nothing else. Borrowing it would put a second, competing card idiom
     in one column.

     Scoped ul.owned-games > li for the same specificity reason ul.squad > li
     and ul.fixtures > li are scoped.

     The anchor carries the 44px floor, not the li: the li's padding is not
     what a finger lands on. Most rows are entirely link, but a row for a game
     the viewer owns (M20 B3) has a trailing ownership note outside the
     anchor — flex-with-space-between on the li keeps that note on the same
     line as the name instead of wrapping under it, which is what a bare block
     anchor (100% width, nothing to its right) did the one time this went
     unstyled and unnoticed until the rendered page was actually looked at.
     Flex items do not grow by default, so the anchor also needs its own
     flex: 1 — without it, a row with no note (the common case, every game the
     viewer does not own) shrinks the anchor to the width of its text and
     leaves the rest of the row looking tappable but dead. */
  /* The bottom margin is not decoration: paragraphs get zero margin from the
     layout's base rule, so the footer's run of account links lands hard
     against the last row's bottom border and reads as a fourth row of this
     list. */
  .owned-games {
    list-style: none; margin: 0.4rem 0 1.1rem; padding: 0; text-align: left;
    border-top: 1px solid var(--line);
  }
  ul.owned-games > li {
    border-bottom: 1px solid var(--line);
    display: flex; align-items: center; justify-content: space-between;
  }
  ul.owned-games > li > a {
    display: flex; align-items: center; min-height: 44px; flex: 1;
    padding: 0.4rem 0.1rem; font-size: var(--t-body);
  }
  ul.owned-games > li > .detail { white-space: nowrap; padding: 0 0.1rem; }

  /* The onboarding card (M19). Its own idiom, not .fixture-card: a card up
     there is a fixture with buttons, and this is a short list of links with a
     dismiss control. */
  .onboarding {
    margin-top: 1.25rem; padding: 1rem 1rem 0.75rem;
    border: none; border-radius: 1.25rem; background: var(--card-raised);
  }
  .onboarding h2 { margin: 0 0 0.25rem; font-size: var(--t-lead); }
  .onboarding ul { list-style: none; margin: 0; padding: 0; }
  .onboarding li a {
    display: flex; align-items: center; min-height: 44px; font-size: var(--t-body);
  }
  .onboarding form { display: flex; justify-content: flex-end; margin-top: 0.25rem; }
  .onboarding .button { flex: 0 0 auto; min-height: 44px; padding: 0.4rem 1rem; font-size: var(--t-support); font-weight: 400; }
  /* The install hint is pointless inside the installed app itself. This is
     the server's only way to know: no script runs on this page, but the
     display mode is a pure CSS fact. */
  @media (display-mode: standalone) {
    .onboarding li.hint-install { display: none; }
  }
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
  .signin label { text-align: left; font-size: var(--t-body); color: var(--mut); }
  .signin input {
    width: 100%; min-height: 52px; padding: 0.85rem 1rem;
    border-radius: 0.65rem; border: 2px solid var(--line);
    background: var(--bg); color: var(--fg); font: inherit; font-size: var(--t-lead);
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
  .passkey p { font-size: var(--t-body); }

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
    background: var(--bg); color: var(--fg); font: inherit; font-size: var(--t-body);
  }
  .cancel-form textarea:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .cancel-form .hint { margin-top: 0.4rem; font-size: var(--t-support); }
  .cancel-form .button.danger { margin-top: 1.25rem; width: 100%; }
  /* The back-out link (M10 §3.7, restored by the whole-branch review's
     Important 3). .button is shared with real button elements, which get no
     underline from the user agent in the first place; every other anchor in
     the app is inline body copy that wants one (STYLES has no blanket rule
     removing it), so an anchor wearing .button is the one place that default
     reads as broken next to a filled control -- without this it renders
     underlined beside the solid red submit above it. Only text-decoration is
     touched: .button already sets display: flex on itself, which is what
     centres its label regardless of the element it is applied to, and margin
     here is the same 1.25rem the danger button above gets so the two read as
     a matched pair. */
  .keep-link { margin-top: 0.75rem; text-decoration: none; }
  .form-error {
    margin-top: 1rem; padding: 0.7rem 1rem; border-radius: 0.6rem;
    background: var(--warn-bg); color: var(--warn); font-size: var(--t-body); text-align: left;
  }
  .cancel-heading { margin-top: 0; color: var(--danger); }
`;

/**
 * Forms and owner pages: left-aligned, wider than the shared 30rem column,
 * with real labels above real inputs.
 *
 * Wider column only. The left alignment that used to be here is the default
 * now (M10 §2.3) and repeating it would hide the fact that it moved.
 */
export const FORM_CSS = `
  main { max-width: 40rem; }
  .field { margin: 1.1rem 0; }
  .field label { display: block; font-weight: 600; margin-bottom: 0.3rem; }
  .field input, .field select, .field textarea {
    width: 100%; padding: 0.6rem 0.7rem; font: inherit;
    color: var(--fg); background: var(--field);
    border: none; border-radius: 0.75rem;
  }
  .field textarea { min-height: 8rem; resize: vertical; }
  .field input:focus-visible, .field select:focus-visible, .field textarea:focus-visible {
    outline: 3px solid var(--accent); outline-offset: 1px;
  }
  .field .error { display: block; margin-top: 0.3rem; color: var(--warn); font-size: var(--t-support); }
  /* The caption above a value the page is only reading out to the viewer, and
     the value itself — the paragraph immediately after it, so the pair carries
     one class between them rather than two names for one idea.

     Deliberately not .read-only: that box's dashed border says there is
     nothing here to act on, which is true of an empty list and false of a
     value, where the border instead reads as a disabled field the viewer
     might once have been able to type into. Nothing on these pages ever was.

     The value is lifted off the base paragraph colour because that colour is
     the same muted grey as the caption, and a caption indistinguishable from
     its own value is no caption at all. The bottom margin is here rather than
     on whatever follows because what follows differs per page. */
  .readout-label { margin-top: 1.1rem; font-size: var(--t-support); color: var(--mut); }
  .readout-label + p { color: var(--fg); margin-bottom: 1.1rem; }
  .field-invalid input, .field-invalid select, .field-invalid textarea { outline: 2px solid var(--warn); outline-offset: 1px; }
  .row { display: flex; gap: 1rem; }
  .row .field { flex: 1; }
  /* A checkbox with a label and an explanatory hint. Written as a grid with
     the control spanning both rows rather than as a .field: a .field puts its
     label above a full-width input, which for a checkbox means a lone 1.4rem
     box floating under its own caption, and the hint then reads as belonging
     to whatever follows. The columns pin the control to the right of both
     lines of text at every width, so the hint can wrap to three lines without
     the tick moving. 52px because the whole row is the label's hit area — a
     bare checkbox is about 22px, well under the phone floor. */
  .switch-row { display: grid; grid-template-columns: 1fr auto; align-items: center;
    gap: 0.25rem 1rem; min-height: 52px; padding: 0.6rem 0; border-bottom: 1px solid var(--line); }
  .switch-row label { font-weight: 600; }
  .switch-row .hint { grid-column: 1; font-size: var(--t-support); color: var(--mut); }
  .switch-row input { grid-column: 2; grid-row: 1 / span 2; width: 1.4rem; height: 1.4rem; accent-color: var(--accent); }
  /* The notification settings section (M26). Each row is a .switch-row, so
     the switch itself needs nothing new; what is new is the timing strip that
     hangs beneath the hint on its own grid row.

     Both inner rules are written .switch-row .notify-timing X, at (0,2,1),
     rather than .notify-timing X at (0,1,1). The (0,1,1) form ties
     .switch-row input and .switch-row label above and would win only by
     coming later in this block — and .switch-row input is not a cosmetic
     tie to lose: it would size every number and time input here to a 1.4rem
     square in grid column 2, on top of the checkbox. Specificity settles it
     instead, so re-ordering this block cannot silently break the section. */
  .notify-group { border: 1px solid var(--line); border-radius: 0.5rem; padding: 0 1rem; margin: 1.5rem 0; }
  .notify-group legend { font-weight: 600; padding: 0 0.3rem; }
  .notify-row:last-of-type { border-bottom: none; }
  .notify-timing { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.5rem; }
  .notify-timing-field { display: flex; flex-direction: column; gap: 0.2rem; }
  .switch-row .notify-timing label { font-weight: 400; font-size: var(--t-support); color: var(--mut); }
  /* The filled-field treatment .field input gives every other control on this
     form, restated rather than inherited: these inputs sit inside a
     .switch-row, not a .field, so without it they render as the browser's
     default thin-bordered boxes among a page of rounded filled ones — visibly
     unfinished, and invisible to any string assertion. */
  .switch-row .notify-timing input {
    grid-column: auto; grid-row: auto; height: auto; max-width: 9rem;
    width: 100%; padding: 0.6rem 0.7rem; font: inherit;
    color: var(--fg); background: var(--field);
    border: none; border-radius: 0.75rem;
  }
  .switch-row .notify-timing input:focus-visible { outline: 3px solid var(--accent); outline-offset: 1px; }
  .switch-row .notify-timing .error { display: block; margin-top: 0.3rem; color: var(--warn); font-size: var(--t-support); }
  /* The fixture-message audience radios (audienceFields in broadcast.ts).
     Without this, .field input above turns each radio into a full-width
     bordered box that centres its own dot, while .field label stacks the
     caption text on the line beneath it — a viewer cannot tell which dot
     belongs to which option (M15 review, Critical 1). Own class rather than
     narrowing .field input: other pages rely on that rule styling a normal
     text/select/textarea input the usual way.
     .audience-group label ties .field label at (0,1,1) — the same tie
     .switch-row label above breaks by coming later in this block; source
     order, not specificity, is what makes this win. .audience-group
     input[type=radio] outranks .field input on specificity alone
     ((0,2,1) vs (0,1,1)), so that half doesn't depend on order. 52px matches
     .switch-row's touch-target floor: the whole row is the label's hit
     area, not just the 1.4rem dot. */
  .audience-group { border: 1px solid var(--line); border-radius: 0.5rem; padding: 0 1rem; }
  .audience-group.field-invalid { border-color: var(--warn); }
  .audience-group legend { font-weight: 600; padding: 0 0.3rem; }
  .audience-group label {
    display: flex; align-items: center; gap: 0.75rem;
    min-height: 52px; padding: 0.4rem 0; margin-bottom: 0; font-weight: 400;
    border-bottom: 1px solid var(--line);
  }
  .audience-group label:last-of-type { border-bottom: none; }
  .audience-group input[type="radio"] {
    flex: 0 0 auto; width: 1.4rem; height: 1.4rem; padding: 0; border: none;
    accent-color: var(--accent);
  }
  details { margin: 1.5rem 0; border-top: 1px solid var(--line); padding-top: 1rem; }
  summary { cursor: pointer; font-weight: 600; }
  .actions { display: flex; gap: 0.75rem; margin-top: 1.75rem; }
  .qr { margin: 1rem 0; max-width: 240px; }
  .invite-link { display: flex; gap: 0.5rem; align-items: center; }
  .invite-link input {
    flex: 1; font-family: var(--mono); font-size: var(--t-support);
    background: var(--field); border: none; border-radius: 0.75rem;
  }
  /* Without this, .button's own flex: 1 (from STYLES) matches .invite-link
     input's flex: 1 above, so the field and the Copy button split the row
     exactly in half regardless of content — on the one page whose whole
     purpose is this URL, truncating it to a fragment like
     "https://makethe.team/j" (M10 whole-branch review, Minor 9). Fixed size,
     content-sized, so the input takes whatever room the button does not need. */
  .invite-link .button { flex: 0 0 auto; }
  .squad { list-style: none; padding: 0; }
  /* Scoped to ul.squad > li, matching SQUAD_STYLES_CSS's identically-shaped
     row rule (see the comment there) — not the bare ".squad li" this used to
     be. The player's page wraps its chips in a div.squad, not a ul, precisely
     so a bare selector here cannot also reach li.chip inside ul.chips inside
     it; a bare ".squad li" beats a chip's own (0,1,0) ".chip" on specificity
     regardless of which <style> block comes later, and did exactly that until
     this was scoped (M10 whole-branch review, Critical 1). */
  ul.squad > li { padding: 0.5rem 0; border-bottom: 1px solid var(--line); }
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
  ul.squad > li {
    display: grid; grid-template-columns: 1fr auto;
    align-items: center; gap: 0.4rem 0.75rem;
  }
  /* Placement, not auto-placement — the half of the grid this rule was
     missing, and the reason a two-part row looked right while a three-part
     one did not.

     The organiser's fixture row is not always a name and a control. It can
     carry a status word, and an attribution line saying who set the answer:
     up to three pieces of text beside the control. Auto-placement walks those
     into whatever cell is free, so on that page the third piece landed in
     column 2 and the control was pushed down into column 1, where the 1fr
     stretched it from the left margin to most of the width — a control of a
     visibly different size and position from the compact one on every row
     above it. The row's shape depended on how many children it happened to
     have, which is the same defect as depending on how long the name is,
     wearing a different coat.

     So the text goes in column 1 and the control in column 2, said out loud.
     The control sits in row 1 — beside the name, not centred against the
     stack. That is a measurement, not a preference. A grid item that spans
     several tracks contributes its height to all of them, so pinning the
     control across the text rows (the .switch-row idiom above, which is right
     for its own two-line row) inflates the empty tracks under a one-line row
     and leaves the name sitting in the top third of it, 13px above the
     control it belongs to. Every row in a real squad has one line of text, so
     that was the common case paying for the rare one. In row 1 the name and
     the control are in the same track, so they are level in every row shape
     this markup can produce, and any support lines hang beneath the pair.

     Nothing here refers to how many pieces of text a row has, so a fourth
     piece would stack under the third and change nothing else.

     A bare text node (the other-squads list on the leave page) has no class
     to select. It does not need one: it is an anonymous item, and with the
     control pinned to column 2 the only cell left for it is column 1. */
  ul.squad > li > .name, ul.squad > li > .status, ul.squad > li > .set-by { grid-column: 1; }
  ul.squad > li > form { grid-column: 2; grid-row: 1; }
  ul.squad > li form { margin: 0; }
  /* The shared 52px tap target is kept — this only stops the button growing
     to the row's full width the way it does inside .responses / .actions. */
  ul.squad > li .button { width: auto; font-size: var(--t-body); padding: 0.6rem 1rem; }
  /* The per-member disclosure (M10 §3.8). Deliberately not the general
     details rule above, which is for the game form's optional sections and
     carries a top border and a 1.5rem margin — fourteen of those would be a
     worse page than the fourteen buttons this replaces. */
  .member-actions { margin: 0; border: 0; padding: 0; }
  .member-actions summary { font-weight: 500; font-size: var(--t-support); color: var(--mut); }
  .member-actions[open] { grid-column: 1 / -1; }
  .member-actions form { margin: 0.5rem 0; }
  /* The segmented mark-in/mark-out (M10 §3.3). A shared rounded track with two
     halves, sized to content — the .button primitive is a 52px full-width tap
     target and two of them per row is what made a fourteen-person squad
     unreadable. 44px keeps each half a legitimate phone target.
     Here, in FORM_CSS, rather than in SQUAD_STYLES_CSS just above: that block
     is shared with the player's own fixture page, which has no controls at
     all (it only ever reads squad state) and must not carry rules for a
     control it can never render. */
  .segment { display: flex; margin: 0; padding: 3px; gap: 3px; border-radius: 999px; background: var(--field); }
  .segment .seg {
    min-height: 44px; padding: 0.5rem 0.9rem; border: 0; border-radius: 999px;
    background: transparent; color: var(--mut);
    font: inherit; font-size: var(--t-support); font-weight: 600; cursor: pointer;
  }
  .segment .seg:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .segment .seg.on { background: var(--ok-fg); color: var(--ok-bg); }
  /* Neutral by design (M20 §2.4): "out" is not a success state and gets no
     colour family of its own, only a raised-card fill against the field
     track so a pressed "Out" still reads as pressed next to the unpressed
     segments beside it. */
  .segment .seg.out { background: var(--card-raised); color: var(--fg); }
  .problem { margin-top: 1rem; padding: 0.7rem 1rem; border-radius: 0.6rem; background: var(--warn-bg); color: var(--warn); font-size: var(--t-body); text-align: left; }
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
  /* The M29 hand-over control. Its own selectors (.picker-control,
     .picker-choice) collide with nothing in any other block — checked
     against test/views/style-cascade.test.ts's enumeration — so it lives
     here rather than in a block of its own, and there is nothing new to
     register in PAGE_STYLE_BLOCKS (src/security/csp.ts). */
  .picker-control { display: flex; flex-direction: column; gap: 0.25rem; align-items: flex-start; }
  /* The same 44px hit area every other radio row on this page gets, for the
     same reason: these are chosen on a phone, standing on a touchline. */
  .picker-choice {
    display: flex; align-items: center; gap: 0.5rem;
    min-height: 44px; font-size: var(--t-body); color: var(--mut);
  }
  .picker-choice input { width: 1.1rem; height: 1.1rem; accent-color: var(--accent); }
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
    min-height: 44px; font-size: var(--t-body); color: var(--mut);
  }
  .teams .sides input { width: 1.1rem; height: 1.1rem; accent-color: var(--accent); }
  /* The drag-and-drop columns (Task 7). They ship hidden and only
     TEAM_PICKER_JS reveals them, so the default here must be display: none.
     An unconditional display: flex would beat the user-agent rule that makes
     the hidden attribute mean anything, and every scripting-off visitor would
     be shown two empty boxes they cannot put a name into. */
  .team-columns { display: none; }
  .team-columns:not([hidden]) { display: flex; gap: 1rem; margin: 0.75rem 0; }
  .team-column {
    flex: 1 1 0; min-width: 0; padding: 0.75rem 0.85rem; border-radius: 1.25rem;
  }
  /* The two sides get their own fill, in source order — the first is the
     success family (a side you can pick with confidence), the second the
     warn family (M20 §2.4), so a scripting-on organiser can tell the columns
     apart by colour as well as by the heading. */
  .team-column:first-child { background: var(--ok-bg); color: var(--ok-fg); }
  .team-column:last-child { background: var(--accent-mut); color: var(--warn); }
  .team-column h3 { margin: 0 0 0.25rem; font-size: var(--t-body); }
  /* Tall enough to be a target while empty — a drop area with no height is a
     side an organiser cannot pick until somebody is already on it. On the
     pool as well as the two columns: with every name dragged onto a side the
     pool is the empty one, and it is the only way to drag somebody back off. */
  .team-drop { min-height: 3.5rem; }
  .teams li.dragging { opacity: 0.5; }
  /* Randomise and Save side by side; flex-wrap so a narrow phone stacks them
     rather than squashing the labels. Randomise ships hidden and flex does
     not override the hidden attribute on a flex *item*, so with scripting
     off the row holds Save alone. */
  .team-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.75rem; }
  /* nowrap: at 390px "Randomise teams" broke across two lines inside its
     button (the capture showed it); wrapping belongs to the row, not the label. */
  .team-actions .button { white-space: nowrap; }
  .teams.over { outline: 2px dashed var(--accent); outline-offset: 2px; }
  .team-counts { display: flex; gap: 1.25rem; margin: 0.75rem 0; font-weight: 600; }
  .team-counts .count { color: var(--mut); font-weight: 400; }
  .team-note { margin: 0.5rem 0; color: var(--mut); font-size: var(--t-body); }
  /* The one line a player must not be able to miss: which side they are on
     (BR-35 §5). Given the accent colour and the weight the response headline
     uses, because it is the same kind of statement — what is true of you —
     and it has to survive being read next to two full line-ups. */
  .your-side { margin: 1rem 0 0.5rem; font-size: var(--t-lead); font-weight: 700; color: var(--accent); }
`;

/**
 * `/privacy` (M7c) — a page of prose, which nothing else in this product is.
 *
 * Its own block rather than reusing `FORM_CSS`: that block widens the column
 * for pages with real forms and carries a dozen rules for inputs, squad rows
 * and disclosures that this page can never render. The only thing the two
 * genuinely share is the wider measure, which is one line.
 *
 * The paired what/why entries are a definition list in spirit but not in
 * markup — a `dl` puts the term and its description in separate boxes that
 * are awkward to keep together when the term is a whole sentence, which
 * every one of these is.
 */
export const PRIVACY_STYLES_CSS = `
  main { max-width: 40rem; }
  .lede { font-size: var(--t-lead); color: var(--fg); margin-bottom: 1.5rem; }
  .held { margin: 0 0 1.1rem; }
  .held-what { color: var(--fg); font-weight: 600; }
  .held-why { margin-top: 0.15rem; }
  .updated { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--line); font-size: var(--t-support); }
`;

/**
 * The offline page (M13). One rule beyond the shared primitives: the mark is
 * shown at a size that reads as an illustration rather than a favicon.
 */
export const OFFLINE_STYLES_CSS = `
  .offline-mark { width: 88px; height: 88px; border-radius: 22%; margin: 0 auto 1.5rem; display: block; }
`;

/**
 * The "This device" panel on the account page (M13; merged with the
 * notification control at M20 B5). Its own block rather than an extension of
 * `FORM_CSS`: `renderThisDeviceSection` (`src/views/install.ts`) is the one
 * place this markup exists, so its canonical CSS lives beside the other
 * single-page blocks above rather than folded into the wider form
 * stylesheet every owner page also carries.
 */
export const INSTALL_STYLES_CSS = `
  /* The heading lives *outside* the card since M21, so the box hugs its h2
     (the 2rem section gap is the heading's own margin now) and the first
     paragraph inside needs no headroom. */
  .install { margin-top: 0.75rem; padding: 1rem 1.1rem; border: none; border-radius: 1.25rem; background: var(--card-raised); }
  .install > p:first-child, .install > [data-install-instructions] { margin-top: 0; }
  .install ol { margin: 0.5rem 0 0; padding-left: 1.2rem; color: var(--mut); font-size: var(--t-support); }
  .install li + li { margin-top: 0.35rem; }
`;

/**
 * The notification permission button and device list (M14 Task 12,
 * `renderPushBody` / `renderPushOffer` in `src/views/install.ts`) — spec
 * §11's states 3-5. The box/heading rules are scoped to `section.push`
 * specifically (not the bare `.push` class) because M20 B5 folded the
 * account page's copy into `renderThisDeviceSection`'s `.install` panel as a
 * plain `<div class="push">`, not a second `<section>` — a second box+margin
 * there would nest a card inside a card. `renderPushOffer`'s own
 * `<section class="push">` on `/r/:token` is unaffected: it is still the
 * only element these two rules match. The inner rules below (`.push h3`,
 * `.push .button`, …) stay unqualified because both the offer's `section`
 * and the account page's `div` need them.
 */
export const PUSH_STYLES_CSS = `
  section.push { margin-top: 2rem; padding: 1rem 1.1rem; border: none; border-radius: 1.25rem; background: var(--card-raised); }
  section.push h2 { margin-top: 0; }
  .push h3 { margin: 1.25rem 0 0.5rem; font-size: var(--t-support); color: var(--mut); }
  .push .button { margin-top: 0.5rem; }

  table.push-devices { width: 100%; border-collapse: collapse; text-align: left; font-size: var(--t-support); }
  table.push-devices th {
    color: var(--mut); font-weight: 600; padding: 0.3rem 0.5rem 0.3rem 0;
    border-bottom: 1px solid var(--line);
  }
  table.push-devices td { padding: 0.55rem 0.5rem 0.55rem 0; border-bottom: 1px solid var(--line); color: var(--fg); vertical-align: middle; }
  table.push-devices td.push-actions { display: flex; gap: 0.5rem; justify-content: flex-end; padding-right: 0; }
  table.push-devices form { margin: 0; }
  .push .device-when { color: var(--mut); }
  /* Row controls, not page actions: the 52px floor .button sets is for the
     one thing a page asks you to do, and two of those per row would drown
     the names the table exists to show. 44px keeps the tap-target floor. */
  .push .button.row-action {
    flex: 0 0 auto; min-height: 44px; padding: 0.35rem 0.8rem;
    font-size: var(--t-support); font-weight: 600; margin-top: 0;
  }
  .this-device {
    display: inline-block; margin-left: 0.4rem; padding: 0.05rem 0.5rem;
    border-radius: 1rem; background: var(--accent-mut); color: var(--accent);
    font-size: var(--t-support); font-weight: 600; white-space: nowrap;
  }
  .push label.device-name {
    display: block; margin-top: 1rem; text-align: left;
    color: var(--mut); font-size: var(--t-support); font-weight: 600;
  }
  .push input.device-name-input {
    display: block; width: 100%; margin-top: 0.3rem; padding: 0.6rem 0.75rem;
    border: 1px solid var(--line); border-radius: 0.6rem;
    background: var(--bg); color: var(--fg); font: inherit;
  }
`;

/**
 * Where the .danger-link explanation lives, because the rule itself cannot
 * carry one.
 *
 * .danger-link is in STYLES (src/views/layout.ts) — several pages offer a
 * destructive escape hatch as a link rather than a button, and a primitive
 * three pages share does not belong to any one of them. It gets no comment
 * beside it there: STYLES is inlined into the public holding page, and
 * test/routes/access.test.ts asserts that block names no page, file or
 * operation, so an explanatory comment there would leak the product's shape
 * to a signed-out visitor and fail that test.
 *
 * A link and never a button: M10 §3.2 keeps a filled --danger and a filled
 * --accent off the same screen, and every page that needs this already
 * spends its filled button on the safe action. Colour plus weight on a link
 * marks the dangerous one without a second fill competing for the eye.
 */

/**
 * The owner's invite page — the sharing card, and the QR code's disclosure.
 *
 * Its own block rather than more rules in FORM_CSS: that block is loaded by
 * every form and owner page in the product, and a card that only the invite
 * page can render would be dead CSS hashed into all of them.
 *
 * The QR code is a details/summary rather than always-on. It is the least
 * used of the three ways to pass an invite on, and at 240px it pushed the
 * link and the share button — which is what most people actually use —
 * below the fold on a phone. Its own rules zero the general details
 * treatment from FORM_CSS, whose top border and 1.5rem margin are for the
 * game form's optional sections and read as a page division here.
 */
export const INVITE_CSS = `
  .card { margin: 1.1rem 0; padding: 1rem; border: none; border-radius: 1.25rem; background: var(--card-raised); }
  .card h2 { margin: 0 0 0.6rem; font-size: var(--t-body); }
  .card .actions { margin-top: 0.75rem; }
  .qr-toggle { margin: 0; border: 0; padding: 0; }
  /* The padding is the tap target, and it is not decoration. At the support
     size this control's line box is 1.4rem — 0.875rem against the body's
     inherited unitless line-height of 1.6, so 22.4px — which is legible but
     about half the 44px floor, and this is a phone-first page: an owner
     passing an invite on is standing next to the person taking it. 0.75rem
     top and bottom brings it to 46.4px.
     Padding and deliberately NOT min-height with display: flex, which is the
     obvious way to clear the floor: flex on a summary strips WebKit's native
     disclosure triangle, and that triangle is the only thing that says this
     line opens rather than being another piece of grey supporting text. */
  .qr-toggle summary {
    padding: 0.75rem 0;
    font-weight: 600; font-size: var(--t-support); color: var(--mut); cursor: pointer;
  }

  /* "Coming up" on the owner's game page: one line per fixture, each a link
     to it. Its own list rather than DASHBOARD_STYLES_CSS's .fixture-list /
     .fixture-card, which is the right shape for the dashboard — where a card
     carries a heading, a status badge, a headline and two response buttons —
     and the wrong one here, where a row is a date, a state and a count.
     Borrowing it would put a second, competing card idiom next to the invite
     .card above and ship this page three rules (.fixture-card h2,
     .viewer-headline, .responses) for elements it can never render.

     Not ul.squad, which is what this list used to wear. A fixture is not a
     person, and sharing the class means the next rule written for a squad row
     silently restyles the fixture list too.

     Scoped ul.fixtures > li for the same reason ul.squad > li is (see the
     comment there): a bare descendant selector beats a chip's own .chip on
     specificity, and this app has li elements inside li elements. */
  .fixtures { list-style: none; margin: 0; padding: 0; text-align: left; border-top: 1px solid var(--line); }
  /* The row is a flex line so the anchor below can be a flex item that fills
     it. A row is a date wrapped in the link plus a sibling span of state and
     count that is not part of it, and blockifying the anchor on its own would
     drop that span onto a second line — the row would grow from one line to
     two everywhere, to fix a tap target. min-height rather than the vertical
     padding this rule used to carry: the padding also applied to the empty
     state, which has no anchor to carry a height, and the row keeps the ~45px
     it already had instead of stacking 44px on top of 19px of padding. */
  ul.fixtures > li {
    display: flex; align-items: center; gap: 0.75rem; min-height: 44px;
    padding: 0 0.1rem; border-bottom: 1px solid var(--line); font-size: var(--t-body);
  }
  /* Constraint 9's 44px floor, the same shape as ul.owned-games > li > a. An
     anchor is inline by default and min-height does nothing to an inline box,
     so the hit area was the link text's own line box — about 25px in a row
     that already measured 45px, which is the trap: the row looks compliant
     and the thing you actually tap is not. display: flex blockifies it, and
     flex: 1 hands it every pixel the state and count do not need, so the
     empty stretch left of them is part of the link too. */
  ul.fixtures > li > a { display: flex; align-items: center; flex: 1; min-height: 44px; }
  /* The state and the headcount are context for the date, not peers of it —
     without the demotion all three read as one undifferentiated run of text
     and there is nothing to scan down the column for. */
  .fixtures .detail { color: var(--mut); font-size: var(--t-support); }
`;

/**
 * The admin allow-list page (M16). Selectors are namespaced under
 * `.allowlist` so this block cannot collide with SQUAD_STYLES_CSS's or
 * FORM_CSS's list and row rules at equal specificity — the cascade-order
 * failure test/views/style-cascade.test.ts exists to catch.
 */
export const ADMIN_ALLOWLIST_CSS = `
  ul.allowlist { list-style: none; padding: 0; margin: 1.1rem 0; }
  ul.allowlist > li {
    display: flex; align-items: center; justify-content: space-between;
    gap: 1rem; padding: 0.55rem 0; border-bottom: 1px solid var(--line);
    overflow-wrap: anywhere;
  }
  /* Secret-sourced entries have no remove button; mark them so the asymmetry
     reads as designed rather than broken. */
  ul.allowlist .provenance { color: var(--mut); font-size: var(--t-support); }
  .allowlist-add { display: flex; gap: 0.75rem; align-items: flex-end; }
  .allowlist-add .field { flex: 1; margin: 0; }
`;

export const ADMIN_TOOLS_CSS = `
  ul.admin-tools { list-style: none; padding: 0; margin: 1.1rem 0; }
  ul.admin-tools > li { padding: 0.55rem 0; border-bottom: 1px solid var(--line); }
  ul.admin-tools .tool-note { color: var(--mut); font-size: var(--t-support); margin: 0.15rem 0 0; }
  ul.doors { list-style: none; padding: 0; margin: 1.1rem 0; }
  ul.doors > li { padding: 0.35rem 0; overflow-wrap: anywhere; }
  ul.doors .door-open { color: var(--accent); font-weight: 600; }
  ul.doors .door-shut { color: var(--mut); }
  table.admin-log { width: 100%; border-collapse: collapse; margin: 1.1rem 0; }
  table.admin-log th, table.admin-log td {
    text-align: left; padding: 0.45rem 0.6rem 0.45rem 0;
    border-bottom: 1px solid var(--line); overflow-wrap: anywhere;
    font-size: var(--t-support); vertical-align: top;
  }
`;

/**
 * The "Post to WhatsApp" card (M22) — `src/views/whatsapp.ts`. Every rule is
 * namespaced under `.whatsapp` so this block cannot collide with another at
 * equal specificity, the failure test/views/style-cascade.test.ts exists to
 * catch; test/views/whatsapp.test.ts checks the namespacing directly.
 */
export const WHATSAPP_CSS = `
  /* text-align: left because the cancelled page is a centred layout and a
     centred message would centre every line of the textarea too. */
  .whatsapp { margin: 1.1rem 0; padding: 1rem; border-radius: 1.25rem; background: var(--card-raised); text-align: left; }
  .whatsapp h2 { margin: 0 0 0.35rem; font-size: var(--t-body); }
  .whatsapp h3 { margin: 0.9rem 0 0.35rem; font-size: var(--t-support); color: var(--mut); }
  .whatsapp p { margin: 0 0 0.6rem; color: var(--mut); font-size: var(--t-support); }
  /* Its own field rules rather than FORM_CSS's .field textarea: this is not a
     form field, it is the message on show, and FORM_CSS is not on every page
     the card appears on. */
  .whatsapp textarea {
    display: block; width: 100%; box-sizing: border-box; margin: 0;
    padding: 0.6rem 0.75rem; border: 1px solid var(--line); border-radius: 0.75rem;
    background: var(--field); color: inherit; font: inherit; font-size: var(--t-body);
    line-height: 1.45; resize: vertical;
  }
  .whatsapp textarea:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  /* "Open in WhatsApp" wrapped onto two lines beside Copy at 390px (the
     capture showed it); nowrap keeps each label on one line and flex-wrap
     drops Copy to its own row if there really is no room. */
  .whatsapp-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.6rem; }
  .whatsapp-actions .button { white-space: nowrap; }
`;

/**
 * The result panel (M25): the candidate list while a result is open to
 * argument, and the locked result with its two confidence figures.
 *
 * All-new selectors, so nothing already on a page changes appearance by
 * adding this block. Deliberately not reusing .squad -- a candidate row is a
 * count and a control, not a person and two controls, and sharing the
 * selector would put this block into the ul.squad cascade collision that
 * SQUAD_STYLES_CSS and FORM_CSS already have.
 */
export const RESULT_CSS = `
  .result-candidates { list-style: none; margin: 0.8rem 0 0; padding: 0; display: grid; gap: 0.6rem; }
  .result-candidate {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.6rem 0.9rem;
    padding: 0.7rem 0.9rem; border: 1px solid var(--line); border-radius: 0.5rem;
  }
  .result-claim { font-weight: 600; }
  .result-backers { font-size: var(--t-support); color: var(--mut); }
  .result-yours { font-size: var(--t-support); color: var(--mut); }
  .result-candidate form { margin: 0 0 0 auto; }
  .result-final { font-size: var(--t-lead); font-weight: 600; margin: 0.4rem 0 0.2rem; }
  /* Two of these render back to back in the locked view -- "Result 2 of 2"
     then "Score 2 of 2" -- and margin: 0 on both left them touching with no
     line gap at all, which a capture at 390px (M25 Task 14) showed reading as
     one run-on line rather than two distinct figures. Only the second gets
     the gap: collapsing top margins would otherwise stack it against
     .result-final's own bottom margin above the first line, widening a space
     that was already right. */
  .result-confidence { font-size: var(--t-support); color: var(--mut); margin: 0; }
  .result-confidence + .result-confidence { margin-top: 0.3rem; }
  .result-note { font-size: var(--t-support); color: var(--mut); }
  .result-score { display: flex; flex-wrap: wrap; align-items: end; gap: 0.9rem; }
  .result-score label { display: grid; gap: 0.3rem; }
  /* Bare width only, before this fix -- every other text input on the site
     gets .field input's padding/background/radius, but these two aren't
     inside a .field, so a capture at 390px (M25 Task 14) showed a stock
     browser number box beside the app's own styled fields. Repeats
     .field input's declarations rather than adding the class to the
     markup: .field label also sets display: block, which would stack
     "Team A" above its input and break the side-by-side layout
     .result-score exists for. */
  .result-score input {
    width: 4.5rem; padding: 0.6rem 0.7rem; font: inherit;
    color: var(--fg); background: var(--field);
    border: none; border-radius: 0.75rem;
  }
  .result-score input:focus-visible { outline: 3px solid var(--accent); outline-offset: 1px; }
  /* A single class, not .danger-link plus a reset: a <button> and STYLES's
     .danger-link (colour and weight only, its only other user an <a>) would
     both land on this element at equal specificity, and STYLE_BLOCKS always
     emits RESULT_CSS after STYLES -- so any shorthand here (font, background,
     border) silently wins over a .danger-link longhand it never meant to
     touch. One class with no earlier block to collide with sidesteps that
     rather than relying on two blocks to keep composing correctly. */
  .result-withdraw {
    appearance: none; -webkit-appearance: none;
    background: none; border: none; padding: 0;
    font-family: inherit; font-size: var(--t-support); font-weight: 600;
    color: var(--danger); cursor: pointer; -webkit-tap-highlight-color: transparent;
  }
`;

/**
 * The freshness bar at the foot of the pages whose facts move under the
 * reader (M24): the age on the left, the Refresh link beside it.
 *
 * Support-sized muted text above a rule, deliberately the quietest thing on
 * the page — it is a reassurance, not a control, and the reload it describes
 * usually happens without anyone tapping. `--mut` on `--bg`, `--card` and
 * `--card-raised` all clear 4.5:1 (`test/views/contrast.test.ts`).
 *
 * All-new selectors, so nothing already on a page changes appearance by
 * adding this block. `.updated` was not reused: that is the privacy page's
 * "last updated" line for a document, a different thing that happens to
 * share a word.
 */
export const FRESHNESS_CSS = `
  .freshness {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.9rem;
    margin: 2.5rem 0 0; padding-top: 0.9rem;
    border-top: 1px solid var(--line);
    font-size: var(--t-support); color: var(--mut);
  }
  /* Pushed to the end of the row on anything wider than a narrow phone, where
     the two sitting adjacent read as one sentence with a link in it. */
  .freshness-refresh { margin-left: auto; }
`;

/**
 * The player's auto-decline panel (M28), on the fixture pages and the game
 * page.
 *
 * A `<details>` when the switch is off, so a control most players will never
 * touch stays one quiet line under the answer buttons rather than a block of
 * radios competing with them; an always-open panel when it is on, because a
 * setting that is currently silencing a squad must never be something a
 * reader has to open a disclosure to find out about.
 *
 * All-new selectors, so adding this block changes nothing already on a page.
 * The radios and the checkbox are left to `FORM_CSS`, which every page that
 * renders this panel already loads.
 */
export const MUTE_CSS = `
  .mute { margin-top: 1.5rem; font-size: var(--t-support); }
  .mute > summary {
    cursor: pointer; color: var(--mut); font-weight: 600;
    -webkit-tap-highlight-color: transparent;
  }
  .mute > summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .mute-panel {
    margin-top: 0.9rem; padding: 0.9rem 1rem;
    background: var(--card-raised); border-radius: 0.75rem;
  }
  /* The "it is on right now" state, which is never inside a disclosure. The
     left rule is the whole visual difference from the panel above: an amber
     edge reads as "something is deliberately switched on here" without
     borrowing .warn, whose colour belongs to the waitlist. */
  .mute-on {
    margin-top: 1.5rem; padding: 0.9rem 1rem;
    background: var(--card-raised); border-radius: 0.75rem;
    border-left: 4px solid var(--accent);
    font-size: var(--t-support);
  }
  .mute-on p, .mute-panel p { margin: 0 0 0.6rem; }
  .mute-on form, .mute-panel form { margin: 0; }
  .mute-legend { font-weight: 600; margin-bottom: 0.4rem; }
  .mute-durations { display: grid; gap: 0.4rem; margin: 0 0 0.9rem; border: none; padding: 0; }
  .mute-durations label { display: flex; align-items: center; gap: 0.5rem; }
  /* The organiser's marker on a squad row. A quiet pill rather than a colour
     on the name: the fact is about the member's answers, not about the member,
     and nothing here is a warning. --mut on --card-raised clears 4.5:1
     (test/views/contrast.test.ts). */
  .member-muted {
    display: inline-block; padding: 0.1rem 0.5rem;
    background: var(--card-raised); border-radius: 0.6rem;
    font-size: var(--t-support); color: var(--mut); white-space: nowrap;
  }
`;

export const PAGE_STYLE_BLOCKS = [
  FIXTURE_STYLES_CSS,
  PRIVACY_STYLES_CSS,
  TEAM_PICKER_CSS,
  SQUAD_STYLES_CSS,
  DASHBOARD_STYLES_CSS,
  SIGNIN_STYLES_CSS,
  PASSKEY_STYLES_CSS,
  CANCEL_STYLES_CSS,
  FORM_CSS,
  OFFLINE_STYLES_CSS,
  INSTALL_STYLES_CSS,
  PUSH_STYLES_CSS,
  INVITE_CSS,
  ADMIN_ALLOWLIST_CSS,
  ADMIN_TOOLS_CSS,
  WHATSAPP_CSS,
  RESULT_CSS,
  FRESHNESS_CSS,
  MUTE_CSS,
] as const;

export type PageStyleBlock = (typeof PAGE_STYLE_BLOCKS)[number];

/**
 * The complete set of `<style>` blocks the app can ever emit — `STYLES` plus
 * every page-specific block above. This is the one value a CSP's
 * `style-src` hashing should map over (see the module comment).
 */
export const STYLE_BLOCKS = [STYLES, ...PAGE_STYLE_BLOCKS] as const;
