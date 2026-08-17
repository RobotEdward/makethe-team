import { describe, expect, it } from "vitest";
import { ICON_SVG } from "../../src/views/icon.js";
import { APPLE_TOUCH_ICON_PNG, ICON_192_PNG, ICON_512_PNG } from "../../src/views/icon-bytes.js";

/**
 * The mark (spec §5). These assertions are about the two properties that make
 * it work as an *icon*, not about taste: it is full-bleed, so an Android
 * launcher can crop it to any shape; and every dot sits inside the maskable
 * safe zone, so that crop never takes a bite out of the tick.
 */
describe("the app icon", () => {
  it("is full bleed, so a maskable crop always lands on the accent colour", () => {
    expect(ICON_SVG).toContain('viewBox="0 0 512 512"');
    expect(ICON_SVG).toContain('<rect width="512" height="512" fill="#1f6f4a"/>');
  });

  it("keeps every dot inside the maskable safe zone", () => {
    // Android crops maskable icons to whatever shape it likes; only the
    // centre circle of radius 40% (204.8 of 512) is guaranteed to survive.
    // A dot whose *edge* crosses that line gets clipped on some launchers
    // and not others, which is the worst way to find out.
    const dots = [...ICON_SVG.matchAll(/<circle cx="(\d+)" cy="(\d+)" r="(\d+)"/g)].map((m) => ({
      cx: Number(m[1]),
      cy: Number(m[2]),
      r: Number(m[3]),
    }));

    expect(dots).toHaveLength(5);
    for (const dot of dots) {
      const distance = Math.hypot(dot.cx - 256, dot.cy - 256);
      expect(distance + dot.r, `dot at ${dot.cx},${dot.cy} escapes the safe zone`).toBeLessThan(204.8);
    }
  });

  it("has one hollow dot — four in, one spot left", () => {
    // The whole idea of the mark. A later "tidy-up" that fills this dot in
    // turns a squad with a place going spare into five identical dots.
    expect(ICON_SVG).toContain('fill="none" stroke="#fbfaf8"');
  });

  it("ships the three raster sizes the platforms actually read", () => {
    // Android reads the manifest's 192 and 512; iOS ignores the manifest
    // entirely and reads only <link rel="apple-touch-icon">.
    for (const [name, bytes] of [
      ["icon-192", ICON_192_PNG],
      ["icon-512", ICON_512_PNG],
      ["apple-touch-icon", APPLE_TOUCH_ICON_PNG],
    ] as const) {
      expect(bytes.length, `${name} is empty`).toBeGreaterThan(100);
      // PNG magic number. Proves the build script produced an image and not,
      // say, an error message that got base64'd by accident.
      expect([...bytes.slice(0, 4)], `${name} is not a PNG`).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
  });
});
