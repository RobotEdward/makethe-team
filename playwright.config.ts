import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level tests.
 *
 * These exist for one reason: the Vitest suite runs inside workerd and can
 * never observe a CSP violation, a console error, or whether inline script
 * executed at all. `docs/known-issues.md`'s `connect-src` post-mortem is the
 * governing case — both passkey buttons were broken in every browser for days
 * while the whole server suite stayed green.
 *
 * Scope rule, enforced by review rather than by code: a test belongs here only
 * if Vitest structurally cannot make the check. Business logic stays there.
 * See `docs/superpowers/specs/2026-08-13-browser-testing-design.md`.
 */
export const BASE_URL = "http://localhost:8787";

/**
 * How `wrangler dev` is started for this suite, and why each flag is there.
 *
 * `--env-file` rather than `.dev.vars`: that file is read by the Vitest
 * workers pool too, and it *overrides* the bindings `vitest.config.ts` sets
 * explicitly. Putting `SIGNIN_ALLOWLIST` and `BETTER_AUTH_URL` there turned
 * 56 server tests red, because every signed-in test suddenly had a different
 * allowlist and origin from the ones it asserts against.
 *
 * `--env-file` rather than `--var`: `--var KEY:VALUE` splits on the colon, so
 * any value containing one is mangled. `--var BETTER_AUTH_URL:http://…` gave
 * an origin that matched nothing, and every POST came back a bare 403
 * "Forbidden" that reads like an auth bug and is a configuration one.
 *
 * `--local-upstream` is the non-obvious one. `wrangler.jsonc` declares the
 * custom domain `makethe.team`, and `wrangler dev` presents *that* host to
 * the Worker — it rewrites the incoming `Origin` header, so a request the
 * browser sent from `http://localhost:8787` arrives claiming
 * `http://makethe.team`. Every state-changing handler compares `Origin`
 * against `BETTER_AUTH_URL` (`wrongOrigin` in `src/routes/games.ts` and its
 * siblings), so without this flag every form post in the suite is refused,
 * whatever `BETTER_AUTH_URL` is set to. Confirmed by logging both values
 * inside the handler. The port must be included: bare `localhost` is not
 * enough.
 */
const WRANGLER_FLAGS = [
  "--port",
  "8787",
  "--env-file",
  "test/browser/browser.env",
  "--local-upstream",
  "localhost:8787",
];

export default defineConfig({
  testDir: "./test/browser",
  // `wrangler dev` is backed by a single local D1. Parallel workers would race
  // on the same rows, so the suite is deliberately serial — a browser test
  // that depends on a neighbour's state is a broken test, but two workers
  // writing the same squad is a broken *run*.
  workers: 1,
  fullyParallel: false,
  // CI must never pass because a test was left focused or skipped.
  forbidOnly: Boolean(process.env.CI),
  // No retries anywhere. A test that passes on the second attempt is telling
  // us something, and retries are how that signal gets thrown away.
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx wrangler dev ${WRANGLER_FLAGS.join(" ")}`,
    url: `${BASE_URL}/sign-in`,
    // Never reuse a server this config did not start.
    //
    // `reuseExistingServer: true` is the usual default and it cost an hour
    // here: a `wrangler dev` left running from manual poking was adopted
    // silently, and because it had been started *without* `DEV_VARS` its
    // `BETTER_AUTH_URL` was still production's. Every POST then failed the
    // origin check with a bare 403 "Forbidden", which reads like an auth bug
    // and is really a configuration one. The bindings above are part of this
    // suite's contract, so the suite starts the server that has them.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
