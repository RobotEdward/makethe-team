# M12 — Visual Standards Everywhere: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply M10's tokens, layout rules and component vocabulary to the twelve views M10 did not reach, adding four CSS primitives and changing no features, routes or schema.

**Architecture:** Four new CSS primitives land first (`.capacity`, `.switch-row`, `.danger-link`, `INVITE_CSS`), each a named export registered in `PAGE_STYLE_BLOCKS` so the CSP hashes it. `.capacity` is the only one with a renderer behind it: `renderStatusLine` in `src/views/fixture.ts` is already shared by four pages, so widening it once gives every page the bar. Everything after that is per-view markup work, one task per view or closely-related pair.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, server-rendered template-literal views, Vitest (`@cloudflare/vitest-pool-workers`), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-17-visual-standards-everywhere-design.md`

## Global Constraints

Copied verbatim from spec §0. Every task's requirements implicitly include these.

1. **Every `<style>` block must be a member of `PAGE_STYLE_BLOCKS`** in `src/views/styles.ts`. `src/security/csp.ts` hashes exactly `STYLE_BLOCKS` (`STYLES` + `PAGE_STYLE_BLOCKS`) for `style-src`. A block defined outside that array is dropped by the browser and no fetch-level test will fail.
2. **Never write an inline CSS literal at a `layout()` call site.** New CSS is a named export in `styles.ts`, added to `PAGE_STYLE_BLOCKS`.
3. **Shared primitives go in `STYLES` (`layout.ts`); everything page-specific goes in `styles.ts`.** Do not widen `STYLES` for something two pages use — pass two blocks instead.
4. **`STYLES` renders on the public holding page and on error pages.** Its comments and content must stay free of file paths, page names, and operational words — `test/routes/access.test.ts` asserts their absence. Put explanatory comments in `styles.ts` instead.
5. **No new `pageScripts`.** Every page must be completely usable with JavaScript off (TR-4, TR-15). Anything new must be a progressive enhancement over markup that already works, and must ship `hidden`.
6. **Every interpolation goes through `escapeHtml`** — including `href` values.
7. **Do not widen `ul.squad > li` back to `.squad li`.** The player's fixture page wraps chips in a `div.squad`; a bare descendant selector reaches `li.chip` and beats `.chip` on specificity. This regressed once already.
8. **`--danger` and `--accent` must never appear as two filled buttons on the same screen.**
9. **No new colours, and only four type sizes** (`--t-title` 2rem, `--t-lead` 1.25rem, `--t-body` 1rem, `--t-support` 0.875rem). Spacing rhythm 0.4 / 0.6 / 0.75 / 1.1 / 1.5 / 2rem. Radii 0.5 / 0.6 / 0.65 / 0.7 / 0.75rem / 999px. Tap targets 52px for `.button`, 44px floor otherwise.
10. **No feature, route, or schema changes.** No copy rewrites except the lines this plan quotes as replacements.
11. **TR-5:** every timezone conversion goes through `formatLocalDateTime`.

---

## Controller ruling — the `.capacity` data gap (resolve before Task 1)

Spec §3.1 says the bar's width is `inCount / maxPlayers`, `.short` when `inCount < minPlayers`, with the label `10 of 10 in · 2 waiting`, rendered from `renderStatusLine(view)`. **`FixtureView` (`src/domain/fixture-view.ts:20-25`) carries none of those four numbers** — only `status`, `flags`, `spotsLeft` and `needsOwnerAttention`. The spec is not implementable as literally written.

**Ruling, binding on Task 1:**

- `inCount`, `minPlayers` and `maxPlayers` are **added to `FixtureView`**, copied straight through by `fixtureView()` from `FixtureFacts`, which already has all three. This changes no call site of `fixtureView()` (there are seven in `src/`, plus `test/domain/fixture-view.test.ts`) because it only widens the return value.
- The waiting count is **a required second parameter** to `renderStatusLine`, not a `FixtureView` field. It is not derivable from `FixtureFacts`, and `fixtures.waitlist_count` is already threaded to the pages that need it under exactly that name. Required rather than defaulted, for the reason `DashboardFixture.waitlistCount`'s own comment gives: *"a required field cannot be quietly omitted by a future caller the way an optional one could."* A silent `0` would render "· 0 waiting" as fact on a page that simply had not been updated.

**Cost if wrong:** widening `FixtureView` puts three display numbers on a type whose doc comment frames it as derived judgements. The alternative — a second parameter carrying all four numbers — was rejected because three of the four already exist on `FixtureFacts` and would have to be re-threaded through four call sites by hand.

---

## Controller ruling — `player-game.ts` renders a raw lifecycle too

Spec §4 names only `src/views/game-overview.ts` for the raw-enum defect. `src/views/player-game.ts:67` has the identical bug:

```ts
`<li>${escapeHtml(formatLocalDateTime(fixture.kicksOffAt, timezone))} — ${escapeHtml(fixture.lifecycle)}</li>`,
```

**Ruling:** in scope, handled in Task 10. Spec §4 states the rule generally — *"A player-facing page must not surface an internal enum value"* — and `player-game.ts` is the player-facing game page. Fixing the organiser's copy while leaving the player's is not a defensible reading. **Cost if wrong:** one extra view touched, reverted in a line.

---

## File Structure

| File | Responsibility in M12 |
|---|---|
| `src/domain/fixture-view.ts` | Widen `FixtureView` with `inCount`/`minPlayers`/`maxPlayers` |
| `src/views/fixture.ts` | `renderStatusLine` gains the bar and the waiting count; new `fixtureStatusWords` export |
| `src/views/styles.ts` | `.capacity` into `FIXTURE_STYLES_CSS`; `.switch-row` into `FORM_CSS`; new `INVITE_CSS`; drop the centred `h2`; `ul.owned-games` rules |
| `src/views/layout.ts` | `.danger-link` into `STYLES` |
| `src/views/game-overview.ts` | Invite card, QR `<details>`, danger link, fixture list, lifecycle words, back link |
| `src/views/dashboard.ts` | `.capacity` adoption, owned-games rows |
| `src/views/game-form.ts` | Two `.switch-row`s |
| `src/views/join.ts` | Reorder; squad as chips |
| `src/views/remove-member.ts` | `.keep-link` escape |
| `src/views/leave.ts` | `ul.squad` rows, back link |
| `src/views/account.ts` | Merge two headings; drop dashed box for read-out values |
| `src/views/squad-member.ts` | Same, plus role |
| `src/views/player-game.ts` | Lifecycle words; waitlist count plumbed for `.capacity` |
| `test/views/layout.test.ts` | New `centred: true` enumeration guard |

---

## Task 1: `.capacity` — the widened view, the CSS, and the shared renderer

**Files:**
- Modify: `src/domain/fixture-view.ts:20-25`, `:57-93`
- Modify: `src/views/styles.ts` (`FIXTURE_STYLES_CSS`, from line 40)
- Modify: `src/views/fixture.ts:373-379` (`renderStatusLine`)
- Modify call sites: `src/views/dashboard.ts:120`, `src/views/owner-fixture.ts:248`, `src/views/fixture.ts:483`, `src/views/player-game.ts:58`
- Modify: `src/views/player-game.ts` (`PlayerGameParams.openFixture`) and its route in `src/routes/games.ts`
- Test: `test/domain/fixture-view.test.ts`, `test/views/fixture.test.ts`

**Interfaces:**
- Produces: `FixtureView` gains `inCount: number; minPlayers: number; maxPlayers: number`. `renderStatusLine(view: FixtureView, waitlistCount: number): string`. Later tasks call the two-argument form only.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing tests**

In `test/domain/fixture-view.test.ts`:

```ts
it("carries the counts a renderer needs through to the view", () => {
  const view = fixtureView(facts({ inCount: 9 }), INSIDE_WINDOW);
  expect(view.inCount).toBe(9);
  expect(view.minPlayers).toBe(facts({}).minPlayers);
  expect(view.maxPlayers).toBe(facts({}).maxPlayers);
});
```

In `test/views/fixture.test.ts`:

```ts
it("renders the headcount as a bar whose width is the fill, not the gap", () => {
  const html = renderStatusLine(fixtureView(facts({ inCount: 6, minPlayers: 8, maxPlayers: 10 }), NOW), 0);
  expect(html).toContain(`<span class="fill short w-60">`);
  expect(html).toContain("6 of 10");
  expect(html).not.toContain("spots left");
});

