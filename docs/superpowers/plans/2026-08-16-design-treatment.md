# Design Treatment (M10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the eight findings of the external design review, on top of one shared set of design primitives.

**Architecture:** Server-rendered HTML with per-page inline `<style>` blocks allowed by SHA-256 hash in the CSP. Task 1 lands the primitives (tokens, type scale, alignment); Task 2 lands the typeface and the CSP directives it needs; Tasks 3–9 are one finding each; Task 10 is documentation. No new routes, no schema change, no new notification.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, Vitest (`@cloudflare/vitest-pool-workers`), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-16-design-treatment-design.md`. Read it before Task 1; it explains *why* for everything below.

## Global Constraints

- **Every `<style>` block must be a named export in `src/views/styles.ts` and a member of `PAGE_STYLE_BLOCKS`**, or `STYLES` in `src/views/layout.ts`. `src/security/csp.ts` hashes exactly `STYLE_BLOCKS` at runtime. A block written inline at a `layout()` call site does not compile; one that escaped the enumeration would be silently dropped by the browser with no server-side test failing. Same rule for scripts and `PAGE_SCRIPT_BLOCKS`.
- **Dark mode is not optional.** `STYLES` has a `@media (prefers-color-scheme: dark)` block redefining every token. Any token added in the light block MUST get a value in the dark block in the same commit. The design review is light-only and says nothing about this.
- **No JavaScript is required for anything.** The only scripts in the product are the two passkey blocks, the invite-copy block, and the team picker's drag enhancement. This milestone adds none. Every control it touches stays a plain form submit or a native element.
- **Escape everything interpolated into HTML** with `escapeHtml` from `src/views/layout.ts`.
- **Never use `member.name` directly** — always `displayName(member.name, member.erasedAt)` (BR-34).
- The exact colour values, in both themes, are in Task 1 Step 1. Copy them verbatim; do not invent near-misses.
- Run `npm run lint && npm run typecheck && npm test` before every commit.
- **`npm run test:browser` does not include the visual captures.** `playwright.config.ts:81` sets `grepInvert: /@capture|@guide/` unless `CAPTURE` is set, so the journeys run and the screenshots do not. Any task whose steps call for a visual gate must run **both**:
  ```bash
  npm run test:browser                            # journeys — behaviour
  CAPTURE=1 npx playwright test --grep @capture    # screenshots — layout
  ```
  The second is the only thing that can see a layout break: no string assertion in the unit suite renders a page at 390px. Running the first alone and reporting "browser suite green" is a false negative for every finding in this milestone.

---

### Task 1: Design primitives — tokens, type scale, one left edge

The foundation every other task builds on. Nothing here is visible as a feature; everything here changes how every page looks.

**Files:**
- Modify: `src/views/layout.ts` (`STYLES`, `LayoutOptions`, `layout()`)
- Modify: `src/views/styles.ts` (`FORM_CSS` — remove the alignment override; every block — move hardcoded sizes onto the scale)
- Modify: `src/routes/home.ts`, `src/views/link-problem.ts`, `src/views/cancel.ts`, `src/views/signin.ts` (add `centred: true` at the call sites named in Step 4)
- Test: `test/views/layout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LayoutOptions.centred?: boolean`; CSS custom properties `--danger`, `--danger-bg`, `--danger-fg`, `--t-title`, `--t-lead`, `--t-body`, `--t-support`; the `.centred` class on `main`.

- [ ] **Step 1: Add the tokens to `STYLES` in `src/views/layout.ts`**

In the `:root` block, after the existing `--warn` line:

```css
    --danger: #a4321f; --danger-bg: #fbe9e5; --danger-fg: #fbfaf8;
    --t-title: 2rem; --t-lead: 1.25rem; --t-body: 1rem; --t-support: 0.875rem;
```

In the `@media (prefers-color-scheme: dark)` `:root` block, after its `--warn` line:

```css
      --danger: #e8705a; --danger-bg: #2e1613; --danger-fg: #1a0d0a;
```

The `--t-*` sizes are theme-independent and are deliberately NOT repeated in the dark block.

Add this comment immediately above the `--danger` line in the light block:

```css
    /* Irreversible actions only — call off, remove, leave, erase. Never used
       for anything a person can undo. `--warn` used to carry both this and
       "unsettled", which is why the three genuinely irreversible buttons in
       the product were styled as neither. See the M10 spec §2.1. */
```

- [ ] **Step 2: Add `.button.danger` to `STYLES`**

Immediately after the `.button.primary` rule:

```css
  /* Filled, like .primary, because a destructive action is still the primary
     thing on the page it appears on — the fill says "this is the action", the
     colour says "and it cannot be undone". Four pages use it, which is why it
     is here and not in CANCEL_STYLES_CSS where it started. */
  .button.danger {
    background: var(--danger); border-color: var(--danger); color: var(--danger-fg);
  }
  .button.danger:focus-visible { outline: 3px solid var(--danger); outline-offset: 2px; }
```

- [ ] **Step 3: Flip the default alignment**

In `STYLES`, change:

```css
  main { max-width: 30rem; width: 100%; text-align: center; }
```

to:

```css
  /* Left by default. Centring is opt-in via `centred` on layout(), for pages
     that are a single statement and nothing else. Until M10 the default was
     centre and FORM_CSS overrode it back, so the product ran in two
     alignments at once — the design review's finding 6. */
  main { max-width: 30rem; width: 100%; text-align: left; }
  main.centred { text-align: center; }
```

And change `h1` and `h2` to use the scale:

```css
  h1 { font-size: var(--t-title); letter-spacing: -0.02em; margin: 0 0 0.5rem; }
  h2 { font-size: var(--t-lead); margin: 2rem 0 0.6rem; }
```

Note `h2` loses its `text-align: left` — it is redundant now and would have to be fought by `.centred`.

Set the body font size from the scale: in the `body` rule, `font: var(--t-body)/1.6 ...` replacing `font: 16px/1.6 ...`.

- [ ] **Step 4: Add `centred` to `LayoutOptions` and `layout()`**

```ts
  /**
   * Centre this page's content. The default is left (see `main` in `STYLES`).
   *
   * True only for pages that say one thing and offer nothing to scan: the
   * holding page, a link problem, and the terminal cancellation pages. A page
   * with a form, a list, or more than about three sentences is left-aligned,
   * because centred prose wraps ragged and centred controls have no shared
   * edge to follow.
   */
  centred?: boolean;
```

In `layout()`, change the body line to:

```ts
return `<!doctype html>
...
<body><main${centred ? ` class="centred"` : ""}>${body}</main>${scriptTags}</body>
```

Destructure `centred` from the options.

