import { expect, test, type Browser, type Page } from "@playwright/test";
import { BASE_URL } from "../../playwright.config.js";
import { observe } from "./observe.js";
import { signIn, TEST_OWNER, TEST_PLAYER } from "./sign-in.js";
import { JOINER_NAME, seedWorld } from "./world.js";

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

/** The `<li>` for one squad member, by their visible name — the organiser's rows. */
function squadRow(page: Page, name: string) {
  return page.locator("ul.squad li").filter({ hasText: name });
}

/**
 * The chip for one squad member on the player's own fixture page (M10 §3.5).
 * Distinct from `squadRow` above: the player's page groups into
 * `<li class="chip">` inside `<ul class="chips">` inside `<div class="squad">`
 * rather than `<ul class="squad"><li>`, so `squadRow`'s `ul.squad li`
 * locator finds nothing there.
 */
function squadChip(page: Page, name: string) {
  return page.locator("ul.chips li.chip").filter({ hasText: name });
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

      // The controls are behind a per-member `<details>` disclosure (M10
      // §3.8) — a native element, opened here by clicking its `<summary>`
      // with no script involved. This runs with JavaScript disabled too, and
      // must still be able to open it, because `<summary>` needs none.
      await member.locator("summary").click();

      // --- promote ---------------------------------------------------------
      await member.getByRole("button", { name: "Make an organiser" }).click();
      await page.waitForURL(/\/g\/[^/]+$/);
      await expect(squadRow(page, "Alex Morgan").locator(".member")).toContainText("organiser");
      await squadRow(page, "Alex Morgan").locator("summary").click();
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
      await ownerRow.locator("summary").click();
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
      await squadRow(page, "Alex Morgan").locator("summary").click();
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
      // The chosen answer is the one rendered `chosen-in` (BR-5: a waitlisted
      // viewer would get `chosen-waiting` instead, never this class, so this
      // also asserts the seeded fixture had a place free).
      await expect(visitorPage.locator("button[value='in']")).toHaveClass(/chosen-in/);
      await expect(visitorPage.locator("button[value='out']")).not.toHaveClass(/chosen-out/);
      await visitor.close();
    });
  });
}

/**
 * The squad-visibility setting (M8), driven end to end through real page
 * loads and a real form post — the tier this suite's own header explains:
 * `renderSquadSection`'s branch could save correctly and change nothing a
 * browser actually renders, and the server suite would never notice.
 *
 * Not parameterised over JavaScript: the edit form is a plain POST and
 * `/r/:token` a plain GET, both already covered end to end for every other
 * page by the loop above, so a second pass here would only repeat the console
 * gate.
 */
test("the organiser's squad-visibility setting hides and reveals names on the response page", async ({
  page,
  browser,
}) => {
  const seen = observe(page);
  // `seedWorld` already leaves `page` signed in as the owner — see the other
  // single-run tests in this file for why a second `signIn` would hang.
  const world = await seedWorld(page, browser);

  // The token is minted for the joiner (see `world.ts`), so `/r/:token` is
  // Alex Morgan's own fixture page: asserting only `JOINER_NAME`'s absence
  // would just prove Alex Morgan's own name is hidden from Alex Morgan, which
  // a future self/other split in `squadForViewer` could satisfy without the
  // setting doing anything for *other* players. `OTHER_MEMBER_NAME` is the
  // owner — a genuinely different squad member on the same fixture — so the
  // real claim under test (a player stops seeing everyone else) is on both
  // names together, not just the viewer's own.
  const OTHER_MEMBER_NAME = "owner"; // displayName() in src/routes/signin.ts falls back to the email's local part; the sign-in form here never carries a name, so TEST_OWNER ("owner@example.test") renders as this.

  // --- 1: the owner page renders --------------------------------------
  await page.goto(`/g/${world.gameId}`);
  await expect(page.locator("#invite-url")).toBeVisible();

  // --- 2: turn the setting off through the edit form -------------------
  await page.goto(`/g/${world.gameId}/edit`);
  await page.getByLabel("Let players see who else is playing").uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(/\/g\/[^/]+$/);

  // --- 3: the response page hides both names but keeps the count -------
  await page.goto(`/r/${world.responseToken}`);
  await expect(page.locator("main")).not.toContainText(JOINER_NAME);
  await expect(page.locator("main")).not.toContainText(OTHER_MEMBER_NAME);
  await expect(page.locator("main")).toContainText("in so far");

  // --- 4: turn it back on, both names reappear ---------------------------
  await page.goto(`/g/${world.gameId}/edit`);
  await page.getByLabel("Let players see who else is playing").check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(/\/g\/[^/]+$/);

  await page.goto(`/r/${world.responseToken}`);
  // The player's page renders the squad as chips (M10 §3.5), not
  // `ul.squad li` rows — `squadChip`, not `squadRow`, is the locator that
  // actually finds something here.
  await expect(squadChip(page, JOINER_NAME)).toHaveCount(1);
  await expect(squadChip(page, OTHER_MEMBER_NAME)).toHaveCount(1);

  expect(await seen.violations()).toEqual([]);
  expect(seen.errors()).toEqual([]);
});

