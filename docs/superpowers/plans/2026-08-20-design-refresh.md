# Design Refresh (M20) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the whole product in the approved warm palette and display type, recolour the icon to match, and land seven IA changes from the design review.

**Architecture:** Phase A (Tasks 1–4) changes the visual system through the token block in `src/views/layout.ts` and the component blocks in `src/views/styles.ts` — every page inherits it because all CSS flows through those two files and the CSP hashes are derived from them. Phase B (Tasks 5–11) makes seven structural changes, ordered cheap to deep, each independently shippable.

**Tech Stack:** Cloudflare Workers + Hono server-rendered HTML, Drizzle/D1, vitest + Playwright, Google Fonts, rsvg-convert for icon rasterisation.

**Spec:** `docs/superpowers/specs/2026-08-20-design-refresh-design.md` — the plan argues from the spec; read both. `screens.md` (repo root, untracked) is the screen inventory; the design mocks are in `Make The Team - IA and screens.html` (repo root, untracked — open it in a browser if you need to see a mock).

## Global Constraints

- Work in the milestone worktree `../maketheteam-m20` (created at execution start via the using-git-worktrees skill), with its own `npm install`. Never add an `allowScripts` block to `package.json`.
- **Pushing `main` deploys production.** Merge fast-forward to `main` only complete, verified slices. Phase A merges only after Task 4's full visual pass.
- Every `<style>` block must be a member of `STYLE_BLOCKS` (`src/views/styles.ts`) or it is silently dropped by the CSP. Never add `style=""` attributes, `'unsafe-inline'`, or `'unsafe-hashes'`.
- `pageStyles` array order is cascade order; `test/views/style-cascade.test.ts` enumerates same-selector collisions. Order-pinning tests must pair with presence assertions (`indexOf` returns `-1` when absent, and `-1 < anything`).
- No backticks inside CSS comments in template literals; no UI copy quoted inside CSS comments (both are documented silent failures — see `CLAUDE.md`).
- Every interpolation goes through `escapeHtml`, `href` and class attributes included.
- Comments name the failure a rule prevents; they never restate the code, and they never overclaim.
- The repo is public: no real person's name in any committed content.
- Full check before every merge to main: `npm run lint && npx tsc --noEmit && npm test && npx playwright test`. `npm test` takes >120s — wait for it in the foreground; never background it and end the turn.
- Commit trailers: end every commit message with the repo's standard `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and `Claude-Session:` lines (copy them from `git log -1` before your first commit).
- Working-notes rule 3: after changing a page, capture and *read* the rendered PNG (`npm run guide:capture` regenerates `docs/guide/images/*`; scope with `--grep` where possible).

---

### Task 1: Tokens, fonts, and the contrast guard

**Files:**
- Modify: `src/views/layout.ts` (the `STYLES` export: `:root` and dark blocks; the `body` font rule; the `h1`/`h2` rules; the Google Fonts `<link>` near the bottom of `layout()`; the `THEME_COLOR` constant)
- Create: `test/views/contrast.test.ts`

**Interfaces:**
- Produces: CSS custom properties every later task uses: `--bg --card --card-raised --fg --mut --line --accent --accent-fg --accent-mut --link --ok --ok-bg --ok-fg --warn --warn-bg --wait --wait-fg --danger --danger-fg --field`, in both themes. `THEME_COLOR = "#c67139"`.

- [ ] **Step 1: Write the failing contrast guard**

This is the spec's global invariant (§2.2: "the contrast check is part of the task, not a follow-up") written as the enumerating test *first*, per working-notes rule 1. Create `test/views/contrast.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { STYLES } from "../../src/views/layout.js";

/**
 * WCAG 2.1 relative luminance and contrast ratio. The token block is the
 * single source of every colour in the product, so checking the declared
 * pairs here checks every page at once — the failure this prevents is a
 * palette nudge that quietly drops body text under the AA floor on one
 * theme while the other still reads fine.
 */
function channel(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(n.slice(i, i + 2), 16));
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The declarations of one theme, `--name` -> `#rrggbb`. */
function tokens(theme: "light" | "dark"): Record<string, string> {
  const darkAt = STYLES.indexOf("prefers-color-scheme: dark");
  expect(darkAt).toBeGreaterThan(-1);
  const slice = theme === "light" ? STYLES.slice(0, darkAt) : STYLES.slice(darkAt);
  const out: Record<string, string> = {};
  for (const m of slice.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]!] = m[2]!;
  return out;
}

/** [foreground token, ground token, minimum ratio]. 4.5 for text, 3 for large/UI. */
const PAIRS: readonly [string, string, number][] = [
  ["--fg", "--bg", 4.5],
  ["--fg", "--card", 4.5],
  ["--fg", "--card-raised", 4.5],
  ["--fg", "--field", 4.5],
  ["--mut", "--bg", 4.5],
  ["--mut", "--card", 4.5],
  ["--mut", "--card-raised", 4.5],
  ["--link", "--bg", 4.5],
  ["--link", "--card", 4.5],
  ["--link", "--card-raised", 4.5],
  // Button text renders at var(--t-lead) bold — WCAG large text, 3:1 floor.
  // Never put small text in these two fills; small text uses the -bg/-fg
  // pale pairs above, which hold the 4.5 floor.
  ["--accent-fg", "--accent", 3],
  ["--danger-fg", "--danger", 3],
  ["--ok-fg", "--ok-bg", 4.5],
  ["--warn", "--warn-bg", 4.5],
  ["--wait-fg", "--wait", 4.5],
  ["--accent", "--bg", 3],
  ["--line", "--bg", 1.2],
];

