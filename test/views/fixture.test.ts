import { describe, expect, it } from "vitest";
import {
  fixtureStatusWords,
  renderFixturePage,
  renderPublishedTeamsSection,
  renderStatusLine,
  type FixturePageOptions,
} from "../../src/views/fixture.js";
import { renderOwnerFixturePage, type OwnerFixtureParams } from "../../src/views/owner-fixture.js";
import { renderPlayerGamePage } from "../../src/views/player-game.js";
import { FRESHNESS_JS, SERVICE_WORKER_JS } from "../../src/views/scripts.js";
import { FIXTURE_STYLES_CSS, SQUAD_STYLES_CSS } from "../../src/views/styles.js";
import { fixtureView, type FixtureFacts } from "../../src/domain/fixture-view.js";
import type { SquadMember } from "../../src/db/queries.js";
import type { ResponseStatus } from "../../src/domain/response-status.js";

const BASE = {
  gameName: "Thursday 7-a-side",
  venueName: "Oxford Sports Park",
  kicksOffAtLocal: "Thursday 13 August, 19:00",
  view: { status: "open" as const, flags: [], inCount: 9, minPlayers: 10, maxPlayers: 14, spotsLeft: 5, needsOwnerAttention: false },
  squad: [
    {
      playerId: "p1",
      name: "Edward Cooper",
      erasedAt: null,
      status: "in" as const,
      team: null, waitlistRank: null,
      setBy: null,
      source: "token" as const,
      isGuest: false,
    },
    {
      playerId: "p2",
      name: "Sam Okonjo",
      erasedAt: null,
      status: "pending" as const,
      team: null, waitlistRank: null,
      setBy: null,
      source: "token" as const,
      isGuest: false,
    },
  ],
  inCount: 1,
  waitlistCount: 0,
  viewer: { playerId: "p2", status: "pending" as const },
  token: "tok",
  intent: null,
  // The field is required on the page's options, and `null` is how a caller
  // says "nothing published here" — which is what every case below except the
  // teams tests wants.
  teams: null,
};

function optionsWith(overrides: Partial<FixturePageOptions>): FixturePageOptions {
  return { ...BASE, ...overrides };
}

/** Shorthand for `renderFixturePage(pageOptions({ squad: [...] }))` callers below. */
function pageOptions(overrides: Partial<FixturePageOptions>): FixturePageOptions {
  return optionsWith(overrides);
}

/** A minimal squad member, for tests that only care about one or two fields. */
function member(
  overrides: Partial<SquadMember> & { name: string; status: ResponseStatus },
): SquadMember {
  return {
    playerId: overrides.name,
    erasedAt: null,
    team: null,
    waitlistRank: null,
    setBy: null,
    source: "token",
    isGuest: false,
    ...overrides,
  };
}