/**
 * Tier 2, but not run twice through the whole-file loop above: nothing on
 * this page is script-only, and BR-27's attribution and the guest form are
 * both plain form posts already covered end to end by the JS-off projection
 * above for every other page in the catalogue. The point of this pair is the
 * console gate over a page Tasks 4-6 never drove in a real browser (see this
 * file's header for why that gap matters), and the two-step over-capacity
 * confirmation neither server tests nor the loop above can distinguish from
 * a page that lies and proceeds anyway.
 *
 * The mark-in step below still gets its own JS-off pass, inline: Task 6's
 * segmented control is new enough, and different enough in kind from a plain
 * button, that its no-JS guarantee deserves a real check rather than an
 * inference from the loop above having covered "some button on some page".
 */
test("an organiser answers for a player, adds a guest, and goes over capacity", async ({ page, browser }) => {
  const seen = observe(page);
  // `seedWorld` already leaves `page` signed in as `TEST_OWNER` — a second
  // `signIn` here would hit `GET /sign-in`'s own redirect for an
  // already-authenticated session (straight to the dashboard, skipping the
  // email form) and hang waiting for an input that was never going to render.
  const world = await seedWorld(page, browser);

  // A separate, JS-off context, signed in as the same owner, for the mark-in
  // itself: the segmented control (M10 §3.3) is still two plain
  // `<button type="submit">` elements in one form, and this proves it — the
  // click reaches the server and the *reloaded* page shows the member's new
  // answer back through `aria-pressed`, with no script anywhere in the loop.
  // A control that only *displayed* state via a script, or that needed one to
  // submit, would fail here even though the JS-on run above never would.
  const noScript = await browser.newContext({ javaScriptEnabled: false });
  const noScriptPage = await noScript.newPage();
  await signIn(noScriptPage, TEST_OWNER);
  await noScriptPage.goto(`/g/${world.gameId}/f/${world.fixtureId}`);

  await squadRow(noScriptPage, JOINER_NAME).getByRole("button", { name: "In" }).click();

  const joinerRow = squadRow(noScriptPage, JOINER_NAME);
  // BR-27's attribution, on the joiner's row specifically — scoped so a stray
  // "marked in by" anywhere on the page cannot pass this.
  await expect(joinerRow.locator(".set-by")).toContainText("marked in by");
  // The control's own state, carried to a screen reader as well as by the
  // fill — not just "a change happened", but "In is now the pressed half".
  await expect(joinerRow.locator('button[name="intent"][value="in"]')).toHaveAttribute("aria-pressed", "true");
  await noScript.close();

  await page.goto(`/g/${world.gameId}/f/${world.fixtureId}`);

  // Add a guest, who occupies a slot of their own.
  await page.fill("#guest-name", "Sam Whitlock");
  await page.getByRole("button", { name: "Add guest" }).click();
  await expect(squadRow(page, "Sam Whitlock")).toHaveCount(1);

  expect(await seen.violations()).toEqual([]);
  expect(seen.errors()).toEqual([]);
});

