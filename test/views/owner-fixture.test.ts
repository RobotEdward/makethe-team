import { describe, expect, it } from "vitest";
import { renderOwnerFixturePage, type OwnerFixtureParams } from "../../src/views/owner-fixture.js";
import { FIXTURE_STYLES_CSS, FORM_CSS, SQUAD_STYLES_CSS } from "../../src/views/styles.js";
import { fixtureView } from "../../src/domain/fixture-view.js";

const KICKOFF = new Date("2026-08-13T18:00:00Z");
const NOW = new Date("2026-08-13T09:00:00Z");

const BASE: OwnerFixtureParams = {
  gameId: "g-1",
  gameName: "Thursday 7-a-side",
  fixtureId: "f-1",
  kicksOffAtLocal: "Thursday 13 August, 19:00",
  venueName: "Oxford Sports Park",
  inCount: 2,
  maxPlayers: 10,
  view: fixtureView(
    {
      lifecycle: "open",
      kicksOffAt: KICKOFF,
      inCount: 2,
      minPlayers: 8,
      maxPlayers: 10,
      prefersEvenNumbers: false,
      shortWarningOffsetHours: 12,
    },
    NOW,
  ),
  squad: [
    {
      playerId: "p-1",
      name: "Ada Okafor",
      erasedAt: null,
      status: "in",
      team: null,
      waitlistRank: null,
      setBy: null,
      source: "token",
      isGuest: false,
    },
    {
      playerId: "p-2",
      name: "Somebody with a considerably longer name than the first one",
      erasedAt: null,
      status: "pending",
      team: null,
      waitlistRank: null,
      setBy: null,
      source: "token",
      isGuest: false,
    },
  ],
  viewerPlayerId: "p-1",
  teamNames: { a: "Reds", b: "Blues" },
  prefersEvenNumbers: false,
  teamsPublished: false,
  teamsNeedAnotherLook: false,
  announcementOutstanding: false,
};

function params(over: Partial<OwnerFixtureParams> = {}): OwnerFixtureParams {
  return { ...BASE, ...over };
}

/**
 * The cascade rule this milestone wrote, on the page it was written for. This
 * is the only page in the app that renders real squad rows with per-member
 * controls, so it is the page where getting the order wrong actually shows.
 */
describe("the squad row's layout", () => {
  it("lets FORM_CSS win the ul.squad row, so a row's shape is not the member's name's length", () => {
    // Both blocks declare `ul.squad > li` at identical specificity, and
    // `layout()` emits `pageStyles` in array order, so array order is cascade
    // order. Measured in a browser: a row here carries up to four children —
    // name, status, attribution, control — and SQUAD_STYLES_CSS's flex row
    // does not wrap, so at 390px such a row ran 50px past the viewport and
    // the Out half of the segment sat off-screen. FORM_CSS's grid wraps it
    // instead. No string assertion can see that; this order is all that
    // stands between it and a silent return.
    const html = renderOwnerFixturePage(params());
    const squadAt = html.indexOf(SQUAD_STYLES_CSS);
    const formAt = html.indexOf(FORM_CSS);
    // Both presence assertions are load-bearing: `indexOf` returns -1 for an
    // absent block, and -1 is less than everything, so the comparison below
    // passes vacuously on a page that ships neither block.
    expect(squadAt).toBeGreaterThan(-1);
    expect(formAt).toBeGreaterThan(-1);
    expect(squadAt).toBeLessThan(formAt);
  });

  it("still ships the block that draws the list's own container", () => {
    // SQUAD_STYLES_CSS going first is not the same as dropping it: the top
    // border on `.squad`, and the chip and status colours, are only here.
    const html = renderOwnerFixturePage(params());
    expect(html).toContain(SQUAD_STYLES_CSS);
    expect(html).toContain(`<ul class="squad">`);
  });

  it("ships the block the status badge and the capacity bar are declared in", () => {
    // `renderStatusLine` renders here, and a bar whose track has no height is
    // invisible rather than broken — nothing else on this page fails loudly
    // if the block goes missing.
    const html = renderOwnerFixturePage(params());
    expect(html).toContain(FIXTURE_STYLES_CSS);
    expect(html).toContain(`<div class="capacity">`);
  });
});