it("marks a full squad as full rather than as nothing left", () => {
  const html = renderStatusLine(fixtureView(facts({ inCount: 10, minPlayers: 8, maxPlayers: 10 }), NOW), 2);
  expect(html).toContain("w-100");
  expect(html).not.toContain("short");
  expect(html).toContain("10 of 10 in · 2 waiting");
});

it("clamps an over-capacity squad to a full bar", () => {
  const html = renderStatusLine(fixtureView(facts({ inCount: 14, minPlayers: 8, maxPlayers: 10 }), NOW), 0);
  expect(html).toContain("w-100");
});

it("declares a rule for every width it can emit", () => {
  // The silent failure this catches: a width class with no matching rule is
  // a zero-width bar that no string assertion and no fetch test can see.
  for (let pct = 0; pct <= 100; pct += 5) {
    expect(FIXTURE_STYLES_CSS).toContain(`.capacity .fill.w-${pct}`);
  }
});

it("shows no bar for a fixture nobody can join", () => {
  const html = renderStatusLine(fixtureView(facts({ lifecycle: "cancelled" }), NOW), 0);
  expect(html).not.toContain("capacity");
});
```

**The bar's width is a class, never a `style` attribute.** Settled by the controller against `src/security/csp.ts:105-135`, so do not re-open it:

- `style-src` is emitted as hashes plus one font origin. No `style-src-attr` is set, so style attributes fall back to `style-src`.
- A CSP hash **cannot** authorise a `style=` attribute without `'unsafe-hashes'`, which this app does not set and must not.
- There is currently **not one inline `style="…"` attribute anywhere in `src/views/`** — verified by grep. This codebase has never relied on one.

An inline width would therefore be stripped in production: the bar renders at zero width, invisible, while every fetch-level test passes. That is exactly the silent failure spec §0.1 exists to prevent.

**Instead:** round the percentage down to the nearest 5 and emit `class="fill w-60"`, with twenty-one pre-declared classes in `FIXTURE_STYLES_CSS` (`w-0` through `w-100`). Generate them in the template literal rather than typing twenty-one rules by hand. Under no circumstances add `'unsafe-inline'` or `'unsafe-hashes'` to `style-src`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/domain/fixture-view.test.ts test/views/fixture.test.ts`
Expected: FAIL — `inCount` undefined on the view; `renderStatusLine` takes one argument.

