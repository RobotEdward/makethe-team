# Browser Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Playwright harness that catches the class of failure the server suite structurally cannot see — CSP violations, console errors, JS-off breakage, broken WebAuthn — and runs in CI.

**Architecture:** A single page catalogue (`test/browser/catalogue.ts`) is iterated by three consumers: a console/CSP gate, the journey specs, and a visual capture script. Playwright's `webServer` starts `wrangler dev`; a helper signs a browser in by reading the magic-link token out of local D1, because `ConsoleNotifier` never logs the URL.

**Tech Stack:** `@playwright/test` 1.62 (installed, chromium headless shell), `wrangler dev` on :8787, existing D1 local state.

**Spec:** `docs/superpowers/specs/2026-08-13-browser-testing-design.md`

## Global Constraints

- **The scope rule.** A browser test earns its place only if the server suite structurally cannot perform the check. Never re-test business logic (BR-3, BR-6/7, capacity, tokens, redaction) through a browser. If a check would pass identically in Vitest, it belongs in Vitest.
- **Every detector must be proved to fire.** Any assertion whose job is to catch something must be demonstrated failing on a deliberate fault, and that demonstration committed as a test. A detector that cannot fail manufactures confidence.
- **Never assert on a bare `toContain` against a whole page.** Scope assertions to the element. J6a's review found two tests that passed whether the value was right or wrong.
- Browser tests live in `test/browser/`, run by Playwright, and **must be excluded from the Vitest config** — Vitest discovery does not consult `.gitignore` and would collect and fail them.
- Playwright artefacts (`test-results/`, `playwright-report/`, `test/browser/screenshots/`) are gitignored.
- The magic-link callback is **always** `/sign-in/complete`. Any other callback yields a session with no Player and a 403 on every authenticated page.
- Local D1 is read via `wrangler d1 execute --local --json` only. Never open the SQLite file directly — Miniflare holds its own connection and a second writer is a documented WAL-deadlock hazard.
- Test identities use `@example.test` addresses. Never a real address, never the author's.
- Commit after each task, with the repo's existing trailer convention.

---

### Task 1: Playwright config, local bindings, and the sign-in helper

**Files:**
- Create: `playwright.config.ts`
- Create: `test/browser/sign-in.ts`
- Create: `test/browser/smoke.spec.ts`
- Modify: `vitest.config.ts` (exclude `test/browser/**`)
- Modify: `.dev.vars.example`
- Modify: `.gitignore`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces: `signIn(page, email)` → resolves once the page holds an authenticated session with a linked Player; `TEST_OWNER`, `TEST_PLAYER` address constants; `BASE_URL`.

- [ ] **Step 1: `.dev.vars.example` — document every binding**

The four bindings below each fail *silently* when unset. Replace the file's contents with:

```
# Copy to .dev.vars (gitignored) for local development.
# Any string works locally; production uses a Worker secret.
RESPONSE_TOKEN_SECRET=local-development-secret-do-not-use-in-production
CANCEL_TOKEN_SECRET=local-development-secret-do-not-use-in-production

# --- required for local sign-in, and therefore for browser tests ---
# Each of these fails SILENTLY when unset: POST /sign-in answers the same
# 200 "check your inbox" on every branch, deliberately, so that an address
# cannot be enumerated. That also means a misconfigured local environment
# looks exactly like a working one.
#
# "console" prints every email to the wrangler dev console. wrangler.jsonc
# says "resend", which throws here (no RESEND_API_KEY) into a swallowed error.
NOTIFIER=console
# Fails closed (TR-35): unset means nobody can sign in.
SIGNIN_ALLOWLIST=owner@example.test,player@example.test
# Without this, magic links are minted against https://makethe.team and
# cannot be followed locally.
BETTER_AUTH_URL=http://localhost:8787
BETTER_AUTH_SECRET=local-development-secret-do-not-use-in-production
```

- [ ] **Step 2: `.gitignore` — add Playwright artefacts**

Append:

```
# Playwright
test-results/
playwright-report/
test/browser/screenshots/
```