Set `centred: true` at exactly these call sites and nowhere else:
- `src/routes/home.ts` — the holding page
- `src/views/link-problem.ts`
- `src/views/cancel.ts` — `renderCancelledPage`, `renderAlreadyCancelledPage`, `renderAlreadyPlayedPage` (NOT `renderCancelConfirmPage`, which is a form)
- `src/views/signin.ts` — the "check your inbox" page and the refusal pages, but NOT the page with the email form

If a call site is ambiguous, leave it left-aligned and note it in your report. Left is the default and the safe direction.

- [ ] **Step 5: Remove `FORM_CSS`'s alignment override**

In `src/views/styles.ts`, `FORM_CSS` currently begins:

```css
  main { max-width: 40rem; text-align: left; }
  h1 { text-align: left; }
```

Replace with:

```css
  /* Wider column only. The left alignment that used to be here is the default
     now (M10 §2.3) and repeating it would hide the fact that it moved. */
  main { max-width: 40rem; }
```

Update the block's doc comment above it — it currently explains that it overrides the shared block's centring, which is no longer true. Say instead that it widens the column for pages with real forms.

- [ ] **Step 6: Put every remaining font-size on the scale**

Sweep `src/views/styles.ts` and `src/views/layout.ts` for `font-size:` and map each value to the nearest token:

| Current values | Becomes |
| --- | --- |
| `2rem` | `var(--t-title)` |
| `1.4rem`, `1.25rem`, `1.2rem`, `1.1rem`, `1.05rem` | `var(--t-lead)` |
| `1rem`, `0.95rem` | `var(--t-body)` |
| `0.92rem`, `0.9rem`, `0.85rem` | `var(--t-support)` |

`.invite-link input` at `0.85rem` maps to `var(--t-support)` like everything else — 0.875rem is close enough that the monospace URL still fits, and an exception here would be the first crack in the scale. `.teams .sides input`'s `1.1rem` width/height is a control's *size*, not a font size; leave it alone.

Aim for **no exceptions**. After the sweep every `font-size:` in both files should read `var(--t-...)`. If you find one that genuinely cannot move, do not quietly leave it — state it in your report with the reason, and add it to Step 7's filter by name.

- [ ] **Step 7: Write the tests**

In `test/views/layout.test.ts`:

```ts
it("defaults to left alignment and offers centring as an opt-in", () => {
  const left = layout({ title: "T", body: "<p>x</p>" });
  expect(left).toContain("<main>");
  const centred = layout({ title: "T", body: "<p>x</p>", centred: true });
  expect(centred).toContain(`<main class="centred">`);
});

it("defines a danger colour in both themes", () => {
  // A token defined only in the light block leaves every danger button
  // invisible-to-unreadable for a dark-mode viewer, and no server-side test
  // renders a theme. This is the only thing that catches it.
  const dark = STYLES.slice(STYLES.indexOf("prefers-color-scheme: dark"));
  expect(dark).toContain("--danger:");
  expect(dark).toContain("--danger-bg:");
  expect(dark).toContain("--danger-fg:");
});

it("puts every font size on the four-step scale", () => {
  // Guards §2.2. A fifteenth size can still be added — but not silently.
  const sizes = [...`${STYLES}${PAGE_STYLE_BLOCKS.join("")}`.matchAll(/font-size:\s*([^;]+);/g)]
    .map((m) => m[1].trim())
    .filter((v) => !v.startsWith("var(--t-"));
  expect(sizes).toEqual([]);
});
```

Import `STYLES` from `../../src/views/layout.js` and `PAGE_STYLE_BLOCKS` from `../../src/views/styles.js`. If the third test finds legitimate exceptions from Step 6, list them explicitly in the `filter` with a comment naming each, rather than loosening the regex.

- [ ] **Step 8: Run the tests**

`npm run lint && npm run typecheck && npm test`

Expected: green. Existing tests that assert on centring or on a literal font size will fail — fix them by updating the assertion, never by reverting the CSS.

- [ ] **Step 9: Run the browser suite**

`npm run test:browser`

This is the real gate for this task. The capture suite renders the whole catalogue at 390px; an alignment flip that breaks a page shows up here and nowhere else. Report any page that looks wrong rather than only the pass/fail.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: land the M10 design primitives — tokens, type scale, one left edge"
```

---

### Task 2: Instrument Sans and IBM Plex Mono, and the CSP holes they need

**Files:**
- Modify: `src/views/layout.ts` (`layout()` head, `STYLES` font stacks)
- Modify: `src/security/csp.ts`
- Test: `test/security/csp.test.ts`, `test/views/layout.test.ts`

**Interfaces:**
- Consumes: Task 1's `--t-*` tokens.
- Produces: `FONT_ORIGINS` exported from `src/security/csp.ts` — `readonly ["https://fonts.googleapis.com", "https://fonts.gstatic.com"]`.

**Context you need:** this is the first external resource any page loads. The CSP is `default-src 'none'` with inline styles and scripts allowed by SHA-256 hash. Hashes and host sources coexist in one directive: inline `<style>` blocks stay hash-allowed while the external sheet is allowed by host.

- [ ] **Step 1: Add the head links**

In `layout()`, between the `<meta name="robots">` line and `<title>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
```

`display=swap` is not optional: without it a phone on a bad connection at the side of a pitch renders nothing until the font arrives.

- [ ] **Step 2: Put the families in front of the existing stacks**

In `STYLES`, the `body` rule's font stack becomes:

```css
    font: var(--t-body)/1.6 "Instrument Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
```

The rest of the stack stays exactly as it is — it is what a visitor sees while the font loads, and what they keep if the request is blocked, so a failed font degrades to precisely the pre-M10 appearance.

Add a `--mono` token to both `:root` blocks... no: add it once in the light block only, since it is theme-independent, beside the `--t-*` sizes:

```css
    --mono: "IBM Plex Mono", ui-monospace, monospace;
```

and use `font-family: var(--mono)` for `.invite-link input` in `FORM_CSS`, replacing its `ui-monospace, monospace`.

- [ ] **Step 3: Add the CSP directives**

In `src/security/csp.ts`:

```ts
/**
 * The two hosts M10's typeface needs, and the only external origins any page
 * is allowed to touch.
 *
 * Exported so `test/security/csp.test.ts` asserts on exactly these rather than
 * on a pasted string, and so the test can prove the policy is no *wider* than
 * this — a `font-src https:` would satisfy "the fonts load" and give away the
 * whole point of having the directive.
 *
 * Adopted over an objection recorded in the M10 spec §2.4: every page load now
 * discloses the visitor's IP to Google. `/privacy` must say so, and
 * `docs/known-issues.md` carries it on the list that page is written from.
 */