test("one more mark-in past capacity asks first, rather than waitlisting silently", async ({
  page,
  browser,
}) => {
  const seen = observe(page);
  // See the previous test for why `seedWorld` alone is enough here.
  const world = await seedWorld(page, browser);

  const fixturePath = `/g/${world.gameId}/f/${world.fixtureId}`;

  // Fill every place directly over HTTP, the way `world.ts` mints response
  // tokens rather than clicking through fourteen player pages. 14 is
  // `/g/new`'s own default `maxPlayers` (src/routes/games.ts), which
  // `seedWorld` never overrides. Guests need no prior membership, so this is
  // the fastest way to a genuinely full fixture.
  const maxPlayers = 14;
  for (let i = 1; i <= maxPlayers; i++) {
    const response = await page.request.post(`${BASE_URL}${fixturePath}/guest`, {
      form: { name: `Filler ${i}` },
      headers: { origin: BASE_URL },
    });
    expect(response.ok(), `filler guest ${i} of ${maxPlayers} should have had a free slot`).toBeTruthy();
  }

  await page.goto(fixturePath);
  const squad = page.locator("ul.squad");
  const seatedBefore = await squad.locator("li").count();

  // One more is the over-capacity case: BR-8's confirmation, not a silent add.
  await page.fill("#guest-name", "Priya Kapoor");
  await page.getByRole("button", { name: "Add guest" }).click();

  await expect(page.locator(".confirm")).toContainText("Add them anyway");
  // The weight of this test: the guest must not already be seated. A page
  // that just says the confirming words and adds them anyway would pass
  // every assertion above this one.
  await expect(squad).not.toContainText("Priya Kapoor");
  await expect(squad.locator("li")).toHaveCount(seatedBefore);

  await page.getByRole("button", { name: "Add them anyway" }).click();

  await expect(squadRow(page, "Priya Kapoor")).toHaveCount(1);
  await expect(squad.locator("li")).toHaveCount(seatedBefore + 1);
  await expect(page.locator(".problem")).toContainText("Over capacity");

  expect(await seen.violations()).toEqual([]);
  // The deliberate 422 above is a real, correct navigation — Chromium logs a
  // non-2xx navigation as a console error regardless of cause, the same one
  // `console-gate.spec.ts` discounts for `expectedStatus` entries. Discount
  // exactly that message and nothing else, so this still catches anything
  // else the page might have logged.
  const selfReport = "Failed to load resource: the server responded with a status of 422";
  expect(seen.errors().filter((error) => !error.includes(selfReport))).toEqual([]);
});

test("a player can leave a game from their own leave link, with JavaScript off", async ({ page, browser }) => {
  // `seedWorld` already leaves `page` signed in as the owner — see the other
  // single-run tests in this file for why a second `signIn` here would hang.
  const world = await seedWorld(page, browser);

  // A fresh, JS-off context: `/leave/:token` is reached from an inbox, with
  // no session, and must work without script — an unsubscribe that needs
  // JavaScript is not an unsubscribe.
  const visitor = await browser.newContext({ javaScriptEnabled: false });
  const visitorPage = await visitor.newPage();
  const seen = observe(visitorPage);
  await visitorPage.goto(`/leave/${world.leaveToken}`);

  await expect(visitorPage.locator("h1")).toContainText("Thursday 7-a-side");
  await expect(visitorPage.getByRole("button", { name: "Leave this game" })).toBeVisible();

  await visitorPage.getByRole("button", { name: "Leave this game" }).click();
  await expect(visitorPage.locator("main")).toContainText("out of");
  await expect(visitorPage.locator("main")).toContainText("Thursday 7-a-side");

  // Reload the same link: it must now say they are already out, not offer
  // the button again.
  await visitorPage.goto(`/leave/${world.leaveToken}`);
  await expect(visitorPage.locator("main")).toContainText("already out");
  await expect(visitorPage.getByRole("button", { name: "Leave this game" })).toHaveCount(0);

  expect(await seen.violations()).toEqual([]);
  expect(seen.errors()).toEqual([]);

  await visitor.close();
});

