import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { ACCOUNT_PATH, PUSH_SUBSCRIBE_PATH } from "../../src/auth/paths.js";
import { PUSH_BUTTON_ID, PUSH_KEY_ATTRIBUTE } from "../../src/views/scripts.js";
import { observe } from "./observe.js";
import { signIn, TEST_OWNER, TEST_PLAYER } from "./sign-in.js";
import { seedWorld, type World } from "./world.js";

const run = promisify(execFile);

/**
 * M14 web push (spec-referenced in the task 15 brief), tested at the tier
 * this suite exists for: what only a real browser can prove.
 *
 * **What this file deliberately does not attempt.** Whether a push actually
 * arrives — on the wire, past the OS, onto a lock screen — cannot be
 * asserted from Playwright without driving Chrome DevTools Protocol far
 * beyond what this harness uses elsewhere (a virtual authenticator for
 * WebAuthn is a supported CDP domain; a synthetic push event delivered to a
 * *registered* service worker is not exposed through Playwright at all, and
 * `Page.evaluate`-ing `self.dispatchEvent(new PushEvent(...))` inside the
 * worker only proves the handler runs, which Task 11's
 * `test/routes/service-worker.test.ts` already does more precisely — it
 * executes the served script text (`src/routes/pwa.ts`) against a stubbed
 * `self`, with no browser involved at all). That gap is real and is
 * documented as a manual gate in `docs/runbooks/browser-testing.md`, not
 * silently left uncovered.
 *
 * **What this file also does not repeat.** Every catalogued page — which
 * includes `/app/account` and the `respond` GET page — already runs through
 * `console-gate.spec.ts`'s CSP/console sweep, so "no CSP violation on any
 * catalogued page" needs no duplicate assertion here. And the one-time push
 * offer on the response-confirmation page is exercised precisely, including
 * its VAPID-absent no-op, by `test/routes/respond-post.test.ts` — a POST
 * response and a database row are Vitest's job, not this suite's.
 *
 * **What is left, and is genuinely browser-only:**
 *   1. The subscribe endpoint's validation, reached the way the real button
 *      reaches it — a `fetch` issued from inside a loaded page, so a broken
 *      `connect-src` would show up as a network failure here exactly as it
 *      did for both passkey buttons (the post-mortem this whole suite exists
 *      to prevent a repeat of).
 *   2. The account page's device list and its plain-`<form>` Remove control,
 *      submitted with JavaScript off — real browser form-submission
 *      semantics, not a route handler called directly.
 */

/**
 * This deployment's `wrangler dev` (`test/browser/browser.env`) sets neither
 * `PUSH_NOTIFIER` nor a VAPID pair, so `wrangler.jsonc`'s own `"null"`
 * applies — the same dark state Task 15's brief requires this suite to be
 * honest about. `env.VAPID_PUBLIC_KEY` is undefined here exactly as it is in
 * production tonight, so no test in this file may assume a permission
 * button is ever revealed. What *is* true in both places, and is what these
 * tests check: the subscribe endpoint itself, and the device list, work
 * whether or not that key exists — neither depends on it.
 */

/** Matches `test/browser/world.ts`'s own private helper — see its comment. */
async function execSql(sql: string): Promise<void> {
  await run("npx", ["wrangler", "d1", "execute", "makethe-team", "--local", "--command", sql], {
    cwd: process.cwd(),
    maxBuffer: 4 * 1024 * 1024,
  });
}

/**
 * Inserts a `push_subscriptions` row directly, bypassing the real subscribe
 * flow entirely — deliberately. A genuine `pushManager.subscribe()` call
 * reaches an actual push service over the network (FCM for Chromium), which
 * this hermetic suite must not depend on, and is also the one thing this
 * file's own header says Playwright cannot exercise meaningfully. What is
 * under test here is the *account page's* rendering and removal of a row
 * that already exists, not how the row got there — `test/routes/push.test.ts`
 * and `test/routes/account.test.ts` cover the subscribe/list logic itself in
 * Vitest, where it is precise and fast.
 */
async function insertSubscription(playerId: string, endpoint: string, userAgent: string): Promise<void> {
  await execSql(
    `INSERT INTO push_subscriptions (id, player_id, endpoint, p256dh, auth, user_agent, created_at) ` +
      `VALUES ('${randomUUID()}', '${playerId}', '${endpoint}', 'p256dh-value', 'auth-value', '${userAgent}', ${Date.now()})`,
  );
}

let world: World;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  world = await seedWorld(page, browser);
  await context.close();
});

