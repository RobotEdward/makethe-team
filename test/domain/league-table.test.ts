import { describe, expect, it } from "vitest";
import { buildLeagueTable, type LeagueTally } from "../../src/domain/league-table.js";

function tally(overrides: Partial<LeagueTally> = {}): LeagueTally {
  return {
    playerId: "p-1",
    name: "Ada Okafor",
    erasedAt: null,
    played: 0,
    won: 0,
    lost: 0,
    drawn: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    ...overrides,
  };
}

describe("buildLeagueTable", () => {
  it("awards three points for a win and one for a draw", () => {
    const [row] = buildLeagueTable([tally({ played: 6, won: 3, lost: 2, drawn: 1 })]);

    expect(row!.points).toBe(10);
  });

  it("takes the win percentage over settled games, not every game played", () => {
    // Nine played, one of them never settled: 3 of 8, not 3 of 9.
    const [row] = buildLeagueTable([tally({ played: 9, won: 3, lost: 4, drawn: 1 })]);

    expect(row!.winPercent).toBe(37.5);
  });

  it("has no win percentage for a player whose games have all gone unsettled", () => {
    const [row] = buildLeagueTable([tally({ played: 4 })]);

    expect(row!.winPercent).toBeNull();
  });

  it("takes goal difference as scored minus conceded", () => {
    const [row] = buildLeagueTable([tally({ played: 3, goalsFor: 11, goalsAgainst: 4 })]);

    expect(row!.goalDifference).toBe(7);
  });

  it("orders by points, then goal difference, then wins", () => {
    const table = buildLeagueTable([
      tally({ playerId: "p-level", name: "Level", won: 2, drawn: 0, goalsFor: 5, goalsAgainst: 5 }),
      tally({ playerId: "p-top", name: "Top", won: 3, drawn: 0 }),
      tally({ playerId: "p-better-gd", name: "Better GD", won: 2, goalsFor: 9, goalsAgainst: 1 }),
    ]);

    expect(table.map((row) => row.playerId)).toEqual(["p-top", "p-better-gd", "p-level"]);
  });

  it("puts more wins above fewer when points and goal difference tie", () => {
    const table = buildLeagueTable([
      // Both on 4 points and level on goals: one win and one draw beats none.
      tally({ playerId: "p-draws", name: "Draws", won: 1, drawn: 1 }),
      tally({ playerId: "p-wins", name: "Wins", won: 1, drawn: 1 }),
      tally({ playerId: "p-none", name: "None", won: 0, drawn: 4 }),
    ]);

    expect(table.map((row) => row.playerId)).toEqual(["p-draws", "p-wins", "p-none"]);
  });

  it("breaks a total tie by name, so the order cannot depend on the row order", () => {
    const ascending = buildLeagueTable([
      tally({ playerId: "p-2", name: "Zoe", won: 1 }),
      tally({ playerId: "p-1", name: "Adam", won: 1 }),
    ]);

    expect(ascending.map((row) => row.name)).toEqual(["Adam", "Zoe"]);
  });

  it("calls an erased player by the label, never by the stored placeholder", () => {
    const [row] = buildLeagueTable([
      tally({ name: "[erased player]", erasedAt: new Date("2026-01-01T00:00:00Z") }),
    ]);

    expect(row!.name).toBe("a former player");
  });

  it("is empty for a squad nobody has played in", () => {
    expect(buildLeagueTable([])).toEqual([]);
  });
});