test("a player schedules their own erasure, sees it on the dashboard, and cancels it, with JavaScript off", async ({
  page,
  browser,
}) => {
  // `seedWorld` signs `page` in as the owner and puts Alex Morgan in the squad
  // as an ordinary member. The journey below is Alex Morgan's, not the owner's,
  // and that is not an arbitrary choice: the seeded owner is the only organiser
  // their game has, so `/app/delete` answers *them* with the `sole-organiser`
  // refusal, which renders no button at all. The joined member is the one who
  // reaches the `offer` state — the branch with the destructive control on it.
  // (`test/browser/catalogue.ts` picks the same persona, for the same reason.)
  await seedWorld(page, browser);

  // A context of its own, with JavaScript off. Its own, because the two
  // identities must never share a cookie jar; JS off, because erasing your own
  // data is something a person *must* be able to do — a control that needs
  // script is a control some people cannot reach. Every step below is a plain
  // link or a real form post, so a failure here is a product defect.
  const player = await browser.newContext({ javaScriptEnabled: false });
  const playerPage = await player.newPage();
  const seen = observe(playerPage);
  await signIn(playerPage, TEST_PLAYER);

  // --- 1: reached from the dashboard, not by typing the URL ----------------
  // The link is the only way in for a real person, so following it is part of
  // what is under test: a page that works only when navigated to directly is
  // a page nobody finds.
  await playerPage.goto("/app");
  await playerPage.getByRole("link", { name: "Delete my account and data" }).click();
  await playerPage.waitForURL(/\/app\/delete$/);
  await expect(playerPage.locator("h1")).toHaveText("Delete my data");
  // Scoped to the button, not the page: "Delete my data" is also the heading
  // and the browser tab's title, so a page-wide check would pass in the
  // `sole-organiser` state too — the one state that deliberately offers
  // nothing to press.
  const request = playerPage.getByRole("button", { name: "Delete my data" });
  await expect(request).toBeVisible();

  // --- 2: request it, and land back on the same page, now pending ----------
  await request.click();
  await playerPage.waitForURL(/\/app\/delete$/);
  await expect(playerPage.locator("main")).toContainText("due to be erased");
  // The offer is gone: a page that still shows the button after a successful
  // request would let the same person schedule it twice over.
  await expect(playerPage.getByRole("button", { name: "Delete my data" })).toHaveCount(0);

  // --- 3: the dashboard says so, and carries its own way out ---------------
  // The banner is the whole reason a pending erasure is visible anywhere but
  // the page that started it — see `renderErasureBanner`. Scoped to the
  // banner, so the assertion cannot be satisfied by text elsewhere.
  await playerPage.goto("/app");
  const banner = playerPage.locator(".nudge").filter({ hasText: "due to be erased" });
  await expect(banner).toHaveCount(1);

  // --- 4: cancel from the banner, and see it gone --------------------------
  await banner.getByRole("button", { name: "Keep my account" }).click();
  await playerPage.waitForURL(/\/app$/);
  await expect(playerPage.locator(".nudge").filter({ hasText: "due to be erased" })).toHaveCount(0);

  // And the delete page is back to offering it, rather than merely hiding the
  // banner while the deadline still stands.
  await playerPage.goto("/app/delete");
  await expect(playerPage.getByRole("button", { name: "Delete my data" })).toBeVisible();
  await expect(playerPage.locator("main")).not.toContainText("due to be erased");

  expect(await seen.violations()).toEqual([]);
  expect(seen.errors()).toEqual([]);

  await player.close();
});

/** The guest added to both picker journeys, so there are two players to split. */
const GUEST_NAME = "Sam Whitlock";

/**
 * The team picker (BR-35), the two ways it can be driven.
 *
 * Both journeys need the same starting position — a fixture with two players
 * `in` and nobody on a side — so it is built once here rather than twice.
 * `page` arrives from `seedWorld` already signed in as the owner; the guest
 * is the second player because a guest is `in` the moment they are added,
 * which the joined member is not.
 */
