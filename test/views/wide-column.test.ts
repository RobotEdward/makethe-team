import { describe, expect, it } from "vitest";
import * as STYLE_MODULE from "../../src/views/styles.js";
import { PAGE_STYLE_BLOCKS, WIDE_COLUMN_CSS } from "../../src/views/styles.js";

/**
 * `WIDE_COLUMN_CSS` widens `main` above 64rem, and it does it by overriding a
 * declaration another block on the same page already made.
 *
 * `test/views/style-cascade.test.ts` cannot guard this pair. It keys a
 * media-scoped rule with its prelude on purpose — otherwise every breakpoint
 * in the codebase would report as a collision — so
 * `@media (min-width: 64rem) main` and `FORM_CSS`'s bare `main` are two
 * different selectors to it, and the ordering that decides which one wins goes
 * unwatched. A rule inside a media query gets no specificity bonus: source
 * order is the entire mechanism, and `pageStyles` order is source order.
 *
 * So this file is that block's own guard, in the shape CLAUDE.md asks for when
 * two blocks style one element through different selectors.
 */

/** The blocks that declare a bare, unconditioned `main { … }` rule. */
function blocksDeclaringMain(): string[] {
  return Object.entries(STYLE_MODULE as unknown as Record<string, unknown>)
    .filter(([name, css]) => {
      if (typeof css !== "string" || !name.endsWith("_CSS")) return false;
      // Comments stripped first, so `main` discussed in prose is not read as a
      // declaration; at-rules dropped, because a media-scoped `main` is the
      // override, not the thing being overridden.
      const source = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{[\s\S]*?\n\s*\}/g, "");
      return /(^|[;}])\s*main\s*\{/.test(source);
    })
    .map(([name]) => name);
}

/** Every `pageStyles: [...]` array in the source tree, in cascade order. */
function styleArrays(): { id: string; blocks: string[] }[] {
  const sources = import.meta.glob("../../src/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  const arrays: { id: string; blocks: string[] }[] = [];
  for (const [rawPath, source] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))) {
    const path = rawPath.replace(/^(\.\.\/)+/, "");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    let index = 0;
    for (const match of code.matchAll(/pageStyles:\s*\[([^\]]*)\]/g)) {
      arrays.push({
        id: `${path}#${index}`,
        blocks: (match[1] ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== ""),
      });
      index += 1;
    }
  }
  return arrays;
}

/** The pages meant to carry the wider column, and why each one needs it. */
const WIDE_PAGES: Record<string, string> = {
  "src/views/picker-page.ts#0":
    "Two drop columns side by side. At 40rem each side holds about 18rem, " +
    "which is a full name and a drag handle with nothing to spare.",
  "src/views/owner-fixture.ts#0":
    "The longest page in the product — 3954px at 390px wide — and most of " +
    "that length is a squad list running one name per row.",
};

describe("the wide column", () => {
  /**
   * `src/security/csp.ts` hashes exactly `PAGE_STYLE_BLOCKS` for `style-src`.
   * A block outside it is dropped by the browser with every test still green
   * — the classic failure this codebase makes silently.
   */
  it("is registered for the Content-Security-Policy", () => {
    expect(PAGE_STYLE_BLOCKS).toContain(WIDE_COLUMN_CSS);
  });

  it("widens main only above the laptop breakpoint", () => {
    expect(WIDE_COLUMN_CSS).toMatch(/@media \(min-width: 64rem\)/);
    expect(WIDE_COLUMN_CSS).toMatch(/main \{ max-width: 52rem; \}/);
  });

  /**
   * The header and the column have to move together, or the page name sits
   * inset from the content it heads by the difference between the two widths.
   */
  it("takes the header with it, to the same width", () => {
    const widths = [...WIDE_COLUMN_CSS.matchAll(/max-width:\s*([\d.]+rem)/g)].map((m) => m[1]);

    expect(widths.length).toBe(2);
    expect(new Set(widths).size).toBe(1);
    expect(WIDE_COLUMN_CSS).toContain(".site-header");
  });

  /**
   * The presence half of the pair. Without it the ordering assertion below
   * passes vacuously the moment the block stops being listed anywhere —
   * `indexOf` returns -1, and -1 is less than everything.
   */
  it("is carried by exactly the pages that need it", () => {
    const carrying = styleArrays()
      .filter(({ blocks }) => blocks.includes("WIDE_COLUMN_CSS"))
      .map(({ id }) => id);

    expect(carrying.sort()).toEqual(Object.keys(WIDE_PAGES).sort());
  });

  it.each(Object.entries(WIDE_PAGES))("%s puts it after every block that sets main — %s", (id) => {
    const page = styleArrays().find((array) => array.id === id);
    expect(page, `no pageStyles array found for ${id}`).toBeDefined();

    const mine = page!.blocks.indexOf("WIDE_COLUMN_CSS");
    expect(mine).toBeGreaterThan(-1);

    const overridden = page!.blocks.filter((block) => blocksDeclaringMain().includes(block));
    // Not a vacuous list: the pages that need widening are precisely the ones
    // already widened to 40rem by another block, so there is always at least
    // one declaration here for this block to beat.
    expect(overridden.length).toBeGreaterThan(0);

    for (const block of overridden) {
      expect(
        page!.blocks.indexOf(block),
        `${id} lists ${block} after WIDE_COLUMN_CSS, so its unconditioned ` +
          `main rule wins at every width and the page never widens.`,
      ).toBeLessThan(mine);
    }
  });
});
