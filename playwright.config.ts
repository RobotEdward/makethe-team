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
 * The bindings `wrangler dev` needs for a browser to be able to sign in,
 * passed on the command line rather than written to `.dev.vars`.
 *
 * That is not a style preference. `.dev.vars` is also read by the Vitest
 * workers pool (`vitest.config.ts` points it at the same `wrangler.jsonc`),
 * and it *overrides* the bindings that config sets explicitly — putting
 * `SIGNIN_ALLOWLIST` and `BETTER_AUTH_URL` there turned 56 server tests red,
 * because every signed-in test suddenly had a different allowlist and a
 * different origin from the one it asserts against. Keeping these on the
 * command line means the browser suite configures only the browser suite.
 *
 * Every value is a local-only dummy, which is also why CI needs no secret.
 */
const DEV_VARS = [
  // wrangler.jsonc says "resend", which throws here with no RESEND_API_KEY —
  // into an error signin.ts deliberately swallows, so it fails invisibly.
  "NOTIFIER:console",
  // Without this, magic links are minted against https://makethe.team.
  `BETTER_AUTH_URL:${BASE_URL}`,
  "BETTER_AUTH_SECRET:local-browser-tests-only-not-a-real-secret",
  "CANCEL_TOKEN_SECRET:local-browser-tests-only-not-a-real-secret",
  "RESPONSE_TOKEN_SECRET:local-browser-tests-only-not-a-real-secret",
  // Suppresses the send for anything else. Note the harness does not depend
  // on this — see the header of `test/browser/sign-in.ts`.
  "SIGNIN_ALLOWLIST:owner@example.test,player@example.test",
].flatMap((v) => ["--var", v]);

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
    command: `npx wrangler dev --port 8787 ${DEV_VARS.join(" ")}`,
    url: `${BASE_URL}/sign-in`,
    // Locally, reuse a dev server that is already up. On CI there is never one
    // to reuse and silently reusing something unexpected would be worse.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