export const FONT_ORIGINS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"] as const;
```

In `buildCspHeader()`, change the `style-src` line to append `FONT_ORIGINS[0]`, and add a `font-src` line naming `FONT_ORIGINS[1]`:

```ts
    `style-src ${sources(styleHashes)} ${FONT_ORIGINS[0]}`,
    `font-src ${FONT_ORIGINS[1]}`,
```

Extend the module's header comment: the `style-src` bullet must now say that the Google Fonts *stylesheet* is allowed by host while every inline block stays hash-allowed, and a new `font-src` bullet must say it does not fall back to `default-src` and so has to be named.

- [ ] **Step 4: Write the tests**

In `test/security/csp.test.ts`:

```ts
it("allows the two font origins and nothing wider", async () => {
  const header = await cspHeader();
  const styleSrc = header.split("; ").find((d) => d.startsWith("style-src "))!;
  const fontSrc = header.split("; ").find((d) => d.startsWith("font-src "))!;

  expect(styleSrc).toContain("https://fonts.googleapis.com");
  expect(fontSrc).toBe("font-src https://fonts.gstatic.com");

  // The point of the directive is what it refuses. A wildcard scheme source
  // would pass any test that only checks the fonts load.
  expect(header).not.toContain("https:;");
  expect(header).not.toContain("'unsafe-inline'");
  for (const directive of [styleSrc, fontSrc]) {
    expect(directive).not.toContain("*");
  }
});
```

In `test/views/layout.test.ts`:

```ts
it("preconnects and swaps, so a slow font never blanks the page", () => {
  const html = layout({ title: "T", body: "" });
  expect(html).toContain(`rel="preconnect" href="https://fonts.gstatic.com" crossorigin`);
  expect(html).toContain("display=swap");
});

it("keeps the system stack behind the webfont", () => {
  // If the font request is blocked, this is the whole appearance of the
  // product. It must still be the stack that shipped before M10.
  expect(STYLES).toContain(`"Instrument Sans", ui-sans-serif, system-ui`);
});
```

- [ ] **Step 5: Run the tests**

`npm run lint && npm run typecheck && npm test`

- [ ] **Step 6: Run the browser suite, and read the console gate**

`npm run test:browser`

`test/browser/console-gate.spec.ts` fails on console output. A CSP that names the wrong host produces a browser console refusal and nothing else — no server error, no failed assertion anywhere else in the suite. **This step is the only proof the directives are right rather than merely present.** If the gate is silent and the fonts render, the policy works.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: adopt Instrument Sans and IBM Plex Mono, with the CSP holes they need"
```

---

### Task 3: Green never destroys

**Files:**
- Modify: `src/views/remove-member.ts:71`, `src/views/leave.ts:54`, `src/views/delete-account.ts:79`, `src/views/styles.ts` (`CANCEL_STYLES_CSS`)
- Test: `test/views/remove-member.test.ts`, `test/routes/leave.test.ts`, `test/routes/delete-account.test.ts`, `test/routes/cancel.test.ts`

**Interfaces:**
- Consumes: Task 1's `.button.danger` and `--danger`.

- [ ] **Step 1: Write the failing tests first**

