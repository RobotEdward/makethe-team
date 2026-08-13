import { expect, test, type Page } from "@playwright/test";
import { signIn, TEST_OWNER, TEST_PLAYER } from "./sign-in.js";
import { seedWorld } from "./world.js";

/**
 * Tier 2: the journeys a person must be able to complete, run twice — once
 * with JavaScript and once without.
 *
 * The project's stated policy is that anything a person *must* do works with
 * JavaScript off. The second projection is what proves that, rather than
 * asserting it: every one of these flows is server-rendered HTML and real
 * form posts, so a failure in the JS-off run is a genuine product defect and
 * not a test artefact.
 *
 * Assertions scope to an element, never the whole document. J6a's own review
 * found two tests that passed whether the value under test was right or
 * wrong, both because a page-wide `toContain` cannot tell the difference.
 */

/** The `<li>` for one squad member, by their visible name. */
function squadRow(page: Page, name: string) {
  return page.locator("ul.squad li").filter({ hasText: name });
}

for (const javaScriptEnabled of [true, false] as const) {
  test.describe(`javascript ${javaScriptEnabled ? "on" : "off"}`, () => {
    test.use({ javaScriptEnabled });

    test("signing in reaches the dashboard", async ({ page }) => {
      await signIn(page, TEST_OWNER);
      await page.goto("/app");
      await expect(page.locator("h1")).toBeVisible();
      expect(page.url()).toContain("/app");
    });

    test("an owner can create a game and sees themselves in the squad", async ({ page }) => {
      await signIn(page, TEST_OWNER);
      await page.goto("/g/new");
      await page.fill('input[name="name"]', "Sunday Kickabout");
      await page.fill('input[name="venueName"]', "Burgess Park");
      await page.click('button[type="submit"]');
      await page.waitForURL(/\/g\/[^/]+$/);

      await expect(page.locator("h1")).toHaveText(/Sunday Kickabout/);
      // The owner is in their own squad, marked as themselves and as organiser.
      const own = page.locator("ul.squad li .member").first();
      await expect(own).toContainText("(you)");
      await expect(own).toContainText("organiser");
    });

    test("a second identity can join from the invite link", async ({ page, browser }) => {
      const world = await seedWorld(page, browser, { javaScriptEnabled });
      await page.goto(`/g/${world.gameId}`);
      // Scoped to the joiner's own row, so this cannot pass on the owner's.
      await expect(squadRow(page, "Alex Morgan")).toHaveCount(1);
    });

    test("the copy-invite button is script-only and degrades", async ({ page, browser }) => {
      const world = await seedWorld(page, browser, { javaScriptEnabled });
      await page.goto(`/g/${world.gameId}`);

      // The invite URL itself is always readable — it is an input's value,
      // not something the button produces. Asserting on the page text would
      // therefore pass in both projections and prove nothing.
      await expect(page.locator("#invite-url")).toHaveValue(/\/j\//);

      const copy = page.locator("#invite-copy");
      if (javaScriptEnabled) {
        await expect(copy).toBeVisible();
      } else {
        // It ships `hidden` and is revealed by script, so with JS off it must
        // stay hidden rather than offer an action that cannot work.
        await expect(copy).toBeHidden();
      }
    });

    test("an owner can promote a member, is refused the last demotion, and can remove them", async ({
      page,
      browser,
    }) => {
      const world = await seedWorld(page, browser, { javaScriptEnabled });
      await page.goto(`/g/${world.gameId}`);

      const member = squadRow(page, "Alex Morgan");
      await expect(member.locator(".member")).not.toContainText("organiser");

      // --- promote ---------------------------------------------------------
      await member.getByRole("button", { name: "Make an organiser" }).click();
      await page.waitForURL(/\/g\/[^/]+$/);
      await expect(squadRow(page, "Alex Morgan").locator(".member")).toContainText("organiser");
      // The control now offers the opposite direction. Scoped to this row:
      // an unscoped check passes whichever label is present anywhere.
      await expect(
        squadRow(page, "Alex Morgan").getByRole("button", { name: "Make an ordinary member" }),
      ).toBeVisible();

      // --- the last-owner refusal -----------------------------------------
      // Demote the new organiser back, leaving the owner as the only one,
      // then try to demote the owner. That must be refused at 422.
      await squadRow(page, "Alex Morgan")
        .getByRole("button", { name: "Make an ordinary member" })
        .click();
      await page.waitForURL(/\/g\/[^/]+$/);

      const ownerRow = page.locator("ul.squad li").filter({ hasText: "(you)" });
      const [refusal] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === "POST"),
        ownerRow.getByRole("button", { name: "Make an ordinary member" }).click(),
      ]);
      expect(refusal.status(), "demoting the last organiser must be refused").toBe(422);
      await expect(page.locator(".problem")).toBeVisible();
      // And it must not have taken effect.
      await page.goto(`/g/${world.gameId}`);
      await expect(
        page.locator("ul.squad li").filter({ hasText: "(you)" }).locator(".member"),
      ).toContainText("organiser");

      // --- remove ----------------------------------------------------------
      await squadRow(page, "Alex Morgan").getByRole("link", { name: "Remove" }).click();
      await page.waitForURL(/\/squad\/[^/]+\/remove$/);
      // The confirmation page names the person, so a mis-targeted link cannot
      // pass this.
      await expect(page.locator("main")).toContainText("Alex Morgan");

      await page.getByRole("button", { name: /remove/i }).click();
      await page.waitForURL(/\/g\/[^/]+$/);
      await expect(squadRow(page, "Alex Morgan")).toHaveCount(0);
    });

    test("a player can answer a fixture from a response link", async ({ page, browser }) => {
      const world = await seedWorld(page, browser, { javaScriptEnabled });

      // A fresh context: `/r/:token` is reached from an inbox, with no
      // session at all, which is the whole point of the token.
      const visitor = await browser.newContext({ javaScriptEnabled });
      const visitorPage = await visitor.newPage();
      await visitorPage.goto(`/r/${world.responseToken}`);
      await expect(visitorPage.locator("h1")).toBeVisible();

      // Assert the controls exist before clicking. A fixture that is not open
      // renders a read-only notice with no buttons, and clicking a locator
      // that will never resolve simply hangs until the test times out — a
      // failure that says nothing about what went wrong.
      await expect(
        visitorPage.locator("form.responses button"),
        "the fixture is not accepting answers — is it open?",
      ).toHaveCount(2);

      // Answer "I'm in", then confirm the page comes back showing that answer
      // as the current one. `POST /r/:token` re-renders in place rather than
      // redirecting, deliberately — there is no session to redirect with.
      await visitorPage.getByRole("button", { name: "I'm in" }).click();
      // The chosen answer is the one rendered `button primary` (BR-5: it is
      // deliberately not emphasised for a waitlisted viewer, so this also
      // asserts the seeded fixture had a place free).
      await expect(visitorPage.locator("button[value='in']")).toHaveClass(/primary/);
      await expect(visitorPage.locator("button[value='out']")).not.toHaveClass(/primary/);
      await visitor.close();
    });
  });
}

test("the two identities never share a session", async ({ page, browser }) => {
  // Not parameterised: this is about cookie isolation, which JavaScript has
  // no bearing on. It guards the fixture setup every journey above relies on.
  await signIn(page, TEST_OWNER);
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  const response = await otherPage.goto("/app");
  // A fresh context has no cookie, so the dashboard must bounce it.
  expect(response?.url()).toContain("/sign-in");
  await other.close();
  expect(TEST_PLAYER).not.toBe(TEST_OWNER);
});
