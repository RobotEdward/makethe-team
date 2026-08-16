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
    const buttonBox = (await row.locator("button").boundingBox())!;

    // Offsets relative to the row, rounded: the same arrangement expressed
    // independently of where the row sits on the page.
    shapes.push(
      JSON.stringify({
        nameX: Math.round(nameBox.x - rowBox.x),
        nameY: Math.round(nameBox.y - rowBox.y),
        buttonX: Math.round(buttonBox.x - rowBox.x),
        buttonY: Math.round(buttonBox.y - rowBox.y),
      }),
    );
  }

  expect(
    new Set(shapes).size,
    `squad rows are laid out differently from one another: ${shapes.join(" vs ")}`,
  ).toBe(1);
});

test("the member's name sits on its own line at phone width", async ({ page, browser }) => {
  // The complement to the test above: identical-but-wrong would also pass a
  // sameness check. This pins which shape it is.
  await page.setViewportSize({ width: 390, height: 844 });
  const world = await seedWorld(page, browser);
  await page.goto(`/g/${world.gameId}`);

  const row = page.locator("ul.squad li:has(.member)").first();
  const nameBox = (await row.locator(".member").boundingBox())!;
  const buttonBox = (await row.locator("button").boundingBox())!;

  expect(
    buttonBox.y,
    "at 390px the control must sit below the name, not beside it",
  ).toBeGreaterThanOrEqual(nameBox.y + nameBox.height);
});

test("a squad row is one line at desktop width", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const world = await seedWorld(page, browser);
  await page.goto(`/g/${world.gameId}`);

  const row = page.locator("ul.squad li:has(.member)").first();
  const nameBox = (await row.locator(".member").boundingBox())!;
  const buttonBox = (await row.locator("button").boundingBox())!;

  // Vertically overlapping means they share a line — the stacked phone layout
  // must not leak upwards into the roomy case.
  expect(buttonBox.y).toBeLessThan(nameBox.y + nameBox.height);
});
