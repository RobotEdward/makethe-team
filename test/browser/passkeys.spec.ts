import { expect, test, type Page } from "@playwright/test";
import { observe } from "./observe.js";
import { signIn, TEST_OWNER } from "./sign-in.js";

/**
 * Tier 3: the passkey ceremonies, driven through Chrome DevTools Protocol's
 * virtual authenticator — no hardware, no operating-system prompt.
 *
 * This is the highest-value area in the whole harness. `docs/known-issues.md`
 * records that both of these buttons were broken in every browser for days by
 * a `connect-src` directive, while the entire server suite stayed green: the
 * ceremonies are pure browser API, so nothing in workerd can execute them.
 */

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

test("a signed-in player can register a passkey", async ({ page }) => {
  const seen = observe(page);
  await signIn(page, TEST_OWNER);
  const { cdp, authenticatorId } = await attachAuthenticator(page);

  await page.goto("/app/passkeys");

  // The affordance ships `hidden` and is revealed by script only when the
  // browser supports WebAuthn. If it stays hidden, the script did not run —
  // which is precisely how the connect-src bug presented.
  await expect(page.locator("#passkey-add")).toBeVisible();

  // Count credentials before registration to avoid false positives from
  // credentials registered in previous test runs. We assert the count
  // increased, not just that a credential exists, because credentials
  // accumulate across runs and "passkey" text would match stale entries.
  const credentialListBefore = page.locator(".passkey-list li");
  const countBefore = await credentialListBefore.count();

  await page.click("#passkey-add-button");

  // Two independent confirmations, because either alone can lie. The
  // authenticator proves the ceremony completed in the browser; the page
  // proves the server recorded what the browser produced.
  await expect
    .poll(
      async () => {
        const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
        return credentials.length;
      },
      { message: "the virtual authenticator holds no credential" },
    )
    .toBeGreaterThan(0);

  // Poll the page's credential list until it reflects the registration,
  // rather than driving a navigation that races with the app's own reload.
  await expect
    .poll(
      async () => await credentialListBefore.count(),
      { message: "the page did not record the registered credential" },
    )
    .toBe(countBefore + 1);

  expect(
    await seen.violations(),
    "a CSP violation during registration — this is the connect-src regression",
  ).toEqual([]);
  expect(seen.errors()).toEqual([]);
});

test("a registered passkey signs in on its own", async ({ page }) => {
  // Register first, in this context, so the credential and the origin match.
  await signIn(page, TEST_OWNER);
  const { cdp, authenticatorId } = await attachAuthenticator(page);
  await page.goto("/app/passkeys");
  await expect(page.locator("#passkey-add")).toBeVisible();
  await page.click("#passkey-add-button");
  await expect
    .poll(async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length)
    .toBeGreaterThan(0);

  // Drop the session entirely. The credential is all that is left, which is
  // the point: this must sign in without a magic link.
  await page.context().clearCookies();

  // **Stop the authenticator answering anything it is not asked to.**
  //
  // The sign-in page starts a conditional-mediation request on load (M40,
  // PASSKEY_SIGN_IN_JS), and a virtual authenticator built with
  // `automaticPresenceSimulation` satisfies it with no interaction at all —
  // so the page signs itself in and navigates to the dashboard while this
  // test is still trying to click the button. That is a race, and it is the
  // one this suite lost intermittently: the click retried against a page
  // that had already left, and the failure screenshot showed `/app`.
  //
  // With presence simulation off, the conditional request stays pending and
  // cannot resolve, so the only ceremony that can finish is the one the
  // click below starts. That is exactly the thing under test — the button,
  // whose inertness is what the connect-src regression looked like.
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId,
    enabled: false,
  });

  const seen = observe(page);
  await page.goto("/sign-in");
  await expect(page.locator("#passkey")).toBeVisible();
  await page.click("#passkey-button");

  // Only now, after the click has aborted the conditional request and started
  // a modal one of its own, is the authenticator allowed to answer. Enabling
  // this before the click would reopen the race it exists to close.
  await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId,
    enabled: true,
  });

  // The ceremony ends by navigating away from the sign-in page. If the button
  // is inert — which is exactly how the connect-src bug presented — this
  // times out rather than passing quietly.
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 15_000 });

  // And the session it produced is real: an authenticated page, not a bounce.
  const authenticated = await page.goto("/g/new");
  expect(authenticated?.status(), "the passkey session does not authenticate").toBe(200);
  expect(page.url()).toContain("/g/new");

  expect(
    await seen.violations(),
    "a CSP violation during passkey sign-in — this is the connect-src regression",
  ).toEqual([]);
});