test.describe("the subscribe endpoint", () => {
  const malformed: { name: string; body: unknown }[] = [
    { name: "no subscription field at all", body: {} },
    { name: "an endpoint that is not https", body: { subscription: { endpoint: "http://push.example/x", keys: { p256dh: "AA", auth: "AA" } } } },
    { name: "keys missing auth", body: { subscription: { endpoint: "https://push.example/x", keys: { p256dh: "AA" } } } },
    {
      name: "keys that are not the right shape once decoded",
      body: { subscription: { endpoint: "https://push.example/x", keys: { p256dh: "not-base64url!!", auth: "AA" } } },
    },
  ];

  for (const { name, body } of malformed) {
    test(`rejects ${name}, reached by a real fetch from the page — no CSP violation`, async ({ page }) => {
      const seen = observe(page);
      await signIn(page, TEST_OWNER);
      await page.goto(ACCOUNT_PATH);

      const result = await page.evaluate(
        async ({ path, payload }) => {
          const response = await fetch(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          return { status: response.status, body: await response.text() };
        },
        { path: PUSH_SUBSCRIBE_PATH, payload: body },
      );

      expect(result.status, `body was: ${result.body}`).toBe(400);
      expect(
        await seen.violations(),
        "a CSP violation here would mean the account page's own script could " +
          "never have reached this endpoint either — the exact failure mode " +
          "the connect-src post-mortem describes.",
      ).toEqual([]);
    });
  }
});

test("the account page offers the permission button, carrying the configured VAPID key", async ({
  page,
}) => {
  await signIn(page, TEST_OWNER);
  await page.goto(ACCOUNT_PATH);

  // Push went live on 18 August 2026, so `wrangler.jsonc` now carries a real
  // `VAPID_PUBLIC_KEY` and this `wrangler dev` inherits it. That makes the
  // *live* affordance the honest thing for a browser to assert, and this test
  // was rewritten from its dark-state predecessor when the key landed.
  //
  // `PUSH_NOTIFIER` is still pinned to "null" in `browser.env`, which is a
  // separate axis: it governs whether a push is ever *sent*, and pinning it
  // keeps this suite free of the production secret. The button's presence
  // depends only on the public key, which is why flipping the notifier alone
  // does not restore the old assertion.
  //
  // The no-key path is still covered, where it can be asserted precisely and
  // without a browser: `test/routes/account.test.ts` renders the account page
  // with `VAPID_PUBLIC_KEY` absent and asserts no button and no key attribute.
  const button = page.locator(`#${PUSH_BUTTON_ID}`);
  await expect(button).toHaveCount(1);

  // Not merely "an attribute exists": the value is what the browser hands to
  // `PushManager.subscribe()` as `applicationServerKey`, so a wrong or empty
  // one fails at the platform with an error this app never sees. Pinned
  // against the deployed configuration rather than a literal, so rotating the
  // key does not silently leave this asserting the old one.
  await expect(button).toHaveAttribute(PUSH_KEY_ATTRIBUTE, /^B[A-Za-z0-9_-]{86}$/);

  await expect(page.locator("section.push h2")).toHaveText("Notifications");
});

test.describe("the device list, with JavaScript off", () => {
  test.use({ javaScriptEnabled: false });

  test("a registered device renders, and its plain-form Remove control actually removes it", async ({ page }) => {
    const endpoint = `https://push.example/browser-test-${randomUUID()}`;
    await insertSubscription(world.memberPlayerId, endpoint, "The test phone");

    await signIn(page, TEST_PLAYER);
    await page.goto(ACCOUNT_PATH);

    const row = page.locator(".push-device", { hasText: "The test phone" });
    await expect(row).toBeVisible();

    // This is a real `<form method="post">` submit, not a script-driven
    // delete — §11's closing paragraph requires the whole list to work with
    // no JavaScript at all, and `javaScriptEnabled: false` on this whole
    // describe block is what proves it rather than assumes it.
    await row.getByRole("button", { name: "Remove" }).click();

    // `POST /app/push/unsubscribe`'s form branch answers a 303 back to
    // `ACCOUNT_PATH` precisely so a no-JS submit lands somewhere that shows
    // the row is actually gone, rather than leaving the stale page in place
    // (M14 Task 12 review, Finding 3).
    await expect(page).toHaveURL(new RegExp(`${ACCOUNT_PATH}$`));
    await expect(page.locator(".push-device", { hasText: "The test phone" })).toHaveCount(0);
  });
});