Add to each of the four test files an assertion of this shape (adapt the render call to each file's existing helpers):

```ts
it("styles the irreversible action as dangerous, never as primary", () => {
  const html = renderRemoveMemberPage({ /* existing fixture from this file */ });
  expect(html).toContain(`class="button danger"`);
  expect(html).not.toContain(`class="button primary"`);
});
```

For `delete-account.test.ts`, the assertion is narrower and the comment matters:

```ts
it("styles Delete my data as dangerous but keeps Keep my account primary", () => {
  // Two primary buttons in one file, and both are right: a viewer never sees
  // the offer and the keep button together, and cancelling a pending erasure
  // is a safe, restorative action that IS the primary thing on its page.
  // Asserted so a later sweep for "green near deletion" cannot take it.
  expect(offerHtml).toContain(`class="button danger"`);
  expect(offerHtml).not.toContain(`class="button primary"`);
  expect(pendingHtml).toContain(`class="button primary"`);
});
```

- [ ] **Step 2: Run them and watch them fail**

`npm test -- remove-member leave delete-account cancel`
Expected: four failures, each on the missing `danger` class.

- [ ] **Step 3: Swap the classes**

- `src/views/remove-member.ts:71` — `class="button primary"` → `class="button danger"`
- `src/views/leave.ts:54` — same
- `src/views/delete-account.ts:79` (`offerBody` only — **not** the two `Keep my account` buttons) — same

- [ ] **Step 4: Move the cancel button off amber**

In `src/views/styles.ts`, `CANCEL_STYLES_CSS` currently contains:

```css
  .cancel-form .button.danger {
    margin-top: 1.25rem; width: 100%;
    background: var(--warn-bg); border-color: var(--warn); color: var(--warn);
  }
```

The colours move to Task 1's shared `.button.danger`. Keep only what is specific to this form:

```css
  .cancel-form .button.danger { margin-top: 1.25rem; width: 100%; }
```

Also change `.cancel-heading`'s `color: var(--warn)` to `color: var(--danger)`.

`.form-error` keeps `--warn`: a rejected submission is a correctable problem, not a destructive act.

- [ ] **Step 5: Run the tests**

`npm run lint && npm run typecheck && npm test`

- [ ] **Step 6: Sweep for any remaining destructive green**

```bash
grep -rn "button primary" src/views/
```

Every surviving occurrence must be an action that creates, confirms, joins, saves, or restores. List them all in your report with a word each on why they are safe. If you find one you cannot justify, say so rather than changing it — the spec enumerates the four that move.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "fix: no irreversible action wears the same green as I'm in"
```

---

### Task 4: The button remembers what you answered

**Files:**
- Modify: `src/views/fixture.ts` (`renderButtons`), `src/views/dashboard.ts` (`renderActions`), `src/views/styles.ts` (`FIXTURE_STYLES_CSS`)
- Test: `test/views/fixture.test.ts`, `test/routes/respond-get.test.ts`, `test/routes/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 1's tokens.
- Produces: `renderResponseButtons(action: string, status: ResponseStatus, hidden?: string): string`, exported from `src/views/fixture.ts` — one renderer for both pages.

**Context:** today `renderButtons` reads `options.intent` (from `?intent=`) to decide which button gets `primary`. That only exists on the one render immediately after a submit. A player opening their link two days later sees two identical buttons. The source moves to `viewer.status`, which is true on every render.

**BR-5 is the rule this task must not break:** a waitlisted player must never read as confirmed. Today they get *neither* button emphasised, and there is a comment in `renderButtons` explaining why. After this task they get a positive amber signal instead — stronger, not weaker. Do not delete that comment; rewrite it to describe the new mechanism.

- [ ] **Step 1: Write the failing tests**

In `test/views/fixture.test.ts`:

```ts
it("shows the answer in the button on every render, not only after submitting", () => {
  // No ?intent= anywhere — this is a player opening their link days later.
  const html = renderFixturePage(pageOptions({ viewer: { playerId: "p1", status: "in" }, intent: null }));
  expect(html).toContain(`class="button chosen-in"`);
});

it("never gives a waitlisted player the confirmed green (BR-5)", () => {
  const html = renderFixturePage(pageOptions({
    viewer: { playerId: "p1", status: "waitlisted", waitlistRank: 2 },
    intent: "in",
  }));
  // The intent says "in" because that is what they tapped. What got recorded
  // is a waitlist place, and that is what the control must show.
  expect(html).toContain(`class="button chosen-waiting"`);
  expect(html).not.toContain("chosen-in");
  expect(html).toContain("I'm in · waiting");
});

it("emphasises neither button for a player who has not answered", () => {
  const html = renderFixturePage(pageOptions({ viewer: { playerId: "p1", status: "pending" }, intent: null }));
  expect(html).not.toContain("chosen-");
});

it("shows the out answer in the out button", () => {
  const html = renderFixturePage(pageOptions({ viewer: { playerId: "p1", status: "out" }, intent: null }));
  expect(html).toContain(`class="button chosen-out"`);
});
```

Use whatever fixture-building helper `test/views/fixture.test.ts` already has; do not introduce a second one.

- [ ] **Step 2: Run them and watch them fail**

`npm test -- fixture`
Expected: four failures on the missing `chosen-` classes.

- [ ] **Step 3: Write the shared renderer in `src/views/fixture.ts`**

```ts
/**
 * The two response buttons, with the viewer's current answer shown in the
 * control itself rather than only in a sentence above it (M10 §3.1).
 *
 * Driven by `status` — what the server recorded — and never by `?intent=`,
 * which is what the player *tapped* and exists on exactly one render. Those
 * two differ in the case that matters: a player who taps "I'm in" on a full
 * fixture is recorded `waitlisted`, and echoing their intent would show them a
 * solid green confirmation of a place they do not have (BR-5). The waitlisted
 * state gets its own amber treatment and its own label, so it is a positive
 * signal rather than the absence of one.
 *
 * Shared with the dashboard's cards, which post the same two intents to a
 * different action with a hidden fixture id. One renderer, because two copies
 * of "what does 'in' look like" is how the two pages start disagreeing.
 */
export function renderResponseButtons(action: string, status: ResponseStatus, hidden = ""): string {
  const inClass = status === "in" ? "button chosen-in" : status === "waitlisted" ? "button chosen-waiting" : "button";
  const outClass = status === "out" ? "button chosen-out" : "button";
  const inLabel = status === "waitlisted" ? "I'm in · waiting" : "I'm in";
  // A tick only on the settled answer. A waitlisted player has not got what
  // they asked for, so nothing here may read as a confirmation.
  const tick = status === "in" ? `<span aria-hidden="true">✓</span> ` : "";

  return `
    <form method="post" action="${escapeHtml(action)}" class="responses">${hidden}
      <button type="submit" class="${inClass}" name="intent" value="in" aria-pressed="${status === "in" || status === "waitlisted"}">${tick}${escapeHtml(inLabel)}</button>
      <button type="submit" class="${outClass}" name="intent" value="out" aria-pressed="${status === "out"}">Can't make it</button>
    </form>`;
}
```

Replace `renderButtons`'s body with a call to it: `renderResponseButtons(`/r/${encodeURIComponent(options.token)}`, options.viewer.status)`.

`intent` is now unread by the view. Leave the field on `FixturePageOptions` — the route still parses it and other tests reference it — but change its doc comment to say it no longer affects rendering, and why it was removed from that job.

- [ ] **Step 4: Point the dashboard at the same renderer**

In `src/views/dashboard.ts`, replace `renderActions`'s body:

```ts
function renderActions(row: DashboardRow): string {
  return renderResponseButtons(
    DASHBOARD_PATH,
    row.myStatus,
    `<input type="hidden" name="fixtureId" value="${escapeHtml(row.fixtureId)}">`,
  );
}
```

Import `renderResponseButtons` from `./fixture.js` — that file is already imported here for `viewerHeadlineOpen` and `renderStatusLine`.

- [ ] **Step 5: Add the CSS to `FIXTURE_STYLES_CSS`**

```css
  /* The answer, in the control that set it (M10 §3.1). Each state is a fill
     plus a distinct label or glyph, never colour alone — the tick on
     `chosen-in` and the "· waiting" on `chosen-waiting` are what make the
     three states tellable apart without seeing colour at all. */
  .button.chosen-in {
    background: var(--accent); border-color: var(--accent); color: var(--accent-fg);
  }
  .button.chosen-waiting {
    background: var(--warn-bg); border-color: var(--warn); color: var(--warn);
  }
  .button.chosen-out {
    background: var(--line); border-color: var(--mut); color: var(--fg);
  }
```

- [ ] **Step 6: Run the tests**

`npm run lint && npm run typecheck && npm test`

Tests asserting `button primary` on the response pages will fail. That class no longer appears there — update them to the `chosen-` classes. Do not add `primary` back.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: show the recorded answer in the response button itself"
```

---

### Task 5: Say what answering yes will do, before the tap

**Files:**
- Modify: `src/views/fixture.ts` (`FixturePageOptions`, `renderFixturePage`), `src/routes/respond.ts` (supply `waitlistCount`), `src/views/styles.ts` (`FIXTURE_STYLES_CSS`)
- Test: `test/views/fixture.test.ts`, `test/routes/respond-get.test.ts`

**Interfaces:**
- Consumes: Task 4's `renderResponseButtons`.
- Produces: `FixturePageOptions.waitlistCount: number` — **required**, not optional.

**Context:** "0 spots left" sits beside a green confirmed badge and above two live buttons with no explanation of what tapping yes would do. The fix states the outcome: "The squad is full — answering yes puts you 3rd on the waitlist."

The rank is the current waitlist length **plus one** — the place they would take. It is not `viewer.waitlistRank`, which only exists once they are already on it.

**Why a new field.** `FixtureView` has no waitlist count, and counting `waitlisted` members out of `squad` fails exactly when the organiser has hidden the squad (BR-33) and `squad` is `null` — the page that most needs the warning. Required rather than optional so a future caller cannot omit the warning silently.

- [ ] **Step 1: Write the failing tests**

```ts
it("tells a player what answering yes would do on a full fixture", () => {
  const html = renderFixturePage(pageOptions({
    view: { status: "confirmed", flags: ["full"], spotsLeft: 0, needsOwnerAttention: false },
    viewer: { playerId: "p1", status: "pending" },
    waitlistCount: 2,
  }));
  expect(html).toContain("The squad is full — answering yes puts you 3rd on the waitlist.");
});

it("says it to a player who said no, who might yet change their mind", () => {
  const html = renderFixturePage(pageOptions({ /* as above */ viewer: { playerId: "p1", status: "out" }, waitlistCount: 0 }));
  expect(html).toContain("puts you 1st on the waitlist");
});

it("does not warn a player who is already in", () => {
  const html = renderFixturePage(pageOptions({ /* full fixture */ viewer: { playerId: "p1", status: "in" }, waitlistCount: 2 }));
  expect(html).not.toContain("on the waitlist.");
});

it("does not warn a player who is already on the waitlist", () => {
  // Their headline says exactly where they are; a second sentence offering to
  // put them on it would read as though they were not.
  const html = renderFixturePage(pageOptions({ /* full */ viewer: { playerId: "p1", status: "waitlisted", waitlistRank: 1 }, waitlistCount: 2 }));
  expect(html).not.toContain("answering yes puts you");
});

it("says nothing when there is still room", () => {
  const html = renderFixturePage(pageOptions({ view: { status: "open", flags: [], spotsLeft: 3, needsOwnerAttention: false }, waitlistCount: 0 }));
  expect(html).not.toContain("The squad is full");
});
```

- [ ] **Step 2: Run them and watch them fail**

`npm test -- fixture`

- [ ] **Step 3: Add the field and the renderer**

On `FixturePageOptions`, beside `inCount`:

```ts
  /**
   * How many are on the waitlist right now, so the page can say what place a
   * yes would take (M10 §3.4). Beside `inCount` and for the same reason: a
   * count the page must be able to state whether or not the squad's names are
   * visible to this viewer (BR-33).
   *
   * Required. An optional field here would let a new caller drop the warning
   * from a full fixture with nothing failing — which is the exact misreading
   * ("0 spots left" as "you can't come") this exists to prevent.
   */
  waitlistCount: number;
```

In `src/views/fixture.ts`:

```ts
/**
 * What answering yes would actually do, on a fixture with no room left.
 *
 * Shown where the tap happens rather than as a status line above it, and only
 * to a viewer who could still take that place: `pending`, or `out` and
 * entitled to change their mind. Someone already `in` is not going to join a
 * waitlist, and someone already `waitlisted` has a headline saying precisely
 * where they are — offering to put them on it would read as though they were
 * not on it.
 */
function renderFullWarning(view: FixtureView, viewer: FixturePageOptions["viewer"], waitlistCount: number): string {
  if (view.spotsLeft > 0) return "";
  if (viewer.status !== "pending" && viewer.status !== "out") return "";
  return `<p class="full-warning">The squad is full — answering yes puts you ${ordinal(waitlistCount + 1)} on the waitlist.</p>`;
}
```

`ordinal` is already imported from `./squad-row.js`.

Render it immediately after the buttons, inside the same branch that renders them, so it never appears on a read-only page:

```ts
    ${readOnlyReason ? renderReadOnlyNotice(readOnlyReason) : renderButtons(options) + renderFullWarning(view, viewer, options.waitlistCount)}
```

CSS in `FIXTURE_STYLES_CSS`:

```css
  .full-warning { margin: 0.5rem 0 0; font-size: var(--t-support); color: var(--mut); }
```

- [ ] **Step 4: Supply it from the route**

In `src/routes/respond.ts`, find where `renderFixturePage` is called. The squad is already loaded there. Pass the count of members with `status === "waitlisted"` — from the **unfiltered** squad the route holds, not from the visibility-filtered list it passes as `squad`, which may be `null`.

Read the surrounding code before editing: if the route already has a waitlist-derived value in scope, use it rather than recounting. State in your report which expression you used and why it is the unfiltered one.

- [ ] **Step 5: Run the tests**

`npm run lint && npm run typecheck && npm test`

Every existing construction of `FixturePageOptions` in tests now fails to compile — that is the required field doing its job. Add `waitlistCount` to each.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: say what a yes does on a full fixture, before the tap"
```

---

### Task 6: One segmented In/Out control per squad row

**Files:**
- Modify: `src/views/owner-fixture.ts` (`renderMemberControls`, `renderSquadList`), `src/views/styles.ts` (`SQUAD_STYLES_CSS` or `FORM_CSS` — pick and justify)
- Test: `test/routes/owner-fixture.test.ts`, `test/browser/journeys.spec.ts`

**Context:** fourteen people means twenty-eight full-width buttons, and at 390px "Mark in" wraps to "Mark / in". The fix is one segmented control per row, sized to content, that also displays the member's current answer.

Still two `<button type="submit">` in one form. The no-JS guarantee is untouched.

- [ ] **Step 1: Write the failing test**

```ts
it("shows each member's current answer in the control that changes it", () => {
  const html = renderOwnerFixturePage(params({ squad: [member({ name: "Callum", status: "in" })] }));
  expect(html).toContain(`aria-pressed="true"`);
  // The visual state must not be the only statement of it: a screen reader
  // user gets the same fact from aria-pressed, and a viewer who cannot see
  // colour gets it from the pressed styling plus the label.
  expect(html).toMatch(/name="intent" value="in"[^>]*aria-pressed="true"/);
});

it("does not mark a control pressed for a member who has not answered", () => {
  const html = renderOwnerFixturePage(params({ squad: [member({ name: "Freya", status: "pending" })] }));
  expect(html).not.toContain(`aria-pressed="true"`);
});
```

- [ ] **Step 2: Run it and watch it fail**

`npm test -- owner-fixture`

- [ ] **Step 3: Rewrite `renderMemberControls`**

```ts
/**
 * One squad row's controls: remove, for a guest; a segmented mark-in/mark-out
 * for a member.
 *
 * The segment displays the member's current answer as well as setting it
 * (M10 §3.3), which is what lets the status text come off the row — fourteen
 * members previously meant twenty-eight full-width buttons, and at 390px the
 * labels wrapped. Two submits in one form, exactly as before: nothing here
 * needs JavaScript.
 *
 * `aria-pressed` carries the same fact the fill does, so the state is not
 * stated in colour alone.
 */
function renderMemberControls(gameId: string, fixtureId: string, member: SquadMember): string {
  if (member.isGuest) {
    return `<form method="post" action="${escapeHtml(ownerGuestRemovePath(gameId, fixtureId, member.playerId))}"><button class="button" type="submit">Remove</button></form>`;
  }
  // `waitlisted` counts as in: the organiser marked them in and capacity put
  // them on the waitlist. The row's own status label says which.
  const isIn = member.status === "in" || member.status === "waitlisted";
  const isOut = member.status === "out";
  return `<form method="post" action="${escapeHtml(ownerResponsePath(gameId, fixtureId, member.playerId))}" class="segment">
             <button class="seg${isIn ? " on" : ""}" type="submit" name="intent" value="in" aria-pressed="${isIn}">In</button>
             <button class="seg${isOut ? " out" : ""}" type="submit" name="intent" value="out" aria-pressed="${isOut}">Out</button>
           </form>`;
}
```

Note the class is `seg`, not `button` — these are deliberately not the 52px full-width primitive.

- [ ] **Step 4: Add the CSS**

Put it in `FORM_CSS`, beside the existing `.squad li` grid rules that this replaces the shape of, and say in a comment why it is there rather than in `SQUAD_STYLES_CSS` (that block is shared with the player's fixture page, which has no controls at all and must not carry rules it cannot use).

```css
  /* The segmented mark-in/mark-out (M10 §3.3). A shared rounded track with two
     halves, sized to content — the .button primitive is a 52px full-width tap
     target and two of them per row is what made a fourteen-person squad
     unreadable. 44px keeps each half a legitimate phone target. */
  .segment { display: flex; margin: 0; padding: 3px; gap: 3px; border-radius: 0.7rem; background: var(--line); }
  .segment .seg {
    min-height: 44px; padding: 0.5rem 0.9rem; border: 0; border-radius: 0.55rem;
    background: transparent; color: var(--mut);
    font: inherit; font-size: var(--t-support); font-weight: 600; cursor: pointer;
  }
  .segment .seg:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .segment .seg.on { background: var(--accent); color: var(--accent-fg); }
  .segment .seg.out { background: var(--bg); color: var(--fg); }
```

Check whether the `@media (max-width: 30rem)` grid rule in `FORM_CSS` still gives the right shape now that the controls are narrower; if a row fits on one line at 390px, say so in your report and leave the media query in place only if it still earns itself.

- [ ] **Step 5: Add the browser journey**

In `test/browser/journeys.spec.ts`, extend the existing organiser journey (do not add a new top-level one) to: load the owner fixture page with JavaScript disabled, click the "In" segment for a pending member, and assert the reloaded page shows that member's In segment with `aria-pressed="true"`.

The comment on the assertion should say what it is really proving: that a control which now *displays* state still *sets* it, with no script involved.

- [ ] **Step 6: Run the tests**

`npm run lint && npm run typecheck && npm test && npm run test:browser && CAPTURE=1 npx playwright test --grep @capture`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: one segmented In/Out per squad row, showing the current answer"
```

---

### Task 7: Group the squad by answer, as chips

**Files:**
- Modify: `src/views/fixture.ts` (`renderSquadList`), `src/views/styles.ts` (`SQUAD_STYLES_CSS`)
- Test: `test/views/fixture.test.ts`

**Context:** the player-facing squad is fourteen visually identical rows; the waitlist order is implied only by position. This groups by answer with a count and renders people as chips.

**BR-27's attribution must survive.** A chip cannot carry "marked in by Jamie" without becoming a row again, so attribution moves to a sentence beneath the group that has any. With no email telling a player somebody answered for them, this line is the only way they can find out — dropping it would be a real reduction in what BR-27 surfaces, and it was decided against explicitly.

**Only the player-facing list changes.** `src/views/owner-fixture.ts` keeps its rows: they carry Task 6's controls, and the organiser's job is acting on individuals rather than scanning a summary.

- [ ] **Step 1: Write the failing tests**

```ts
it("groups the squad by answer with a count", () => {
  const html = renderFixturePage(pageOptions({ squad: [
    member({ name: "Ada", status: "in" }),
    member({ name: "Bo", status: "in" }),
    member({ name: "Cy", status: "waitlisted", waitlistRank: 1 }),
    member({ name: "Di", status: "pending" }),
  ]}));
  expect(html).toContain(">In<");
  expect(html).toMatch(/In<\/span>\s*<span class="group-count">2</);
  expect(html).toMatch(/Waiting<\/span>\s*<span class="group-count">1</);
  expect(html).toContain(`class="chip"`);
});

it("keeps BR-27 attribution as a line beneath the group", () => {
  const html = renderFixturePage(pageOptions({ squad: [
    member({ name: "Ada", status: "in", source: "owner", setBy: { name: "Jamie", erasedAt: null } }),
  ]}));
  expect(html).toContain("marked in by Jamie");
});

it("omits a group nobody is in", () => {
  // A heading over nothing reads as a broken page.
  const html = renderFixturePage(pageOptions({ squad: [member({ name: "Ada", status: "in" })] }));
  expect(html).not.toContain("Waiting");
});

it("shows a waitlisted player's place in their chip", () => {
  const html = renderFixturePage(pageOptions({ squad: [member({ name: "Cy", status: "waitlisted", waitlistRank: 2 })] }));
  expect(html).toContain("Cy · 2nd");
});

it("still marks guests", () => {
  const html = renderFixturePage(pageOptions({ squad: [member({ name: "Jono", status: "in", isGuest: true })] }));
  expect(html).toContain("Jono (guest)");
});
```

- [ ] **Step 2: Run them and watch them fail**

`npm test -- fixture`

- [ ] **Step 3: Rewrite `renderSquadList` in `src/views/fixture.ts`**

```ts
/** The four groups a player-facing squad is read in, in this order. */
const SQUAD_GROUPS: readonly { status: ResponseStatus; label: string }[] = [
  { status: "in", label: "In" },
  { status: "waitlisted", label: "Waiting" },
  { status: "out", label: "Out" },
  { status: "pending", label: "No reply" },
];

/**
 * The squad, grouped by answer, as chips (M10 §3.5).
 *
 * Fourteen identical rows made "are my mates in?" a question you had to read
 * every line to answer, and left the waitlist order implied only by position.
 * Grouping answers the first; the rank inside a waiting chip answers the
 * second out loud.
 *
 * A group with nobody in it renders nothing at all — a heading over an empty
 * list reads as a broken page rather than an honest empty state, which is the
 * same rule `renderOwnedGamesSection` follows on the dashboard.
 *
 * BR-27's attribution moves to a sentence beneath its group rather than onto
 * the chip, which could not carry it without becoming a row again. It is kept
 * because no email tells a player that somebody answered for them, so this is
 * the only place they can ever find out.
 */
function renderSquadList(squad: readonly SquadMember[]): string {
  if (squad.length === 0) return `<p class="muted">No players yet.</p>`;

  const groups = SQUAD_GROUPS.map(({ status, label }) => {
    const members = squad.filter((member) => member.status === status);
    if (members.length === 0) return "";

    const chips = members
      .map((member) => {
        // `displayName`, never `member.name` (BR-34) — an erased player stays
        // in a played fixture's squad, which is what keeps its numbers honest.
        const name = displayName(member.name, member.erasedAt);
        const guest = member.isGuest ? " (guest)" : "";
        const rank = status === "waitlisted" && member.waitlistRank !== null ? ` · ${ordinal(member.waitlistRank)}` : "";
        return `<li class="chip chip-${status}">${escapeHtml(`${name}${guest}${rank}`)}</li>`;
      })
      .join("");

    return `<div class="squad-group">
        <p class="group-head"><span class="group-label">${label}</span> <span class="group-count">${members.length}</span></p>
        <ul class="chips">${chips}</ul>
        ${renderGroupAttribution(members)}
      </div>`;
  }).join("");

  return `<div class="squad">${groups}</div>`;
}

/**
 * BR-27's attribution for a whole group, in one sentence.
 *
 * `attribution` in `src/views/squad-row.ts` renders it per row and is still
 * what the organiser's page uses. This says the same thing about a set, so a
 * group of chips can carry it without every chip growing a second line.
 */
function renderGroupAttribution(members: readonly SquadMember[]): string {
  const set = members.filter((member) => member.source === "owner" && member.setBy !== null);
  if (set.length === 0) return "";

  const verb = set[0].status === "out" ? "marked out" : "marked in";
  // §4: never `setBy.name` directly — an organiser who has since erased
  // themselves leaves this line behind on every response they set.
  const by = [...new Set(set.map((member) => displayName(member.setBy!.name, member.setBy!.erasedAt)))];
  const names = set.map((member) => displayName(member.name, member.erasedAt));
  return `<p class="set-by">${escapeHtml(`${listSentence(names)} ${names.length === 1 ? "was" : "were"} ${verb} by ${listSentence(by)}.`)}</p>`;
}

/** "a", "a and b", "a, b and c" — the Oxford comma deliberately omitted. */
function listSentence(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
```

Import `ResponseStatus` if it is not already imported.

**A group can contain members set by different organisers, and mixed statuses cannot occur inside one group** (the group *is* a status), so `verb` is safe to take from the first member. Add that as a comment.

- [ ] **Step 4: Replace `SQUAD_STYLES_CSS`**

The `.squad li` row rules go; chips arrive. **`src/views/owner-fixture.ts` also uses `SQUAD_STYLES_CSS` and still renders rows**, so the row rules must survive for it. Keep both, and comment which page uses which:

```css
  /* Rows: the organiser's fixture page only. The player's page groups into
     chips below — the organiser is acting on individuals, not scanning. */
  .squad li { ... existing rules ... }

  /* Chips: the player's fixture page (M10 §3.5). */
  .squad-group { margin: 0 0 1.1rem; }
  .group-head { display: flex; align-items: baseline; gap: 0.5rem; margin: 0 0 0.4rem; }
  .group-label { font-weight: 600; color: var(--fg); font-size: var(--t-support); }
  .group-count { font-family: var(--mono); font-size: var(--t-support); color: var(--mut); }
  .chips { list-style: none; display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0; padding: 0; }
  .chip {
    padding: 0.3rem 0.65rem; border-radius: 999px;
    font-size: var(--t-support); background: var(--line); color: var(--mut);
  }
  .chip-in { background: var(--accent-mut); color: var(--accent); }
  .chip-waitlisted { background: var(--warn-bg); color: var(--warn); }
  .set-by { display: block; margin: 0.4rem 0 0; font-size: var(--t-support); color: var(--mut); }
```

Verify `.squad li` rules still apply on the organiser's page after `.squad` changed from `<ul>` to `<div>` on the player's page — the organiser's is still a `<ul class="squad">`, so a `.squad li` selector matches both unless a chip is also an `li` inside `.squad`. **It is** (`<li class="chip">` inside `<ul class="chips">` inside `<div class="squad">`). Scope the row rules to `ul.squad > li` and say why in a comment. Prove it by rendering both pages in a test and checking the chip markup does not pick up the row's `display: grid`.

- [ ] **Step 5: Run the tests**

`npm run lint && npm run typecheck && npm test`

- [ ] **Step 6: Run the browser suite**

`npm run test:browser && CAPTURE=1 npx playwright test --grep @capture`

The capture half is the point here: chips wrapping badly at 390px is invisible to every other test in the repo.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: group the player-facing squad by answer, as chips"
```

---

### Task 8: The cancel page names the date, and the verb is "call off"

**Files:**
- Modify: `src/views/cancel.ts` (`renderCancelConfirmPage` only)
- Test: `test/routes/cancel.test.ts`

**Context:** the page titles the *game* and the button says "Cancel this game and tell everyone", for an action that affects one week. `docs/guide/06-calling-a-fixture-off.md` already uses the right language, which suggests the documentation drifted ahead of the interface.

**Only user-facing copy on this page changes.** The route `/cancel/:token`, the `cancelled` lifecycle, the audit action, N-4 and every business rule keep their names. The cancellation **email** is explicitly out of scope: it is read with no surrounding context, where "cancelled" is unambiguous and "called off" is not.

- [ ] **Step 1: Write the failing tests**

```ts
it("names the date, not the game, so one week cannot read as all of them", () => {
  const html = renderCancelConfirmPage(preview({ kicksOffAtLocal: "Sunday 16 August, 19:00" }));
  expect(html).toContain("Sunday 16 August, 19:00 won't be played");
  expect(html).not.toContain("Cancel this game?");
});

it("puts the number of people in the button being pressed", () => {
  const html = renderCancelConfirmPage(preview({ recipientCount: 12, unreachableCount: 0 }));
  expect(html).toContain("Call it off and email 12 people");
});

it("offers backing out as the thing called cancel", () => {
  expect(renderCancelConfirmPage(preview({}))).toContain("Keep the game on");
});
```

- [ ] **Step 2: Run them and watch them fail**

`npm test -- cancel`

- [ ] **Step 3: Rewrite the copy in `renderCancelConfirmPage`**

- Heading: `<h1>${escapeHtml(kicksOffAtLocal)} won't be played</h1>`, replacing both the `cancel-heading` h2 and `fixtureHeading`'s h1. The game name and venue move to a supporting line beneath: `<p class="venue">${gameName}, ${venueName}</p>`.
- Add, beneath that: `<p>Every other week carries on as normal.</p>` — the sentence that makes it unambiguous.
- Submit button: `Call it off and email ${reachable} ${plural(reachable, "person", "people")}`.
- Add a second button beneath it, a plain link styled as a button, back to wherever the page was reached from — `Keep the game on`. If no such return path exists on this page today, link to the owner's fixture page if the ids are in scope, and otherwise say so in your report rather than inventing a route.
- The `read-only` paragraph keeps its wording but drops "here" from "This can't be undone here".

`fixtureHeading` is used only by this page — check with `grep -n "fixtureHeading" src/` before changing or removing it.

- [ ] **Step 4: Update the guide prose**

```bash
grep -rn "Cancel this game" docs/guide/
```

Any sentence naming the old button label must name the new one. `test/browser/guide-references.spec.ts` checks the guide against the app; run it.

- [ ] **Step 5: Run the tests**

`npm run lint && npm run typecheck && npm test && npm run test:browser -- guide`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: the cancel confirmation names the date and calls it calling off"
```

---

### Task 9: Role and removal behind a per-member disclosure

**Files:**
- Modify: `src/views/game-overview.ts`, `src/views/styles.ts` (`FORM_CSS`)
- Test: `test/views/game-overview.test.ts`, `test/browser/journeys.spec.ts`

**Context:** every member row carries a "Make an organiser" button — fourteen rows of an action most organisers use twice a year, outweighing the squad itself.

`<details>`/`<summary>` rather than a script or a new route: it is the designed shape (the controls are behind a per-member action) and it needs no JavaScript, so there is nothing to degrade. The user authorised a JS-only solution; this is strictly better and does not need the permission.

- [ ] **Step 1: Write the failing tests**

```ts
it("puts role and removal behind a per-member disclosure", () => {
  const html = renderGameOverviewPage(params({ squad: [m("Callum"), m("Freya")] }));
  expect(html).toContain("<summary>Manage</summary>");
  // Both controls still there, and still reachable with no JavaScript —
  // details/summary is a native element, not an enhancement.
  expect(html).toContain("Make an organiser");
  expect(html).toContain(">Remove</a>");
});

it("gives every member their own disclosure", () => {
  const html = renderGameOverviewPage(params({ squad: [m("Callum"), m("Freya")] }));
  expect(html.match(/<summary>Manage<\/summary>/g)).toHaveLength(2);
});
```

- [ ] **Step 2: Run them and watch them fail**

`npm test -- game-overview`

- [ ] **Step 3: Wrap the controls**

In `renderGameOverviewPage`'s `squadItems` map, the `<li>` becomes:

```ts
      return `<li>
        <span class="member">${name}${organiser}${guest}${you}</span>
        <details class="member-actions">
          <summary>Manage</summary>
          <form method="post" action="${escapeHtml(memberRolePath(gameId, member.playerId))}">
            <input type="hidden" name="role" value="${nextRole}">
            <button class="button" type="submit">${roleLabel}</button>
          </form>
          <a href="${escapeHtml(memberRemovePath(gameId, member.playerId))}">Remove</a>
        </details>
      </li>`;
```

- [ ] **Step 4: Adjust `FORM_CSS`**

The `.squad li` grid was `1fr auto auto` for name + form + link. It becomes `1fr auto` for name + disclosure, and the `@media (max-width: 30rem)` rule that stacked the name onto its own line is no longer needed — a name and the word "Manage" fit on one line at 390px. **Delete it and say so in your report**; leaving a media query that can no longer trigger is worse than not having written it.

`FORM_CSS` already styles `details`/`summary` generally (`margin: 1.5rem 0; border-top: ...`) — that rule is for the game form's optional sections and would put a border above every squad row. Scope it, and add:

```css
  /* The per-member disclosure (M10 §3.8). Deliberately not the general
     `details` rule above, which is for the game form's optional sections and
     carries a top border and a 1.5rem margin — fourteen of those would be a
     worse page than the fourteen buttons this replaces. */
  .member-actions { margin: 0; border: 0; padding: 0; }
  .member-actions summary { font-weight: 500; font-size: var(--t-support); color: var(--mut); }
  .member-actions[open] { grid-column: 1 / -1; }
  .member-actions form { margin: 0.5rem 0; }
```

Check whether `.member-actions[open] { grid-column: 1 / -1 }` actually works given the disclosure is a grid *item* — if the open panel needs to escape the row's column, verify it in the browser capture rather than assuming.

- [ ] **Step 5: Add a browser assertion**

The existing squad-management journey in `test/browser/journeys.spec.ts` makes somebody an organiser. It now has to open the disclosure first. Update it, and add a comment noting that the click is on a native `<summary>` with no script involved — the journey runs with JavaScript disabled and must still pass.

**If the JS-off journey cannot open a `<details>` in the harness, that is a finding, not a workaround to route around** — report it before changing the approach.

- [ ] **Step 6: Run the tests**

`npm run lint && npm run typecheck && npm test && npm run test:browser && CAPTURE=1 npx playwright test --grep @capture`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: role and removal move behind a per-member disclosure"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/known-issues.md`, `docs/guide/*.md`
- Test: `test/browser/guide-references.spec.ts`

- [ ] **Step 1: Add the Google Fonts admission to the `/privacy` list**

`docs/known-issues.md` carry-forward item 2 lists three things `/privacy` must say. Add a fourth, in the same voice as the others:

> - **Every page load contacts Google.** M10 adopted Instrument Sans and IBM
>   Plex Mono from Google Fonts, so each page fetches a stylesheet from
>   `fonts.googleapis.com` and font files from `fonts.gstatic.com` — which
>   discloses the visitor's IP address to a third party this product has no
>   agreement with, on every page including the ones reached from an email
>   without signing in. It is the only external request any page makes; the CSP
>   allows exactly those two hosts and nothing else (`FONT_ORIGINS` in
>   `src/security/csp.ts`). Adopted deliberately with the cost known.

- [ ] **Step 2: Sweep the guide for changed labels**

Every button label this milestone changed:

| Was | Is |
| --- | --- |
| "Cancel this game and tell everyone" | "Call it off and email N people" |
| "Mark in" / "Mark out" | "In" / "Out" |
| (role/remove directly on the row) | behind "Manage" |

```bash
grep -rn "Cancel this game\|Mark in\|Mark out\|Make an organiser" docs/guide/
```

Update every hit. Where the guide describes *where* a control is ("beside their name"), check it is still true after Task 9 moved it.

- [ ] **Step 3: Regenerate the screenshots and check the references**

```bash
npm run test:browser -- guide
```

Screenshots regenerate from `guide-capture.spec.ts`. `guide-references.spec.ts` checks the prose against the app.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: record the Google Fonts disclosure and re-align the guide"
```