- [ ] **Step 3: `vitest.config.ts` — exclude the browser specs**

In the `test.exclude` array, add `"test/browser/**"` alongside the existing entries, with this comment above it:

```ts
      // Playwright specs, not Vitest ones. Discovery does not consult
      // .gitignore or file extension conventions, so without this the
      // workers pool tries to run them and every one fails on an import
      // of "@playwright/test" it cannot resolve inside workerd.
```

- [ ] **Step 4: `playwright.config.ts`**

```ts
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level tests. These exist for exactly one reason: the 1009 Vitest
 * tests run inside workerd and can never observe a CSP violation, a console
 * error, or whether inline script executed at all. See
 * `docs/superpowers/specs/2026-08-13-browser-testing-design.md`.
 */
export const BASE_URL = "http://localhost:8787";

export default defineConfig({
  testDir: "./test/browser",
  // A browser test that needs its neighbours' state is a broken test, but
  // `wrangler dev` is a single local D1 — parallel workers would race on the
  // same rows. One worker, deliberately.
  workers: 1,
  fullyParallel: false,
  // CI must never pass because a test was quietly skipped or left focused.
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx wrangler dev --port 8787",
    url: `${BASE_URL}/sign-in`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
```

- [ ] **Step 5: `test/browser/sign-in.ts` — the helper**

`ConsoleNotifier` logs the subject and dedupe key but not the URL, so the token comes from D1. Note the callback: `/sign-in/complete` and nothing else.

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";

const run = promisify(execFile);

/** Addresses in `.dev.vars`'s SIGNIN_ALLOWLIST. Never a real address. */
export const TEST_OWNER = "owner@example.test";
export const TEST_PLAYER = "player@example.test";

/**
 * Read the most recent magic-link token out of local D1.
 *
 * Via `wrangler d1 execute`, never by opening the SQLite file: Miniflare holds
 * its own connection to it and a second writer is the WAL-deadlock hazard
 * documented in `src/auth/factory.ts`. This only reads, but it uses the
 * supported path regardless.
 *
 * `verification.identifier` is the token; `value` holds the JSON-encoded email.
 */
async function latestMagicLinkToken(email: string): Promise<string> {
  const { stdout } = await run("npx", [
    "wrangler", "d1", "execute", "makethe-team", "--local", "--json",
    "--command", "SELECT identifier, value FROM verification ORDER BY rowid DESC LIMIT 5",
  ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });

  const parsed = JSON.parse(stdout.slice(stdout.indexOf("[")));
  const rows = parsed[0]?.results ?? [];
  const match = rows.find((r: { value: string }) => String(r.value).includes(email));
  if (!match) {
    throw new Error(
      `no magic-link token in D1 for ${email}. The likeliest cause is that ` +
      `SIGNIN_ALLOWLIST in .dev.vars does not list it — the allowlist fails ` +
      `closed and POST /sign-in still answers 200, so this is silent.`,
    );
  }
  return match.identifier;
}

