import { describe, expect, it } from "vitest";
import { renderOwnerFixturePage, type OwnerFixtureParams } from "../../src/views/owner-fixture.js";
import { FIXTURE_STYLES_CSS, FORM_CSS, SQUAD_STYLES_CSS, WHATSAPP_CSS } from "../../src/views/styles.js";
import { COPY_BUTTON_JS } from "../../src/views/scripts.js";
import { fixtureView } from "../../src/domain/fixture-view.js";

const KICKOFF = new Date("2026-08-13T18:00:00Z");
const NOW = new Date("2026-08-13T09:00:00Z");

const BASE: OwnerFixtureParams = {
  nav: { isAdmin: false, current: "games" } as const,
  gameId: "g-1",
  gameName: "Thursday 7-a-side",
  inviteToken: "tok-1",
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
  teamsEmailEnabled: true,
  cancellationReason: null,
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

describe("a squad row places its control rather than letting the grid guess", () => {
  it("pins the text to column 1 and the control to column 2, spanning the text rows", () => {
    // No string assertion can see a layout, so this pins the mechanism rather
    // than the result — the result was checked by rendering the page at 390px
    // and reading the geometry back out of the browser.
    //
    // What it stands against: `1fr auto` with everything auto-placed is only
    // right for a two-part row. This page's row can carry a status word and an
    // attribution line as well, and auto-placement walked the third piece into
    // column 2 and pushed the control down into column 1, where the 1fr
    // stretched it across most of the row. The brace is part of each needle:
    // without it a prefix match would accept a rule that had lost its body.
    expect(FORM_CSS).toContain("ul.squad > li > .name, ul.squad > li > .status, ul.squad > li > .set-by { grid-column: 1; }");
    expect(FORM_CSS).toContain("ul.squad > li > form { grid-column: 2; grid-row: 1; }");
  });

  it("keeps the control in the name's own row, not spanning the text beneath it", () => {
    // Measured, not preferred: a grid item that spans several tracks gives its
    // height to all of them, so spanning the control across the text rows
    // inflated the empty tracks under a one-line row and left the name 13px
    // above the control it belongs to — on the row shape almost every squad
    // member has. Row 1 puts name and control in the same track, so they are
    // level in every row shape. `span` must not come back.
    expect(FORM_CSS).not.toContain("ul.squad > li > form { grid-column: 2; grid-row: 1 / span");
  });
});

describe("a squad member's stored status", () => {
  it("is escaped where it reaches the class attribute", () => {
    // The same hole that was open in `renderStatusLine`: the value goes into
    // `class="status status-..."`, and it is a database string, not markup
    // (Constraint 6). `responses.status` has no CHECK constraint behind it.
    const html = renderOwnerFixturePage(
      params({
        squad: [{ ...BASE.squad[0]!, status: `x" onclick="alert(1)` as never }],
      }),
    );
    expect(html).not.toContain(`onclick="alert(1)"`);
    expect(html).toContain("&quot;");
  });

  it("still reads as words when it is a status this build has never heard of", () => {
    const html = renderOwnerFixturePage(
      params({ squad: [{ ...BASE.squad[0]!, status: "abandoned" as never }] }),
    );
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("Status unknown");
    expect(text).not.toContain("abandoned");
    expect(text).not.toContain("undefined");
  });
});

describe("the back link", () => {
  it("carries the class §2.5 names, and the block that declares it", () => {
    // The class alone is inert: `.back-link { margin-top: 1.5rem }` lives in
    // FIXTURE_STYLES_CSS, and without it the link butts against the block
    // above it.
    const html = renderOwnerFixturePage(params());
    expect(html).toContain(`<p class="back-link">`);
    expect(html).toContain(`href="/g/g-1"`);
    expect(html).toContain(FIXTURE_STYLES_CSS);
    expect(FIXTURE_STYLES_CSS).toContain(".back-link {");
  });

  it("offers exactly one way back up, at the end of the body", () => {
    const html = renderOwnerFixturePage(params());
    expect(html.match(/class="back-link"/g)).toHaveLength(1);
  });
});

describe("the message-players link (M15 Task 10)", () => {
  it("links to the fixture-scoped compose page, as a secondary button", () => {
    // Not `.button primary` — publishing teams is this page's one primary
    // action (`renderPublish` in `src/views/team-picker.ts`), so a second
    // filled button here would leave nothing saying which one mattered.
    const html = renderOwnerFixturePage(params());
    expect(html).toContain(`<a class="button" href="/g/g-1/f/f-1/message">Message players</a>`);
    expect(html).not.toContain(`<a class="button primary"`);
  });
});

describe("the Post to WhatsApp card (M22)", () => {
  const params = (over: Partial<OwnerFixtureParams> = {}): OwnerFixtureParams => ({ ...BASE, ...over });
  const viewIn = (lifecycle: "scheduled" | "open" | "cancelled" | "played", inCount = 2) =>
    fixtureView(
      {
        lifecycle,
        kicksOffAt: KICKOFF,
        inCount,
        minPlayers: 8,
        maxPlayers: 10,
        prefersEvenNumbers: false,
        shortWarningOffsetHours: 12,
      },
      NOW,
    );

  it("prepares the numbers message for an open fixture, linking to the game page", () => {
    const html = renderOwnerFixturePage(params());
    expect(html).toContain('id="whatsapp"');
    expect(html).toContain("⚽ Thursday 7-a-side — Thursday 13 August, 19:00 at Oxford Sports Park");
    expect(html).toContain("2 in so far — 6 more needed.");
    expect(html).toContain("In or out? Say so on Make The Team: https://makethe.team/g/g-1");
    expect(html).toContain("https://wa.me/?text=");
  });

  it("ships the card's style block and the copy script with it", () => {
    const html = renderOwnerFixturePage(params());
    expect(html).toContain(WHATSAPP_CSS);
    expect(html).toContain(COPY_BUTTON_JS);
  });

  it("has nothing to post for a fixture that is not open yet, or has been played", () => {
    for (const lifecycle of ["scheduled", "played"] as const) {
      const html = renderOwnerFixturePage(params({ view: viewIn(lifecycle) }));
      expect(html, lifecycle).not.toContain('id="whatsapp"');
      expect(html, lifecycle).not.toContain(COPY_BUTTON_JS);
    }
  });

  it("prepares the teams message first, then the numbers, once teams are published", () => {
    const html = renderOwnerFixturePage(
      params({
        teamsPublished: true,
        squad: [
          { ...BASE.squad[0]!, team: "a" },
          { ...BASE.squad[1]!, name: "Bea", status: "in", team: "b" },
          { ...BASE.squad[1]!, playerId: "p-3", name: "Out Person", status: "out", team: "b" },
        ],
      }),
    );
    expect(html).toContain("<h3>Teams</h3>");
    expect(html).toContain("<h3>Numbers</h3>");
    expect(html.indexOf("<h3>Teams</h3>")).toBeLessThan(html.indexOf("<h3>Numbers</h3>"));
    expect(html).toContain("Reds: Ada Okafor\nBlues: Bea</textarea>");
    expect(html).not.toContain("Out Person</textarea>");
  });

  it("prepares the cancellation message, with the reason, for a cancelled fixture", () => {
    const html = renderOwnerFixturePage(
      params({ view: viewIn("cancelled"), cancellationReason: "Pitch flooded" }),
    );
    expect(html).toContain("Thursday 7-a-side on Thursday 13 August, 19:00 is cancelled.\nPitch flooded</textarea>");
    expect(html).not.toContain("In or out?");
  });
});

/**
 * Where the result panel sits (M27), pinned on the organiser's page for the
 * reason it is pinned on the player's: below the squad and the teams it was
 * two full lists away on a phone.
 *
 * Presence is asserted alongside the order because `indexOf` returns `-1` for
 * an absent needle and `-1 < anything` (CLAUDE.md).
 */
describe("owner fixture page — result panel position (M27)", () => {
  const RESULT: OwnerFixtureParams["result"] = {
    names: { a: "Reds", b: "Blues", draw: "Draw" },
    candidates: [],
    derived: null,
    locked: false,
    writable: true,
    eligible: true,
    rostered: true,
    yourPlayerId: "p-1",
    deadlineLocal: "Saturday 15 August, 19:00",
    actionPath: "/g/g-1/f/f-1/result",
    clearPath: "/g/g-1/f/f-1/result/clear",
  };

  it("renders the result panel above the squad", () => {
    const html = renderOwnerFixturePage(
      params({
        view: fixtureView(
          {
            lifecycle: "played",
            kicksOffAt: KICKOFF,
            inCount: 2,
            minPlayers: 8,
            maxPlayers: 10,
            prefersEvenNumbers: false,
            shortWarningOffsetHours: 12,
          },
          NOW,
        ),
        result: RESULT,
      }),
    );
    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<h2>Squad</h2>");
    expect(html.indexOf("<h2>Result</h2>")).toBeLessThan(html.indexOf("<h2>Squad</h2>"));
  });
});
