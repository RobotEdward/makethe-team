import { describe, expect, it } from "vitest";
import type { SquadMember } from "../../src/db/queries.js";
import { LIFECYCLES, type Lifecycle } from "../../src/domain/lifecycle.js";
import { fixtureStatusWords } from "../../src/views/fixture.js";
import { FRESHNESS_ATTRIBUTE } from "../../src/views/scripts.js";
import { renderPlayerFixturePage, type PlayerFixtureParams } from "../../src/views/player-fixture.js";

const NAMES = { a: "Reds", b: "Blues" };

const PICKED: readonly SquadMember[] = [
  {
    playerId: "p1",
    name: "Edward Cooper",
    erasedAt: null,
    status: "in" as const,
    team: "a" as const,
    waitlistRank: null,
    setBy: null,
    source: "token" as const,
    isGuest: false,
    invitedAt: null,
  },
  {
    playerId: "p2",
    name: "Sam Okonjo",
    erasedAt: null,
    status: "in" as const,
    team: "b" as const,
    waitlistRank: null,
    setBy: null,
    source: "token" as const,
    isGuest: false,
    invitedAt: null,
  },
];

// Deliberately distinct from `NAMES` (the published-teams side names): a
// test asserting "Reds"/"Blues" are absent from an unpublished-teams page
// must not have those same words leaking in through the result panel's own
// "who won" labels instead.
const RESULT_PARAMS: PlayerFixtureParams["result"] = {
  names: { a: "Team A", b: "Team B", draw: "Draw" },
  candidates: [],
  derived: null,
  locked: false,
  writable: true,
  eligible: true,
  rostered: true,
  yourPlayerId: "p1",
  deadlineLocal: "Saturday 15 August, 19:00",
  actionPath: "/f/fx-1/result",
  clearPath: "/f/fx-1/result/clear",
};

const BASE: PlayerFixtureParams = {
  nav: { isAdmin: false, current: "games" } as const,
  gameName: "Thursday 7-a-side",
  venueName: "Oxford Sports Park",
  venueAddress: null,
  kicksOffAtLocal: "Thursday 13 August, 19:00",
  lifecycle: "played",
  teams: null,
  squad: null,
  inCount: 0,
  viewerPlayerId: "p1",
  result: RESULT_PARAMS,
  fixturePath: "/f/fx-1",
};

function params(over: Partial<PlayerFixtureParams> = {}): PlayerFixtureParams {
  return { ...BASE, ...over };
}

