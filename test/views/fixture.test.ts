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
    expect(html).toMatch(/you're in/i);
  });
});