- [ ] **Step 3: Widen `FixtureView`**

In `src/domain/fixture-view.ts`, add to the interface and return the three fields from **both** return sites in `fixtureView()` (the early `lifecycle !== "open"` return at line 67 and the main return at line 87). Missing the early return is the likely bug here: a `scheduled` or `cancelled` fixture would get `undefined` counts.

- [ ] **Step 4: Add the CSS to `FIXTURE_STYLES_CSS`**

Spec §3.1's block, plus the width classes the CSP forces:

```ts
export const FIXTURE_STYLES_CSS = `
  …existing rules…
  .capacity { margin-top: 0.6rem; }
  .capacity .track { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
  .capacity .fill { display: block; height: 100%; background: var(--accent); }
  .capacity .fill.short { background: var(--warn); }
  .capacity .spots { margin-top: 0.35rem; font-size: var(--t-support); color: var(--mut); }
  .capacity .count { font-family: var(--mono); }
${Array.from({ length: 21 }, (_, i) => `  .capacity .fill.w-${i * 5} { width: ${i * 5}%; }`).join("\n")}
`;
```

Generated rather than typed so the twenty-one rules cannot drift from the twenty-one values the renderer can emit. `FIXTURE_STYLES_CSS` is already in `PAGE_STYLE_BLOCKS`, so no registration change — but note the block is now computed at module load, so confirm the CSP hash is still taken over the final string (it is: `csp.ts` hashes the exported value, not the literal).

Keep the file's commenting standard — say why, not what. The "why" worth recording here is the CSP constraint, since the next person will otherwise reach for a `style` attribute.

- [ ] **Step 5: Rewrite `renderStatusLine`**

Replace `src/views/fixture.ts:373-379`. Keep the `.spots` element as the bar's label so nothing is lost with CSS off (spec §3.1). Never emit a bare "0 spots left".

```ts
export function renderStatusLine(view: FixtureView, waitlistCount: number): string {
  const label = STATUS_LABEL[view.status];
  const badge = `<p class="status-badge status-${view.status}">${escapeHtml(label)}</p>`;
  if (view.status === "cancelled" || view.status === "played") return badge;

  // Rounded down to a declared 5% step: the CSP forbids a style attribute, so
  // the width can only be one of the classes FIXTURE_STYLES_CSS declares.
  const ratio = view.maxPlayers === 0 ? 0 : view.inCount / view.maxPlayers;
  const pct = Math.min(100, Math.floor(ratio * 20) * 5);
  const short = view.inCount < view.minPlayers ? " short" : "";
  const waiting = waitlistCount > 0 ? ` · ${waitlistCount} waiting` : "";
  return `${badge}
    <div class="capacity">
      <div class="track"><span class="fill${short} w-${pct}"></span></div>
      <p class="spots"><span class="count">${view.inCount} of ${view.maxPlayers}</span> in${escapeHtml(waiting)}</p>
    </div>`;
}
```

Note `Math.floor(ratio * 20) * 5` reaches 100 only at a genuinely full squad, and `Math.min` clamps the over-capacity case — a 14-of-10 fixture shows a full bar, not an overflowing one.

- [ ] **Step 6: Update all four call sites**

`dashboard.ts:120` → `renderStatusLine(row.view, row.waitlistCount)` (`DashboardFixture` already has it).
`fixture.ts:483` → `renderStatusLine(view, options.waitlistCount)` (`FixturePageOptions` already has it).
`owner-fixture.ts:248` → derive from the squad already in scope: `squad.filter((m) => m.status === "waitlisted").length`.
`player-game.ts:58` → `openFixture.waitlistCount`. **This one needs plumbing:** add `waitlistCount: number` to `PlayerGameParams.openFixture` and supply it from the fixture row in `src/routes/games.ts`. `player-game.ts` cannot derive it — `openFixture.squad` is `null` when the organiser has squad visibility off.

- [ ] **Step 7: Delete the old `.spots` rule if it is now unreachable**

`styles.ts:51` has `.spots { margin-top: 0.4rem; font-size: var(--t-support); }`. `.capacity .spots` supersedes it. Grep for other `class="spots"` emitters before deleting; if any remain, leave it.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS. Note this suite takes over 120 seconds — do not set a shorter timeout, and wait for it inside your own turn.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: the headcount is a bar, not a countdown to zero"
```

---

## Task 2: `.switch-row`, `.danger-link`, and `INVITE_CSS`

**Files:**
- Modify: `src/views/styles.ts` (`FORM_CSS`; new `INVITE_CSS`; `PAGE_STYLE_BLOCKS`)
- Modify: `src/views/layout.ts` (`STYLES`)
- Test: `test/security/csp.test.ts`

**Interfaces:**
- Produces: `INVITE_CSS` exported from `src/views/styles.ts` and present in `PAGE_STYLE_BLOCKS`. Classes `.switch-row`, `.switch-row .hint`, `.danger-link`, `.card`, `.card h2`, `.card .actions`, `.qr-toggle`, `.qr-toggle summary` available to Tasks 4, 5 and 6.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

`test/security/csp.test.ts` already enumerates the style blocks. Add:

```ts
it("hashes every exported style block, including new ones", async () => {
  const header = await cspHeader();
  for (const block of STYLE_BLOCKS) {
    expect(header).toContain(`'sha256-${await sha256Base64(block)}'`);
  }
  expect(STYLE_BLOCKS).toContain(INVITE_CSS);
});
```

Match the file's existing helpers rather than importing new ones — read it first.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/security/csp.test.ts`
Expected: FAIL — `INVITE_CSS` is not exported.

- [ ] **Step 3: Add `.switch-row` to `FORM_CSS`**

```css
.switch-row { display: grid; grid-template-columns: 1fr auto; align-items: center;
  gap: 0.25rem 1rem; min-height: 52px; padding: 0.6rem 0; border-bottom: 1px solid var(--line); }
.switch-row label { font-weight: 600; }
.switch-row .hint { grid-column: 1; font-size: var(--t-support); color: var(--mut); }
.switch-row input { grid-column: 2; grid-row: 1 / span 2; width: 1.4rem; height: 1.4rem; accent-color: var(--accent); }
```

- [ ] **Step 4: Add `.danger-link` to `STYLES` in `layout.ts`**

```css
.danger-link { color: var(--danger); font-weight: 600; }
```

**Global Constraint 4 applies here specifically:** `STYLES` renders on the public holding page, and `test/routes/access.test.ts` asserts its content is free of file paths, page names and operational words. Add **no comment** beside this rule in `layout.ts`; put the explanation in `styles.ts` instead. Run `npx vitest run test/routes/access.test.ts` immediately after this step.

- [ ] **Step 5: Add `INVITE_CSS` as a new export**

```ts
export const INVITE_CSS = `
  .card { margin: 1.1rem 0; padding: 1rem; border: 1px solid var(--line); border-radius: 0.75rem; }
  .card h2 { margin: 0 0 0.6rem; font-size: var(--t-body); }
  .card .actions { margin-top: 0.75rem; }
  .qr-toggle { margin: 0; border: 0; padding: 0; }
  .qr-toggle summary { font-weight: 600; font-size: var(--t-support); color: var(--mut); cursor: pointer; }
`;
```

- [ ] **Step 6: Register it**

Add `INVITE_CSS` to `PAGE_STYLE_BLOCKS` (`styles.ts:471`). **This step is the one that matters** — an unregistered block is dropped by the browser in production and no fetch-level test fails.

- [ ] **Step 7: Run the suite and commit**

Run: `npm test`

```bash
git add -A
git commit -m "feat: switch rows, danger links, and the invite card's CSS"
```

---

## Task 3: The `centred: true` guard, and the last centred heading

**Files:**
- Modify: `src/views/styles.ts:184` (`DASHBOARD_STYLES_CSS`)
- Test: `test/views/layout.test.ts`

**Interfaces:**
- Produces: a test that fails if any view outside the enumerated terminal set passes `centred: true`. Later tasks must not add one.

- [ ] **Step 1: Write the failing test**

Spec §5 asks for this. The enumeration, verified against the tree at `26174f8` — these ten and no others:

```ts
const TERMINAL_CENTRED = [
  "src/routes/home.ts",
  "src/views/link-problem.ts",
  "src/views/cancel.ts",   // three: cancelled, already-cancelled, and the game page
  "src/views/signin.ts",   // five terminal states
];

it("centres only pages that are a single statement with nothing to scan", async () => {
  const offenders: string[] = [];
  for (const file of await readdir("src", { recursive: true })) {
    if (!file.endsWith(".ts")) continue;
    const source = await readFile(`src/${file}`, "utf8");
    if (!source.includes("centred: true")) continue;
    if (!TERMINAL_CENTRED.includes(`src/${file}`)) offenders.push(`src/${file}`);
  }
  expect(
    offenders,
    "centred: true is only for a page that is one statement with nothing to " +
      "scan. A scannable page reads as a poster instead of a list. Add the " +
      "page to TERMINAL_CENTRED only if it is genuinely terminal.",
  ).toEqual([]);
});
```

Use whatever fs access `test/views/` already has — if the vitest workers pool blocks `node:fs`, put this spec in `test/browser/` or alongside `catalogue.spec.ts` instead, which already reads `src/routes` from disk. Check before writing.

- [ ] **Step 2: Run to verify it passes for the right reason**

Run: `npx vitest run test/views/layout.test.ts`
Expected: PASS. Then temporarily add `centred: true` to `src/views/dashboard.ts`, re-run, and confirm it FAILS. Revert. A guard that has never been seen to fail is not a guard.

- [ ] **Step 3: Remove the centred heading**

`src/views/styles.ts:184`: delete `text-align: center;` from `.fixture-card h2`, leaving `margin` and `font-size`.

- [ ] **Step 4: Run the suite and commit**

Run: `npm test`

```bash
git add -A
git commit -m "test: centred pages are terminal statements, and nothing else is"
```

---

## Task 4: `src/views/game-overview.ts` — the organiser's home

The least finished page in the app, and the largest single item. Read the whole file first.

**Files:**
- Modify: `src/views/game-overview.ts`
- Test: `test/views/game-overview.test.ts`

**Interfaces:**
- Consumes: `INVITE_CSS` (Task 2), `.danger-link` (Task 2), `fixtureStatusWords` (Task 10 — **if Task 10 has not run, define the mapping here and Task 10 imports it from here**).

- [ ] **Step 1: Write the failing tests**

```ts
it("puts the invite link, its QR and the rotate form in one card", () => {
  const html = renderGameOverview(params());
  expect(html).toContain(`<div class="card">`);
  expect(html).toContain(`<details class="qr-toggle">`);
  expect(html).toContain(`<summary>Show the QR code</summary>`);
});

it("marks removing someone as destructive, not as navigation", () => {
  expect(renderGameOverview(params())).toContain(`class="danger-link"`);
});

it("never prints an internal lifecycle value", () => {
  const html = renderGameOverview(params({ upcoming: [{ id: "f1", kicksOffAt: KICKOFF, lifecycle: "open", inCount: 6 }] }));
  expect(html).not.toContain(">open<");
  expect(html).not.toMatch(/— open,/);
  expect(html).toContain("Open for answers");
});

it("does not dress a fixture list as a squad", () => {
  expect(renderGameOverview(params())).not.toContain(`<ul class="squad">${""}`);
});

it("offers one way back", () => {
  expect(renderGameOverview(params())).toContain(`class="back-link"`);
});
```

Adapt to the file's existing test helpers and exported renderer name — read `test/views/game-overview.test.ts` first.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/views/game-overview.test.ts`

- [ ] **Step 3: The invite card**

Wrap the invite link, the QR and the rotate form in one `<div class="card">` with an `<h2>`. Move the QR inside `<details class="qr-toggle"><summary>Show the QR code</summary>…</details>` — native `<details>`, no script (Global Constraint 5). "Replace this link" stays a form, under the same card, as the outlined default `.button` — it is not the page's primary action. Pass `INVITE_CSS` alongside the `FORM_CSS` the page already passes.

`.invite-link .button` must keep `flex: 0 0 auto` or the URL truncates to a fragment.

- [ ] **Step 4: The Remove link**

Inside `.member-actions`, give the Remove link `class="danger-link"`. It stays a link — do not make it a `.button` (Global Constraint 8).

- [ ] **Step 5: "Coming up" stops borrowing `ul.squad`**

It is a fixture list, not people. Use `.fixture-list`/`.fixture-card` from `DASHBOARD_STYLES_CSS` at its compact end, or a plain `ul.fixtures` with its own two rules added to `INVITE_CSS`. Pick one and say why in a comment.

- [ ] **Step 6: Map the lifecycle to words**

`game-overview.ts:96` interpolates `escapeHtml(fixture.lifecycle)` — a raw enum on a page a player can reach. Map it to the same words `renderStatusLine` uses via `STATUS_LABEL` in `fixture.ts`. Export a `fixtureStatusWords(lifecycle: Lifecycle): string` helper from `src/views/fixture.ts` rather than a second copy of the mapping.

- [ ] **Step 7: The back link**

Add `<p class="back-link"><a href="${DASHBOARD_PATH}">Back to your games</a></p>` as the last thing in the body. `.back-link` is in `FIXTURE_STYLES_CSS` — confirm the page passes that block, and pass it if not.

- [ ] **Step 8: Run the suite and commit**

Run: `npm test`

```bash
git add -A
git commit -m "feat: the organiser's game page, finished"
```

---

## Task 5: `src/views/dashboard.ts` — capacity and the only bulleted list in the app

**Files:**
- Modify: `src/views/dashboard.ts:150`, `src/views/styles.ts` (`DASHBOARD_STYLES_CSS`)
- Test: `test/views/` (dashboard coverage — locate it; it may live in `test/routes/dashboard.test.ts`)

**Interfaces:**
- Consumes: `renderStatusLine(view, waitlistCount)` (Task 1) — already wired by Task 1 Step 6; this task is only the owned-games list and verifying `.capacity` reads correctly in a column of three.

- [ ] **Step 1: Write the failing test**

```ts
it("gives games you own the same row shape as everything else", async () => {
  const html = await dashboardHtml(worldWithTwoOwnedGames());
  expect(html).toContain(`<ul class="owned-games">`);
  expect(html).not.toMatch(/<ul class="owned-games">\s*<li>[^<]*<\/li>/);
});
```

Better: assert the CSS exists rather than the markup shape — `expect(DASHBOARD_STYLES_CSS).toContain(".owned-games")`. Today it contains no rule for it at all, which is the actual defect.

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Style `ul.owned-games`**

`dashboard.ts:150` renders `<ul class="owned-games">` and `DASHBOARD_STYLES_CSS` has **no rule for it** — it is a browser-default bulleted list, the only one in the app. Give it the `ul.squad > li` row shape or reuse `.card`. Do not widen `ul.squad > li` to reach it (Global Constraint 7) — restate the rules under `.owned-games`.

- [ ] **Step 4: Check the capacity column**

The dashboard is where "0 spots left" appeared three times in one column. Render a three-fixture dashboard and confirm three bars read as three different states, not as three identical grey lines.

- [ ] **Step 5: Run the suite and commit**

```bash
git add -A
git commit -m "feat: the dashboard's owned games stop being a bulleted list"
```

---

## Task 6: `src/views/game-form.ts` — two switch rows

**Files:**
- Modify: `src/views/game-form.ts`
- Test: the file's existing view/route tests

**Interfaces:**
- Consumes: `.switch-row` (Task 2).

- [ ] **Step 1: Write the failing test**

```ts
it("gives every switch a hint, because one of them has no visible effect", () => {
  const html = renderGameForm(params());
  const rows = html.match(/class="switch-row"/g) ?? [];
  expect(rows).toHaveLength(2);
  expect(html).toContain("Warns you when the maximum is an odd number.");
  expect(html).toContain(`class="hint"`);
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Convert both checkboxes**

`prefersEvenNumbers` and squad visibility. Markup order is fixed: `<label for>` first, real `<input type="checkbox" id>` second, `.hint` third. Keep the real checkbox — no CSS-only fake control, it must work with JS off and be reachable by a screen reader.

One sentence of hint per row, **mandatory**. Squad visibility has no visible effect for the organiser, so the hint is the only place its meaning exists. Suggested, matching the guide's specimen:
- `prefersEvenNumbers` → "Warns you when the maximum is an odd number."
- squad visibility → "Off, only you see the squad on a fixture page."

Write the visibility hint to match whichever way round the checkbox is actually stored — read the field before wording it.

- [ ] **Step 4: Run the suite and commit**

```bash
git add -A
git commit -m "feat: the two game settings say what they do"
```

---

## Task 7: `src/views/join.ts` — the form above the names

**Files:**
- Modify: `src/views/join.ts`
- Test: the file's existing tests

- [ ] **Step 1: Write the failing test**

```ts
it("puts the form above the squad, for someone standing in a car park", () => {
  const html = renderJoin(params({ squad: fourteenPeople() }));
  expect(html.indexOf(`name="name"`)).toBeLessThan(html.indexOf("Who's playing"));
});

it("shows the squad as chips, because nothing here acts on a person", () => {
  const html = renderJoin(params({ squad: fourteenPeople() }));
  expect(html).toContain(`class="chip`);
  expect(html).not.toContain(`<ul class="squad">`);
});
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Reorder and re-render**

New order: game details, **then the form**, then "Who's playing (14)" as social proof at the foot. Render the squad as neutral `.chip`s from `SQUAD_STYLES_CSS`, not `ul.squad` rows.

**Keep `redactName` at the point of interpolation.** This is a public page reached by anyone holding the link; moving redaction away from the interpolation site is how a future edit leaks full names. Pass `SQUAD_STYLES_CSS` if the page does not already.

- [ ] **Step 4: Run the suite and commit**

```bash
git add -A
git commit -m "feat: two fields before fourteen names on the invite page"
```

---

## Task 8: `remove-member.ts` and `leave.ts` — the escape and the list

Batched: both are small, both are about a destructive page's shape.

**Files:**
- Modify: `src/views/remove-member.ts`, `src/views/leave.ts`
- Test: `test/views/remove-member.test.ts` and leave's existing tests

- [ ] **Step 1: Write the failing tests**

```ts
// remove-member
it("gives the escape the same weight as the one on the cancel page", () => {
  const html = renderRemoveMember(params());
  expect(html).toContain(`class="button keep-link"`);
  expect(html).toContain("No, leave the squad as it is");
});

// leave
it("does not stack full-width buttons one per game", () => {
  const html = otherGamesBody(params({ games: threeGames() }));
  expect(html).toContain(`<ul class="squad">`);
  expect(html).toContain(`class="back-link"`);
});
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: `remove-member.ts`**

The destructive button is already right. The escape is a bare `<p><a>`; give it `cancel.ts`'s `.keep-link` treatment (`cancel.ts:145` is the worked example: `<a class="button keep-link" href="…">`) and pass `CANCEL_STYLES_CSS`, which is where `.keep-link` lives (`styles.ts:276`).

**Keep the wording** — "No, leave the squad as it is". It is better than anything a rewrite would produce.

- [ ] **Step 4: `leave.ts`**

`otherGamesBody` renders a bare `<ul>` with a `.button` inside each `<li>` — unstyled, full-width buttons, one per game. Use `<ul class="squad">` so the existing grid row shape applies. Add the `.back-link`. The `confirmBody` organiser warning stays `.nudge` — do not touch it.

- [ ] **Step 5: Run the suite and commit**

```bash
git add -A
git commit -m "feat: a matched escape on remove, and rows instead of stacked buttons on leave"
```

---

## Task 9: `account.ts` and `squad-member.ts` — stop using a dashed box for a value

Batched: the same defect, in two files M11 created.

**Files:**
- Modify: `src/views/account.ts:106-107`, `src/views/squad-member.ts:46-57`
- Test: `test/routes/account.test.ts` and the squad-member tests

**Interfaces:**
- Produces: a `.field-label` (or similarly named) rule for the `--mut` label above a read-out value. Declare it once and use it in both files; put it in `FORM_CSS`, which both pages already pass.

- [ ] **Step 1: Write the failing tests**

```ts
it("does not put a read-out value in an empty-state box", async () => {
  const html = await accountHtml(signedInPlayer());
  expect(html).toContain("player@example.com");
  expect(html).not.toMatch(/<p class="read-only">[^<]*@/);
});

it("keeps the dashed box for the state it means — nothing to act on", async () => {
  const html = await accountHtml(playerWithNoFixtures());
  expect(html).toContain(`<p class="read-only">Nothing yet.`);
});

it("groups signing in under one heading", async () => {
  const html = await accountHtml(signedInPlayer());
  expect(html).toContain("<h2>Signing in</h2>");
  expect(html).not.toContain("<h2>Your email address</h2>");
  expect(html).not.toContain("<h2>How you sign in</h2>");
});
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: `account.ts`**

Five `h2`s with one line each reads as a stack of dividers. Merge "Your email address" and "How you sign in" under one **"Signing in"** heading.

Drop `.read-only`'s dashed border for the email value (`account.ts:106-107`). A dashed box means "you cannot act on this here" — right for the empty fixtures state at line 134, wrong for a value you are reading out. Use a plain `<p>` with the label in `--mut` above it.

**Leave the `.fixture-card`s exactly as they are** — they are correct, and `.capacity` does not apply to a history row. **Keep the erasure `.nudge` exactly as it is.**

- [ ] **Step 4: `squad-member.ts`**

Same `.read-only` misuse at lines 46-47 (email) and 57 (role and joined date). Plain `<p>`, label in `--mut` above the value. The "No email address — a guest, added for one fixture" case is genuinely an absence, not a value: it may keep `.read-only`. Make the call and say why in a comment.

- [ ] **Step 5: Run the suite and commit**

```bash
git add -A
git commit -m "feat: a dashed box means nothing to act on, not here is your email"
```

---

## Task 10: The P3 audits, and the player's raw lifecycle

**Files:**
- Modify: `src/views/player-game.ts:67`
- Audit only: `src/views/signin.ts`, `src/views/team-picker.ts`, `src/views/delete-account.ts`, `src/views/privacy.ts`, `src/views/passkeys.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("never shows a player an internal lifecycle value", () => {
  const html = renderPlayerGame(params({ upcoming: [{ kicksOffAt: KICKOFF, lifecycle: "scheduled" }] }));
  expect(html).not.toMatch(/— scheduled/);
  expect(html).toContain("Not open yet");
});
```

Word it from `STATUS_LABEL`, not from this plan — read the real labels.

- [ ] **Step 2: Fix `player-game.ts:67`** using the `fixtureStatusWords` helper Task 4 exports from `fixture.ts`.

- [ ] **Step 3: Audit `delete-account.ts` — the one with teeth**

It renders `.button.danger` and `.button.primary` on the same page. **Verify they are in mutually exclusive states** (Global Constraint 8). Enumerate every state the page can render and assert it in a test:

```ts
it("never shows a red and a green filled button together", () => {
  for (const state of EVERY_DELETE_ACCOUNT_STATE) {
    const html = renderDeleteAccount(state);
    const filled = (html.match(/class="button (danger|primary)"/g) ?? []).length;
    expect(filled, `state ${state.name} renders ${filled} filled buttons`).toBeLessThanOrEqual(1);
  }
});
```

If any state shows both, demote "Keep my account" to the outlined default.

- [ ] **Step 4: Audit `team-picker.ts`**

Check "Publish teams" and "Save teams" — two `.button.primary` submits — are never rendered together. Assert it with the same shape of test. `.your-side` at `--t-lead`/`--accent` is right; leave it.

- [ ] **Step 5: Audit `signin.ts`**

Confirm the five `centred: true` states are genuinely terminal statements. They are. Task 3's guard now enforces it. **Change nothing.**

- [ ] **Step 6: `privacy.ts` and `passkeys.ts`** — no visual work. Confirm and move on.

- [ ] **Step 7: Run the suite and commit**

```bash
git add -A
git commit -m "feat: no raw enum on a player's page, and one filled button per screen"
```

---

## Task 11: Browser verification and the guide

**Files:**
- Run: `test/browser/layout.spec.ts`, `test/browser/catalogue.spec.ts`, `test/browser/console-gate.spec.ts`
- Regenerate: `docs/guide/images/*`

- [ ] **Step 1: Run the browser suite at 390px**

Run: `npx playwright test`
Expected: PASS, including the console/CSP gate for every catalogued page.

Two failure modes no string assertion can see, **both of which have happened in this repo before**:
- a row whose shape depends on the length of the name in it (the `.switch-row` and `ul.owned-games` grids are the new candidates);
- a control invisible because its fill sits on top of its track (`.capacity .fill` on `.capacity .track` is exactly this shape).

**Look at the captured PNGs.** The M11 milestone shipped three user-visible defects past a fully green 1404-test suite and eight clean reviews; all three were only visible by opening the images.

- [ ] **Step 2: Re-capture the guide images**

The P1 screens have changed, so `docs/guide` now shows the old UI.

Run: `npm run guide:capture`

Then read `docs/guide/05-running-your-squad.md` and the other chapters that reference the changed screens, and correct any prose that describes the old layout — the QR code is now behind a disclosure, and that is described in the guide as always visible.

- [ ] **Step 3: Manual pass at 390px, light and dark**

Confirm, per spec §5: every screen has one primary action; no red and green filled button on the same screen; every session page has a back link; no centred body text outside the terminal pages.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: regenerate the guide for the M12 visual pass"
```

---

## Self-review notes

- **Spec coverage:** §0 → Global Constraints. §1 → constraint 9. §2.1 → Task 3. §2.2 → Task 10. §2.3 → Task 1. §2.4 → Tasks 8, 9. §2.5 → Tasks 4, 5, 8. §2.6 → Task 9. §2.7 → Task 7. §3.1 → Task 1. §3.2 → Tasks 2, 6. §3.3 → Tasks 2, 4. §3.4 → Tasks 2, 4. §4 P1 → Tasks 4, 5, 6. §4 P2 → Tasks 7, 8, 9. §4 P3 → Task 10. §5 → Tasks 3, 11.
- **Two spec defects ruled on above**, before Task 1: the `.capacity` data gap and the `player-game.ts` raw lifecycle.
- **One spec-adjacent hazard settled by the controller, not left to an implementer**: spec §3.1's bar has no stated width mechanism, and the obvious one — a `style` attribute — is silently stripped by this app's CSP. Verified directly against `src/security/csp.ts` (hash-only `style-src`, no `style-src-attr`, and no existing inline style attribute anywhere in `src/views/`). Task 1 uses declared width classes and asserts every emittable class has a rule.
- **Task ordering is load-bearing.** Tasks 1-3 produce interfaces every later task consumes. Tasks 4-10 are independent of each other and could run in any order.