async function seedTwoPlayersIn(page: Page, browser: Browser, javaScriptEnabled: boolean) {
  const world = await seedWorld(page, browser, { javaScriptEnabled });
  const fixturePath = `/g/${world.gameId}/f/${world.fixtureId}`;

  await page.goto(fixturePath);
  await squadRow(page, JOINER_NAME).getByRole("button", { name: "In" }).click();
  // This is a postcondition check, not an appearance check: the picker
  // journeys below need the joiner genuinely `in`, and a silently failed
  // click would otherwise surface several tests later, far from its cause.
  // `.status` no longer renders for an `in` member (M10 §3.3 — the segment
  // states it instead), so `aria-pressed` on the segment itself is now the
  // authoritative place to read this fact back.
  await expect(
    squadRow(page, JOINER_NAME).locator('button[name="intent"][value="in"]'),
  ).toHaveAttribute("aria-pressed", "true");

  await page.fill("#guest-name", GUEST_NAME);
  await page.getByRole("button", { name: "Add guest" }).click();
  await expect(squadRow(page, GUEST_NAME)).toHaveCount(1);

  return { world, fixturePath };
}

/**
 * One player's row in the picker, wherever it currently sits.
 *
 * By `data-player` rather than by which list contains it: the drag-and-drop
 * script moves rows between the pool and the two columns, and a locator tied
 * to one of those would stop matching exactly when the row moved — the moment
 * the assertion is about.
 */
function pickerRow(page: Page, name: string) {
  return page.locator("li[data-player]").filter({ hasText: name });
}

/** The radio for one side on one player's row — the thing a save actually posts. */
function sideRadio(page: Page, name: string, side: string) {
  return pickerRow(page, name).getByLabel(side, { exact: true });
}

test.describe("the team picker, javascript off", () => {
  test.use({ javaScriptEnabled: false });

  /**
   * The guarantee. Picking sides, saving and publishing is something an
   * organiser *must* be able to do, so every step of it is a radio and a real
   * form post — and this runs with scripting disabled to prove that rather
   * than assert it. If the drag-and-drop journey below ever has to be
   * deleted, this is the one that keeps the feature honest.
   */
  test("an organiser picks both sides with the radios, saves, and publishes", async ({ page, browser }) => {
    const seen = observe(page);
    const { world, fixturePath } = await seedTwoPlayersIn(page, browser, false);

    // The columns the script would reveal must stay hidden here: an empty
    // drop target nobody can drop into is worse than no drop target at all.
    await expect(page.locator("#team-columns")).toBeHidden();

    await sideRadio(page, JOINER_NAME, "Team A").check();
    await sideRadio(page, GUEST_NAME, "Team B").check();
    await page.getByRole("button", { name: "Save teams" }).click();
    await page.waitForURL(new RegExp(`${fixturePath}$`));

    // Read back off the re-rendered page, not off the form that was just
    // submitted: this is the assertion that the pick was *stored*.
    await expect(sideRadio(page, JOINER_NAME, "Team A")).toBeChecked();
    await expect(sideRadio(page, GUEST_NAME, "Team B")).toBeChecked();

    await page.getByRole("button", { name: "Publish teams" }).click();
    await page.waitForURL(new RegExp(`${fixturePath}$`));
    // Publishing is on record: the control now offers to do it *again*, which
    // is the state `teams_published_at` renders.
    await expect(page.getByRole("button", { name: "Publish again" })).toBeVisible();

    // And it reached a player. `/r/:token` is the page a squad member reads,
    // and an unpublished pick renders nothing there at all — so this is the
    // difference between "saved" and "announced".
    await page.goto(`/r/${world.responseToken}`);
    await expect(page.locator(".your-side")).toContainText("Team A");

    expect(await seen.violations()).toEqual([]);
    expect(seen.errors()).toEqual([]);
  });
});