describe.each(["light", "dark"] as const)("the %s palette", (theme) => {
  const t = tokens(theme);
  it.each(PAIRS)("%s on %s reads at %s:1 or better", (fgTok, bgTok, floor) => {
    expect(t[fgTok], `${fgTok} missing from the ${theme} block`).toBeDefined();
    expect(t[bgTok], `${bgTok} missing from the ${theme} block`).toBeDefined();
    expect(ratio(t[fgTok]!, t[bgTok]!)).toBeGreaterThanOrEqual(floor);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/views/contrast.test.ts`
Expected: FAIL — the new token names (`--card`, `--ok`, `--wait`, `--field`, `--link`…) do not exist yet.

- [ ] **Step 3: Replace the token blocks**

In `src/views/layout.ts`, set `THEME_COLOR = "#c67139"` (its doc comment about deriving `--accent` stays true and stays put). Then replace the `:root` and dark declarations inside `STYLES`. Keep `color-scheme: light dark;`, the type-scale line, and `--mono` exactly as they are; keep the `--danger` "irreversible actions only" comment; **delete** the stale `--mut` contrast-numbers comment and replace it with one line: `/* Contrast floors for every pair are enforced by test/views/contrast.test.ts. */`. New declarations:

```css
    --fg: #201e1d; --bg: #efe3cd;
    --card: #f5ead8; --card-raised: #f9f4ed; --field: #ebddc5;
    --mut: #645c50; --line: #dcd3c4;
    --accent: ${THEME_COLOR}; --accent-fg: #fff7f0; --accent-mut: #ffe1d0;
    --link: #8c491a;
    --ok: #8fa073; --ok-bg: #e1eecc; --ok-fg: #3d472b;
    --warn: #8a4c14; --warn-bg: #ffe1d0;
    --wait: #f6a06b; --wait-fg: #402310;
    --danger: #a4321f; --danger-fg: #fbfaf8;
```

and in the `prefers-color-scheme: dark` block:

```css
      --fg: #ede5d8; --bg: #221f1b;
      --card: #2b2721; --card-raised: #322d26; --field: #3a342b;
      --mut: #a89e8f; --line: #3a352d;
      --accent: #d98a55; --accent-fg: #2a1608; --accent-mut: #3a2818;
      --link: #e0a878;
      --ok: #a3b585; --ok-bg: #2c3320; --ok-fg: #cfe0b0;
      --warn: #f0b285; --warn-bg: #43301f;
      --wait: #f6a06b; --wait-fg: #402310;
      --danger: #e8705a; --danger-fg: #1a0d0a;
```

These are the spec's starting values; **if a pair fails Step 4, nudge the foreground token darker/lighter until it passes and keep the passing value** — the spec explicitly says the shipped value is whatever passed AA.

- [ ] **Step 4: Run the guard until it passes**

Run: `npx vitest run test/views/contrast.test.ts`
Expected: PASS (after any nudges from Step 3).

- [ ] **Step 5: Swap the type**

Still in `layout.ts`:
- In the `body` rule, change the family list to `"Figtree", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`.
- Change the `h1` rule to `h1 { font-family: "Caprasimo", "Figtree", serif; font-weight: 400; font-size: var(--t-title); letter-spacing: 0; margin: 0 0 0.5rem; }` and `h2` to `h2 { font-family: "Caprasimo", "Figtree", serif; font-weight: 400; font-size: var(--t-lead); margin: 2rem 0 0.6rem; }`. Caprasimo has one weight; declaring 400 stops browsers faux-bolding it.
- Change `a { color: var(--accent); }` to `a { color: var(--link); }`.
- Find the Google Fonts `<link>` inside `layout()` and replace the families: `https://fonts.googleapis.com/css2?family=Caprasimo&family=Figtree:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap`. (IBM Plex Mono stays — spec §2.3.)

- [ ] **Step 6: Typecheck and see what the token rename broke**

Run: `npx tsc --noEmit && npx vitest run test/views test/routes/pwa.test.ts test/routes/signin.test.ts`
Expected: tsc clean. Some tests may assert old colour literals (`#1f6f4a` in `test/views/layout.test.ts` / `test/routes/pwa.test.ts` for theme-color and manifest). Update those expectations to `#c67139`. Any test asserting a token that no longer exists (`--accent-mut` still exists; `--warn` semantics changed) gets its expectation updated, never deleted.

- [ ] **Step 7: Full unit suite**

Run: `npm test`
Expected: PASS. Fix what fails by updating expectations to the new values — behaviour has not changed, only colours and fonts.

- [ ] **Step 8: Commit**

```bash
git add -A src test
git commit -m "feat: warm palette and display type tokens, with a contrast guard (M20 A1)"
```

---

### Task 2: Component restyle — pills, cards, badges, bars

**Files:**
- Modify: `src/views/layout.ts` (`STYLES`: `.button`, `.nudge`, `.update-overlay`)
- Modify: `src/views/styles.ts` (every block listed in the table below)

**Interfaces:**
- Consumes: Task 1's tokens.
- Produces: the class treatments later tasks rely on: `.button` is a filled pill; `.nudge.ok` is the success notice; `.badge` variants; the capacity bar's overflow segment uses `--wait`.

- [ ] **Step 1: Restyle the shared primitives in `STYLES`**

In `layout.ts`:
- `.button`: replace the border/background/radius lines with `border: none; border-radius: 999px; background: var(--field); color: var(--fg);` (min-height, padding, font lines stay). `.button.primary` and `.button.danger` keep their fills; remove their `border-color` declarations (there is no border now).
- `.nudge`: change `border-radius` to `1rem`. Add directly below it:

```css
  /* The one success notice shape. B4's broadcast receipt is its first user;
     anything later that says "that worked" uses this, not a new class. */
  .nudge.ok { background: var(--ok-bg); color: var(--ok-fg); }
```

- `.update-overlay`: change `border-radius` to `1rem` and `background: var(--bg)` to `background: var(--card-raised)`.

- [ ] **Step 2: Restyle the page blocks in `styles.ts`**

Work block by block. For each row, find the named selectors *in that block* (do not trust remembered line numbers) and apply the treatment. Where a selector in the table does not exist in the block, skip it — do not invent it.

| Block | Treatment |
|---|---|
| `FIXTURE_STYLES_CSS` | Card containers (`.fixture-card` and any bordered box): `border: none; border-radius: 1.25rem; background: var(--card-raised);`. Status badge classes: the confirmed/on state gets `background: var(--ok-fg); color: var(--ok-bg);` (dark green fill, pale text — badge text is small, and pale-on-mid-green fails AA); open/needs-players states get `background: var(--ok-bg); color: var(--ok-fg);`; played/not-open get `background: var(--field); color: var(--mut);`; cancelled/over-capacity get `background: var(--accent-mut); color: var(--warn);`. Capacity bar: track `background: var(--line);`, fill `background: var(--ok);`, and the over-capacity overflow segment `background: var(--wait);`. |
| `SQUAD_STYLES_CSS` | Roster chips: `border-radius: 999px; background: var(--field);` with the viewer's own chip filled in ink — `background: var(--fg); color: var(--bg);` — which is what the mock's own-chip actually is, and the one fill that passes AA at chip size in both themes. Waitlisted chips: `background: var(--warn-bg); color: var(--warn);`. |
| `DASHBOARD_STYLES_CSS` | `.onboarding`: `border: none; border-radius: 1.25rem; background: var(--card-raised);`. Everything else inherits. |
| `FORM_CSS` | Inputs/textareas/selects: `border: none; background: var(--field); border-radius: 0.75rem;`, and a focus rule `outline: 3px solid var(--accent); outline-offset: 2px;` if the block does not already have one. Error text keeps `--danger`. The `.segment` In/Out control (find it in this file — the "segmented mark-in/mark-out" comment): track `border-radius: 999px; background: var(--field);`, segments pill-radiused, a selected In (`.seg.on`) becomes `background: var(--ok-fg); color: var(--ok-bg);` (success family per spec §2.4, dark-fill variant because segment text is small), and a selected Out (`.seg.out` — the markup in `src/views/owner-fixture.ts` distinguishes them) stays neutral: `background: var(--card-raised); color: var(--fg);`. |
| `TEAM_PICKER_CSS` | The two team columns: `border-radius: 1.25rem;`, first column `background: var(--ok-bg); color: var(--ok-fg);`, second `background: var(--accent-mut); color: var(--warn);`. Radio pills follow `.button`'s pill radius. |
| `PUSH_STYLES_CSS` / `INSTALL_STYLES_CSS` | Section boxes: `border: none; border-radius: 1.25rem; background: var(--card-raised);`. Device-table row actions keep their size; no colour changes beyond inheritance. |
| `INVITE_CSS` | `.card`: `border: none; border-radius: 1.25rem; background: var(--card-raised);`. The invite URL readout keeps `--mono` and gets `background: var(--field); border: none; border-radius: 0.75rem;`. |
| `SIGNIN_STYLES_CSS`, `CANCEL_STYLES_CSS`, `PASSKEY_STYLES_CSS`, `ADMIN_ALLOWLIST_CSS`, `ADMIN_TOOLS_CSS`, `PRIVACY_STYLES_CSS`, `OFFLINE_STYLES_CSS` | Sweep for hard-coded colours and old radii only: any literal hex becomes the matching token; boxes get `border-radius: 1.25rem`. No structural changes. |

While editing: CSS comments must not quote UI copy and must not contain backticks (both are documented silent failures).

- [ ] **Step 3: Cascade and suite checks**

Run: `npx vitest run test/views/style-cascade.test.ts && npm test`
Expected: PASS. If style-cascade fails, a same-selector collision changed — reorder the page's `pageStyles` array or list the collision with a reason, per that test's own instructions. Update any test asserting a replaced declaration (search the failure text, fix the expectation).

- [ ] **Step 4: Look at pages, not strings**

Run: `npm run guide:capture`
Read (with the Read tool, actually look) at minimum: `docs/guide/images/dashboard.png`, `join.png`, `account.png`, `game-overview.png`, plus any image whose page you touched a selector in. You are looking for: invisible controls, black-on-dark or white-on-cream text, un-rounded boxes that stayed bordered, a capacity bar with no visible fill. Fix and re-capture until each page reads cleanly.

- [ ] **Step 5: Commit**

```bash
git add -A src test docs/guide/images
git commit -m "feat: pill buttons, soft cards and the badge family in the new palette (M20 A2)"
```

---

### Task 3: Icon colours, regenerated bytes

**Files:**
- Modify: `src/views/icon.ts` (colour values only), `src/views/icon-bytes.ts` (regenerated, committed)
- Test: `test/views/icon.test.ts` (update colour expectations)

**Interfaces:**
- Consumes: nothing. Produces: the terracotta/cream icon at every size; `THEME_COLOR` already changed in Task 1.

- [ ] **Step 1: Update the failing expectations first**

In `test/views/icon.test.ts`, find any assertion on `#1f6f4a` or `#fbfaf8` in `ICON_SVG` and change it to `#c67139` / `#f9f4ed`. If no colour assertion exists, add one:

```ts
it("is the terracotta mark on the cream dots (M20)", () => {
  expect(ICON_SVG).toContain('fill="#c67139"');
  expect(ICON_SVG).toContain('fill="#f9f4ed"');
  expect(ICON_SVG).not.toContain("#1f6f4a");
});
```

Run: `npx vitest run test/views/icon.test.ts` — expected: FAIL.

- [ ] **Step 2: Recolour the mark — geometry untouched**

In `src/views/icon.ts`, the doc comment forbids touching the numbers; obey it. Change exactly three colour values in `ICON_SVG`: the `<rect>` fill `#1f6f4a` → `#c67139`, the `<g>` fill `#fbfaf8` → `#f9f4ed`, and the hollow-dot `stroke` `#fbfaf8` → `#f9f4ed`. Nothing else.

- [ ] **Step 3: Regenerate the committed bytes**

Run: `node scripts/build-icons.mjs`
Expected: `src/views/icon-bytes.ts` rewritten (the script needs `rsvg-convert`; it errors with install instructions if missing).

- [ ] **Step 4: Verify**

Run: `npx vitest run test/views/icon.test.ts test/routes/pwa.test.ts`
Expected: PASS. Then render the icon once and look at it:

```bash
node -e 'const {ICON_SVG}=await import("./src/views/icon.ts"); const fs=await import("node:fs"); fs.writeFileSync("/tmp/icon-check.svg", ICON_SVG);' --experimental-strip-types 2>/dev/null || npx tsx -e 'import {ICON_SVG} from "./src/views/icon.ts"; import fs from "node:fs"; fs.writeFileSync("/tmp/icon-check.svg", ICON_SVG);'
rsvg-convert -w 192 /tmp/icon-check.svg -o /tmp/icon-check.png
```

Read `/tmp/icon-check.png`: cream dots on terracotta, tick shape intact.

- [ ] **Step 5: Commit**

```bash
git add src/views/icon.ts src/views/icon-bytes.ts test/views/icon.test.ts
git commit -m "feat: the mark in terracotta and cream (M20 A3)"
```

---

### Task 4: The full visual pass — Phase A's merge gate

**Files:**
- Modify: `docs/guide/images/*` (regenerated), plus whatever the pass turns up.

- [ ] **Step 1: Regenerate everything**

Run: `npm run guide:capture`
Expected: all guide images regenerated in the new system.

- [ ] **Step 2: Read every image**

Read **all** files in `docs/guide/images/` — every one, not a sample. For each: type legible in Caprasimo/Figtree, controls visible against their grounds, badges in the right family (green = going ahead, amber = unsettled, red = irreversible), nothing still in the old green accent.

- [ ] **Step 3: Spot-check dark mode**

The guide captures light. Shoot two dark pages with a throwaway script in the scratchpad (pattern from `shoot-onboarding.mjs` there; start wrangler with the flags from `WRANGLER_FLAGS` in `playwright.config.ts`, including `--local-upstream localhost:8787`):

```js
const ctx = await browser.newContext({ colorScheme: "dark" });
```

Capture `/` and `/app` (sign in via the local D1 verification-token pattern the shoot scripts use). Read both PNGs: warm charcoal ground, readable text, no light-mode islands.

- [ ] **Step 4: The full gate**

Run: `npm run lint && npx tsc --noEmit && npm test && npx playwright test`
Expected: all clean. This is the gate the spec's §6 sets for merging Phase A.

- [ ] **Step 5: Commit, merge, push**

```bash
git add -A
git commit -m "feat: full visual pass in the new system (M20 A4)"
# then, from the main checkout:
git merge --ff-only <worktree-branch> && git push
```

Watch CI (`gh run list --limit 1`) and confirm production answers 200 after deploy.

---

### Task 5: Reorder the organiser's game page (B1)

**Files:**
- Modify: `src/views/game-overview.ts` (the `body` template in `renderGameOverviewPage`)
- Test: `test/views/game-overview.test.ts`

- [ ] **Step 1: Write the failing order test**

Add to `test/views/game-overview.test.ts` (reuse the file's existing render helper/params):

```ts
it("puts fixtures first, squad second, invite last (M20 B1)", () => {
  const html = renderGameOverviewPage(baseParams());
  const coming = html.indexOf("Coming up");
  const squad = html.indexOf("Squad (");
  const invite = html.indexOf("Invite people");
  const message = html.indexOf("Message everyone");
  // Presence first: indexOf's -1 sorts before everything, so an absent
  // section would pass the order assertions vacuously.
  for (const at of [coming, squad, invite, message]) expect(at).toBeGreaterThan(-1);
  expect(coming).toBeLessThan(squad);
  expect(squad).toBeLessThan(invite);
  expect(invite).toBeLessThan(message);
});
```

Run: `npx vitest run test/views/game-overview.test.ts` — expected: FAIL (invite currently renders first).

- [ ] **Step 2: Reorder the template**

In `renderGameOverviewPage`'s `body`, move the sections so the order after the `Edit this game` link is: `Coming up` list → `Squad (N)` list → the invite `div.card` → the `Message everyone` action → back-link. Move whole blocks; change no markup inside them. The HTML comment about the message action living outside the invite form moves with the action.

- [ ] **Step 3: Verify**

Run: `npx vitest run test/views/game-overview.test.ts test/routes/games.test.ts && npm run guide:capture -- --grep game-overview 2>/dev/null || npm run guide:capture`
Expected: tests PASS. Read `docs/guide/images/game-overview.png`: fixtures at the top, invite card near the bottom.

- [ ] **Step 4: Commit**

```bash
git add src/views/game-overview.ts test/views/game-overview.test.ts docs/guide/images
git commit -m "feat: fixtures first on the organiser's game page (M20 B1)"
```

---

### Task 6: Fold the dashboard footer into the header (B2)

**Files:**
- Modify: `src/views/dashboard.ts` (the `body` in `renderDashboardPage`; imports)
- Test: `test/routes/dashboard.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/routes/dashboard.test.ts` (its `viewer()`/sign-in helpers already exist):

```ts
it("keeps delete and privacy in the footer but drops the passkey nudge and sign-out (M20 B2)", async () => {
  const { html } = await viewer();
  expect(html).toContain("Delete my account and data");
  expect(html).toContain("Privacy");
  expect(html).not.toContain("Sign in faster next time with a passkey");
  // The sign-out form lives on the account page only now (spec decision Q3).
  expect(html).not.toContain('class="signout"');
});
```

Run: `npx vitest run test/routes/dashboard.test.ts` — expected: the new test FAILS.

- [ ] **Step 2: Delete the two footer pieces**

In `renderDashboardPage`'s `body`, delete the `<p><a href="${PASSKEYS_PATH}">Sign in faster next time with a passkey</a></p>` line and the `${signOutForm("Sign out")}` line; keep the delete·privacy line. Remove the now-unused `signOutForm` import — and the `PASSKEYS_PATH` import **only if** nothing else in the file uses it (the onboarding card does — check before removing).

- [ ] **Step 3: Verify**

Run: `npx vitest run test/routes/dashboard.test.ts && npx tsc --noEmit`
Expected: PASS, no unused-import errors. Confirm the account page still renders its sign-out (it does — `signOutForm` in `src/views/account.ts`); that is the invariant that makes this a deletion, not a loss.

- [ ] **Step 4: Commit**

```bash
git add src/views/dashboard.ts test/routes/dashboard.test.ts
git commit -m "feat: the dashboard footer trusts the header (M20 B2)"
```

---

### Task 7: "Your squads" on the dashboard (B3)

**Files:**
- Modify: `src/db/queries.ts`, `src/views/dashboard.ts`, `src/routes/dashboard.ts`
- Test: `test/routes/dashboard.test.ts`

**Interfaces:**
- Produces: `listMemberGames(db, playerId): Promise<{ id: string; name: string; owned: boolean }[]>` in `src/db/queries.ts`; `DashboardPageOptions.squads: readonly SquadListEntry[]` replacing `ownedGames`.

- [ ] **Step 1: Write the failing route tests**

```ts
describe("the Your squads section (M20 B3)", () => {
  it("lists every membership with the owned marker, and links each game", async () => {
    // Arrange with the file's existing seed helpers: the signed-in player
    // owning one game and being an ordinary member of another.
    const { html } = await viewer();
    expect(html).toContain("Your squads");
    expect(html).toContain("you own this");     // on the owned game only
    expect(html).toContain(`href="/g/`);        // both names are links
    expect(html).not.toContain("Games you own"); // the old heading is gone
  });
  it("omits the section entire when the player has no squads, keeping Set up a game", async () => {
    const { html } = await viewerWithNoMemberships();
    expect(html).not.toContain("Your squads");
    expect(html).toContain("Set up a game");
  });
});
```

Adapt the arrange steps to the file's existing fixtures (read them first — working-notes rule 4). Run: `npx vitest run test/routes/dashboard.test.ts` — expected: FAIL.

- [ ] **Step 2: The query**

In `src/db/queries.ts`, next to `listOwnedGames`:

```ts
/**
 * Every active game this player is an active member of, with whether they
 * own it — the dashboard's "Your squads" list (M20 B3). This exists because
 * a non-organiser's only other route to a game page is a fixture card that
 * is only there while a fixture is open.
 */
export async function listMemberGames(
  db: Db,
  playerId: string,
): Promise<{ id: string; name: string; owned: boolean }[]> {
  const rows = await db
    .select({ id: games.id, name: games.name, role: memberships.role })
    .from(games)
    .innerJoin(memberships, eq(memberships.gameId, games.id))
    .where(
      and(
        eq(games.active, true),
        eq(memberships.playerId, playerId),
        eq(memberships.active, true),
      ),
    )
    .orderBy(games.name);
  return rows.map((r) => ({ id: r.id, name: r.name, owned: r.role === "owner" }));
}
```

- [ ] **Step 3: The view**

In `src/views/dashboard.ts`, replace `OwnedGame`/`ownedGames` with:

```ts
export interface SquadListEntry {
  id: string;
  name: string;
  owned: boolean;
}
```

and replace `renderOwnedGamesSection` with (keeping its doc comment's point about `/g/new` reachability and the no-heading-over-nothing empty state):

```ts
function renderYourSquadsSection(squads: readonly SquadListEntry[]): string {
  const link = `<p><a href="${NEW_GAME_PATH}">Set up a game</a></p>`;
  if (squads.length === 0) return link;
  const items = squads
    .map(
      (g) =>
        `<li><a href="${escapeHtml(gamePath(g.id))}">${escapeHtml(g.name)}</a>${
          g.owned ? `<span class="detail"> · you own this</span>` : ""
        }</li>`,
    )
    .join("");
  return `
    <h2>Your squads</h2>
    <ul class="owned-games">${items}</ul>
    ${link}`;
}
```

Rename the option field `ownedGames` → `squads` through `DashboardPageOptions` and the `renderDashboardPage` destructuring/call.

- [ ] **Step 4: The route**

In `src/routes/dashboard.ts`, swap `listOwnedGames(db, player.id)` for `listMemberGames(db, player.id)` in the `Promise.all`, pass it as `squads`. Then check `listOwnedGames` for remaining callers (`grep -rn "listOwnedGames" src test`) — if the dashboard was its last caller, delete it and its tests' fixtures move to `listMemberGames`; if others remain, leave it.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run test/routes/dashboard.test.ts test/routes/games.test.ts && npx tsc --noEmit && npm run guide:capture`
Read `docs/guide/images/dashboard.png` — the section reads as a quiet list, the owned marker sits after the name. Then:

```bash
git add -A src test docs/guide/images
git commit -m "feat: Your squads — a route to a game page that always exists (M20 B3)"
```

---

### Task 8: The broadcast receipt (B4)

**Files:**
- Modify: `src/routes/broadcast.ts` (the `handleSend` redirect), `src/routes/games.ts` (both `renderGameOverviewPage` call sites and the `renderOwnerFixturePage` one, plus a shared helper), `src/views/game-overview.ts`, `src/views/owner-fixture.ts` (new optional param each)
- Test: `test/routes/broadcast-post.test.ts`, `test/routes/games.test.ts` or `test/routes/owner-fixture.test.ts`

**Interfaces:**
- Produces: the redirect shape `?sent=<n>&via=email|push|both`; `broadcastNotice?: string` on `GameOverviewParams` and `OwnerFixtureParams`.

- [ ] **Step 1: Failing tests, both halves**

In `test/routes/broadcast-post.test.ts`, find the existing happy-path send test and extend its redirect assertion:

```ts
expect(res.status).toBe(303);
const location = res.headers.get("location")!;
expect(location).toMatch(/\?sent=\d+&via=(email|push|both)$/);
```

In `test/routes/games.test.ts` (organiser page tests):

```ts
describe("the broadcast receipt (M20 B4)", () => {
  it("renders the one-line notice from the redirect flag", async () => {
    const { html } = await ownerGetsGamePage("?sent=11&via=email");
    expect(html).toContain("Sent to 11 players by email.");
  });
  it("renders nothing for a malformed flag — never caller text", async () => {
    for (const q of ["?sent=11&via=carrier-pigeon", "?sent=lots&via=email", "?sent=-3&via=push", "?sent=11"]) {
      const { html } = await ownerGetsGamePage(q);
      expect(html).not.toContain("Sent to");
    }
  });
});
```

Adapt the fetch helper to the file's existing signed-in-owner pattern. Run both files — expected: FAIL.

- [ ] **Step 2: The redirect**

In `handleSend` in `src/routes/broadcast.ts`, replace `return c.redirect(scope.redirectTo, 303);` with:

```ts
  // The receipt flag (M20 B4). An enum plus a bounded integer the
  // destination page re-validates — the notice can never carry text a
  // sender chose, which is what keeps this from being a reflection sink.
  const via = channels.email && channels.push ? "both" : channels.push ? "push" : "email";
  return c.redirect(`${scope.redirectTo}?sent=${recipientCount}&via=${via}`, 303);
```

(`channels` and `recipientCount` are both already in scope at that point.)

- [ ] **Step 3: The reader**

In `src/routes/games.ts`, add one helper near the top-level route handlers:

```ts
/**
 * The broadcast receipt (M20 B4), from the send handler's redirect flag.
 * Enum-and-integer only: an unrecognised channel or a count that is not a
 * sane positive integer renders nothing rather than something surprising —
 * the query string is caller-controlled, the notice text is not.
 */
function broadcastNoticeFrom(c: Context<AppEnv>): string | undefined {
  const sent = Number(c.req.query("sent"));
  if (!Number.isInteger(sent) || sent < 1 || sent > 10_000) return undefined;
  const channel = { email: "by email", push: "by push", both: "by email and push" }[
    c.req.query("via") ?? ""
  ];
  if (channel === undefined) return undefined;
  return `Sent to ${sent} player${sent === 1 ? "" : "s"} ${channel}.`;
}
```

Pass `broadcastNotice: broadcastNoticeFrom(c)` at each of the three render call sites (`grep -n "renderGameOverviewPage\|renderOwnerFixturePage" src/routes/games.ts` to find them; only the GET handlers need it — a 422 re-render never carries a receipt).

- [ ] **Step 4: The views**

Add `broadcastNotice?: string` to `GameOverviewParams` and `OwnerFixtureParams`. In each view's `body`, directly under the `problem` notice line, render:

```ts
${params.broadcastNotice === undefined ? "" : `<p class="nudge ok">${escapeHtml(params.broadcastNotice)}</p>`}
```

(`.nudge.ok` shipped in Task 2's `STYLES`.)

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run test/routes/broadcast-post.test.ts test/routes/games.test.ts test/routes/owner-fixture.test.ts && npx tsc --noEmit`
Expected: PASS — including the existing broadcast tests, whose redirect assertions you extended rather than replaced.

```bash
git add -A src test
git commit -m "feat: a broadcast comes back with a receipt (M20 B4)"
```

---

### Task 9: One "This device" panel on the account page (B5)

**Files:**
- Modify: `src/views/install.ts` (compose the merged section), `src/views/account.ts` (call it)
- Test: `test/routes/account.test.ts`

- [ ] **Step 1: Failing test**

In `test/routes/account.test.ts`:

```ts
describe("the This device panel (M20 B5)", () => {
  it("renders one merged section, not two lookalike boxes", async () => {
    const { html } = await signedInAccountPage();
    expect(html).toContain("<h2>This device</h2>");
    expect(html).toContain("Add Make The Team to your home screen and turn on game notifications.");
    // The old two-section headings are gone…
    expect(html).not.toContain("<h2>Add to your home screen</h2>");
    expect(html).not.toContain("<h2>Notifications</h2>");
    // …but every working part of both survives inside the panel.
    expect(html).toContain("data-install-button");
    expect(html).toContain("Your devices");
  });
});
```

Adapt to the file's existing signed-in fetch helper. Run — expected: FAIL.

- [ ] **Step 2: Compose the merged renderer**

In `src/views/install.ts`, add (below `renderPushSection`, which it wraps):

```ts
/**
 * The account page's merged install + notifications panel (M20 B5): one
 * section, because the two jobs are one job — make this phone useful. The
 * token-page offer (`renderPushOffer`) is deliberately NOT built from this:
 * the type split that stops a devices list existing on a token page is the
 * product's endpoint-disclosure invariant, and a shared entry point is how
 * it would erode.
 */
export function renderThisDeviceSection(push: PushSectionOptions): string {
  return `
    <section class="install">
      <h2>This device</h2>
      <p>Add Make The Team to your home screen and turn on game notifications.</p>
      <p data-install-instructions>
        Keep Make The Team a tap away, and it opens like an app rather than a tab.
      </p>
      <ol data-install-steps>
        <li>Open the browser's <strong>Share</strong> or menu button.</li>
        <li>Choose <strong>Add to Home Screen</strong>.</li>
      </ol>
      <button class="button" type="button" data-install-button hidden>Add to home screen</button>
      <p data-install-done hidden>Make The Team is installed on this device.</p>
      ${renderPushBody(push)}
    </section>
  `;
}
```

where `renderPushBody` is the current inside of `renderPushSection` *minus* its `<section>` wrapper, heading and intro — extract it so `renderPushSection` (if any other caller remains) and `renderThisDeviceSection` share one body. Check callers first: `grep -rn "renderPushSection\|renderInstallSection" src`. If the account page was the only caller of both, delete the two old exports and their heading/intro options; if the offer path or another page uses one, keep it delegating to `renderPushBody`. Preserve every `data-` attribute and hidden-by-default rule exactly — `INSTALL_JS` and `PUSH_SUBSCRIBE_JS` find their elements by those attributes and ids.

- [ ] **Step 3: Swap the account page**

In `src/views/account.ts`, replace the `${renderInstallSection()}` and `${renderPushSection({...})}` lines with one `${renderThisDeviceSection({...})}` call carrying the same options the push section received (vapidPublicKey, devices, defaultDeviceName, notice, reloadTo — drop `heading`/`intro` if Step 2 removed them). `pageScripts` stays `[INSTALL_JS, PUSH_SUBSCRIBE_JS]`.

- [ ] **Step 4: Verify — including the eyes-on check**

Run: `npx vitest run test/routes/account.test.ts test/routes/push.test.ts test/views/scripts.test.ts && npx tsc --noEmit && npm run guide:capture`
Read `docs/guide/images/account.png`: one panel, heading, install steps, name field area, device table. Then run `npx playwright test` (the push/install browser tests exercise the reveal logic this task must not break).

- [ ] **Step 5: Commit**

```bash
git add -A src test docs/guide/images
git commit -m "feat: install and notifications are one This device panel (M20 B5)"
```

---

### Task 10: One sign-in failure page (B6)

**Files:**
- Modify: `src/views/signin.ts` (`renderLinkRefusalPage`)
- Test: `test/routes/signin.test.ts` (the completion-failure tests)

- [ ] **Step 1: Failing tests**

Find the existing tests covering the four refusals in `test/routes/signin.test.ts` (search for `renderLinkRefusalPage` usage or the old headings). Rewrite their page-content expectations:

```ts
// All four cases now share one heading and one shape (M20 B6)…
expect(html).toContain("We can't sign you in");
// …their status codes are unchanged — monitoring reads them:
// conflict 409, ambiguous-email 500, email-held-by-guest 500, create-raced 503.
```

plus one distinct-copy assertion per case (e.g. `"more than one player"` for ambiguous-email) and, for `create-raced` only: `expect(html).toContain("Try again")`. For the other three: `expect(html).not.toContain("Try again")`. Run — expected: FAIL.

- [ ] **Step 2: Collapse the renderer**

Replace the `switch` body of `renderLinkRefusalPage` with:

```ts
export function renderLinkRefusalPage(refusal: LinkRefusal): { html: string; status: 409 | 500 | 503 } {
  // One page for all four dead ends (M20 B6): they all resolve to "ask your
  // organiser", so the reason line is the only thing that varies. Status
  // codes are unchanged — they are how the ops side tells the cases apart.
  const status = refusal === "conflict" ? 409 : refusal === "create-raced" ? 503 : 500;
  const reason = {
    conflict:
      "Your player already belongs to a different sign-in, and we won't move it across automatically — that is exactly what it would look like if someone else were trying to take the account over. Sign in the way you did the first time, or ask whoever organises your game to sort it out.",
    "ambiguous-email":
      "Your email address appears on more than one player, and we can't tell which one is you. Ask whoever organises your game to remove the duplicate, then sign in again.",
    "email-held-by-guest":
      "Your email address is attached to a guest entry — someone an organiser added by hand — and guest entries aren't accounts. Ask whoever organises your game to turn it into a proper player, then sign in again.",
    "create-raced":
      "Something else was changing your record at the same moment and we backed off rather than guess. Nothing is broken and nothing was lost.",
  }[refusal];
  // The one sanctioned deviation (spec decision Q4): the race is the only
  // case where trying again is the fix, so it alone keeps a next step
  // beyond "go back".
  const retry =
    refusal === "create-raced"
      ? `<p><a href="${SIGN_IN_COMPLETE_PATH}">Try again</a> — it should go through this time.</p>`
      : "";
  return {
    status,
    html: layout({
      title: "We can't sign you in — Make The Team",
      body: `
        <h1>We can't sign you in</h1>
        <p>${escapeHtml(reason)}</p>
        ${retry}
        ${signOutForm("Sign out and try a different address")}
        <p><a href="/">Back to Make The Team</a></p>
      `,
      centred: true,
    }),
  };
}
```

Keep the function's existing doc comment about why every case carries a sign-out. Confirm `SIGN_IN_COMPLETE_PATH` and `escapeHtml` are already imported in the file (both are used today).

- [ ] **Step 3: Verify**

Run: `npx vitest run test/routes/signin.test.ts && npx tsc --noEmit`
Expected: PASS, including the untouched route-sweep and status-code assertions. The refused branch must never throw — the object-literal lookup is total over `LinkRefusal`, which `tsc` confirms.

- [ ] **Step 4: Commit**

```bash
git add src/views/signin.ts test/routes/signin.test.ts
git commit -m "feat: four sign-in dead ends become one page (M20 B6)"
```

---

### Task 11: The response page's single answer block (B7)

**Files:**
- Modify: `src/views/fixture.ts` (the `body` in `renderFixturePage`), `src/views/dashboard.ts` (`renderRow`), `src/views/styles.ts` (`FIXTURE_STYLES_CSS`)
- Test: `test/views/fixture.test.ts`, `test/routes/respond-get.test.ts`, `test/routes/dashboard.test.ts`

- [ ] **Step 1: Failing structure tests**

In `test/views/fixture.test.ts` (reuse its existing options builders):

```ts
describe("the answer block (M20 B7)", () => {
  it("wraps headline, buttons and full-warning in one state-classed section", () => {
    const html = renderFixturePage(openUnansweredOptions());
    const block = html.match(/<section class="answer answer-open">([\s\S]*?)<\/section>/);
    expect(block).not.toBeNull();
    expect(block![1]).toContain("Can you make it?");
    expect(block![1]).toContain("aria-pressed");
  });
  it("keeps the fixture's own facts below the block, not inside it", () => {
    const html = renderFixturePage(openUnansweredOptions());
    const blockEnd = html.indexOf("</section>");
    expect(html.indexOf("status-line", blockEnd)).toBeGreaterThan(blockEnd);
  });
  it("names the waitlisted state on the block", () => {
    const html = renderFixturePage(waitlistedOptions());
    expect(html).toContain('class="answer answer-waiting"');
  });
  it("renders read-only states as the block with a sentence for buttons", () => {
    const html = renderFixturePage(playedOptions());
    expect(html).toContain('class="answer answer-closed"');
    expect(html).not.toContain("aria-pressed");
  });
});
```

(If the file's builders use different names, adapt; if a state builder is missing, add it from the existing ones' pattern.) Run — expected: FAIL.

- [ ] **Step 2: Restructure `renderFixturePage`**

In `src/views/fixture.ts`, compute the state class and wrap the viewer's pieces:

```ts
  // One answer block (M20 B7): the viewer's own state — headline, buttons or
  // the read-only sentence, and the pre-tap warning — said once, in one
  // tinted card, with the fixture's impersonal facts below it rather than
  // interleaved. The class names a state, not a colour, so the CSS can
  // retint without the markup changing.
  const answerState = readOnlyReason
    ? "closed"
    : viewer.status === "waitlisted"
      ? "waiting"
      : viewer.status === "in"
        ? "going"
        : viewer.status === "out"
          ? "declined"
          : "open";
```

Then in `body`, replace the current run of `${headline …}${renderStatusLine…}${renderNudge…}${renderOverCapacity…}${readOnlyReason ? … : …}` with:

```ts
    <section class="answer answer-${answerState}">
      ${headline ? `<h2 class="${headlineClass}">${escapeHtml(headline)}</h2>` : ""}
      ${readOnlyReason ? renderReadOnlyNotice(readOnlyReason) : renderButtons(options) + renderFullWarning(view, viewer, options.waitlistCount)}
    </section>
    ${renderStatusLine(view, options.waitlistCount)}
    ${renderNudge(view)}
    ${renderOverCapacity(view)}
```

The headline element becomes an `h2` inside the block (it was a `p`); `headlineClass` and the waitlisted-above-badge reasoning in the comment above it still hold — the block sits above the badge, which is the same guarantee.

- [ ] **Step 3: The block's CSS**

In `FIXTURE_STYLES_CSS` in `src/views/styles.ts`, add (a comment naming states, no UI copy, no backticks):

```css
  /* The answer block: the viewer's own state in one card. Tints follow the
     state class so a colour change never needs a markup change. */
  .answer {
    margin: 1rem 0; padding: 1.1rem 1.25rem;
    border-radius: 1.25rem; background: var(--card-raised);
  }
  .answer h2 { margin-top: 0; }
  .answer.answer-waiting { background: var(--warn-bg); }
  .answer.answer-waiting .button.primary { background: var(--wait); color: var(--wait-fg); }
  .answer.answer-going { background: var(--ok-bg); }
  .answer.answer-closed { background: var(--field); }
```

Run `npx vitest run test/views/style-cascade.test.ts` — if the new selectors collide with another block's at equal specificity, follow that test's instructions.

- [ ] **Step 4: Mirror on the dashboard card**

In `src/views/dashboard.ts`'s `renderRow`, wrap the imported headline + `renderActions(row)` output in the same `<section class="answer answer-…">` element, computing the state class from the row's viewer status by the same expression (extract `answerStateOf(status, readOnly)` into `src/views/fixture.ts` and export it if writing it twice — one source, two pages, exactly like the copy imports the file already does). The card keeps its current order: fixture facts first, answer block last, per the mock.

- [ ] **Step 5: Repair what the restructure broke, with eyes**

Run: `npx vitest run test/views/fixture.test.ts test/routes/respond-get.test.ts test/routes/respond-post.test.ts test/routes/dashboard.test.ts test/routes/player-game.test.ts`
Existing assertions on element order or on `<p class="viewer-headline">` markup will fail — update them to the new structure (the *copy* is unchanged; only the wrapper moved). Then `npm run guide:capture` and **read** `docs/guide/images/dashboard.png` plus the respond-page images; also run `npx playwright test` (the respond flow has browser coverage).

- [ ] **Step 6: Commit**

```bash
git add -A src test docs/guide/images
git commit -m "feat: the response page says your state once, in one block (M20 B7)"
```

---

## Final gate (after Task 11)

- [ ] `npm run lint && npx tsc --noEmit && npm test && npx playwright test` — all clean.
- [ ] `npm run guide:capture`; read every changed image once more.
- [ ] Merge fast-forward to `main`, push, watch CI, confirm production 200.
- [ ] Update `screens.md` (repo root, untracked) to describe the shipped state: header-trusting dashboard footer, Your squads, the receipt, This device, the single failure page, the answer block, and §5's palette note.
