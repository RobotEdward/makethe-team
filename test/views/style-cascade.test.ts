import { describe, expect, it } from "vitest";
import * as STYLE_MODULE from "../../src/views/styles.js";

/**
 * `layout()` emits `[STYLES, ...pageStyles]` as one `<style>` tag each, in
 * array order — so a page's `pageStyles` array *is* its cascade order, and at
 * equal specificity the block listed last wins.
 *
 * Nothing about a `pageStyles` array says that. It reads as a set of the
 * blocks a page needs; the ordering looks incidental, and reviewers reorder
 * it while tidying imports. `ul.squad > li` is declared by both
 * `SQUAD_STYLES_CSS` (flex) and `FORM_CSS` (grid) at identical specificity,
 * and the wrong order silently reverts a squad row to flex: the page still
 * renders, every fetch-level test still passes, and the only symptom is that
 * a row's shape starts depending on the length of the member's name — which
 * on the organiser's fixture page at 390px pushed content off-screen. That
 * bug was found and fixed four separate times, on four different pages, each
 * time by a human noticing rather than by a test, because the four ad-hoc
 * order-pinning tests that resulted each guard only their own page.
 *
 * The invariant is global, so this guard is global: every selector declared
 * by two or more of a page's blocks must be listed in INTENDED_WINNERS with
 * the block that is meant to win and why, and that block must actually be
 * last. An unlisted collision fails; a reorder fails.
 */

/** A page's `pageStyles` array, as written in source. */
interface StyleArray {
  /** `src/views/x.ts#0` — the index disambiguates a file with two call sites. */
  id: string;
  /** Block identifiers, in cascade order. */
  blocks: string[];
}

interface IntendedWinner {
  /** Matches `StyleArray.id`. */
  page: string;
  /** As produced by `selectorsOf` — media-scoped selectors carry their prelude. */
  selector: string;
  /** The block whose declaration must survive, i.e. the one listed last. */
  winner: string;
  /** Why that block, and not the other, is the one the page needs. */
  reason: string;
}

/**
 * Every collision that is deliberate layering, with the block that must win.
 *
 * Populated by running this test and reading what it reports. An entry here
 * is a decision, not a rubber stamp: the reason has to say what the losing
 * declaration would do to the page if it won.
 */
const INTENDED_WINNERS: IntendedWinner[] = [
  // Expanded over the page list rather than written out ten times: it is the
  // same two blocks meeting on the same two selectors, and ten copies of one
  // reason is ten places for them to drift apart. The pages are still named
  // one by one, so a sixth page pairing these blocks has to be added here.
  ...["game-overview", "join", "leave", "owner-fixture", "player-fixture", "player-game"].flatMap((page) => [
    {
      page: `src/views/${page}.ts#0`,
      selector: "ul.squad > li",
      winner: "FORM_CSS",
      reason:
        "FORM_CSS lays the row out as a grid with fixed columns; SQUAD_STYLES_CSS's " +
        "flex version makes a row's shape depend on the length of the member's name, " +
        "which at 390px pushed the organiser's fixture rows to 440px wide.",
    },
    {
      page: `src/views/${page}.ts#0`,
      selector: ".squad",
      winner: "FORM_CSS",
      reason:
        "Harmless overlap, listed rather than hidden: both set list-style and padding " +
        "to the same values, and FORM_CSS restates neither the margin, the text-align " +
        "nor the border-top, so SQUAD_STYLES_CSS's three survive in either order. " +
        "FORM_CSS's copy earns its place on the pages that carry it without " +
        "SQUAD_STYLES_CSS (remove-member, squad-member).",
    },
  ]),
];

/**
 * Every selector a block declares.
 *
 * These blocks are flat CSS in template literals — no nesting — so a
 * selector is the text before each `{`, comma-split into its individual
 * selectors. Comments are stripped first so a selector quoted in prose is
 * not mistaken for a declaration.
 *
 * Selectors inside an at-rule are keyed with their prelude
 * (`@media (max-width: 480px) ul.squad > li`), so a rule under a media query
 * only collides with a rule under the *same* query. A media-scoped rule can
 * of course also override an unconditioned one, but that is exactly what a
 * responsive override is *for* — treating it as a collision would report
 * every breakpoint in the codebase and drown the signal this test exists to
 * carry. `@keyframes` names are scoped the same way, so two blocks defining
 * the same animation name still collide, which is the case worth catching.
 */
function selectorsOf(css: string): Set<string> {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = new Set<string>();
  /** At-rule preludes currently open; `null` marks an open declaration block. */
  const open: (string | null)[] = [];
  let buffer = "";

  for (const character of source) {
    if (character === "{") {
      const prelude = buffer.trim().replace(/\s+/g, " ");
      buffer = "";
      if (prelude.startsWith("@")) {
        open.push(prelude);
        continue;
      }
      const scope = open.filter((entry) => entry !== null).join(" ");
      for (const selector of prelude.split(",")) {
        const trimmed = selector.trim().replace(/\s+/g, " ");
        if (trimmed !== "") selectors.add(scope === "" ? trimmed : `${scope} ${trimmed}`);
      }
      open.push(null);
    } else if (character === "}") {
      buffer = "";
      open.pop();
    } else {
      buffer += character;
    }
  }

  return selectors;
}

/**
 * Every `pageStyles: [...]` array in the source tree, in cascade order.
 *
 * Source text rather than rendered HTML: the block *identifiers* are what a
 * reviewer reorders, and a rendered page has only the concatenated CSS, in
 * which the two conflicting declarations are indistinguishable from an
 * intentional override. `import.meta.glob` is resolved by Vite at transform
 * time, so this works inside the workers pool where `node:fs` does not (same
 * mechanism as layout.test.ts and scripts.test.ts).
 */
