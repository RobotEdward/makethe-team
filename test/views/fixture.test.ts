import { describe, expect, it } from "vitest";
import { renderFixturePage } from "../../src/views/fixture.js";

const BASE = {
  gameName: "Thursday 7-a-side",
  venueName: "Oxford Sports Park",
  kicksOffAtLocal: "Thursday 13 August, 19:00",
  view: { status: "open" as const, flags: [], spotsLeft: 5, needsOwnerAttention: false },
  squad: [
    { playerId: "p1", name: "Edward Cooper", status: "in" as const, waitlistRank: null },
    { playerId: "p2", name: "Sam Okonjo", status: "pending" as const, waitlistRank: null },
  ],
  viewer: { playerId: "p2", status: "pending" as const },
  token: "tok",
  intent: null,
};

describe("fixture page", () => {
  it("contains no JavaScript at all (TR-4)", () => {
    expect(renderFixturePage(BASE)).not.toContain("<script");
  });

  it("offers two explicit POST buttons, not an auto-submit (TR-15)", () => {
    const html = renderFixturePage(BASE);
    expect(html).toContain('method="post"');
    expect(html).toContain('name="intent" value="in"');
    expect(html).toContain('name="intent" value="out"');
    expect(html).not.toContain("onload");
    expect(html).not.toContain("submit()");
  });

  it("escapes player names", () => {
    const html = renderFixturePage({
      ...BASE,
      squad: [{ playerId: "x", name: '<script>alert("x")</script>', status: "in", waitlistRank: null }],
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
      view: { status: "confirmed" as const, flags: [], spotsLeft: 0, needsOwnerAttention: false },
      viewer: { playerId: "p2", status: "waitlisted" as const, waitlistRank: 1 },
    };

    it("does not present a filled primary 'I'm in' button", () => {
      const html = renderFixturePage(WAITLISTED_CONFIRMED);
      expect(html).not.toMatch(/class="button primary"[^>]*name="intent" value="in"/);
    });

    it("still shows a filled 'in' button when tapped ?intent=in but the viewer is not waitlisted", () => {
      // Control: the suppression above is specific to a waitlisted viewer,
      // not a general regression that disables the ?intent= emphasis.
      const html = renderFixturePage({ ...WAITLISTED_CONFIRMED, viewer: { playerId: "p2", status: "pending" }, intent: "in" });
      expect(html).toMatch(/class="button primary"[^>]*name="intent" value="in"/);
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
      // CSS rule instead of the rendered markup.
      const headlineIndex = html.indexOf('<p class="viewer-headline');
      const badgeIndex = html.indexOf('<p class="status-badge');
      expect(headlineIndex).toBeGreaterThan(-1);
      expect(badgeIndex).toBeGreaterThan(-1);
      expect(headlineIndex).toBeLessThan(badgeIndex);
    });
  });

  it("shows an uneven fixture as on, with a nudge", () => {
    const html = renderFixturePage({
      ...BASE,
      view: { status: "confirmed", flags: ["uneven"], spotsLeft: 3, needsOwnerAttention: true },
    });
    expect(html).toMatch(/confirmed|game is on/i);
    expect(html).toMatch(/odd number|one more|uneven/i);
  });

  it("never uses forbidden vocabulary in copy", () => {
    const html = renderFixturePage(BASE).toLowerCase();
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
      expect(html).toMatch(/aren(&#39;|')t open yet|not open yet/i);
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
            view: { status: readOnlyReason, flags: [], spotsLeft: 0, needsOwnerAttention: false },
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
        view: { status: "played", flags: [], spotsLeft: 0, needsOwnerAttention: false },
        viewer: { playerId: "p1", status: "in" },
        readOnlyReason: "played",
      });
      expect(html).toMatch(/you were in/i);
      expect(html).not.toMatch(/you're in/i);
    });

    it("tells a player who was in that the fixture was cancelled", () => {
      const html = renderFixturePage({
        ...BASE,
        view: { status: "cancelled", flags: [], spotsLeft: 0, needsOwnerAttention: false },
        viewer: { playerId: "p1", status: "in" },
        readOnlyReason: "cancelled",
      });
      expect(html).toMatch(/you were in.*cancelled/i);
    });

    it("gives a pending viewer no headline at all against a terminal fixture", () => {
      const html = renderFixturePage({
        ...BASE,
        view: { status: "played", flags: [], spotsLeft: 0, needsOwnerAttention: false },
        viewer: { playerId: "p2", status: "pending" },
        readOnlyReason: "played",
      });
      expect(html).not.toContain('class="viewer-headline"');
    });
  });
});