/**
 * **The only journey in this suite that *requires* JavaScript, and
 * deliberately so.**
 *
 * Plenty of tests above run with scripting on — the loop at the top of this
 * file runs every journey both ways — but every one of them would still pass
 * with it off, because that is this project's stated policy and the JS-off
 * projection is what proves it. This one is the exception: the team picker is
 * the only place where a *gesture* is offered as an alternative to a control,
 * and a gesture cannot be exercised with the script that implements it turned
 * off. Without this test the drag-and-drop enhancement would ship with no
 * coverage whatsoever.
 *
 * It asserts the underlying radio's `checked` state and never anything
 * visual. The radios are what a save posts, so "the radio followed the drag"
 * is precisely the claim that makes this journey and the JS-off journey above
 * two ways of performing one act, rather than two features that happen to
 * agree today. A test that asserted where the name appeared would pass for a
 * script that moved the name and forgot the form — which is the exact defect
 * worth catching.
 */
test("dragging a name onto a side moves the radio that the save posts", async ({ page, browser }) => {
  const seen = observe(page);
  const { fixturePath } = await seedTwoPlayersIn(page, browser, true);

  // The script ran: it is what reveals the columns. Asserted before the drag,
  // so a block that never executed fails here with its own cause rather than
  // as a mysteriously ineffective drag.
  await expect(page.locator("#team-columns")).toBeVisible();
  await expect(sideRadio(page, JOINER_NAME, "Team A")).not.toBeChecked();

  await pickerRow(page, JOINER_NAME).dragTo(page.locator('ul[data-team="a"]'));
  await expect(sideRadio(page, JOINER_NAME, "Team A")).toBeChecked();

  await pickerRow(page, GUEST_NAME).dragTo(page.locator('ul[data-team="b"]'));
  await expect(sideRadio(page, GUEST_NAME, "Team B")).toBeChecked();

  // Secondary, and only ever secondary: the row is where it was dropped. The
  // radio assertions above are the load-bearing ones — this only catches a
  // script that set the form and left the name behind.
  await expect(page.locator('ul[data-team="a"] li[data-player]')).toHaveCount(1);
  await expect(page.locator('ul[data-team="b"] li[data-player]')).toHaveCount(1);

  // The head counts followed. They are rendered from the server's count and
  // then maintained by the script, so a block that moved names and left the
  // numbers at 0 would tell an organiser their sides were empty while they
  // looked at two full columns.
  await expect(page.locator('[data-count="a"]')).toHaveText("1");
  await expect(page.locator('[data-count="b"]')).toHaveText("1");

  // The same Save button, the same form, the same POST as the journey above:
  // nothing about the drag changes what is submitted or how.
  await page.getByRole("button", { name: "Save teams" }).click();
  await page.waitForURL(new RegExp(`${fixturePath}$`));

  // What was stored, read back off the re-rendered page. This is where the
  // two journeys meet: the same two assertions hold after either one.
  await expect(sideRadio(page, JOINER_NAME, "Team A")).toBeChecked();
  await expect(sideRadio(page, GUEST_NAME, "Team B")).toBeChecked();

  // And the reloaded page sorts the stored pick back into the columns. The
  // server renders every row in the flat pool with its radios checked, so
  // without that pass an organiser would come back to a finished pick sitting
  // under two empty sides.
  await expect(page.locator('ul[data-team="a"] li[data-player]')).toContainText(JOINER_NAME);
  await expect(page.locator('ul[data-team="b"] li[data-player]')).toContainText(GUEST_NAME);

  // The CSP gate matters more here than anywhere else in this file: this is
  // the first script this project has put on an owner page, and a hash that
  // did not cover it would leave the block silently unexecuted — the failure
  // class `docs/known-issues.md` records for `connect-src`.
  expect(await seen.violations()).toEqual([]);
  expect(seen.errors()).toEqual([]);
});

/**
 * Picking with the keyboard, with the script running.
 *
 * This exists because the enhancement can only ever be an enhancement. Moving
 * a row means detaching it, and detaching blurs the radio inside it — so
 * before `place` carried focus across the move, Space checked a radio and
 * then threw the keyboard user out of the group entirely, leaving them worse
 * off than if the script had never loaded. On a project whose no-JavaScript
 * path is a first-class path, that is the one outcome the script must not
 * produce, and it is invisible to every other test here: the radios end up
 * correct either way.
 *
 * Arrow traversal is the assertion that really pins it. One `ArrowRight` is
 * the second interaction in a row, so it can only pass if the first left
 * focus where a keyboard user could keep working from.
 */