function styleArrays(): StyleArray[] {
  const sources = import.meta.glob("../../src/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  const arrays: StyleArray[] = [];
  for (const [rawPath, source] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))) {
    const path = rawPath.replace(/^(\.\.\/)+/, "");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    let index = 0;
    for (const match of code.matchAll(/pageStyles:\s*\[([^\]]*)\]/g)) {
      const blocks = (match[1] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "");
      arrays.push({ id: `${path}#${index}`, blocks });
      index += 1;
    }
  }
  return arrays;
}

/** Every collision on every page, whether or not it is listed. */
function collisions(): { page: string; selector: string; blocks: string[] }[] {
  const found: { page: string; selector: string; blocks: string[] }[] = [];

  for (const { id, blocks } of styleArrays()) {
    // `STYLES` is excluded on purpose — it is always first and always
    // present, and page blocks are *written* to override its primitives.
    // Including it would report a collision on almost every page block and
    // bury the handful that matter.
    const declared = new Map<string, string[]>();
    for (const block of blocks) {
      const css = (STYLE_MODULE as unknown as Record<string, unknown>)[block];
      expect(
        typeof css,
        `${id} passes \`${block}\`, which is not an exported CSS string in ` +
          `src/views/styles.ts. This scan resolves identifiers to their CSS; a ` +
          `block it cannot resolve is a page it silently stops guarding.`,
      ).toBe("string");
      for (const selector of selectorsOf(css as string)) {
        declared.set(selector, [...(declared.get(selector) ?? []), block]);
      }
    }

    for (const [selector, owners] of declared) {
      if (owners.length > 1) found.push({ page: id, selector, blocks: owners });
    }
  }

  return found.sort(
    (a, b) => a.page.localeCompare(b.page) || a.selector.localeCompare(b.selector),
  );
}

describe("pageStyles cascade order", () => {
  it("finds the pageStyles arrays it claims to", () => {
    // Guards the scan itself. If `styleArrays` silently matched nothing — a
    // refactor to a different call shape, an array broken across a variable,
    // a renamed parameter — every assertion below would pass while covering
    // no page at all, which is the failure mode this whole file exists to
    // remove.
    const arrays = styleArrays();
    expect(arrays.length).toBeGreaterThanOrEqual(14);
    const ownerFixture = arrays.find(({ id }) => id.startsWith("src/views/owner-fixture.ts"));
    expect(
      ownerFixture?.blocks,
      "src/views/owner-fixture.ts passes six blocks and is the page whose " +
        "440px-wide squad rows at a 390px viewport this guard was written for. " +
        "If the scan can no longer see it, fix the scan before trusting the " +
        "assertions below.",
    ).toHaveLength(6);
  });

  it("lists every selector two of a page's blocks declare", () => {
    const listed = new Set(INTENDED_WINNERS.map(({ page, selector }) => `${page} ${selector}`));
    const unlisted = collisions()
      .filter(({ page, selector }) => !listed.has(`${page} ${selector}`))
      .map(({ page, selector, blocks }) => `${page}: ${selector} declared by ${blocks.join(" + ")}`);

    expect(
      unlisted,
      "These selectors are declared by two or more blocks on the same page, " +
        "so which declaration reaches the browser is decided by the order of " +
        "that page's `pageStyles` array and by nothing else. Either reorder " +
        "the array so the block that should win is LAST, or add the collision " +
        "to INTENDED_WINNERS with the block that wins and a one-line reason " +
        "saying what the losing declaration would do to the page. Do not " +
        "leave one unlisted: an unnoticed reorder is how `ul.squad > li` " +
        "reverted from grid to flex on four separate pages.",
    ).toEqual([]);
  });

  it("puts each intended winner last, where the cascade can honour it", () => {
    // The other half. Listing a collision records the decision; only this
    // checks the decision survived — a reorder leaves the table accurate and
    // the page wrong, which is precisely the bug.
    const arrays = new Map(styleArrays().map((array) => [array.id, array.blocks]));
    const wrong: string[] = [];

    for (const { page, selector, winner } of INTENDED_WINNERS) {
      const blocks = arrays.get(page);
      if (blocks === undefined) {
        wrong.push(`${page}: no such pageStyles array (stale INTENDED_WINNERS entry)`);
        continue;
      }
      const collision = collisions().find(
        (entry) => entry.page === page && entry.selector === selector,
      );
      if (collision === undefined) {
        wrong.push(`${page}: ${selector} no longer collides (stale INTENDED_WINNERS entry)`);
        continue;
      }
      const losers = collision.blocks.filter((block) => block !== winner);
      if (losers.length === collision.blocks.length) {
        wrong.push(`${page}: ${selector} — ${winner} does not declare it`);
        continue;
      }
      const winnerAt = blocks.lastIndexOf(winner);
      for (const loser of losers) {
        if (blocks.lastIndexOf(loser) > winnerAt) {
          wrong.push(
            `${page}: ${selector} — ${loser} is listed after ${winner}, so ${loser} wins`,
          );
        }
      }
    }

    expect(
      wrong,
      "INTENDED_WINNERS names the block whose declaration must reach the " +
        "browser, and `layout()` gives that to whichever block is LAST in the " +
        "page's `pageStyles` array. Move the intended block to the end of the " +
        "array — or, if the other block is now the one the page wants, change " +
        "INTENDED_WINNERS and say why in its reason.",
    ).toEqual([]);
  });
});
