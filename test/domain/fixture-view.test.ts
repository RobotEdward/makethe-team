import { describe, expect, it } from "vitest";
import { fixtureView, type FixtureFacts } from "../../src/domain/fixture-view.js";

const KICKOFF = new Date("2026-08-13T18:00:00Z");
const INSIDE_WINDOW = new Date("2026-08-13T09:00:00Z"); // 9 hours before
const OUTSIDE_WINDOW = new Date("2026-08-11T09:00:00Z"); // 2 days before

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

describe("terminal and pre-open lifecycles", () => {
  it.each(["scheduled", "cancelled", "played"] as const)("reports %s verbatim", (lifecycle) => {
    const view = fixtureView(facts({ lifecycle, inCount: 11 }), INSIDE_WINDOW);

    expect(view.status).toBe(lifecycle);
    expect(view.flags).toEqual([]);
    expect(view.needsOwnerAttention).toBe(false);
  });

  it("reports the real remaining capacity on a scheduled fixture", () => {
    // Every fixture that exists before a fixture opens is scheduled and empty.
    // Reporting 0 here would have a renderer say "0 spots left" on a fixture
    // nobody has even been asked about.
    const empty = fixtureView(facts({ lifecycle: "scheduled", inCount: 0 }), INSIDE_WINDOW);
    expect(empty.spotsLeft).toBe(14);

    const partial = fixtureView(facts({ lifecycle: "scheduled", inCount: 11 }), INSIDE_WINDOW);
    expect(partial.spotsLeft).toBe(3);
  });

  it.each(["cancelled", "played"] as const)("reports no spots left on a %s fixture", (lifecycle) => {
    // Terminal: nobody can join, so remaining capacity is meaningless.
    expect(fixtureView(facts({ lifecycle, inCount: 0 }), INSIDE_WINDOW).spotsLeft).toBe(0);
  });
});

describe("below the minimum", () => {
  it("is merely open outside the warning window", () => {
    const view = fixtureView(facts({ inCount: 8 }), OUTSIDE_WINDOW);

    expect(view.status).toBe("open");
    expect(view.needsOwnerAttention).toBe(false);
  });

  it("is short inside the warning window", () => {
    const view = fixtureView(facts({ inCount: 8 }), INSIDE_WINDOW);

    expect(view.status).toBe("short");
    expect(view.needsOwnerAttention).toBe(true);
  });

  it("is never flagged uneven, even on an odd count (BR-30)", () => {
    const view = fixtureView(facts({ inCount: 9 }), INSIDE_WINDOW);

    expect(view.status).toBe("short");
    expect(view.flags).not.toContain("uneven");
  });
});

describe("parity — the organiser's example", () => {
  const table: Array<[number, string, boolean]> = [
    [9, "short", false],
    [10, "confirmed", false],
    [11, "confirmed", true],
    [12, "confirmed", false],
    [13, "confirmed", true],
    [14, "confirmed", false],
  ];

  it.each(table)("%i in reports %s, uneven=%s", (inCount, status, uneven) => {
    const view = fixtureView(facts({ inCount }), INSIDE_WINDOW);

    expect(view.status).toBe(status);
    expect(view.flags.includes("uneven")).toBe(uneven);
  });

  it("never flags uneven when the game does not care", () => {
    const view = fixtureView(facts({ inCount: 11, prefersEvenNumbers: false }), INSIDE_WINDOW);

    expect(view.status).toBe("confirmed");
    expect(view.flags).not.toContain("uneven");
    expect(view.needsOwnerAttention).toBe(false);
  });

  it("does not raise attention for an odd count outside the window", () => {
    const view = fixtureView(facts({ inCount: 11 }), OUTSIDE_WINDOW);

    expect(view.status).toBe("confirmed");
    expect(view.flags).toContain("uneven");
    expect(view.needsOwnerAttention).toBe(false);
  });
});

describe("capacity flags", () => {
  it("flags full at exactly max", () => {
    const view = fixtureView(facts({ inCount: 14 }), INSIDE_WINDOW);

    expect(view.flags).toContain("full");
    expect(view.flags).not.toContain("over_capacity");
    expect(view.spotsLeft).toBe(0);
  });

  it("flags over capacity beyond max (BR-8)", () => {
    const view = fixtureView(facts({ inCount: 16 }), INSIDE_WINDOW);

    expect(view.flags).toContain("over_capacity");
    expect(view.flags).not.toContain("full");
    expect(view.spotsLeft).toBe(0);
  });

  it("reports remaining spots below max", () => {
    expect(fixtureView(facts({ inCount: 11 }), INSIDE_WINDOW).spotsLeft).toBe(3);
  });
});

describe("the counts a renderer needs", () => {
  it("carries the counts a renderer needs through to the view", () => {
    const view = fixtureView(facts({ inCount: 9 }), INSIDE_WINDOW);
    expect(view.inCount).toBe(9);
    expect(view.minPlayers).toBe(facts({}).minPlayers);
    expect(view.maxPlayers).toBe(facts({}).maxPlayers);
  });

  it.each(["scheduled", "cancelled", "played"] as const)("carries them on a %s fixture too", (lifecycle) => {
    // The non-open lifecycles leave by a different `return` from the one
    // above, so that is where the three fields go missing — and a renderer
    // handed `undefined` prints "NaN of undefined" rather than throwing, so
    // no other test would catch it.
    const view = fixtureView(facts({ lifecycle, inCount: 9 }), INSIDE_WINDOW);
    expect(view.inCount).toBe(9);
    expect(view.minPlayers).toBe(10);
    expect(view.maxPlayers).toBe(14);
  });
});

describe("the warning window boundary", () => {
  it("opens exactly at the offset", () => {
    const boundary = new Date(KICKOFF.getTime() - 12 * 3_600_000);

    expect(fixtureView(facts({ inCount: 8 }), boundary).status).toBe("short");
    expect(fixtureView(facts({ inCount: 8 }), new Date(boundary.getTime() - 1)).status).toBe("open");
  });

  it("respects a per-game offset", () => {
    const at18Hours = new Date(KICKOFF.getTime() - 18 * 3_600_000);

    expect(fixtureView(facts({ inCount: 8, shortWarningOffsetHours: 24 }), at18Hours).status).toBe("short");
    expect(fixtureView(facts({ inCount: 8, shortWarningOffsetHours: 12 }), at18Hours).status).toBe("open");
  });

  it("still reports short after kickoff has passed", () => {
    const afterKickoff = new Date(KICKOFF.getTime() + 3_600_000);

    expect(fixtureView(facts({ inCount: 8 }), afterKickoff).status).toBe("short");
  });
});

describe("purity", () => {
  it("does not mutate its input", () => {
    const input = facts({ inCount: 11 });
    const snapshot = JSON.stringify(input);

    fixtureView(input, INSIDE_WINDOW);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
