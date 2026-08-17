import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  APPLE_TOUCH_ICON_PATH,
  ICON_192_PATH,
  ICON_512_PATH,
  MANIFEST_PATH,
} from "../../src/auth/paths.js";
import { THEME_COLOR } from "../../src/views/layout.js";

const url = (path: string) => `https://makethe.team${path}`;

describe("the web app manifest", () => {
  it("is served to anyone, with the content type browsers require", async () => {
    // A manifest behind a session is a manifest no first-time visitor can
    // install from — and the browser fetches it before any sign-in exists.
    const response = await SELF.fetch(url(MANIFEST_PATH));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
  });

  it("declares the fields that make an app installable", async () => {
    // Chrome refuses to treat the app as installable if any of these is
    // missing, and says so only in a devtools panel nobody is looking at.
    const manifest = (await (await SELF.fetch(url(MANIFEST_PATH))).json()) as Record<string, unknown>;

    expect(manifest.name).toBe("Make The Team");
    expect(manifest.short_name).toBe("Make The Team");
    expect(manifest.start_url).toBe("/app");
    expect(manifest.display).toBe("standalone");
    expect(manifest.background_color).toBe("#fbfaf8");
    // THEME_COLOR, not a second pasted literal — see that constant's own
    // comment in src/views/layout.ts for why a mismatch between this and the
    // page's <meta name="theme-color"> is the exact failure it exists to
    // rule out. test/views/layout.test.ts asserts the other half.
    expect(manifest.theme_color).toBe(THEME_COLOR);
  });

  it("offers both icon sizes as maskable", async () => {
    // "maskable any" and not "any" alone: without the maskable purpose,
    // Android draws the icon shrunken inside a white circle.
    const manifest = (await (await SELF.fetch(url(MANIFEST_PATH))).json()) as {
      icons: { src: string; sizes: string; type: string; purpose: string }[];
    };

    expect(manifest.icons).toEqual([
      { src: ICON_192_PATH, sizes: "192x192", type: "image/png", purpose: "maskable any" },
      { src: ICON_512_PATH, sizes: "512x512", type: "image/png", purpose: "maskable any" },
    ]);
  });
});

describe("the icons", () => {
  it("serves each size as a cacheable PNG", async () => {
    for (const path of [ICON_192_PATH, ICON_512_PATH, APPLE_TOUCH_ICON_PATH]) {
      const response = await SELF.fetch(url(path));

      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toBe("image/png");
      // These bytes change only when the mark does, and the mark is in the
      // repo. A year is not too long; a re-deploy changes the URL only if we
      // rename the file, which is the moment to think about it.
      expect(response.headers.get("cache-control"), path).toContain("max-age=31536000");
      expect((await response.arrayBuffer()).byteLength, path).toBeGreaterThan(100);
    }
  });
});