/**
 * Sign `page` in as `email`, ending on an authenticated page with a Player.
 *
 * The callback is `/sign-in/complete` and must stay that way: session-to-Player
 * linking happens in that handler (`src/routes/signin.ts`), not inside Better
 * Auth's. A callback pointed straight at the destination produces a valid
 * session with no Player, and every authenticated page answers 403.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/sign-in");
  await page.fill('input[name="email"]', email);
  await page.click('button[type="submit"]');
  const token = await latestMagicLinkToken(email);
  await page.goto(
    `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=/sign-in/complete`,
  );
}
```

- [ ] **Step 6: `test/browser/smoke.spec.ts` — prove the helper works**

```ts
import { expect, test } from "@playwright/test";
import { signIn, TEST_OWNER } from "./sign-in.js";

test("an anonymous visitor is offered the sign-in form", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.locator('form.signin input[name="email"]')).toBeVisible();
});

test("signIn reaches an authenticated page with a linked Player", async ({ page }) => {
  await signIn(page, TEST_OWNER);
  // Scoped to the element, not the whole document: a bare toContain here
  // would pass on the 403 "We can't find your player" page too, which is
  // exactly the failure this asserts against.
  await expect(page.locator("h1")).not.toHaveText(/can.t find your player/i);
  const response = await page.goto("/g/new");
  expect(response?.status()).toBe(200);
});
```

- [ ] **Step 7: `package.json` scripts**

Add: `"test:browser": "playwright test"` and `"test:browser:ui": "playwright test --ui"`.

- [ ] **Step 8: Run it**

Run: `npm run test:browser`
Expected: 2 passed. If the second fails with a 403, the callback is wrong — see Step 5's comment.

- [ ] **Step 9: Prove the helper's error path**

Temporarily change `TEST_OWNER` to `nobody@example.test` (not on the allowlist), run, and confirm the failure message is the explanatory one from `latestMagicLinkToken`, not an opaque timeout. Revert.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "test: a browser can sign in locally"
```

---

### Task 2: The page catalogue and its completeness check

**Files:**
- Create: `test/browser/catalogue.ts`
- Create: `test/browser/catalogue.spec.ts`

**Interfaces:**
- Consumes: `signIn`, `TEST_OWNER`, `TEST_PLAYER` from Task 1.
- Produces: `CATALOGUE: CataloguePage[]`, `type CataloguePage`, and `seedWorld()` returning ids/tokens for parameterised routes.

- [ ] **Step 1: `test/browser/catalogue.ts`**

Every page the app renders, in one list. Three consumers iterate it: the console gate (Task 3), the visual capture (Task 6), and the product guide generator in its own later spec.

```ts
export type Persona = "anonymous" | "owner" | "player";

export interface CataloguePage {
  /** Stable slug — used in test names and screenshot filenames. */
  id: string;
  title: string;
  /** Built from seeded state for parameterised routes. */
  path: (world: World) => string;
  persona: Persona;
  /** Why this page exists, for the guide generator and for a human reader. */
  note: string;
}

export interface World {
  gameId: string;
  fixtureId: string;
  inviteToken: string;
  responseToken: string;
  memberPlayerId: string;
}
```

Entries — one per page, `id` unique:

`home` `/`, `sign-in` `/sign-in`, `dashboard` `/app`, `passkeys` `/app/passkeys`,
`new-game` `/g/new`, `game-overview` `/g/:id`, `edit-game` `/g/:id/edit`,
`remove-member` `/g/:id/squad/:playerId/remove`, `join` `/j/:token`,
`respond` `/r/:token`, `leave` `/leave/:token`, `not-found` `/definitely-not-a-page`.

Personas: `home`, `sign-in`, `join`, `respond`, `leave`, `not-found` are `anonymous`; the rest are `owner`.

`/cancel/:token` and `/sign-in/complete` are deliberately **excluded** with a comment: the first needs a signed owner token minted from a fixture (covered by the journey in Task 5 instead), the second is a redirect-through, not a page a person dwells on.

- [ ] **Step 2: `seedWorld()` — build the state the catalogue points at**

Drive the app's own surface (sign in as owner, `POST /g/new`, read the invite link off the overview, join as the player). **Do not** insert rows into D1 by hand: a hand-built world can be internally inconsistent in ways a real one cannot, and this world is what the console gate loads.

Extract the invite token and the game id from the rendered overview page; extract the response token by reading the most recent `n1`/`n2` message... **not available from the console notifier**, which logs only the dedupe key — so instead mint the fixture response link by opening the fixture through the owner's own overview page. If no response link is reachable from the UI, record `responseToken` as `null` and mark the `respond` catalogue entry skipped with an explicit comment naming the reason; do not fabricate a token.

- [ ] **Step 3: `test/browser/catalogue.spec.ts` — the completeness assertion**

`test/security/csp.test.ts` enumerated pages by hand and drifted: J6a's review found it covered eight public pages and no `/g/*` page at all. This makes drift fail the suite.

```ts
import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CATALOGUE } from "./catalogue.js";

/**
 * Routes that render no page and are deliberately outside the catalogue.
 * Every entry needs a reason — an unexplained exclusion is how the old
 * hand-written enumeration lost every /g/* page without anyone noticing.
 */
