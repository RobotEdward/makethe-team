import { describe, expect, it } from "vitest";
import { renderResultPanel, outcomeNames, type ResultPanelParams } from "../../src/views/result.js";
import { deriveResult, tally, type ResultClaim } from "../../src/domain/result.js";

const NAMES = outcomeNames({ teamAName: "Bibs", teamBName: "Skins" });

function claim(playerId: string, overrides: Partial<ResultClaim> = {}): ResultClaim {
  return {
    playerId,
    outcome: "a",
    scoreA: null,
    scoreB: null,
    filedAt: new Date("2026-08-13T20:00:00Z"),
    ...overrides,
  };
}

function params(overrides: Partial<ResultPanelParams> = {}): ResultPanelParams {
  return {
    names: NAMES,
    candidates: [],
    derived: null,
    locked: false,
    writable: true,
    eligible: true,
    rostered: true,
    yourPlayerId: "p1",
    deadlineLocal: "Sat 15 Aug, 7:00pm",
    actionPath: "/g/g1/f/f1/result",
    clearPath: "/g/g1/f/f1/result/clear",
    ...overrides,
  };
}

describe("renderResultPanel", () => {
  it("offers the game's own side names, not Team A and Team B", () => {
    const html = renderResultPanel(params());
    expect(html).toContain("Bibs");
    expect(html).toContain("Skins");
    expect(html).not.toContain("Team A");
  });

  it("shows the deadline while the window is open", () => {
    expect(renderResultPanel(params())).toContain("Sat 15 Aug, 7:00pm");
  });

  it("lists each candidate with its backer count and marks the viewer's own", () => {
    const claims = [claim("p1"), claim("p2"), claim("p3", { outcome: "b" })];
    const html = renderResultPanel(params({ candidates: tally(claims) }));
    expect(html).toContain("2");
    expect(html).toContain("your pick");
  });

  it("renders an agree form per candidate that posts values, never an id", () => {
    const html = renderResultPanel(params({ candidates: tally([claim("p2", { scoreA: 3, scoreB: 2 })]) }));
    expect(html).toContain('name="outcome"');
    expect(html).toContain('value="3"');
    // Nothing may name a candidate by id: with no id in the form there is
    // nothing a tampered submission can point at but its own single vote.
    expect(html).not.toContain("candidateId");
  });

  it("shows both confidence figures when locked", () => {
    const derived = deriveResult(
      [claim("p1", { scoreA: 3, scoreB: 2 }), claim("p2", { scoreA: 3, scoreB: 2 }), claim("p3")],
      new Set(),
    );
    const html = renderResultPanel(params({ derived, locked: true, writable: false }));
    expect(html).toContain("Bibs won 3–2");
    expect(html).toContain("3 of 3");
    expect(html).toContain("2 of 3");
  });

  it("says the score was not agreed when the winning outcome had no scores", () => {
    const derived = deriveResult([claim("p1"), claim("p2")], new Set());
    const html = renderResultPanel(params({ derived, locked: true, writable: false }));
    expect(html).toContain("Bibs won");
    expect(html).toContain("Score not agreed");
  });

  it("says so when the fixture was never rostered", () => {
    const derived = deriveResult([claim("p1")], new Set());
    const html = renderResultPanel(params({ derived, locked: true, writable: false, rostered: false }));
    expect(html).toContain("Teams weren't picked");
  });

  it("still offers the form after the deadline when nothing was filed", () => {
    const html = renderResultPanel(params({ locked: false, writable: true, candidates: [], derived: null }));
    expect(html).toContain("No result recorded");
    expect(html).toContain("<form");
  });

  it("offers no form to someone who was not in the fixture", () => {
    const html = renderResultPanel(params({ eligible: false }));
    expect(html).not.toContain("<form");
  });

  it("escapes a side name containing markup", () => {
    const html = renderResultPanel(
      params({ names: outcomeNames({ teamAName: '<script>x</script>', teamBName: "Skins" }) }),
    );
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says nothing rather than throwing on an outcome this build cannot name", () => {
    // The stored-lookup rule: `outcome` is a bare text column with no CHECK,
    // so a row can carry a value the union says is impossible, and
    // `escapeHtml(undefined)` throws and 500s the page.
    const derived = deriveResult([claim("p1", { outcome: "abandoned" as never })], new Set());
    expect(() => renderResultPanel(params({ derived, locked: true, writable: false }))).not.toThrow();
  });
});
