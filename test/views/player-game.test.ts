import { describe, expect, it } from "vitest";
import { gamePastFixturesPath } from "../../src/auth/paths.js";
import { LIFECYCLES, type Lifecycle } from "../../src/domain/lifecycle.js";
import { fixtureView } from "../../src/domain/fixture-view.js";
import { fixtureStatusWords } from "../../src/views/fixture.js";
import { renderPlayerGamePage, type PlayerGameParams } from "../../src/views/player-game.js";
import { FORM_CSS, INVITE_CSS, SQUAD_STYLES_CSS } from "../../src/views/styles.js";

const KICKOFF = new Date("2026-03-05T19:00:00Z");

const BASE: PlayerGameParams = {
  // No played fixtures in these fixtures, so no standings (M49).
  standings: [],
  nav: { isAdmin: false, current: "games" } as const,
  gameId: "g-1",
  gameName: "Thursday 7-a-side",
  venueName: "Venue Name",
  venueAddress: null,
  timezone: "Europe/London",
  archivedOn: null,
  openFixture: null,
  upcoming: [],
  lastResult: null,
  viewerPlayerId: "p-me",
  mute: {
    muteAction: "/g/g-1/mute",
    unmuteAction: "/g/g-1/unmute",
    state: { muted: false },
    otherGamesCount: 0,
  },
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

describe("the way back up", () => {
  it("is the header's Games link, not a body back link (M16)", () => {
    const html = renderPlayerGamePage(params());
    expect(html).toContain(`<header class="site-header">`);
    expect(html).not.toContain(`class="back-link"`);
  });
});

describe("the organiser's quick-message links (M15 Task 10)", () => {
  // The compose links belong on the owner's two pages
  // (`src/views/game-overview.ts`, `src/views/owner-fixture.ts`) — this page
  // is what a squad member, not the organiser, is shown, and it renders with
  // no `gameId` or `fixtureId` to build such a link from at all.
  it("never offers a way to message the squad", () => {
    const html = renderPlayerGamePage(params());
    expect(html).not.toContain("Message everyone");
    expect(html).not.toContain("Message players");
    expect(html).not.toMatch(/\/message"/);
  });
});

/**
 * The member's way into the past-fixtures page (M27) — the same reasoning as
 * the organiser's link on `src/views/game-overview.ts`: a page nothing links
 * to is unreachable except by typing its URL.
 */
describe("the link to past fixtures (M27)", () => {
  it("links to the games this player has played here", () => {
    const html = renderPlayerGamePage(params());
    expect(html).toContain(`href="${gamePastFixturesPath(BASE.gameId)}"`);
  });
});

/**
 * The player's game page can be answered from (M52).
 *
 * The game's name is the largest element on every dashboard fixture card and
 * it links here; `Your squads` links here; a member tapping a kickoff lands
 * here. Yet the page rendered the kickoff, the status, the teams and the squad
 * and then stopped — no buttons, no headline saying whether the viewer had
 * answered. The most-tapped link on the dashboard led somewhere strictly less
 * capable than the card it was tapped from.
 *
 * The block is the dashboard's, imported rather than restated, so a waitlisted
 * player cannot read as confirmed on one page and not the other (BR-5).
 */
describe("answering from the game page", () => {
  const openFixture = (over: Partial<NonNullable<PlayerGameParams["openFixture"]>> = {}) => ({
    fixtureId: "f-1",
    kicksOffAtLocal: "Thursday 5 March at 19:00",
    myStatus: "pending" as const,
    view: fixtureView(
      {
        lifecycle: "open",
        kicksOffAt: KICKOFF,
        inCount: 4,
        minPlayers: 8,
        maxPlayers: 14,
        prefersEvenNumbers: false,
        shortWarningOffsetHours: 24,
      },
      new Date("2026-03-01T12:00:00Z"),
    ),
    inCount: 4,
    waitlistCount: 0,
    squad: null,
    teams: null,
    ...over,
  });

  it("offers both answers on the open fixture", () => {
    const html = renderPlayerGamePage(params({ openFixture: openFixture() }));

    expect(html).toContain('name="intent" value="in"');
    expect(html).toContain('name="intent" value="out"');
  });

  it("posts to this fixture, not to the dashboard", () => {
    const html = renderPlayerGamePage(params({ openFixture: openFixture() }));

    // A dashboard-scoped action would bounce the player out of the game they
    // are looking at, and carries a fixture id in a hidden field this page has
    // no reason to trust it with.
    expect(html).toContain('action="/g/g-1/f/f-1/answer"');
  });

  it("says what the viewer has already answered", () => {
    const html = renderPlayerGamePage(params({ openFixture: openFixture({ myStatus: "in" }) }));

    expect(html).toContain(`class="button chosen-in"`);
  });

  it("never shows the confirmed styling to a waitlisted player (BR-5)", () => {
    const html = renderPlayerGamePage(
      params({ openFixture: openFixture({ myStatus: "waitlisted" }) }),
    );

    expect(html).toContain(`class="button chosen-waiting"`);
    expect(html).not.toContain(`class="button chosen-in"`);
  });

  it("offers nothing to answer when no fixture is open", () => {
    const html = renderPlayerGamePage(params({ openFixture: null }));

    expect(html).not.toContain('name="intent"');
  });

  /** Every part of this page is plain markup; the answer block must stay so. */
  it("adds no script", () => {
    const html = renderPlayerGamePage(params({ openFixture: openFixture() }));

    expect(html).not.toContain("onclick");
    expect(html).not.toContain("submit()");
  });
});

