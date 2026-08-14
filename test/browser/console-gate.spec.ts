import { expect, test } from "@playwright/test";
import { CATALOGUE } from "./catalogue.js";
import { observe } from "./observe.js";
import { signIn, TEST_OWNER, TEST_PLAYER } from "./sign-in.js";
import { seedWorld, type World } from "./world.js";

/**
 * Tier 1: every page in the catalogue, loaded in a real browser, failing on
 * any console error or CSP violation.
 *
 * This is the whole reason the harness exists. `docs/known-issues.md`'s
 * `connect-src` post-mortem describes both passkey buttons broken in every
 * browser for days while the entire server suite stayed green: workerd never
 * enforces a policy, it only returns the header. Nothing here asserts on
 * business logic — that stays in Vitest, where it is faster and more precise.
 */

let world: World;

test.beforeAll(async ({ browser }) => {
  // One world for the whole file. Building it per test would multiply games
  // and squads for no gain: these tests only load pages, never mutate them.
  const context = await browser.newContext();
  const page = await context.newPage();
  world = await seedWorld(page, browser);
  await context.close();
});

for (const entry of CATALOGUE) {
  test(`${entry.id} — no console errors, no CSP violations`, async ({ page }) => {
    const seen = observe(page);
    // `player` gets the joined member's own identity, so a page like this
    // one — a member's own view of a game — is loaded as the member it is
    // built for, not as the game's owner.
    if (entry.persona === "player") await signIn(page, TEST_PLAYER);
    else if (entry.persona !== "anonymous") await signIn(page, TEST_OWNER);

    const response = await page.goto(entry.path(world), { waitUntil: "networkidle" });
    expect(response, `${entry.title} did not respond at all`).not.toBeNull();

    const expectedStatus = entry.expectedStatus ?? 200;
    expect(response?.status(), `${entry.title} answered the wrong status`).toBe(expectedStatus);

    expect(
      await seen.violations(),
      `CSP violations on ${entry.title} (${entry.id}). This is the failure ` +
        `class the connect-src post-mortem describes — the page renders, the ` +
        `server test passes, and the browser refuses the thing the page needs.`,
    ).toEqual([]);

    // Chromium logs the navigation's own non-2xx as a console error. Discount
    // exactly that one message, and only when the page is *meant* to answer
    // that status — never a blanket filter, which would blind the gate to the
    // failed sub-resource loads it exists to catch.
    const selfReport = `Failed to load resource: the server responded with a status of ${expectedStatus}`;
    const errors =
      expectedStatus === 200
        ? seen.errors()
        : seen.errors().filter((error) => !error.includes(selfReport));

    expect(errors, `console errors on ${entry.title} (${entry.id})`).toEqual([]);
  });
}

test("the CSP detector actually fires", async ({ page }) => {
  // Without this the entire tier above could be observing nothing and would
  // look identically green. A detector that cannot fail manufactures
  // confidence, which is worse than no detector at all.
  const seen = observe(page);
  await page.goto("/sign-in");
  expect(await seen.violations()).toEqual([]);

  // A <style> element no hash in the policy can possibly cover. Reached via
  // `globalThis` because this project is typed against the Workers runtime
  // and has no DOM lib — see `observe.ts`.
  await page.evaluate(() => {
    const { document } = globalThis as unknown as {
      document: {
        createElement: (tag: string) => { textContent: string };
        head: { appendChild: (node: unknown) => void };
      };
    };
    const style = document.createElement("style");
    style.textContent = "body{outline:1px solid red}";
    document.head.appendChild(style);
  });

  await expect
    .poll(() => seen.violations(), { message: "the injected style raised no violation" })
    .not.toEqual([]);
});