describe("player fixture page (M25)", () => {
  it("names the fixture, the venue and the viewer's own status", () => {
    const html = renderPlayerFixturePage(
      params({ gameName: "Thursday 7-a-side", venueName: "Oxford Sports Park", lifecycle: "played" }),
    );
    expect(html).toContain("Thursday 7-a-side");
    expect(html).toContain("Oxford Sports Park");
    expect(html).toContain(fixtureStatusWords("played"));
  });

  it("shows the published teams for a played fixture", () => {
    // The whole point of this page: a pick that used to vanish the moment
    // the fixture retired to `played` survives here, and in the past tense.
    const html = renderPlayerFixturePage(
      params({
        lifecycle: "played",
        squad: PICKED,
        inCount: 2,
        teams: { names: NAMES, yourSide: "a", awaitingSide: false },
      }),
    );
    expect(html).toContain("You were on Reds.");
    expect(html).toContain("Edward Cooper");
    expect(html).toContain("Sam Okonjo");
  });

  it("shows no teams when the pick was never published", () => {
    const html = renderPlayerFixturePage(params({ teams: null, squad: PICKED, inCount: 2 }));
    expect(html).not.toContain("<h2>Teams</h2>");
    expect(html).not.toContain("Reds");
    expect(html).not.toContain("Blues");
  });

  it("renders the result panel", () => {
    // "Result" is a string only `renderResultPanel` emits on this page — the
    // section heading it wraps every state in.
    const html = renderPlayerFixturePage(params());
    expect(html).toContain("<h2>Result</h2>");
  });

  it("renders the squad when the game shows it, and not when it doesn't", () => {
    const shown = renderPlayerFixturePage(params({ squad: PICKED, inCount: 2 }));
    expect(shown).toContain("Edward Cooper");
    expect(shown).toContain("Sam Okonjo");

    const hidden = renderPlayerFixturePage(params({ squad: null, inCount: 2 }));
    expect(hidden).not.toContain("Edward Cooper");
    expect(hidden).toContain("Who's playing isn't shown for this game.");
  });

  it("carries the freshness bar", () => {
    const html = renderPlayerFixturePage(params());
    expect(html).toContain(FRESHNESS_ATTRIBUTE);
  });

  it("escapes a venue name containing markup", () => {
    const html = renderPlayerFixturePage(params({ venueName: '<script>alert("x")</script>' }));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("survives a lifecycle this build cannot name", () => {
    // `fixtures.lifecycle` is a bare `text NOT NULL` with no CHECK constraint
    // (see CLAUDE.md); a legacy or hand-written row can hold a value
    // `fixtureStatusWords`'s table has no entry for. `escapeHtml(undefined)`
    // would throw and 500 the page without its fallback.
    const LEGACY = "abandoned" as Lifecycle;
    expect(() => renderPlayerFixturePage(params({ lifecycle: LEGACY }))).not.toThrow();
    const html = renderPlayerFixturePage(params({ lifecycle: LEGACY }));
    expect(html).toContain(fixtureStatusWords(LEGACY));
    expect(html).not.toContain("undefined");
  });

  it("every known lifecycle renders without throwing", () => {
    for (const lifecycle of LIFECYCLES) {
      expect(() => renderPlayerFixturePage(params({ lifecycle }))).not.toThrow();
    }
  });
});

/**
 * Where the result panel sits on the page (M27).
 *
 * A played fixture's page is long — teams, then a full squad list — and the
 * panel used to sit under all of it, so somebody who had just been nudged to
 * say how it went had to scroll past both to find the form. It now renders
 * directly under the header.
 *
 * Both assertions matter. `indexOf` returns `-1` for an absent needle and
 * `-1 < anything`, so an order comparison alone passes vacuously on a page
 * that renders neither block (see CLAUDE.md).
 */
describe("player fixture page — result panel position (M27)", () => {
  it("renders the result panel above the teams and the squad", () => {
    const html = renderPlayerFixturePage(params({ lifecycle: "played", teams: null }));
    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<h2>Squad</h2>");
    expect(html.indexOf("<h2>Result</h2>")).toBeLessThan(html.indexOf("<h2>Squad</h2>"));
  });

  it("renders the result panel above a published teams section", () => {
    const html = renderPlayerFixturePage(
      params({
        lifecycle: "played",
        teams: { names: NAMES, yourSide: "a", awaitingSide: false },
        squad: PICKED,
      }),
    );
    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<h2>Teams</h2>");
    expect(html.indexOf("<h2>Result</h2>")).toBeLessThan(html.indexOf("<h2>Teams</h2>"));
  });

  it("puts a locked result above the teams too", () => {
    const html = renderPlayerFixturePage(
      params({
        lifecycle: "played",
        result: {
          ...RESULT_PARAMS!,
          locked: true,
          writable: false,
          derived: {
            outcome: "a",
            scoreA: 3,
            scoreB: 2,
            outcomeBackers: 4,
            marginBackers: 3,
            voterCount: 5,
            distinctOutcomes: 1,
            distinctScores: 1,
          },
        },
      }),
    );
    expect(html).toContain("Team A won 3–2");
    expect(html).toContain("<h2>Squad</h2>");
    expect(html.indexOf("Team A won 3–2")).toBeLessThan(html.indexOf("<h2>Squad</h2>"));
  });
});
