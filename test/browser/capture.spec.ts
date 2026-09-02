import { mkdirSync, statSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CATALOGUE } from "./catalogue.js";
import { signIn, TEST_OWNER, TEST_PLAYER } from "./sign-in.js";
import { seedWorld, type World } from "./world.js";

/**
 * Tier 4: a screenshot of every catalogue page at phone and desktop width.
 *
 * A judgement aid, not an assertion — there is deliberately no pixel diffing
 * (spec §11). It exists so a layout can be *looked at*: J6a's squad row packs
 * a name, a role form and a remove link into one list item and has never been
 * seen rendered at 390px.
 *
 * Tagged `@capture` and skipped by default, because it is slow and produces
 * nothing CI can act on. Run it deliberately:
 *
 *     CAPTURE=1 npx playwright test --grep @capture
 *
 * `CAPTURE=1` is not optional and the `--grep` alone does nothing: the tag is
 * excluded by `grepInvert` in `playwright.config.ts`, which that variable is
 * what switches off. Without it the run ends "No tests found".
 *
 * Output lands in `test/browser/screenshots/` (gitignored).
 */

const WIDTHS = [
  { label: "phone", width: 390, height: 844 },
  { label: "desktop", width: 1280, height: 900 },
];

const OUTPUT = "test/browser/screenshots";

let world: World;

test.beforeAll(async ({ browser }) => {
  mkdirSync(OUTPUT, { recursive: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  world = await seedWorld(page, browser);
  await context.close();
});

for (const entry of CATALOGUE) {
  for (const size of WIDTHS) {
    test(`@capture ${entry.id} at ${size.label}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      // `player` gets the joined member's own identity — see the same branch
      // in `console-gate.spec.ts` for why.
      if (entry.persona === "player") await signIn(page, TEST_PLAYER);
      else if (entry.persona !== "anonymous") await signIn(page, TEST_OWNER);
      await page.goto(entry.path(world), { waitUntil: "networkidle" });

      const file = `${OUTPUT}/${entry.id}--${size.label}.png`;
      await page.screenshot({ path: file, fullPage: true });

      // The only assertion worth making here: something was actually written.
      // A capture run that silently produced nothing would otherwise look
      // exactly like a successful one.
      expect(statSync(file).size, `${file} is empty`).toBeGreaterThan(1000);
    });
  }
}
