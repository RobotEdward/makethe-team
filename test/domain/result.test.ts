import { describe, expect, it } from "vitest";
import {
  deriveResult,
  outcomeFromScore,
  parseClaim,
  tally,
  type ResultClaim,
} from "../../src/domain/result.js";

const T = (minutes: number) => new Date(Date.UTC(2026, 7, 13, 20, minutes));

function claim(overrides: Partial<ResultClaim> & { playerId: string }): ResultClaim {
  return { outcome: "a", scoreA: null, scoreB: null, filedAt: T(0), ...overrides };
}

const NOBODY = new Set<string>();

describe("outcomeFromScore", () => {
  it("names the higher side and calls equal scores a draw", () => {
    expect(outcomeFromScore(3, 2)).toBe("a");
    expect(outcomeFromScore(2, 3)).toBe("b");
    expect(outcomeFromScore(0, 0)).toBe("draw");
  });
});

describe("parseClaim", () => {
  it("derives the outcome from the score and ignores the submitted one", () => {
    // The whole point: a row saying "3-2, draw" must be unconstructible,
    // because it would count toward an outcome its own score contradicts and
    // nothing in SQLite would catch it.
    const parsed = parseClaim({ outcome: "draw", scoreA: "3", scoreB: "2" });
    expect(parsed).toEqual({ ok: true, outcome: "a", scoreA: 3, scoreB: 2 });
  });

  it("accepts an outcome with no score", () => {
    expect(parseClaim({ outcome: "b", scoreA: "", scoreB: "" })).toEqual({
      ok: true,
      outcome: "b",
      scoreA: null,
      scoreB: null,
    });
  });

  it("refuses half a score", () => {
    const parsed = parseClaim({ outcome: "a", scoreA: "3", scoreB: "" });
    expect(parsed.ok).toBe(false);
  });

  it("refuses a negative, a fraction, a non-number and anything over the cap", () => {
    for (const bad of ["-1", "1.5", "three", "100"]) {
      expect(parseClaim({ outcome: "a", scoreA: bad, scoreB: "0" }).ok).toBe(false);
    }
  });

  it("refuses an outcome outside the union", () => {
    expect(parseClaim({ outcome: "abandoned", scoreA: "", scoreB: "" }).ok).toBe(false);
    expect(parseClaim({ outcome: undefined, scoreA: "", scoreB: "" }).ok).toBe(false);
  });
});

describe("tally", () => {
  it("counts a scored claim toward its outcome alongside an outcome-only one", () => {
    const claims = [
      claim({ playerId: "p1", outcome: "a", scoreA: 3, scoreB: 2 }),
      claim({ playerId: "p2", outcome: "a", scoreA: 3, scoreB: 2 }),
      claim({ playerId: "p3", outcome: "a" }),
    ];
    const [top] = tally(claims);
    expect(top?.outcome).toBe("a");
    expect(top?.backers).toHaveLength(3);
    expect(top?.unscoredBackers).toBe(1);
    expect(top?.scores).toHaveLength(1);
    expect(top?.scores[0]?.backers).toHaveLength(2);
  });

  it("keeps distinct scores within one outcome apart", () => {
    const claims = [
      claim({ playerId: "p1", outcome: "a", scoreA: 3, scoreB: 2 }),
      claim({ playerId: "p2", outcome: "a", scoreA: 4, scoreB: 2 }),
    ];
    expect(tally(claims)[0]?.scores).toHaveLength(2);
  });

  it("orders outcomes by backers, most first", () => {
    const claims = [
      claim({ playerId: "p1", outcome: "b" }),
      claim({ playerId: "p2", outcome: "a" }),
      claim({ playerId: "p3", outcome: "a" }),
    ];
    expect(tally(claims).map((c) => c.outcome)).toEqual(["a", "b"]);
  });
});

