import { expect, test } from "@playwright/test";
import { DASHBOARD_PATH, fixturePath } from "../../src/auth/paths.js";
import { signIn, TEST_OWNER } from "./sign-in.js";
import { JOINER_NAME, seedWorld, type World } from "./world.js";

/**
 * This project is typed against the Workers runtime and has no DOM lib, so
 * everything inside a `page.evaluate` reaches its globals through
 * `globalThis` — the idiom `test/browser/console-gate.spec.ts` and
 * `test/browser/observe.ts` already use.
 */
type BrowserGlobals = {
  __stillHere?: boolean;
  document: { dispatchEvent: (event: unknown) => void };
};

/**
 * The freshness bar's behaviour (M24), which only a browser can see.
 *
 * Every assertion here fails silently everywhere else: whether a resumed page
 * actually re-fetches, and whether it declines to when there is unsaved work
 * on it, are questions about event listeners and a clock. The server sees an
 * ordinary GET either way.
 *
 * `page.clock` is what makes the sixty-second threshold testable without
 * waiting sixty seconds — it fakes `Date.now` and the timers, so the script's
 * own arithmetic is what advances, not the wall clock.
 */
let world: World;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  world = await seedWorld(page, browser);
  await context.close();
});

/**
 * True once the document has been replaced — the marker is set on `window`
 * after load, and only a real navigation clears it.
 */
async function markLoad(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as unknown as BrowserGlobals).__stillHere = true;
  });
}
async function reloaded(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => (globalThis as unknown as BrowserGlobals).__stillHere !== true);
}

/** The resume itself, as the browser dispatches it when an app comes back. */
async function resume(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const { document } = globalThis as unknown as BrowserGlobals;
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("a resumed dashboard re-fetches itself once it has gone stale", async ({ page }) => {
  await signIn(page, TEST_OWNER);
  // Installed before the navigation, which is the only point the clock can be
  // faked from — the script reads `Date.now()` as it parses.
  await page.clock.install();
  await page.goto(DASHBOARD_PATH);
  await expect(page.locator(".freshness-age")).toHaveText("Updated just now");
  await markLoad(page);

  await page.clock.fastForward("05:00");
  // `document.hidden` is false on a focused page, so this is the same shape
  // the browser dispatches when an installed app comes back to the front.
  await resume(page);

  await page.waitForFunction(() => (globalThis as unknown as { __stillHere?: boolean }).__stillHere !== true);
  await expect(page.locator(".freshness-age")).toHaveText("Updated just now");
});

test("a page that has not gone stale is left alone", async ({ page }) => {
  await signIn(page, TEST_OWNER);
  await page.clock.install();
  await page.goto(DASHBOARD_PATH);
  await markLoad(page);

  await page.clock.fastForward("00:20");
  await resume(page);
  await page.waitForTimeout(300);

  expect(await reloaded(page), "twenty seconds is not stale").toBe(false);
});

test("the age counts up where the page is left open", async ({ page }) => {
  await signIn(page, TEST_OWNER);
  await page.clock.install();
  await page.goto(DASHBOARD_PATH);

  // No resume, so no reload — only the ticker, which is the half of this
  // feature that answers "is what I'm looking at current?" without moving
  // anything on the page.
  await page.clock.fastForward("03:00");
  await expect(page.locator(".freshness-age")).toHaveText("Updated 3 minutes ago");
});

test("an in-progress team pick is never reloaded away", async ({ page }) => {
  await signIn(page, TEST_OWNER);
  const path = fixturePath(world.gameId, world.fixtureId);

  // The picker only renders once somebody is playing, so the joiner is put
  // `in` before the clock is faked — that put is a real navigation and would
  // clear the marker below.
  await page.goto(path);
  await page.locator("ul.squad li").filter({ hasText: JOINER_NAME }).getByRole("button", { name: "In" }).click();
  await expect(
    page.locator("ul.squad li").filter({ hasText: JOINER_NAME }).locator('button[name="intent"][value="in"]'),
  ).toHaveAttribute("aria-pressed", "true");

  await page.clock.install();
  await page.goto(path);
  await markLoad(page);

  // Randomise sets every radio from script, firing neither `input` nor
  // `change` — the exact case a naive dirty check misses, and the one that
  // would destroy a pick the organiser has not saved.
  const randomise = page.locator("#team-randomise");
  await expect(randomise).toBeVisible();
  await randomise.click();

  await page.clock.fastForward("30:00");
  await resume(page);
  await page.waitForTimeout(300);

  expect(await reloaded(page), "a touched form retires the reload").toBe(false);
  // And the bar is still there, offering the organiser the choice by hand.
  await expect(page.locator(".freshness-refresh")).toBeVisible();
});

test.describe("javascript off", () => {
  test.use({ javaScriptEnabled: false });

  test("the bar is a plain link back at the page, and claims no age", async ({ page }) => {
    await signIn(page, TEST_OWNER);
    await page.goto(DASHBOARD_PATH);

    // Nothing counts, so nothing is claimed: an "Updated just now" served in
    // the markup would still be saying it an hour later.
    await expect(page.locator(".freshness-age")).toBeHidden();

    const refresh = page.locator(".freshness-refresh");
    await expect(refresh).toHaveAttribute("href", DASHBOARD_PATH);
    await refresh.click();
    await expect(page).toHaveURL(new RegExp(`${DASHBOARD_PATH}$`));
    await expect(page.locator("h1")).toHaveText("Your games");
  });
});
