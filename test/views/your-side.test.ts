import { describe, expect, it } from "vitest";
import * as STYLE_MODULE from "../../src/views/styles.js";

/**
 * "You're on Reds." — the one line BR-35 §5 says a player must not be able to
 * miss — and the block that makes it look like one.
 *
 * It shipped missing. `.your-side` was declared in `TEAM_PICKER_CSS`, which is
 * the picker's block; the player's own fixture page (M25) renders the sentence
 * and deliberately does not load that block, so from M25 until M56 the line
 * rendered there as an ordinary paragraph in body text — the same size and
 * colour as the address above it. Every string assertion passed, because an
 * unstyled class is invisible to all of them, and the page's own comment
 * records the decision not to load the block without noticing what it cost.
 *
 * So this is the class guard: any page that can render the sentence must load
 * a block that declares the rule. Whichever block that is — the assertion is
 * about the pairing, not about where the rule lives.
 */

/** Every `_CSS` export declaring a `.your-side` rule. */
function blocksDeclaringYourSide(): string[] {
  return Object.entries(STYLE_MODULE as unknown as Record<string, unknown>)
    .filter(([name, css]) => {
      if (typeof css !== "string" || !name.endsWith("_CSS")) return false;
      // Comments stripped first: this rule's own comment names the class, and
      // prose about a selector is not a declaration of it.
      return /\.your-side\s*\{/.test(css.replace(/\/\*[\s\S]*?\*\//g, ""));
    })
    .map(([name]) => name);
}

function sources(): Record<string, string> {
  return import.meta.glob("../../src/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
}

/** Comments and imports dropped, so neither can look like a call. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/^import[\s\S]*?from "[^"]*";$/gm, "");
}

/**
 * Modules that render the sentence — either by calling the helper directly, or
 * by calling the section that does — paired with the blocks their `pageStyles`
 * list. A module with no `pageStyles` array of its own renders into somebody
 * else's page and is not a page; `renderPublishedTeamsSection`'s own module is
 * the one that both defines and uses, which the `export function` exclusion
 * keeps from counting as a call.
 */
function pagesRenderingYourSide(): { path: string; blocks: string[] }[] {
  const pages: { path: string; blocks: string[] }[] = [];
  for (const [rawPath, source] of Object.entries(sources()).sort(([a], [b]) => a.localeCompare(b))) {
    const text = code(source);
    const calls = [...text.matchAll(/(export function\s+)?\b(yourSideLine|renderPublishedTeamsSection)\s*\(/g)];
    if (!calls.some((match) => match[1] === undefined)) continue;
    for (const array of text.matchAll(/pageStyles:\s*\[([^\]]*)\]/g)) {
      pages.push({
        path: rawPath.replace(/^(\.\.\/)+/, ""),
        blocks: (array[1] ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== ""),
      });
    }
  }
  return pages;
}

describe("the your-side line", () => {
  it("is declared by exactly one block", () => {
    // Two blocks declaring it is how the pages drift: one page's copy gets
    // tuned and the others silently keep the old treatment.
    expect(blocksDeclaringYourSide()).toEqual(["FIXTURE_STYLES_CSS"]);
  });

  it("is rendered by pages that load a block declaring it", () => {
    const declaring = blocksDeclaringYourSide();
    const pages = pagesRenderingYourSide();

    // The presence half: an empty list would pass the check below vacuously,
    // which is exactly the shape of the failure this file exists for.
    expect(pages.map((page) => page.path)).toEqual([
      "src/views/dashboard.ts",
      "src/views/fixture.ts",
      "src/views/player-fixture.ts",
      "src/views/player-game.ts",
    ]);

    for (const page of pages) {
      expect(
        page.blocks.some((block) => declaring.includes(block)),
        `${page.path} renders "You're on …" but loads none of ${declaring.join(", ")}, ` +
          `so the line renders as body text. Its pageStyles: ${page.blocks.join(", ")}.`,
      ).toBe(true);
    }
  });
});