test("picking with the keyboard keeps focus in the radio group as the row moves", async ({ page, browser }) => {
  const seen = observe(page);
  const { fixturePath } = await seedTwoPlayersIn(page, browser, true);
  await expect(page.locator("#team-columns")).toBeVisible();

  // --- Space, on a focused radio -----------------------------------------
  const onA = sideRadio(page, JOINER_NAME, "Team A");
  await onA.focus();
  await page.keyboard.press("Space");

  await expect(onA).toBeChecked();
  await expect(page.locator('ul[data-team="a"] li[data-player]')).toContainText(JOINER_NAME);
  await expect(onA, "the row moved and took the focused radio with it").toBeFocused();

  // --- and the group is still arrowable ----------------------------------
  await page.keyboard.press("ArrowRight");

  const onB = sideRadio(page, JOINER_NAME, "Team B");
  await expect(onB).toBeChecked();
  await expect(onA).not.toBeChecked();
  await expect(onB, "arrowing again must still be possible").toBeFocused();
  // The columns followed the radios rather than contradicting them.
  await expect(page.locator('ul[data-team="a"] li[data-player]')).toHaveCount(0);
  await expect(page.locator('ul[data-team="b"] li[data-player]')).toContainText(JOINER_NAME);
  await expect(page.locator('[data-count="a"]')).toHaveText("0");
  await expect(page.locator('[data-count="b"]')).toHaveText("1");

  // A keyboard pick posts through the same form as every other pick.
  await page.getByRole("button", { name: "Save teams" }).click();
  await page.waitForURL(new RegExp(`${fixturePath}$`));
  await expect(sideRadio(page, JOINER_NAME, "Team B")).toBeChecked();

  expect(await seen.violations()).toEqual([]);
  expect(seen.errors()).toEqual([]);
});

/**
 * Dragging a name back off a side.
 *
 * The pool is the third drop target, carrying `data-team=""` — the same value
 * as the "Not picked yet" radio — so undoing a placement is a gesture and not
 * only a radio click. Worth its own test because the pool is the one drop
 * target that can be *empty*, and an empty list with no height is a target
 * nobody can hit: this fails if `.team-drop` is ever taken off it.
 */
test("dragging a name back to the unpicked list clears the side it had", async ({ page, browser }) => {
  const seen = observe(page);
  const { fixturePath } = await seedTwoPlayersIn(page, browser, true);
  await expect(page.locator("#team-columns")).toBeVisible();

  // Both names onto sides first, which is what empties the pool.
  await pickerRow(page, JOINER_NAME).dragTo(page.locator('ul[data-team="a"]'));
  await pickerRow(page, GUEST_NAME).dragTo(page.locator('ul[data-team="b"]'));
  await expect(page.locator("#team-pool li[data-player]")).toHaveCount(0);

  await pickerRow(page, JOINER_NAME).dragTo(page.locator("#team-pool"));

  await expect(sideRadio(page, JOINER_NAME, "Not picked yet")).toBeChecked();
  await expect(sideRadio(page, JOINER_NAME, "Team A")).not.toBeChecked();
  await expect(page.locator('[data-count="a"]')).toHaveText("0");
  await expect(page.locator('[data-count="b"]')).toHaveText("1");

  // And the clearing is what gets stored — the save posts `""` for that
  // player, which the route reads as "clear this player's side".
  await page.getByRole("button", { name: "Save teams" }).click();
  await page.waitForURL(new RegExp(`${fixturePath}$`));
  await expect(sideRadio(page, JOINER_NAME, "Not picked yet")).toBeChecked();
  await expect(sideRadio(page, GUEST_NAME, "Team B")).toBeChecked();

  expect(await seen.violations()).toEqual([]);
  expect(seen.errors()).toEqual([]);
});

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