const NOT_PAGES = new Map<string, string>([
  ["/robots.txt", "plain text, no document, no CSP surface"],
  ["/sign-in/complete", "a redirect-through, not a page anyone dwells on"],
  ["/cancel/:token", "needs a signed owner token; covered by the cancel journey"],
]);

test("every GET route the app registers is catalogued or explicitly excluded", () => {
  const routes = new Set<string>();
  for (const file of readdirSync("src/routes")) {
    const source = readFileSync(`src/routes/${file}`, "utf8");
    for (const m of source.matchAll(/\.get\(\s*["'`]([^"'`]+)["'`]/g)) routes.add(m[1]!);
  }
  // Path constants resolve elsewhere; assert on the literal routes only and
  // let the named-constant routes be covered by the catalogue's own ids.
  const catalogued = new Set(CATALOGUE.map((p) => p.id));
  const missing = [...routes].filter(
    (r) => !NOT_PAGES.has(r) && !catalogued.has(slugFor(r)),
  );
  expect(missing, `uncatalogued routes: ${missing.join(", ")}`).toEqual([]);
});
```

Implement `slugFor` to map a route literal to a catalogue id, and add any named-constant routes (`SIGN_IN_PATH`, `DASHBOARD_PATH`, `NEW_GAME_PATH`, `PASSKEYS_PATH`) by importing the constants from `src/auth/paths.ts` rather than hardcoding them.

- [ ] **Step 4: Prove the completeness check fails**

Comment out one catalogue entry, run, and confirm the test fails naming that route. Restore it. **Paste the failure output into the task report** — this is the proof the detector fires.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test: the page catalogue, with a drift check"
```

---

### Task 3: Tier 1 — the console and CSP gate

**Files:**
- Create: `test/browser/console-gate.spec.ts`
- Create: `test/browser/observe.ts`

**Interfaces:**
- Consumes: `CATALOGUE`, `seedWorld` (Task 2); `signIn` (Task 1).
- Produces: `observe(page)` → `{ errors(): string[]; violations(): string[] }`.

- [ ] **Step 1: `test/browser/observe.ts`**

The listener goes in via `addInitScript` so it is installed *before* any document script runs. A listener attached after load misses violations from the page's own inline blocks — which is precisely the case that matters.

```ts
import type { Page } from "@playwright/test";

export interface Observation {
  errors(): string[];
  violations(): Promise<string[]>;
}

export function observe(page: Page): Observation {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e)}`));

  const installed = page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    window.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} blocked ${e.blockedURI || "(inline)"}`,
      );
    });
  });

  return {
    errors: () => errors,
    violations: async () => {
      await installed;
      return page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
    },
  };
}
```

- [ ] **Step 2: `test/browser/console-gate.spec.ts` — the gate itself**

One test per catalogue page, so a failure names the page.

```ts
import { expect, test } from "@playwright/test";
import { CATALOGUE } from "./catalogue.js";
import { observe } from "./observe.js";
import { seedWorld } from "./catalogue.js";
import { signIn, TEST_OWNER } from "./sign-in.js";

