import { describe, expect, it } from "vitest";
import { LIFECYCLES, type Lifecycle } from "../../src/domain/lifecycle.js";
import { fixtureStatusWords } from "../../src/views/fixture.js";
import { renderPlayerGamePage, type PlayerGameParams } from "../../src/views/player-game.js";
import { FIXTURE_STYLES_CSS, FORM_CSS, INVITE_CSS, SQUAD_STYLES_CSS } from "../../src/views/styles.js";

const KICKOFF = new Date("2026-03-05T19:00:00Z");

const BASE: PlayerGameParams = {
  gameName: "Thursday 7-a-side",
  venueName: "Venue Name",
  venueAddress: null,
  timezone: "Europe/London",
  openFixture: null,
  upcoming: [],
  viewerPlayerId: "p-me",
};

function params(over: Partial<PlayerGameParams> = {}): PlayerGameParams {
  return { ...BASE, ...over };
}

/** The one "Coming up" row a test seeded a single fixture into. */
const comingUpRow = (html: string) =>
  html.match(/<ul class="fixtures">(?:<li>([^<]*)<\/li>)?/)?.[1];

describe("coming up", () => {
  /**
   * The words each stored lifecycle must reach a *player* as, written out
   * here rather than read from `fixtureStatusWords`: asserting the page
   * against the same helper it calls would pass however the helper is wired,
   * including not at all. This is this page's own contract with whoever reads
   * it — deliberately a second copy of the table in
   * `test/views/game-overview.test.ts`, because the two pages promising the
   * same words is the thing worth checking.
   */
  const WORDS: Record<Lifecycle, string> = {
    scheduled: "Not open yet",
    open: "Open for responses",
    cancelled: "Cancelled",
    played: "Played",
  };

  it.each(LIFECYCLES)("says in words what a %s fixture's state is", (lifecycle) => {
    const html = renderPlayerGamePage(params({ upcoming: [{ kicksOffAt: KICKOFF, lifecycle }] }));
    expect(comingUpRow(html)).toBe(`Thursday 5 March at 19:00 — ${WORDS[lifecycle]}`);
  });

  it("never shows a player an internal lifecycle value", () => {
    for (const lifecycle of LIFECYCLES) {
      const row = comingUpRow(renderPlayerGamePage(params({ upcoming: [{ kicksOffAt: KICKOFF, lifecycle }] })))!;
      // Not a substring check: "Not open yet" contains "open". The row must
      // not *end in* the raw token, which is what it used to render.
      expect(row.endsWith(`— ${lifecycle}`)).toBe(false);
    }
  });

  it("uses the organiser's words, not a second table of its own", () => {
    // One mapping, not two, or the organiser reads "Open for responses" about
    // the fixture a player is being told is "open".
    for (const lifecycle of LIFECYCLES) {
      expect(WORDS[lifecycle]).toBe(fixtureStatusWords(lifecycle));
    }
  });

  it("says so when there is nothing coming up", () => {
    expect(renderPlayerGamePage(params())).toContain(
      '<ul class="fixtures"><li>No fixtures scheduled.</li></ul>',
    );
  });
});

describe("a lifecycle this build does not know", () => {
  // `fixtures.lifecycle` is a bare `text NOT NULL` — the migration writes no
  // CHECK constraint, so `Lifecycle` is a claim about the schema and not a
  // guarantee about the rows. A legacy row, a hand-applied fix, or a newer
  // deploy mid-rollout can put a value here the words table has no entry for.
  // `as never` is how that row is expressed in a test the type system would
  // otherwise forbid writing — and it is why narrowing this page's parameter
  // to `Lifecycle` is documentation rather than the thing keeping it up.
  const LEGACY = "abandoned" as never;
  const row = { kicksOffAt: KICKOFF, lifecycle: LEGACY };

  it("still renders the player's page", () => {
    // Not cosmetic. An unmapped key is `undefined`, and it goes straight to
    // escapeHtml, which calls .replace on it — without the helper's fallback
    // this throws a TypeError and 500s the page, which is strictly worse than
    // the raw token this task replaced.
    expect(() => renderPlayerGamePage(params({ upcoming: [row] }))).not.toThrow();
  });

  it("says so in words rather than printing nothing or the raw value", () => {
    const row_ = comingUpRow(renderPlayerGamePage(params({ upcoming: [row] })))!;
    expect(row_).toBe("Thursday 5 March at 19:00 — Status unknown");
    expect(row_).not.toContain("undefined");
    expect(row_).not.toContain("abandoned");
  });
});

/**
 * Spec §4 P1: "Coming up" is a fixture list, not people. It wore
 * `class="squad"` until now, which is how a rule written for a squad row —
 * the organiser's person row, flex or grid depending on the cascade — came to
 * lay out a player's list of dates. Fixed on the sibling page
 * (`src/views/game-overview.ts`) and missed here.
 */
describe("the coming-up list is a list of fixtures, not of people", () => {
  const row = { kicksOffAt: KICKOFF, lifecycle: "open" as Lifecycle };

  it("wears the fixtures class, never the squad class", () => {
    const html = renderPlayerGamePage(params({ upcoming: [row] }));
    expect(html).toContain(`<ul class="fixtures">`);
    expect(html).not.toContain(`<ul class="squad">`);
  });

  it("ships the block ul.fixtures is declared in", () => {
    // Without it the list is an unstyled `ul` with no top border, no row
    // separators and no 44px rows — markup with nothing behind it, which no
    // string assertion about the class alone would notice.
    const html = renderPlayerGamePage(params({ upcoming: [row] }));
    expect(html).toContain(INVITE_CSS);
    expect(INVITE_CSS).toContain("ul.fixtures > li {");
  });

  it("keeps the two blocks that fight over ul.squad in the app's order", () => {
    // Inert on this page — the squad here is a `div.squad` of chips, never a
    // `ul.squad` — but pinned so this page is not the one place the rule is
    // written backwards. The presence assertions are what stop the order
    // comparison passing vacuously: `indexOf` returns -1 when a block is
    // absent, and -1 is less than everything.
    const html = renderPlayerGamePage(params({ upcoming: [row] }));
    const squadAt = html.indexOf(SQUAD_STYLES_CSS);
    const formAt = html.indexOf(FORM_CSS);
    expect(squadAt).toBeGreaterThan(-1);
    expect(formAt).toBeGreaterThan(-1);
    expect(squadAt).toBeLessThan(formAt);
  });
});

describe("the back link", () => {
  it("carries the class §2.5 names, and the block that declares it", () => {
    // The class alone is inert: `.back-link { margin-top: 1.5rem }` lives in
    // FIXTURE_STYLES_CSS, and without it the link butts against the list above.
    const html = renderPlayerGamePage(params());
    expect(html).toContain(`<p class="back-link">`);
    expect(html).toContain(FIXTURE_STYLES_CSS);
    expect(FIXTURE_STYLES_CSS).toContain(".back-link {");
  });

  it("offers exactly one way back up, at the end of the body", () => {
    const html = renderPlayerGamePage(params());
    expect(html.match(/class="back-link"/g)).toHaveLength(1);
  });
});