describe("fixture page", () => {
  it("contains no JavaScript at all (TR-4)", () => {
    const html = renderFixturePage(BASE);
    // Two blocks are stripped before the assertion, and both are enhancements
    // over markup that already works: the site-wide service worker
    // registration (M13 Task 5), and the freshness bar's re-fetch-on-resume
    // (M24), whose Refresh link is an ordinary GET of this page's own URL.
    // Neither can answer for anybody — `location.reload()` is a GET, and this
    // page records nothing on a GET (TR-15), which is what makes the block
    // safe on a URL that sits in an email scanners follow with scripting on.
    // Stripping them keeps this proving TR-4 for everything else.
    expect(html).toContain(`<script>${SERVICE_WORKER_JS}</script>`);
    expect(html).toContain(`<script>${FRESHNESS_JS}</script>`);
    const rest = html
      .replace(`<script>${SERVICE_WORKER_JS}</script>`, "")
      .replace(`<script>${FRESHNESS_JS}</script>`, "");
    expect(rest).not.toContain("<script");
  });

  it("offers two explicit POST buttons, not an auto-submit (TR-15)", () => {
    const html = renderFixturePage(BASE);
    expect(html).toContain('method="post"');
    expect(html).toContain('name="intent" value="in"');
    expect(html).toContain('name="intent" value="out"');
    expect(html).not.toContain("onload");
    expect(html).not.toContain("submit()");
  });

  it("shows the answer in the button on every render, not only after submitting", () => {
    // No ?intent= anywhere — this is a player opening their link days later.
    const html = renderFixturePage(optionsWith({ viewer: { playerId: "p1", status: "in" }, intent: null }));
    expect(html).toContain(`class="button chosen-in"`);
  });

  it("never gives a waitlisted player the confirmed green (BR-5)", () => {
    const html = renderFixturePage(
      optionsWith({
        viewer: { playerId: "p1", status: "waitlisted", waitlistRank: 2 },
        intent: "in",
      }),
    );
    // The intent says "in" because that is what they tapped. What got recorded
    // is a waitlist place, and that is what the control must show.
    expect(html).toContain(`class="button chosen-waiting"`);
    expect(html).not.toContain(`class="button chosen-in"`);
    expect(html).toMatch(/I(&#39;|')m in · waiting/);
  });

  it("emphasises neither button for a player who has not answered", () => {
    const html = renderFixturePage(optionsWith({ viewer: { playerId: "p1", status: "pending" }, intent: null }));
    expect(html).not.toContain(`class="button chosen-`);
  });

  it("shows the out answer in the out button", () => {
    const html = renderFixturePage(optionsWith({ viewer: { playerId: "p1", status: "out" }, intent: null }));
    expect(html).toContain(`class="button chosen-out"`);
  });

  it("escapes player names", () => {
    const html = renderFixturePage({
      ...BASE,
      squad: [
        {
          playerId: "x",
          name: '<script>alert("x")</script>',
          erasedAt: null,
          status: "in",
          team: null, waitlistRank: null,
          setBy: null,
          source: "token",
          isGuest: false,
        },
      ],
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says plainly when the viewer is on the waitlist (BR-5)", () => {
    const html = renderFixturePage({
      ...BASE,
      viewer: { playerId: "p2", status: "waitlisted", waitlistRank: 2 },
    });
    expect(html).toMatch(/waitlist/i);
    expect(html).toContain("2");
  });

  describe("a waitlisted viewer must never read as confirmed (BR-5, fix round 1)", () => {
    const WAITLISTED_CONFIRMED = {
      ...BASE,
      view: { status: "confirmed" as const, flags: [], inCount: 14, minPlayers: 10, maxPlayers: 14, spotsLeft: 0, needsOwnerAttention: false },
      viewer: { playerId: "p2", status: "waitlisted" as const, waitlistRank: 1 },
    };

    it("does not present a confirmed-green 'I'm in' button", () => {
      const html = renderFixturePage(WAITLISTED_CONFIRMED);
      expect(html).not.toMatch(/class="button chosen-in"[^>]*name="intent" value="in"/);
    });

    it("ignores ?intent= entirely — appearance is driven by status alone, not by what was tapped", () => {
      // Control: even a mismatched, stale, or hand-crafted ?intent= does not
      // change which button is emphasised. Only `viewer.status` may.
      const html = renderFixturePage({
        ...WAITLISTED_CONFIRMED,
        viewer: { playerId: "p2", status: "pending" },
        intent: "in",
      });
      expect(html).not.toContain(`class="button chosen-`);
    });

    it("gives the waitlist headline the warn treatment, not the default", () => {
      const html = renderFixturePage(WAITLISTED_CONFIRMED);
      expect(html).toMatch(/class="viewer-headline warn"/);
    });

    it("renders the personal headline before the fixture's own status badge", () => {
      const html = renderFixturePage(WAITLISTED_CONFIRMED);
      // Search for the opening tags, not the bare class names — the
      // stylesheet in <head> mentions both class names ahead of either
      // actual element, which would make a bare substring search find the
      // CSS rule instead of the rendered markup. The headline is the answer
      // block's h2 since M20 B7; the block still sits above the badge, which
      // is the guarantee this test exists for.
      const headlineIndex = html.indexOf('<h2 class="viewer-headline');
      const badgeIndex = html.indexOf('<p class="status-badge');
      expect(headlineIndex).toBeGreaterThan(-1);
      expect(badgeIndex).toBeGreaterThan(-1);
      expect(headlineIndex).toBeLessThan(badgeIndex);
    });
  });

  it("shows an uneven fixture as on, with a nudge", () => {
    const html = renderFixturePage({
      ...BASE,
      view: { status: "confirmed", flags: ["uneven"], inCount: 11, minPlayers: 10, maxPlayers: 14, spotsLeft: 3, needsOwnerAttention: true },
    });
    expect(html).toMatch(/confirmed|game is on/i);
    expect(html).toMatch(/odd number|one more|uneven/i);
  });

  it("never uses forbidden vocabulary in copy", () => {
    // Scoped to the page's own copy, not its script — the site-wide service
    // worker registration (M13 Task 5) legitimately says "event" and
    // "addEventListener", and every page carries it now. This test's job was
    // always the product's *prose*, never implementation vocabulary inside a
    // <script> tag; stripping script first (the same technique
    // test/routes/team-publish.test.ts uses to separate "no script" from "no
    // domain vocabulary") is what keeps that property honest rather than
    // accidentally depending on this page happening to carry no script.
    const html = renderFixturePage(BASE).replace(/<script[\s\S]*?<\/script>/g, "").toLowerCase();
    for (const word of ["rsvp", "event", "match"]) expect(html).not.toContain(word);
  });

  it("carries the token through the form action", () => {
    const html = renderFixturePage(BASE);
    expect(html).toContain("tok");
  });

  it("renders read-only with no buttons when given a readOnlyReason", () => {
    const html = renderFixturePage({
      ...BASE,
      readOnlyReason: "played",
    });
    expect(html).not.toContain('method="post"');
    expect(html).not.toContain('name="intent"');
  });

  it("says plainly when the viewer is already in", () => {
    const html = renderFixturePage({
      ...BASE,
      viewer: { playerId: "p1", status: "in" },
    });
    expect(html).toMatch(/you(&#39;|')re in/i);
  });

  describe("readOnlyReason: not-eligible — a valid token for a player no longer on the squad", () => {
    it("renders read-only with no buttons and no viewer headline", () => {
      const html = renderFixturePage({
        ...BASE,
        readOnlyReason: "not-eligible",
      });
      expect(html).not.toContain('method="post"');
      expect(html).not.toContain('name="intent"');
      expect(html).not.toContain('class="viewer-headline"');
    });

    it("never asks a live question, regardless of the viewer's stale status", () => {
      for (const status of ["pending", "in", "out", "waitlisted"] as const) {
        const html = renderFixturePage({
          ...BASE,
          viewer: { playerId: "p2", status, waitlistRank: status === "waitlisted" ? 1 : null },
          readOnlyReason: "not-eligible",
        });
        expect(html).not.toMatch(/can you make it\?/i);
        expect(html).not.toContain('class="viewer-headline"');
      }
    });

    it("explains the squad situation, distinct from a played/cancelled fixture", () => {
      const html = renderFixturePage({ ...BASE, readOnlyReason: "not-eligible" });
      expect(html).toMatch(/no longer on the squad/i);
      expect(html).not.toMatch(/already been played|was cancelled/i);
    });
  });

  describe("readOnlyReason: not-open — a scheduled fixture (fix round 1, finding 2)", () => {
    it("renders read-only with no buttons, no live question, and no viewer headline", () => {
      const html = renderFixturePage({ ...BASE, readOnlyReason: "not-open" });
      expect(html).not.toContain('method="post"');
      expect(html).not.toContain('name="intent"');
      expect(html).not.toContain('class="viewer-headline"');
      expect(html).not.toMatch(/can you make it\?/i);
      // Pins the escaped apostrophe exactly (escapeHtml widened to escape
      // `'` as `&#39;`) rather than accepting either form — a regex
      // matching both a literal `'` and `&#39;` passes identically whether
      // or not escapeHtml escapes the apostrophe, so it gives zero
      // regression coverage for that widening.
      expect(html).toContain("Responses for this fixture aren&#39;t open yet.");
    });
  });

  describe("viewer headline never contradicts a readOnlyReason", () => {
    const reasons = ["played", "cancelled"] as const;
    const statuses = ["pending", "in", "out"] as const;

    for (const readOnlyReason of reasons) {
      for (const status of statuses) {
        it(`renders sensibly for a ${status} viewer when the fixture was ${readOnlyReason}`, () => {
          const html = renderFixturePage({
            ...BASE,
            view: { status: readOnlyReason, flags: [], inCount: 14, minPlayers: 10, maxPlayers: 14, spotsLeft: 0, needsOwnerAttention: false },
            viewer: { playerId: "p2", status },
            readOnlyReason,
          });

          // Never a live question about a fixture that is already over.
          expect(html).not.toMatch(/can you make it\?/i);
          // No response controls at all.
          expect(html).not.toContain('method="post"');
          expect(html).not.toContain('name="intent"');
          // The read-only explanation is always present.
          expect(html).toMatch(readOnlyReason === "played" ? /already been played/i : /was cancelled/i);
        });
      }
    }

    it("tells a player who was in that they were in, in the past tense, when played", () => {
      const html = renderFixturePage({
        ...BASE,
        view: { status: "played", flags: [], inCount: 14, minPlayers: 10, maxPlayers: 14, spotsLeft: 0, needsOwnerAttention: false },
        viewer: { playerId: "p1", status: "in" },
        readOnlyReason: "played",
      });
      expect(html).toMatch(/you were in/i);
      expect(html).not.toMatch(/you're in/i);
    });

    it("tells a player who was in that the fixture was cancelled", () => {
      const html = renderFixturePage({
        ...BASE,
        view: { status: "cancelled", flags: [], inCount: 14, minPlayers: 10, maxPlayers: 14, spotsLeft: 0, needsOwnerAttention: false },
        viewer: { playerId: "p1", status: "in" },
        readOnlyReason: "cancelled",
      });
      expect(html).toMatch(/you were in.*cancelled/i);
    });

    it("gives a pending viewer no headline at all against a terminal fixture", () => {
      const html = renderFixturePage({
        ...BASE,
        view: { status: "played", flags: [], inCount: 14, minPlayers: 10, maxPlayers: 14, spotsLeft: 0, needsOwnerAttention: false },
        viewer: { playerId: "p2", status: "pending" },
        readOnlyReason: "played",
      });
      expect(html).not.toContain('class="viewer-headline"');
    });
  });

  it("names the organiser who answered for a player", () => {
    const html = renderFixturePage({
      ...BASE,
      squad: [
        {
          playerId: "p-1",
          name: "Priya Raman",
          erasedAt: null,
          status: "in",
          team: null, waitlistRank: null,
          setBy: { playerId: "o-1", name: "Jamie Alderton", erasedAt: null },
          source: "owner",
          isGuest: false,
        },
      ],
    });

    expect(html).toContain("marked in by Jamie Alderton");
  });

  /**
   * §4, and the defect the final review found: no renderer branched on
   * `erased_at`, so the deliberately-conspicuous `[erased player]` placeholder
   * — chosen precisely so that a forgotten branch would be visible — reached
   * both of the positions a squad read puts a name in.
   *
   * A played fixture keeps its erased participants (that is what stops last
   * month's ten-a-side becoming a nine-a-side), and `responses.set_by_player_id`
   * is untouched by erasure, so both are live cases rather than theoretical.
   */
  it("shows the erased label rather than the stored placeholder, in both positions", () => {
    const erasedAt = new Date("2026-08-20T09:00:00Z");
    const html = renderFixturePage({
      ...BASE,
      squad: [
        {
          playerId: "p-1",
          name: "[erased player]",
          erasedAt,
          status: "in",
          team: null, waitlistRank: null,
          setBy: null,
          source: "token",
          isGuest: false,
        },
        {
          playerId: "p-2",
          name: "Priya Raman",
          erasedAt: null,
          status: "in",
          team: null, waitlistRank: null,
          setBy: { playerId: "o-1", name: "[erased player]", erasedAt },
          source: "owner",
          isGuest: false,
        },
      ],
    });

    expect(html).not.toContain("erased player");
    expect(html).toContain("a former player");
    expect(html).toContain("marked in by a former player");
  });

  it("says nothing about who set a self-response", () => {
    const html = renderFixturePage({
      ...BASE,
      squad: [
        {
          playerId: "p-1",
          name: "Priya Raman",
          erasedAt: null,
          status: "in",
          team: null, waitlistRank: null,
          setBy: null,
          source: "token",
          isGuest: false,
        },
      ],
    });

    expect(html).not.toContain("marked in by");
  });

  it("words an owner-set waitlisted row as marked in, not marked out", () => {
    const html = renderFixturePage({
      ...BASE,
      squad: [
        {
          playerId: "p-1",
          name: "Priya Raman",
          erasedAt: null,
          status: "waitlisted",
          team: null, waitlistRank: 1,
          setBy: { playerId: "o-1", name: "Jamie Alderton", erasedAt: null },
          source: "owner",
          isGuest: false,
        },
      ],
    });

    expect(html).toContain("marked in by");
    expect(html).not.toContain("marked out by");
  });

  it("words an owner-set out as marked out", () => {
    const html = renderFixturePage({
      ...BASE,
      squad: [
        {
          playerId: "p-1",
          name: "Priya Raman",
          erasedAt: null,
          status: "out",
          team: null, waitlistRank: null,
          setBy: { playerId: "o-1", name: "Jamie Alderton", erasedAt: null },
          source: "owner",
          isGuest: false,
        },
      ],
    });

    expect(html).toContain("marked out by Jamie Alderton");
  });

  it("escapes a setter's name", () => {
    const html = renderFixturePage({
      ...BASE,
      squad: [
        {
          playerId: "p-1",
          name: "Priya Raman",
          erasedAt: null,
          status: "in",
          team: null, waitlistRank: null,
          setBy: { playerId: "o-1", name: "<script>x</script>", erasedAt: null },
          source: "owner",
          isGuest: false,
        },
      ],
    });

    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says a fixture is over capacity", () => {
    const html = renderFixturePage({
      ...BASE,
      view: { status: "confirmed", flags: ["over_capacity"], inCount: 16, minPlayers: 10, maxPlayers: 14, spotsLeft: 0, needsOwnerAttention: false },
    });

    expect(html).toContain("more players in than there are places");
  });

  it("lists the squad when the game allows it", () => {
    const html = renderFixturePage(optionsWith({
      squad: [{ playerId: "p-1", name: "Priya Raman", erasedAt: null, status: "in", team: null, waitlistRank: null,
                setBy: null, source: "token", isGuest: false }],
      inCount: 1,
    }));

    expect(html).toContain("Priya Raman");
  });

  it("names nobody when the game does not, but still says how many are in", () => {
    const html = renderFixturePage(optionsWith({ squad: null, inCount: 8 }));

    expect(html).not.toContain("Priya Raman");
    expect(html).toContain("8 in so far");
    expect(html).toContain("isn't shown for this game");
  });

  it("says one in, not 1 in, for a single player", () => {
    const html = renderFixturePage(optionsWith({ squad: null, inCount: 1 }));

    expect(html).toContain("1 in so far");
  });

  describe("the squad, grouped by answer as chips (M10 §3.5)", () => {
    it("groups the squad by answer with a count", () => {
      const html = renderFixturePage(pageOptions({ squad: [
        member({ name: "Ada", status: "in" }),
        member({ name: "Bo", status: "in" }),
        member({ name: "Cy", status: "waitlisted", waitlistRank: 1 }),
        member({ name: "Di", status: "pending" }),
      ]}));
      expect(html).toContain(">In<");
      expect(html).toMatch(/In<\/span>\s*<span class="group-count">2</);
      expect(html).toMatch(/Waiting<\/span>\s*<span class="group-count">1</);
      expect(html).toContain(`class="chip`);
    });

    it("keeps BR-27 attribution as a line beneath the group", () => {
      const html = renderFixturePage(pageOptions({ squad: [
        member({ name: "Ada", status: "in", source: "owner", setBy: { playerId: "o-1", name: "Jamie", erasedAt: null } }),
      ]}));
      expect(html).toContain("marked in by Jamie");
    });

    /**
     * Fix round 1, finding 3: every existing attribution test used exactly
     * one member with one setter, so `listSentence`'s multi-name grammar
     * ("a, b and c", `was`/`were` agreement, and the `[...new Set(...)]`
     * dedup across two different setters) was never exercised — including
     * the spec's own example sentence.
     */
    describe("group attribution's multi-name grammar (fix round 1, finding 3)", () => {
      const jamie = { playerId: "o-1", name: "Jamie", erasedAt: null };

      it("joins two names with 'and', and uses 'were' for two people", () => {
        const html = renderFixturePage(pageOptions({ squad: [
          member({ name: "Nadia Okafor", status: "in", source: "owner", setBy: jamie }),
          member({ name: "Theo Marchetti", status: "in", source: "owner", setBy: jamie }),
        ]}));
        // The spec's own example sentence.
        expect(html).toContain("Nadia Okafor and Theo Marchetti were marked in by Jamie");
      });

      it("joins three names with commas and a final 'and', deliberately no Oxford comma", () => {
        const html = renderFixturePage(pageOptions({ squad: [
          member({ name: "Ada", status: "in", source: "owner", setBy: jamie }),
          member({ name: "Bo", status: "in", source: "owner", setBy: jamie }),
          member({ name: "Cy", status: "in", source: "owner", setBy: jamie }),
        ]}));
        expect(html).toContain("Ada, Bo and Cy were marked in by Jamie");
      });

      it("uses 'was' rather than 'were' for exactly one name", () => {
        const html = renderFixturePage(pageOptions({ squad: [
          member({ name: "Ada", status: "in", source: "owner", setBy: jamie }),
        ]}));
        expect(html).toContain("Ada was marked in by Jamie");
        expect(html).not.toContain("were marked in");
      });

      it("dedupes and lists two different setters in one group", () => {
        const priya = { playerId: "o-2", name: "Priya", erasedAt: null };
        const html = renderFixturePage(pageOptions({ squad: [
          member({ name: "Ada", status: "in", source: "owner", setBy: jamie }),
          member({ name: "Bo", status: "in", source: "owner", setBy: priya }),
        ]}));
        expect(html).toContain("Ada and Bo were marked in by Jamie and Priya");
      });

      it("does not repeat the same setter's name when they set everyone in the group", () => {
        const html = renderFixturePage(pageOptions({ squad: [
          member({ name: "Ada", status: "in", source: "owner", setBy: jamie }),
          member({ name: "Bo", status: "in", source: "owner", setBy: jamie }),
        ]}));
        // Exactly one "Jamie" in the sentence, not "Jamie and Jamie".
        expect(html).not.toContain("Jamie and Jamie");
        expect(html).toContain("by Jamie.");
      });
    });

    it("omits a group nobody is in", () => {
      // A heading over nothing reads as a broken page.
      const html = renderFixturePage(pageOptions({ squad: [member({ name: "Ada", status: "in" })] }));
      expect(html).not.toContain("Waiting");
    });

    it("shows a waitlisted player's place in their chip", () => {
      const html = renderFixturePage(pageOptions({ squad: [member({ name: "Cy", status: "waitlisted", waitlistRank: 2 })] }));
      expect(html).toContain("Cy · 2nd");
    });

    it("still marks guests", () => {
      const html = renderFixturePage(pageOptions({ squad: [member({ name: "Jono", status: "in", isGuest: true })] }));
      expect(html).toContain("Jono (guest)");
    });

    /**
     * Fix round 1, finding 1: M10 §3.5 — "the viewer's own chip filled in the
     * group's colour so they can see themselves counted." A colour cue via a
     * `chip-you` modifier class, not a text change: the name stays the
     * player's real name throughout (never "You"), because
     * `test/browser/journeys.spec.ts` locates the viewer's own chip by their
     * real name on their own response page, and the spec's requirement is the
     * fill, not the label.
     */
    describe("the viewer's own chip is highlighted, in every group", () => {
      it("marks the viewer's chip in the In group", () => {
        const html = renderFixturePage(pageOptions({
          squad: [member({ name: "Ada", status: "in" }), member({ name: "Bo", status: "in" })],
          viewer: { playerId: "Ada", status: "in" },
        }));
        expect(html).toContain(`<li class="chip chip-in chip-you">Ada</li>`);
        // The other In member is not the viewer, so no highlight.
        expect(html).toContain(`<li class="chip chip-in">Bo</li>`);
      });

      it("marks the viewer's chip in the Waiting group, rank and all", () => {
        const html = renderFixturePage(pageOptions({
          squad: [member({ name: "Cy", status: "waitlisted", waitlistRank: 2 })],
          viewer: { playerId: "Cy", status: "waitlisted", waitlistRank: 2 },
        }));
        expect(html).toContain(`<li class="chip chip-waitlisted chip-you">Cy · 2nd</li>`);
      });

      it("marks the viewer's chip in the Out group", () => {
        const html = renderFixturePage(pageOptions({
          squad: [member({ name: "Eve", status: "out" })],
          viewer: { playerId: "Eve", status: "out" },
        }));
        expect(html).toContain(`<li class="chip chip-out chip-you">Eve</li>`);
      });

      it("marks the viewer's chip in the No reply group", () => {
        const html = renderFixturePage(pageOptions({
          squad: [member({ name: "Fay", status: "pending" })],
          viewer: { playerId: "Fay", status: "pending" },
        }));
        expect(html).toContain(`<li class="chip chip-pending chip-you">Fay</li>`);
      });

      it("highlights nobody when the viewer is not on the visible squad", () => {
        const html = renderFixturePage(pageOptions({
          squad: [member({ name: "Ada", status: "in" })],
          viewer: { playerId: "somebody-else", status: "pending" },
        }));
        // Scoped to the rendered `<li>`, not the whole page — the stylesheet
        // in <head> mentions `chip-you` in its own selectors regardless of
        // whether any chip in the body carries the class.
        expect(html).not.toMatch(/<li class="[^"]*chip-you/);
      });
    });

    /**
     * The trap this task calls out: `SQUAD_STYLES_CSS` is shared with the
     * organiser's page, and a chip is an `<li>` too (`li.chip` inside
     * `ul.chips` inside `div.squad`) — so a bare `.squad li` selector would
     * apply the organiser's row layout (flex, space-between, a border) to
     * every chip as well. A string assertion on the chip's own class list
     * cannot catch that; only checking what the *selector itself* can reach
     * proves it.
     *
     * The row rule is `ul.squad > li`, which is structurally unable to select
     * anything inside `<div class="squad">` — a child combinator requires the
     * named parent tag to actually be that element, and no CSS engine can
     * make a `<div>` match a `ul` selector. So the proof is two checks: (1)
     * the CSS text really does scope the row rule to `ul.squad > li`, not the
     * old bare `.squad li`; and (2) the player's page — where the chips live
     * — never emits `<ul class="squad">` for that selector to ever attach to,
     * while the organiser's page (rendered from the same `SQUAD_STYLES_CSS`)
     * still does, so the row rule keeps applying where it is meant to.
     */
    it("scopes the organiser's row rules so they cannot reach the player's chips", () => {
      // (1) The stylesheet itself: the row rule is child-combinator-scoped to
      // `ul.squad`, and no bare `.squad li` rule survives to over-match.
      expect(SQUAD_STYLES_CSS).toContain("ul.squad > li {");
      expect(SQUAD_STYLES_CSS).not.toContain(".squad li {");

      // (2) The player's page structurally cannot be selected by `ul.squad > li`:
      // its squad wrapper is a `<div>`, not a `<ul>`.
      const playerHtml = renderFixturePage(pageOptions({
        squad: [member({ name: "Ada", status: "in" })],
      }));
      expect(playerHtml).toContain(`<div class="squad">`);
      expect(playerHtml).not.toContain(`<ul class="squad">`);
      expect(playerHtml).toContain(`<li class="chip chip-in">`);

      // The organiser's page, from the same shared CSS, keeps its `<ul class="squad">` —
      // so `ul.squad > li` still reaches the rows it was written for.
      const ownerParams: OwnerFixtureParams = {
        nav: { isAdmin: false, current: "games" } as const,
        gameId: "g-1",
        gameName: "Thursday 7-a-side",
        fixtureId: "f-1",
        kicksOffAtLocal: "Thursday 13 August, 19:00",
        venueName: "Oxford Sports Park",
        inCount: 1,
        maxPlayers: 10,
        view: { status: "open", flags: [], inCount: 9, minPlayers: 10, maxPlayers: 14, spotsLeft: 5, needsOwnerAttention: false },
        squad: [
          { playerId: "p-1", name: "Ada", erasedAt: null, status: "in", team: null, waitlistRank: null,
            setBy: null, source: "token", isGuest: false },
        ],
        viewerPlayerId: "p-1",
        teamNames: { a: "Reds", b: "Blues" },
        prefersEvenNumbers: false,
        teamsPublished: false,
        teamsNeedAnotherLook: false,
        announcementOutstanding: false,
        cancellationReason: null,
      };
      const ownerHtml = renderOwnerFixturePage(ownerParams);
      expect(ownerHtml).toContain(`<ul class="squad">`);
      expect(ownerHtml).not.toContain(`<div class="squad">`);
    });
  });
});

/**
 * M10 §3.4. "0 spots left" sitting beside a green confirmed badge, above two
 * live response buttons, reads as "you can't come" — this states the outcome
 * where the tap happens: what answering yes would actually do.
 */
describe("full fixture — states what a yes would do, before the tap", () => {
  const FULL_VIEW = { status: "confirmed" as const, flags: [], inCount: 14, minPlayers: 10, maxPlayers: 14, spotsLeft: 0, needsOwnerAttention: false };

  it("tells a player what answering yes would do on a full fixture", () => {
    const html = renderFixturePage(optionsWith({
      view: FULL_VIEW,
      viewer: { playerId: "p1", status: "pending" },
      waitlistCount: 2,
    }));
    expect(html).toContain("The squad is full — answering yes puts you 3rd on the waitlist.");
  });

  it("still counts correctly when the organiser hides the squad (BR-33)", () => {
    // The case `waitlistCount` exists for. `squad` is null here, so a count
    // derived from the list this page renders would be 0 and every player in a
    // squad-hidden game would be told they'd be 1st in a queue of three. The
    // field is fed from the route's *unfiltered* squad precisely so that
    // cannot happen; without this test, wiring it to the filtered list would
    // pass every other assertion in the file.
    const html = renderFixturePage(optionsWith({
      view: FULL_VIEW,
      squad: null,
      viewer: { playerId: "p1", status: "pending" },
      waitlistCount: 2,
    }));
    expect(html).toContain("The squad is full — answering yes puts you 3rd on the waitlist.");
    // And the page really is the squad-hidden one, so the assertion above is
    // not passing because the fixture quietly rendered a visible squad.
    expect(html).toContain("isn't shown for this game");
  });

  it("says it to a player who said no, who might yet change their mind", () => {
    const html = renderFixturePage(optionsWith({
      view: FULL_VIEW,
      viewer: { playerId: "p1", status: "out" },
      waitlistCount: 0,
    }));
    expect(html).toContain("puts you 1st on the waitlist");
  });

  it("does not warn a player who is already in", () => {
    const html = renderFixturePage(optionsWith({
      view: FULL_VIEW,
      viewer: { playerId: "p1", status: "in" },
      waitlistCount: 2,
    }));
    expect(html).not.toContain("on the waitlist.");
  });

  it("does not warn a player who is already on the waitlist", () => {
    // Their headline says exactly where they are; a second sentence offering to
    // put them on it would read as though they were not.
    const html = renderFixturePage(optionsWith({
      view: FULL_VIEW,
      viewer: { playerId: "p1", status: "waitlisted", waitlistRank: 1 },
      waitlistCount: 2,
    }));
    expect(html).not.toContain("answering yes puts you");
  });

  it("says nothing when there is still room", () => {
    const html = renderFixturePage(optionsWith({
      view: { status: "open" as const, flags: [], inCount: 11, minPlayers: 10, maxPlayers: 14, spotsLeft: 3, needsOwnerAttention: false },
      waitlistCount: 0,
    }));
    expect(html).not.toContain("The squad is full");
  });
});

/**
 * BR-35 §5, on the page half of it. The email half is covered by
 * `test/notify/send-teams.test.ts`; these two must keep agreeing, so the
 * wording asserted here ("You're on X.") is deliberately the email's own
 * lead sentence.
 */
describe("fixture page — published teams (BR-35 §5)", () => {
  const NAMES = { a: "Reds", b: "Blues" };

  const PICKED = [
    { playerId: "p1", name: "Edward Cooper", erasedAt: null, status: "in" as const, team: "a" as const,
      waitlistRank: null, setBy: null, source: "token" as const, isGuest: false },
    { playerId: "p2", name: "Sam Okonjo", erasedAt: null, status: "in" as const, team: "b" as const,
      waitlistRank: null, setBy: null, source: "token" as const, isGuest: false },
  ];

  it("says nothing about teams when nothing has been published", () => {
    // The assignments are right there on the squad rows; the absent
    // `teams` is the only thing keeping them off the page.
    const html = renderFixturePage(optionsWith({ squad: PICKED, inCount: 2, teams: null }));

    expect(html).not.toContain("<h2>Teams</h2>");
    expect(html).not.toContain("Reds");
    expect(html).not.toContain("Blues");
  });

  it("tells the viewer their own side, first", () => {
    const html = renderFixturePage(optionsWith({
      squad: PICKED,
      inCount: 2,
      viewer: { playerId: "p1", status: "in" },
      teams: { names: NAMES, yourSide: "a", awaitingSide: false },
    }));

    expect(html).toContain("You're on Reds.");
    expect(html.indexOf("You're on Reds.")).toBeLessThan(html.indexOf("<h3>Reds"));
  });

  it("lists both sides when the game shows players to each other", () => {
    const html = renderFixturePage(optionsWith({
      squad: PICKED,
      inCount: 2,
      viewer: { playerId: "p1", status: "in" },
      teams: { names: NAMES, yourSide: "a", awaitingSide: false },
    }));

    expect(html).toContain("Edward Cooper");
    expect(html).toContain("Sam Okonjo");
    expect(html).toContain("<h3>Reds");
    expect(html).toContain("<h3>Blues");
  });

  /**
   * The refinement of BR-33 this whole task turns on: a hidden squad hides
   * the other side's *people*, never the viewer's own assignment — which
   * they are holding an email about.
   */
  it("keeps the viewer's own side when the squad is hidden, and names nobody else", () => {
    const html = renderFixturePage(optionsWith({
      squad: null,
      inCount: 2,
      viewer: { playerId: "p1", status: "in" },
      teams: { names: NAMES, yourSide: "a", awaitingSide: false },
    }));

    expect(html).toContain("You're on Reds.");
    expect(html).not.toContain("Sam Okonjo");
    expect(html).not.toContain("<h3>Blues");
  });

  it("renders no empty line-up for a hidden squad", () => {
    // `null` means "not shown", and an empty list would read as "nobody
    // else is playing" — a different and false statement (M8's reason for
    // `squadForViewer` returning `null` rather than `[]`).
    const html = renderFixturePage(optionsWith({
      squad: null,
      inCount: 2,
      viewer: { playerId: "p1", status: "in" },
      teams: { names: NAMES, yourSide: "a", awaitingSide: false },
    }));

    expect(html).not.toContain("Nobody.");
  });

  it("says nothing at all to a viewer with no side and no visible squad", () => {
    // A bare "Teams" heading over nothing would tell a pending player a pick
    // exists while telling them nothing about it.
    const html = renderFixturePage(optionsWith({
      squad: null,
      inCount: 2,
      viewer: { playerId: "p3", status: "pending" },
      teams: { names: NAMES, yourSide: null, awaitingSide: false },
    }));

    expect(html).not.toContain("<h2>Teams</h2>");
  });

  it("never lists a player who is no longer in, though they keep their side", () => {
    // A dropout keeps their side until the organiser's next save clears it
    // (see `src/domain/teams.ts`), so this row is what the database really
    // looks like in between — and listing them would claim they are playing.
    const html = renderFixturePage(optionsWith({
      squad: [
        PICKED[0]!,
        { ...PICKED[1]!, status: "out" as const },
      ],
      inCount: 1,
      viewer: { playerId: "p1", status: "in" },
      teams: { names: NAMES, yourSide: "a", awaitingSide: false },
    }));

    expect(html).toContain("<h3>Blues");
    // Still named in the squad list below, which is the honest record of who
    // answered what — but nowhere inside the teams section.
    const teamsSection = html.slice(html.indexOf("<h2>Teams</h2>"), html.indexOf("<h2>Squad</h2>"));
    expect(teamsSection).toContain("Edward Cooper");
    expect(teamsSection).not.toContain("Sam Okonjo");
    expect(html).toContain("Sam Okonjo");
  });

  it("tells a player who is in with no side that theirs is not picked yet", () => {
    const html = renderFixturePage(optionsWith({
      squad: PICKED,
      inCount: 2,
      viewer: { playerId: "p3", status: "in" },
      teams: { names: NAMES, yourSide: null, awaitingSide: true },
    }));

    expect(html).toContain("Your side hasn't been picked yet.");
    expect(html).toContain("<h3>Reds");
  });

  it("says nothing when nobody on the published pick is still in", () => {
    // The sibling `renderTeamsReadOnly` drops out on the same emptiness. A
    // heading over "Nobody." twice is an assertion about a pick, made to
    // somebody it says nothing about.
    const html = renderFixturePage(optionsWith({
      squad: PICKED.map((member) => ({ ...member, status: "out" as const })),
      inCount: 0,
      viewer: { playerId: "p3", status: "pending" },
      teams: { names: NAMES, yourSide: null, awaitingSide: false },
    }));

    expect(html).not.toContain("<h2>Teams</h2>");
    expect(html).not.toContain("Nobody.");
  });

  it("escapes a side's name", () => {
    const html = renderFixturePage(optionsWith({
      squad: null,
      inCount: 1,
      viewer: { playerId: "p1", status: "in" },
      teams: { names: { a: '<script>alert("x")</script>', b: "Blues" }, yourSide: "a", awaitingSide: false },
    }));

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("past tense: tells the viewer their own side in the past tense (M25)", () => {
    // `renderFixturePage` always calls the section in the default (future)
    // tense; the `past` tense is exercised directly, the same way M25's
    // player fixture page calls it.
    const html = renderPublishedTeamsSection({ names: NAMES, yourSide: "a", awaitingSide: false }, PICKED, "past");
    expect(html).toContain("You were on Reds.");
    expect(html).not.toContain("You're on");
  });

  it("past tense: never tells an awaiting-side viewer their side isn't picked yet (M25)", () => {
    // "Your side hasn't been picked yet" is a warning about what's still to
    // come. Once the fixture is played there is no "still to come" — a side
    // either was assigned or, same as any other unplaced player, is simply
    // not mentioned.
    const html = renderPublishedTeamsSection({ names: NAMES, yourSide: null, awaitingSide: true }, PICKED, "past");
    expect(html).not.toContain("hasn't been picked yet");
  });

  it("still contains no JavaScript with teams on the page (TR-4)", () => {
    const html = renderFixturePage(optionsWith({
      squad: PICKED,
      inCount: 2,
      viewer: { playerId: "p1", status: "in" },
      teams: { names: NAMES, yourSide: "a", awaitingSide: false },
    }));

    // Two blocks are stripped before the assertion, and both are enhancements
    // over markup that already works: the site-wide service worker
    // registration (M13 Task 5), and the freshness bar's re-fetch-on-resume
    // (M24), whose Refresh link is an ordinary GET of this page's own URL.
    // Neither can answer for anybody — `location.reload()` is a GET, and this
    // page records nothing on a GET (TR-15), which is what makes the block
    // safe on a URL that sits in an email scanners follow with scripting on.
    // Stripping them keeps this proving TR-4 for everything else.
    expect(html).toContain(`<script>${SERVICE_WORKER_JS}</script>`);
    expect(html).toContain(`<script>${FRESHNESS_JS}</script>`);
    const rest = html
      .replace(`<script>${SERVICE_WORKER_JS}</script>`, "")
      .replace(`<script>${FRESHNESS_JS}</script>`, "");
    expect(rest).not.toContain("<script");
  });
});

/**
 * M12 §3.1. The headcount is a bar showing what is there, not a sentence
 * counting down to zero — "0 spots left" beside a live "I'm in" button read
 * as a closed door.
 */
describe("the capacity bar", () => {
  const KICKOFF = new Date("2026-08-13T18:00:00Z");
  const NOW = new Date("2026-08-13T09:00:00Z"); // inside the short-warning window

  function facts(overrides: Partial<FixtureFacts> = {}): FixtureFacts {
    return {
      lifecycle: "open",
      kicksOffAt: KICKOFF,
      inCount: 0,
      minPlayers: 10,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      ...overrides,
    };
  }

  /** The bar's label is split across elements, so assert on what a reader sees. */
  function text(html: string): string {
    return html.replace(/<[^>]+>/g, "");
  }

  it("renders the headcount as a bar whose width is the fill, not the gap", () => {
    const html = renderStatusLine(fixtureView(facts({ inCount: 6, minPlayers: 8, maxPlayers: 10 }), NOW), 0);
    expect(html).toContain(`<span class="fill short w-60">`);
    expect(html).toContain("6 of 10");
    expect(html).not.toContain("spots left");
  });

  it("marks a full squad as full rather than as nothing left", () => {
    const html = renderStatusLine(fixtureView(facts({ inCount: 10, minPlayers: 8, maxPlayers: 10 }), NOW), 2);
    expect(html).toContain("w-100");
    expect(html).not.toContain("short");
    expect(text(html)).toContain("10 of 10 in · 2 waiting");
  });

  it("says nothing about a waitlist nobody is on", () => {
    const html = renderStatusLine(fixtureView(facts({ inCount: 10, minPlayers: 8, maxPlayers: 10 }), NOW), 0);
    expect(html).not.toContain("waiting");
  });

  it("clamps an over-capacity squad to a full bar", () => {
    const html = renderStatusLine(fixtureView(facts({ inCount: 14, minPlayers: 8, maxPlayers: 10 }), NOW), 0);
    expect(html).toContain("w-100");
  });

  it("declares a rule for every width it can emit", () => {
    // The silent failure this catches: a width class with no matching rule is
    // a zero-width bar that no string assertion and no fetch test can see.
    //
    // The opening brace is part of the needle, and is what makes the check
    // real: without it `.w-5` is satisfied by `.w-50`'s rule and `.w-10` by
    // `.w-100`'s, so the two classes most likely to go missing are the two
    // this test could not have detected.
    for (let pct = 0; pct <= 100; pct += 5) {
      expect(FIXTURE_STYLES_CSS).toContain(`.capacity .fill.w-${pct} {`);
    }
  });

  it("emits only widths it has declared", () => {
    // Every reachable headcount, not a sample: a rounding change that produced
    // w-63 would pass the loop above and still ship an invisible bar.
    for (let max = 1; max <= 40; max++) {
      for (let inCount = 0; inCount <= max + 5; inCount++) {
        const html = renderStatusLine(fixtureView(facts({ inCount, minPlayers: 1, maxPlayers: max }), NOW), 0);
        const width = /w-(\d+)/.exec(html)?.[1];
        expect(width).toBeDefined();
        expect(Number(width) % 5).toBe(0);
        expect(Number(width)).toBeLessThanOrEqual(100);
      }
    }
  });

  it.each(["scheduled", "cancelled", "played"] as const)(
    "shows no bar on a %s fixture, which is not taking answers",
    (lifecycle) => {
      // `cancelled` and `played` because nobody can join. `scheduled` because
      // nobody has been asked yet: an empty squad is below any minimum, so the
      // bar would come out amber and read as an alarm about a question the
      // organiser has not put to anybody.
      const html = renderStatusLine(fixtureView(facts({ lifecycle, inCount: 0 }), NOW), 0);
      expect(html).not.toContain("capacity");
      expect(html).toContain("status-badge");
    },
  );

  it("styles the bar on every page that renders it", () => {
    // The failure this pins: `renderStatusLine` is shared by four pages, but
    // `.capacity` is declared in one style block, and a page that omits that
    // block from its `pageStyles` renders a track with no height — an
    // invisible bar, with every other assertion in this file still passing.
    // The fixture page and the dashboard are covered by their own suites;
    // these two had no `FIXTURE_STYLES_CSS` at all before M12.
    const ownerHtml = renderOwnerFixturePage({
      nav: { isAdmin: false, current: "games" } as const,
      gameId: "g-1",
      gameName: "Thursday 7-a-side",
      fixtureId: "f-1",
      kicksOffAtLocal: "Thursday 13 August, 19:00",
      venueName: "Oxford Sports Park",
      inCount: 1,
      maxPlayers: 10,
      view: fixtureView(
        {
          lifecycle: "open",
          kicksOffAt: KICKOFF,
          inCount: 1,
          minPlayers: 8,
          maxPlayers: 10,
          prefersEvenNumbers: false,
          shortWarningOffsetHours: 12,
        },
        NOW,
      ),
      squad: [
        { playerId: "p-1", name: "Ada", erasedAt: null, status: "in", team: null, waitlistRank: null,
          setBy: null, source: "token", isGuest: false },
      ],
      viewerPlayerId: "p-1",
      teamNames: { a: "Reds", b: "Blues" },
      prefersEvenNumbers: false,
      teamsPublished: false,
      teamsNeedAnotherLook: false,
      announcementOutstanding: false,
      cancellationReason: null,
    });
    expect(ownerHtml).toContain(`<div class="capacity">`);
    expect(ownerHtml).toContain(".capacity .track");

    const playerHtml = renderPlayerGamePage({
      nav: { isAdmin: false, current: "games" } as const,
      gameId: "g-1",
      gameName: "Thursday 7-a-side",
      venueName: "Oxford Sports Park",
      venueAddress: null,
      timezone: "Europe/London",
      openFixture: {
        kicksOffAtLocal: "Thursday 13 August, 19:00",
        view: fixtureView(
          {
            lifecycle: "open",
            kicksOffAt: KICKOFF,
            inCount: 1,
            minPlayers: 8,
            maxPlayers: 10,
            prefersEvenNumbers: false,
            shortWarningOffsetHours: 12,
          },
          NOW,
        ),
        inCount: 1,
        waitlistCount: 0,
        squad: null,
        teams: null,
      },
      upcoming: [],
      lastResult: null,
      viewerPlayerId: "p-1",
    });
    expect(playerHtml).toContain(`<div class="capacity">`);
    expect(playerHtml).toContain(".capacity .track");
  });
});

/**
 * The same failure `fixtureStatusWords` was made total to prevent, in the
 * renderer three lines below it. `renderStatusLine` is the status on four
 * pages — the dashboard, the player's fixture page, the player's game page
 * and the organiser's fixture page — so an unmapped lifecycle here is four
 * 500s, not one ugly word.
 */
describe("a stored lifecycle this build has never heard of", () => {
  const KICKOFF = new Date("2026-08-13T18:00:00Z");
  const NOW = new Date("2026-08-13T09:00:00Z");

  // `fixtures.lifecycle` is `text NOT NULL DEFAULT 'scheduled'` with no CHECK
  // constraint (migrations/0000_lonely_jack_flag.sql), so the column can hold
  // this: a legacy row, a hand-applied fix, or a newer deploy writing a
  // lifecycle mid-rollout. Drizzle's `enum` is a type-level assertion only.
  // `as never` is how such a row is written in a test the type system would
  // otherwise forbid.
  const LEGACY = "abandoned" as never;

  function view(lifecycle: FixtureFacts["lifecycle"]) {
    return fixtureView(
      {
        lifecycle,
        kicksOffAt: KICKOFF,
        inCount: 6,
        minPlayers: 8,
        maxPlayers: 10,
        prefersEvenNumbers: false,
        shortWarningOffsetHours: 12,
      },
      NOW,
    );
  }

  /** The badge's words, without the class the raw value also lands in. */
  function words(html: string): string {
    return html.replace(/<[^>]+>/g, "").trim();
  }

  it("renders rather than throwing", () => {
    // Not cosmetic. `STATUS_LABEL[status]` was `undefined`, escapeHtml calls
    // .replace on it, and the page 500s — the identical failure that took the
    // organiser's game page down earlier in this branch.
    expect(() => renderStatusLine(view(LEGACY), 0)).not.toThrow();
  });

  it("says the state is unknown rather than printing the stored token", () => {
    const html = renderStatusLine(view(LEGACY), 0);
    expect(words(html)).toBe("Status unknown");
    expect(words(html)).not.toContain("abandoned");
    expect(words(html)).not.toContain("undefined");
  });

  it("uses the wording the rest of the product already uses for this", () => {
    // One admission, not two: a second phrase for the same thing is how one
    // page comes to call an unreadable fixture something another page doesn't.
    expect(words(renderStatusLine(view(LEGACY), 0))).toBe(fixtureStatusWords(LEGACY));
  });

  it("draws no capacity bar for a state it could not read", () => {
    // Guarded the same way `cancelled`, `played` and `scheduled` are, and for
    // a stronger reason: the badge has just said the state is unknown, and a
    // bar underneath it would state a confident proportion about a fixture
    // nothing is known about.
    const html = renderStatusLine(view(LEGACY), 2);
    expect(html).not.toContain("capacity");
    expect(html).not.toContain("w-60");
    expect(html).not.toContain("waiting");
    expect(html).toContain("status-badge");
  });

  it("escapes the stored value where it reaches the class attribute", () => {
    // The value is a database string, not markup, and it is interpolated
    // into an attribute (Constraint 6).
    const html = renderStatusLine(view(`x" onclick="alert(1)` as never), 0);
    expect(html).not.toContain(`onclick="alert(1)"`);
    expect(html).toContain("&quot;");
  });
});

/**
 * M20 B7. The viewer's own state — the headline, the buttons or the read-only
 * sentence, and the pre-tap warning — is said once, in one tinted block, with
 * the fixture's impersonal facts below it rather than interleaved with it.
 */
describe("the answer block (M20 B7)", () => {
  /** The answer section's inner HTML, or null if the page rendered no block. */
  function answerBlock(html: string): { state: string; inner: string } | null {
    const match = html.match(/<section class="answer answer-([a-z]+)">([\s\S]*?)<\/section>/);
    return match === null ? null : { state: match[1] as string, inner: match[2] as string };
  }

  it("wraps headline, buttons and full-warning in one state-classed section", () => {
    const html = renderFixturePage(
      optionsWith({
        view: { status: "confirmed", flags: [], inCount: 14, minPlayers: 10, maxPlayers: 14, spotsLeft: 0, needsOwnerAttention: false },
        viewer: { playerId: "p2", status: "pending" },
        waitlistCount: 2,
      }),
    );
    const block = answerBlock(html);
    expect(block).not.toBeNull();
    expect(block?.state).toBe("open");
    expect(block?.inner).toContain("Can you make it?");
    expect(block?.inner).toContain("aria-pressed");
    expect(block?.inner).toContain("The squad is full");
  });

  it("keeps the fixture's own facts below the block, not inside it", () => {
    const html = renderFixturePage(BASE);
    const blockEnd = html.indexOf("</section>");
    expect(blockEnd).toBeGreaterThan(-1);
    // The badge is the fixture's fact, so it must not appear inside the
    // viewer's block — and it must still be on the page exactly once.
    expect(answerBlock(html)?.inner).not.toContain("status-badge");
    const badgeIndex = html.indexOf('<p class="status-badge');
    expect(badgeIndex).toBeGreaterThan(blockEnd);
  });

  it("names the waitlisted state on the block", () => {
    const html = renderFixturePage(
      optionsWith({ viewer: { playerId: "p2", status: "waitlisted", waitlistRank: 2 } }),
    );
    expect(html).toContain('class="answer answer-waiting"');
  });

  it("names the going and declined states on the block", () => {
    const going = renderFixturePage(optionsWith({ viewer: { playerId: "p1", status: "in" } }));
    expect(going).toContain('class="answer answer-going"');
    const declined = renderFixturePage(optionsWith({ viewer: { playerId: "p1", status: "out" } }));
    expect(declined).toContain('class="answer answer-declined"');
  });

  it("renders read-only states as the block with a sentence for buttons", () => {
    for (const readOnlyReason of ["played", "cancelled", "not-open", "not-eligible"] as const) {
      const html = renderFixturePage(optionsWith({ readOnlyReason }));
      expect(html).toContain('class="answer answer-closed"');
      expect(html).not.toContain("aria-pressed");
      expect(answerBlock(html)?.inner).toContain('class="read-only"');
    }
  });

  it("never renders buttons and a read-only sentence together, in any state", () => {
    const statuses = ["pending", "in", "out", "waitlisted"] as const;
    const reasons = [undefined, "played", "cancelled", "not-open", "not-eligible"] as const;
    for (const status of statuses) {
      for (const readOnlyReason of reasons) {
        const html = renderFixturePage(
          optionsWith({
            viewer: { playerId: "p2", status, waitlistRank: status === "waitlisted" ? 1 : null },
            readOnlyReason,
          }),
        );
        const inner = answerBlock(html)?.inner ?? "";
        expect(inner).not.toBe("");
        expect(inner.includes('name="intent"') && inner.includes('class="read-only"')).toBe(false);
        // One block per page, and one badge per page: the restructure must not
        // duplicate either.
        expect(html.split('<section class="answer').length - 1).toBe(1);
        expect(html.split('<p class="status-badge').length - 1).toBe(1);
      }
    }
  });
});
