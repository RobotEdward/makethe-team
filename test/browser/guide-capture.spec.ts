import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  buildGuideWorld,
  GUIDE_GAME_NAME,
  GUIDE_ORGANISER,
  type GuideWorld,
} from "./guide-world.js";
import { SHOTS } from "./guide-shots.js";
import { signIn } from "./sign-in.js";

/**
 * Captures the guide's screenshots and writes `docs/guide/manifest.json`.
 *
 * It writes images and the manifest and *nothing else*. The chapters are
 * prose, committed, and edited by hand — if this run could rewrite them, every
 * regeneration would overwrite the writing and the guide could never get
 * better than whatever the last run produced.
 *
 * Tagged `@guide`, so it is excluded from the default browser run and from CI.
 */

const IMAGES = "docs/guide/images";
const MANIFEST = "docs/guide/manifest.json";

test("@guide capture every screen the guide shows", async ({ page, browser }) => {
  test.setTimeout(300_000);
  mkdirSync(IMAGES, { recursive: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const world: GuideWorld = await buildGuideWorld(page, browser);

  const entries: Record<string, unknown>[] = [];
  const written: string[] = [];

  // buildGuideWorld leaves the page signed in as the organiser. `GET /sign-in`
  // bounces an already-signed-in visitor straight to the dashboard (see
  // `src/routes/signin.ts`), so calling `signIn` again while that session is
  // still live never reaches the email field and hangs. Only act when the
  // shot's persona actually differs from the page's current one: sign in once
  // when moving to an organiser shot, and drop the session cookie when moving
  // to an anonymous one so it renders as a real visitor would see it.
  let signedIn = true;

  for (const shot of SHOTS) {
    if (shot.persona === "organiser") {
      if (!signedIn) {
        await signIn(page, GUIDE_ORGANISER);
        signedIn = true;
      }
    } else if (signedIn) {
      await page.context().clearCookies();
      signedIn = false;
    }

    const response = await page.goto(shot.path(world), { waitUntil: "networkidle" });
    expect(response?.status(), `${shot.id} did not render`).toBe(200);
    // A page that has changed shape must fail the run rather than quietly
    // producing a photograph of an error page and shipping it in a public doc.
    await expect(page.locator("h1").first()).toBeVisible();

    // Element-scoped where the shot asks for it: three shots point at the same
    // page as `game-overview`, and photographing the whole page for each would
    // write byte-identical PNGs under different names.
    //
    // Element shots scope vertically to the element and horizontally to the
    // whole viewport. Clipping to the element's own box slices controls that
    // sit flush against its right edge — the Remove link in every squad row
    // came out cut in half — and a guide must never show a truncated control.
    // `/app` lists every fixture this organiser has, across every game they
    // have ever run, nearest first — and `buildGuideWorld` mints a new game on
    // each capture without retiring the last. `nth=0` therefore picks the
    // world just built only when the database was wiped first; otherwise the
    // dashboard ships a card from some earlier game while every other shot
    // shows this one. Assert the card is this game's before photographing it,
    // so that mismatch fails the run instead of shipping.
    if (shot.id === "dashboard") {
      await expect(page.locator(shot.element!)).toContainText(GUIDE_GAME_NAME);
    }

    let shotBuffer: Buffer;
    if (shot.element) {
      const box = await page.locator(shot.element).boundingBox();
      if (!box) throw new Error(`${shot.id}: element ${shot.element} has no box`);
      const viewport = page.viewportSize();
      shotBuffer = await page.screenshot({
        fullPage: true,
        clip: { x: 0, y: box.y, width: viewport?.width ?? 390, height: box.height },
      });
    } else {
      shotBuffer = await page.screenshot({ fullPage: true });
    }

    const file = `${IMAGES}/${shot.id}.png`;
    const staging = `${IMAGES}/.${shot.id}.staging.png`;
    writeFileSync(staging, shotBuffer);
    let optimised: Buffer;
    try {
      execFileSync("python3", ["scripts/optimise-png.py", staging], { stdio: "inherit" });
      optimised = readFileSync(staging);
    } finally {
      // Whatever happens above — a missing Pillow, a corrupt image, a full
      // disk — this staging file must not survive. `git add docs/guide/images`
      // does not skip dotfiles, so a leftover `.staging.png` would otherwise
      // become a raw, unoptimised screenshot silently committed to a public
      // repository under a name nobody would notice. `force: true` so the
      // cleanup itself cannot throw when the file was never written.
      rmSync(staging, { force: true });
    }

    const digest = (bytes: Buffer): string =>
      createHash("sha256").update(bytes).digest("hex");

    if (!existsSync(file) || digest(readFileSync(file)) !== digest(optimised)) {
      writeFileSync(file, optimised);
      written.push(file);
    }

    entries.push({
      id: shot.id,
      chapter: shot.chapter,
      title: shot.title,
      route: shot.route,
      image: `images/${shot.id}.png`,
      shows: shot.shows,
    });
  }

  // No timestamp in the manifest: a captured-at field would churn the file on
  // every run for no reader's benefit.
  writeFileSync(MANIFEST, `${JSON.stringify({ shots: entries }, null, 2)}\n`);
  console.log(`captured ${SHOTS.length} shots, ${written.length} changed`);
});