describe("deriveResult", () => {
  it("returns null when nobody has filed", () => {
    expect(deriveResult([], NOBODY)).toBeNull();
  });

  it("records the unanimous outcome and the majority margin separately", () => {
    // Five voters: three say Bibs 3-2, two say Bibs won with no score. The
    // squad is unanimous on the outcome; the margin is attested by three.
    // A flat tally would report "3-2, three backers" and throw the unanimity
    // away, which is backwards for anything fitted on this data.
    const claims = [
      claim({ playerId: "p1", outcome: "a", scoreA: 3, scoreB: 2 }),
      claim({ playerId: "p2", outcome: "a", scoreA: 3, scoreB: 2 }),
      claim({ playerId: "p3", outcome: "a", scoreA: 3, scoreB: 2 }),
      claim({ playerId: "p4", outcome: "a" }),
      claim({ playerId: "p5", outcome: "a" }),
    ];
    expect(deriveResult(claims, NOBODY)).toEqual({
      outcome: "a",
      outcomeBackers: 5,
      scoreA: 3,
      scoreB: 2,
      marginBackers: 3,
      voterCount: 5,
      distinctOutcomes: 1,
      distinctScores: 1,
    });
  });

  it("locks an outcome with no score when nobody gave one", () => {
    const derived = deriveResult([claim({ playerId: "p1", outcome: "draw" })], NOBODY);
    expect(derived?.scoreA).toBeNull();
    expect(derived?.marginBackers).toBe(0);
  });

  it("breaks an outcome tie on an organiser's backing", () => {
    const claims = [
      claim({ playerId: "p1", outcome: "a", filedAt: T(0) }),
      claim({ playerId: "owner", outcome: "b", filedAt: T(5) }),
    ];
    expect(deriveResult(claims, new Set(["owner"]))?.outcome).toBe("b");
  });

  it("breaks an outcome tie on filing order when no organiser voted", () => {
    const claims = [
      claim({ playerId: "p1", outcome: "a", filedAt: T(0) }),
      claim({ playerId: "p2", outcome: "b", filedAt: T(5) }),
    ];
    expect(deriveResult(claims, NOBODY)?.outcome).toBe("a");
  });

  it("prefers backers over an organiser's backing", () => {
    // The organiser breaks ties; it does not outvote the squad.
    const claims = [
      claim({ playerId: "p1", outcome: "a" }),
      claim({ playerId: "p2", outcome: "a" }),
      claim({ playerId: "owner", outcome: "b" }),
    ];
    expect(deriveResult(claims, new Set(["owner"]))?.outcome).toBe("a");
  });

  it("applies the same three steps to the margin", () => {
    const claims = [
      claim({ playerId: "p1", outcome: "a", scoreA: 3, scoreB: 2, filedAt: T(0) }),
      claim({ playerId: "owner", outcome: "a", scoreA: 4, scoreB: 2, filedAt: T(5) }),
    ];
    const derived = deriveResult(claims, new Set(["owner"]));
    expect([derived?.scoreA, derived?.scoreB]).toEqual([4, 2]);
  });

  it("ignores scores from a losing outcome when choosing the margin", () => {
    // Two people said Skins won 5-0. They lost the outcome vote, so their
    // score must not be able to become "Bibs won 5-0".
    const claims = [
      claim({ playerId: "p1", outcome: "a", scoreA: 1, scoreB: 0 }),
      claim({ playerId: "p2", outcome: "a", scoreA: 1, scoreB: 0 }),
      claim({ playerId: "p3", outcome: "a", scoreA: 1, scoreB: 0 }),
      claim({ playerId: "p4", outcome: "b", scoreA: 0, scoreB: 5 }),
      claim({ playerId: "p5", outcome: "b", scoreA: 0, scoreB: 5 }),
    ];
    const derived = deriveResult(claims, NOBODY);
    expect([derived?.scoreA, derived?.scoreB]).toEqual([1, 0]);
    expect(derived?.distinctScores).toBe(2);
  });
});
