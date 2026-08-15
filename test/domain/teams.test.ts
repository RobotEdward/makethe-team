import { describe, expect, it } from "vitest";
import {
  assignedButNotIn,
  isTeamId,
  sideCounts,
  teamNames,
  teamsNeedAnotherLook,
  unassignedIn,
  type TeamAssignment,
} from "../../src/domain/teams.js";

const row = (over: Partial<TeamAssignment> = {}): TeamAssignment => ({
  playerId: crypto.randomUUID(),
  status: "in",
  team: "a",
  ...over,
});

describe("teamsNeedAnotherLook", () => {
  it("is false for a complete, current pick", () => {
    expect(teamsNeedAnotherLook([row({ team: "a" }), row({ team: "b" })])).toBe(false);
  });

  // Condition 1: a waitlist promotion or a new guest arrived after the pick.
  it("is true when someone is in with no side", () => {
    expect(teamsNeedAnotherLook([row({ team: "a" }), row({ team: null })])).toBe(true);
  });

  // Condition 2, the ordinary drop-out.
  it("is true when someone has a side but answered out", () => {
    expect(teamsNeedAnotherLook([row({ team: "a" }), row({ team: "b", status: "out" })])).toBe(true);
  });

  // Condition 2, the case a filtered query would miss. Leaving a game,
  // being removed by an organiser, and being erased ALL write `withdrawn`,
  // so this is the most common way teams go stale — not an edge case.
  it("is true when someone has a side but was withdrawn", () => {
    expect(teamsNeedAnotherLook([row({ team: "a" }), row({ team: "b", status: "withdrawn" })])).toBe(true);
  });

  // A waitlisted player is not offered a side, so their absence from one is
  // not a change to react to.
  it("is false when a waitlisted player has no side", () => {
    expect(teamsNeedAnotherLook([row({ team: "a" }), row({ team: null, status: "waitlisted" })])).toBe(false);
  });

  it("is false for a fixture nobody has picked at all", () => {
    expect(teamsNeedAnotherLook([row({ team: null }), row({ team: null })])).toBe(false);
  });
});

describe("unassignedIn", () => {
  it("returns only in players with no side", () => {
    const waiting = row({ team: null, status: "waitlisted" });
    const needed = row({ team: null });
    expect(unassignedIn([row(), needed, waiting]).map((r) => r.playerId)).toEqual([needed.playerId]);
  });
});

describe("assignedButNotIn", () => {
  it("includes withdrawn as well as out", () => {
    const gone = row({ team: "a", status: "withdrawn" });
    const dropped = row({ team: "b", status: "out" });
    expect(assignedButNotIn([row(), gone, dropped]).map((r) => r.playerId).sort()).toEqual(
      [gone.playerId, dropped.playerId].sort(),
    );
  });
});

describe("sideCounts", () => {
  // Only `in` players count. A withdrawn player keeps their team value, and
  // counting them would report a side that is one bigger than turns up.
  it("counts only players who are in", () => {
    expect(
      sideCounts([row({ team: "a" }), row({ team: "a", status: "withdrawn" }), row({ team: "b" })]),
    ).toEqual({ a: 1, b: 1 });
  });
});

describe("teamNames", () => {
  it("maps each side to the game's name for it", () => {
    expect(teamNames({ teamAName: "Bibs", teamBName: "Skins" })).toEqual({ a: "Bibs", b: "Skins" });
  });
});

// This guards an organiser-submitted form value (Task 3) before it reaches a
// database write, so it must reject everything that is not exactly "a" or "b".
describe("isTeamId", () => {
  it("accepts the two valid sides", () => {
    expect(isTeamId("a")).toBe(true);
    expect(isTeamId("b")).toBe(true);
  });

  it("rejects other strings, non-strings, null and undefined", () => {
    expect(isTeamId("c")).toBe(false);
    expect(isTeamId("")).toBe(false);
    expect(isTeamId("A")).toBe(false);
    expect(isTeamId(1)).toBe(false);
    expect(isTeamId(null)).toBe(false);
    expect(isTeamId(undefined)).toBe(false);
  });
});