test.describe("every page loads clean in a real browser", () => {
  for (const entry of CATALOGUE) {
    test(`${entry.id} — no console errors, no CSP violations`, async ({ page }) => {
      const seen = observe(page);
      const world = await seedWorld(page);
      if (entry.persona !== "anonymous") await signIn(page, TEST_OWNER);
      const response = await page.goto(entry.path(world), { waitUntil: "networkidle" });
      expect(response, `${entry.id} did not respond`).not.toBeNull();
      expect(await seen.violations(), `CSP violations on ${entry.id}`).toEqual([]);
      expect(seen.errors(), `console errors on ${entry.id}`).toEqual([]);
    });
  }
});
```

Note: `seedWorld` must run before `signIn` for anonymous pages too, since it builds the world those tokens point at. If ordering proves awkward, hoist the world into a `test.beforeAll` and share it — but keep one test per page.

- [ ] **Step 3: The deliberate-violation test — prove the detector fires**

Without this the whole tier could be a no-op and look green.

```ts
test("the CSP detector actually fires", async ({ page }) => {
  const seen = observe(page);
  await page.goto("/sign-in");
  expect(await seen.violations()).toEqual([]);
  // A <style> element the policy's hashes cannot possibly cover.
  await page.evaluate(() => {
    const s = document.createElement("style");
    s.textContent = "body{outline:1px solid red}";
    document.head.appendChild(s);
  });
  await expect.poll(() => seen.violations()).not.toEqual([]);
});
```

- [ ] **Step 4: Run the gate and triage**

Run: `npm run test:browser`
This is where a real finding is most likely. **If a page fails, do not weaken the assertion.** Report the violation in the task report with the page id and the directive; a genuine CSP bug is the whole point of this work and is a finding, not a blocker.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test: fail on any console error or CSP violation"
```

---

### Task 4: Tier 2 — journeys with JavaScript on and off

**Files:**
- Create: `test/browser/journeys.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.

- [ ] **Step 1: Parameterise the whole suite over JS on/off**

The project's policy is that anything a person *must* do works with JS off. The JS-off run proves it rather than asserting it.

```ts
for (const javaScriptEnabled of [true, false] as const) {
  test.describe(`javascript ${javaScriptEnabled ? "on" : "off"}`, () => {
    test.use({ javaScriptEnabled });
    // journeys here
  });
}
```

- [ ] **Step 2: Journey — sign in and reach the dashboard**

Assert on the dashboard's own heading, scoped to the element.

- [ ] **Step 3: Journey — create a game**

Fill `/g/new`, submit, assert the overview shows the game name in its `h1` and that the squad list contains the owner marked `(you)`.

- [ ] **Step 4: Journey — invite and join as a second identity**

Read the invite link from the overview, open it in a fresh context as `TEST_PLAYER`, join, and assert the player now appears in the owner's squad list. Use a separate `browser.newContext()` so the two identities never share a cookie jar.

- [ ] **Step 5: Journey — the copy-invite button degrades**

With JS on: the button is present. With JS off: assert it is absent or inert — **not** that it is broken. Scope to the element; the page contains the invite URL as text either way, so a document-wide assertion would pass regardless.

- [ ] **Step 6: Journey — squad management (the outstanding J6a walkthrough)**

This is the walkthrough J6a deferred. In one test:
1. Promote the joined player to organiser; assert their row now offers "Make player".
2. Demote the *only other* organiser back, then attempt to demote yourself as the last owner; assert the refusal renders at HTTP 422 with the problem message visible.
3. Remove a member; assert the confirmation page states the consequences, and that after the POST they are gone from the squad list.

Assertions scope to the member's own `<li>`, never the whole page — an unscoped `toContain` here passes whether the offered action is the opposite role or the current one, which is the exact defect J6a's review caught.

- [ ] **Step 7: Run both projections**

Run: `npm run test:browser`
Expected: every journey passes twice. A JS-off failure on a *required* action is a real product bug — report it, do not skip the test.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "test: the critical journeys, with and without JavaScript"
```

---

### Task 5: Tier 3 — passkeys via a virtual authenticator

**Files:**
- Create: `test/browser/passkeys.spec.ts`

- [ ] **Step 1: Attach a virtual authenticator**

Verified working during the spec's spike; these exact options succeeded.

```ts
async function attachAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}
```

- [ ] **Step 2: Register a passkey**

Sign in with a magic link, attach the authenticator, go to `/app/passkeys`, click register, and assert the credential exists — via `WebAuthn.getCredentials` on the CDP session **and** via the page listing it. The first proves the ceremony completed; the second proves the app recorded it.

- [ ] **Step 3: Sign in with the passkey**

In a fresh context carrying the same virtual authenticator, sign in via the passkey button and assert an authenticated page loads. This is the exact flow the `connect-src` bug broke.

