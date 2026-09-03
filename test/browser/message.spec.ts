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
  // One radio per `FIXTURE_AUDIENCES` entry, id'd `audience-${audience}` by
  // `audienceFields` in `src/views/broadcast.ts` — reading the id off the
  // domain list itself rather than a hand-typed one keeps this from silently
  // going stale if a fifth audience is ever added.
  //
  // Since M52 an audience nobody is in is rendered `disabled`, so "operable"
  // is asserted against the counts the page itself prints rather than against
  // all four unconditionally: an empty audience that stayed clickable would be
  // a control whose only outcome is the server's 422. The counts are read off
  // the labels so this holds whatever shape the seeded world happens to have.
  const countOf = async (audience: string): Promise<number> => {
    const label = page.locator(`label[for="audience-${audience}"]`);
    const text = (await label.textContent()) ?? "";
    return Number(/\((\d+)\)\s*$/.exec(text.trim())?.[1] ?? "0");
  };

  const populated: string[] = [];
  for (const audience of FIXTURE_AUDIENCES) {
    const radio = page.locator(`#audience-${audience}`);
    await expect(radio).toBeVisible();

    if ((await countOf(audience)) > 0) {
      await expect(radio).toBeEnabled();
      populated.push(audience);
    }
  }

  // The page opens on an audience it can actually send to. With nobody
  // anywhere it falls back to `DEFAULT_FIXTURE_AUDIENCE`, which is why this
  // asserts the checked radio is enabled rather than naming one.
  const checked = page.locator('input[name="audience"]:checked');
  await expect(checked).toHaveCount(1);
  await expect(checked).toBeEnabled();

  // An empty audience is offered as unavailable rather than as a choice that
  // fails on submit — except when it is the checked one, because a disabled
  // checked radio is a form whose selected value cannot be submitted and
  // browsers disagree about what they then send.
  for (const audience of FIXTURE_AUDIENCES) {
    if ((await countOf(audience)) > 0) continue;
    const radio = page.locator(`#audience-${audience}`);
    if (await radio.isChecked()) continue;
    await expect(radio).toBeDisabled();
  }

  // "Operable": checking another radio actually moves the checked state, not
  // merely that the element exists in the DOM (an unstyled or overlapping
  // radio could still pass a bare existence check).
  //
  // Conditional on the world, not skipped quietly: `seedWorld` currently
  // produces exactly one non-empty audience, so there is no second enabled
  // radio to move to. The count is asserted below either way, so this reads as
  // a fact about the world rather than as an assertion that vanished. It
  // becomes unconditional the moment the seed grows a second answered state.
  expect(populated.length, "no audience has anybody in it — the seed is wrong").toBeGreaterThan(0);

  const checkedId = await checked.getAttribute("id");
  // An ordinary loop, not `.find` with an async predicate: that predicate
  // returns a Promise, which is always truthy, so it would pick the first
  // element whatever the answer.
  let target: string | undefined;
  for (const audience of populated) {
    if (`audience-${audience}` !== checkedId) target = audience;
  }
  if (target !== undefined) {
    await page.locator(`#audience-${target}`).check();
    await expect(page.locator(`#audience-${target}`)).toBeChecked();
  }

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
