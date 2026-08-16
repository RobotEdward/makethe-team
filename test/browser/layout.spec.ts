import { expect, test } from "@playwright/test";
import { seedWorld } from "./world.js";

/**
 * A textual pin on `SQUAD_STYLES_CSS`'s selector (see
 * `test/views/fixture.test.ts`) can only prove today's selector text is
 * scoped; it says nothing about a future rule shaped differently — say
 * `.squad ul li { ... }` — that would still reach `div.squad > ul.chips >
 * li.chip` while passing every string assertion. Only a browser's own
 * cascade resolves that, so this belongs here rather than in the view test:
 * load the player's real response page and read the *computed* style off a
 * real chip, not its markup.
 */
test("a player's squad chip does not pick up the organiser row's layout", async ({ page, browser }) => {
  const world = await seedWorld(page, browser);
  await page.goto(`/r/${world.responseToken}`);

  const chip = page.locator("ul.chips li.chip").first();
  await expect(chip).toBeVisible();

  // Reached via `globalThis` because this project is typed against the
  // Workers runtime and has no DOM lib — see `console-gate.spec.ts`.
  const computed = await chip.evaluate((el) => {
    const { getComputedStyle } = globalThis as unknown as {
      getComputedStyle: (element: unknown) => { display: string; justifyContent: string; borderBottomWidth: string };
    };
    const style = getComputedStyle(el);
    return { display: style.display, justifyContent: style.justifyContent, borderBottomWidth: style.borderBottomWidth };
  });

  // `ul.squad > li`'s row rule sets `display: flex; justify-content:
  // space-between` and a bottom border on the organiser's rows. None of that
  // may land on a chip — if it did, the row's own child layout would apply to
  // whatever the chip contains and it would grow the row's divider.
  expect(computed.display).not.toBe("flex");
  expect(computed.justifyContent).not.toBe("space-between");
  expect(computed.borderBottomWidth).toBe("0px");
});

/**
 * Layout assertions — geometry, not pixels.
 *
 * This is a narrow tier and should stay narrow: it exists for the defects
 * that are invisible to a string assertion and real to a person holding a
 * phone. The visual capture (`@capture`) is for *looking*; this is for the
 * one property worth pinning so it cannot come back.
 *
 * The property: **every squad row has the same shape.** The rows used to
 * reflow against the length of the member's name, so a short name pulled its
 * button up onto the name's line while a longer one did not — two rows of
 * identical markup laid out differently. Found by the first capture run.
 */

// M10 §3.8 moved each row's controls behind a per-member `<details
// class="member-actions">`, closed by default. Closed, its `<button>` is not
// rendered (a browser gives hidden `<details>` content no box at all), so
// these three tests now read the row's shape off the always-visible
// `<summary>` rather than the button inside it.

test("every squad row has the same shape at phone width", async ({ page, browser }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const world = await seedWorld(page, browser);
  await page.goto(`/g/${world.gameId}`);

  // `:has(.member)` matters: the overview renders the fixtures list with the
  // same `squad` class, so a bare `ul.squad li` also matches "Coming up" rows,
  // which have no member markup at all.
  const rows = page.locator("ul.squad li:has(.member)");
  const count = await rows.count();
  expect(count, "need at least two members for this to mean anything").toBeGreaterThan(1);

  const shapes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const rowBox = (await row.boundingBox())!;
    const nameBox = (await row.locator(".member").boundingBox())!;
    const summaryBox = (await row.locator("summary").boundingBox())!;

    // Offsets relative to the row, rounded: the same arrangement expressed
    // independently of where the row sits on the page.
    shapes.push(
      JSON.stringify({
        nameX: Math.round(nameBox.x - rowBox.x),
        nameY: Math.round(nameBox.y - rowBox.y),
        summaryX: Math.round(summaryBox.x - rowBox.x),
        summaryY: Math.round(summaryBox.y - rowBox.y),
      }),
    );
  }

  expect(
    new Set(shapes).size,
    `squad rows are laid out differently from one another: ${shapes.join(" vs ")}`,
  ).toBe(1);
});

test("the name and the disclosure share a line at phone width", async ({ page, browser }) => {
  // Before M10 §3.8, this test pinned the opposite: at 390px the name and its
  // control could not share a line ("Make an ordinary member" is long), so
  // the name took a whole line to itself and the control sat below it. The
  // disclosure collapses both controls to the single word "Manage" behind a
  // `<summary>`, and a name plus "Manage" fits one line at 390px — so the
  // `@media (max-width: 30rem)` rule that forced the stack is gone, and this
  // test now pins the opposite shape: same line, not stacked.
  await page.setViewportSize({ width: 390, height: 844 });
  const world = await seedWorld(page, browser);
  await page.goto(`/g/${world.gameId}`);

  const row = page.locator("ul.squad li:has(.member)").first();
  const nameBox = (await row.locator(".member").boundingBox())!;
  const summaryBox = (await row.locator("summary").boundingBox())!;

  // Vertically overlapping means they share a line.
  expect(
    summaryBox.y,
    "at 390px the name and the disclosure must sit on the same line",
  ).toBeLessThan(nameBox.y + nameBox.height);
});

test("a squad row is one line at desktop width", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const world = await seedWorld(page, browser);
  await page.goto(`/g/${world.gameId}`);

  const row = page.locator("ul.squad li:has(.member)").first();
  const nameBox = (await row.locator(".member").boundingBox())!;
  const summaryBox = (await row.locator("summary").boundingBox())!;

  // Vertically overlapping means they share a line — the roomy case must be
  // at least as compact as the phone case now is.
  expect(summaryBox.y).toBeLessThan(nameBox.y + nameBox.height);
});