- [ ] **Step 4: Assert no CSP violation during the ceremony**

Wrap both tests in `observe(page)` and assert zero violations. This is the specific regression that shipped to production before.

- [ ] **Step 5: If a ceremony cannot be completed**

Two known-issues rows are open against passkeys (an error-swallowing `.catch()` on `/app/passkeys`, and `verify-registration` returning 500 not 400). If a test surfaces one, **report it as a finding and leave the test failing or explicitly skipped with the reason** — do not adjust the test until it passes.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "test: passkey register and sign-in via a virtual authenticator"
```

---

### Task 6: Tier 4 — visual capture

**Files:**
- Create: `test/browser/capture.spec.ts`

- [ ] **Step 1: Capture every catalogue page at two widths**

390px (phone) and 1280px (desktop), full page, into `test/browser/screenshots/<id>--<width>.png` (gitignored). Tagged `@capture` and excluded from the default run via `grepInvert` so CI does not carry it; run on demand with `npx playwright test --grep @capture`.

- [ ] **Step 2: No pixel assertions**

This tier is a judgement aid. Assert only that each file was written and is non-empty. Pixel diffing is explicitly out of scope (spec §11).

- [ ] **Step 3: Run and serve**

Run the capture, then serve the directory on port 8333 for review. The J6a squad row at 390px is the specific thing to look at.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test: capture every page at phone and desktop width"
```

---

### Task 7: CI

**Files:**
- Modify: `.github/workflows/pr.yml`

- [ ] **Step 1: Add a separate `browser` job**

A separate job, not extra steps in `check`: a browser flake must be legible as a browser flake and must never mask a lint, type or unit failure.

```yaml
  browser:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Resolve the Playwright version
        id: pw
        run: echo "version=$(node -p "require('@playwright/test/package.json').version")" >> "$GITHUB_OUTPUT"
      - uses: actions/cache@v4
        id: browser-cache
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ steps.pw.outputs.version }}
      # Only the headless shell: Tiers 1-3 never need a headed browser, and
      # it is a fraction of the download.
      - run: npx playwright install --only-shell chromium
        if: steps.browser-cache.outputs.cache-hit != 'true'
      - run: npx playwright install-deps chromium
      - run: npm run test:browser
        env:
          # Every value here is a local-only dummy, so no GitHub secret is
          # needed and this job runs identically on a fork's pull request.
          # `wrangler dev` reads .dev.vars, which is gitignored and absent on
          # CI, so they are supplied as environment variables instead.
          CI: "true"
```

- [ ] **Step 2: Make `wrangler dev` see the bindings on CI**

`.dev.vars` is gitignored and absent on CI. Confirm how `wrangler dev` resolves them — if plain `env:` is not picked up, write a `.dev.vars` in a workflow step from the same dummy values, and comment *why*. Verify by reading the job log, not by assuming.

- [ ] **Step 3: Upload the report on failure**

```yaml
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
```

- [ ] **Step 4: Push the branch and watch the run**

Confirm the job goes green on CI, not just locally. Report the run id.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "ci: run the browser suite as its own job"
```

---

### Task 8: Documentation

**Files:**
- Create: `docs/runbooks/browser-testing.md`
- Modify: `docs/known-issues.md`

- [ ] **Step 1: The runbook**

How to run locally, the `.dev.vars` requirement, the `/sign-in/complete` trap, how to add a page to the catalogue, and how to read a failure. Someone arriving cold must be able to run the suite from it.

- [ ] **Step 2: Update `docs/known-issues.md`**

Row 29 records that M6a's manual browser verification was only partly carried out, and the J6a rows record the deferred walkthrough. Amend — do not delete — each with what is now covered automatically and what still is not (the QR code being *scanned*, and anything needing a real device). Preserve the existing amendment style.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: how to run and extend the browser suite"
```

---

## Manual verification

After Task 6, review the captured screenshots at 390px — particularly the J6a squad row, which has never been seen rendered.
