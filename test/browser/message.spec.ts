import { mkdirSync, statSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { fixtureMessagePath } from "../../src/auth/paths.js";
import { FIXTURE_AUDIENCES } from "../../src/domain/broadcast-audience.js";
import { signIn, TEST_OWNER } from "./sign-in.js";
import { seedWorld, type World } from "./world.js";

/**
 * M15's fixture-scoped quick-message compose page (task 12, spec-referenced
 * milestone workflow rule 3): the one check a string assertion cannot make.
 * `test/views/broadcast.test.ts` already proves the markup — four radios,
 * two checkboxes, a textarea, the right `action` — string-exact; what it
 * cannot see is whether `FORM_CSS`'s `textarea` rule actually reaches this
 * page's `<textarea>`, whether the two checkboxes render as anything but an
 * invisible 13px box against their track, or whether the audience radios and
 * the submit button's count still line up once a real browser lays them out.
 * That is what the screenshot captured below is for.
 *
 * This file does not repeat what `catalogue.spec.ts`'s console/CSP gate
 * already covers for `game-message` and `fixture-message` (both added to
 * `CATALOGUE` alongside this spec, since neither route had an entry yet and
 * `catalogue.spec.ts`'s completeness check fails on any registered GET route
 * that isn't catalogued or explicitly excluded) — this file is for what that
 * sweep cannot see: the operable state of the specific controls named in the
 * task 12 brief, and a look at the rendered page.
 */

const OUTPUT = "test/browser/screenshots";

let world: World;

test.beforeAll(async ({ browser }) => {
  mkdirSync(OUTPUT, { recursive: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  world = await seedWorld(page, browser);
  await context.close();
});

test("the four audience radios and both channel checkboxes are present and operable", async ({
  page,
}) => {
  await signIn(page, TEST_OWNER);
  await page.goto(fixtureMessagePath(world.gameId, world.fixtureId));

  // One radio per `FIXTURE_AUDIENCES` entry, id'd `audience-${audience}` by
  // `audienceFields` in `src/views/broadcast.ts` — reading the id off the
  // domain list itself rather than a hand-typed one keeps this from silently
  // going stale if a fifth audience is ever added.
  for (const audience of FIXTURE_AUDIENCES) {
    const radio = page.locator(`#audience-${audience}`);
    await expect(radio).toBeVisible();
    await expect(radio).toBeEnabled();
  }

  // `DEFAULT_FIXTURE_AUDIENCE` ("playing") is checked on a fresh GET.
  await expect(page.locator("#audience-playing")).toBeChecked();

  // "Operable": clicking a second radio actually moves the checked state,
  // not just that the element exists in the DOM (a `display: none` radio
  // still has a DOM node and still answers `toBeVisible()` false, but an
  // un-styled or overlapping one could still pass a bare existence check).
  await page.locator("#audience-waitlisted").check();
  await expect(page.locator("#audience-waitlisted")).toBeChecked();
  await expect(page.locator("#audience-playing")).not.toBeChecked();

  const email = page.locator("#email");
  const push = page.locator("#push");
  await expect(email).toBeVisible();
  await expect(push).toBeVisible();

  // Both channels default on (`emptyValues` in `src/routes/broadcast.ts`).
  await expect(email).toBeChecked();
  await expect(push).toBeChecked();

  // Operable in the other direction: unchecking each actually clears it.
  await email.uncheck();
  await expect(email).not.toBeChecked();
  await push.uncheck();
  await expect(push).not.toBeChecked();
});

test("the compose page, captured at phone and desktop width", async ({ page }) => {
  await signIn(page, TEST_OWNER);

  // Phone first, desktop second, each its own navigation: `capture.spec.ts`
  // sets the viewport before `goto` for the same reason — a resize after
  // load does not reliably re-run every layout-dependent computed style.
  const widths = [
    { label: "phone", width: 390, height: 844 },
    { label: "desktop", width: 1280, height: 900 },
  ];

  for (const size of widths) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(fixtureMessagePath(world.gameId, world.fixtureId), {
      waitUntil: "networkidle",
    });

    const file = `${OUTPUT}/fixture-message--${size.label}.png`;
    await page.screenshot({ path: file, fullPage: true });

    // Not a claim the page looks right — only that a capture happened at
    // all, so a silently empty run does not read as a successful one.
    expect(statSync(file).size, `${file} is empty`).toBeGreaterThan(1000);
  }
});
