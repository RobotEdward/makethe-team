import { describe, expect, it } from "vitest";
import {
  buildLeagueTable,
  sortStandings,
  standingsSortOrDefault,
  type LeagueTally,
} from "../../src/domain/league-table.js";

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

/**
 * The sort a player picks off a column heading (M59).
 *
 * Every case below builds its rows through `buildLeagueTable`, because
 * `sortStandings` is defined as a re-sort of that output and inherits its
 * tiebreak: the assertions are about which key comes first, not about a
 * comparator working on rows nobody could have.
 */
describe("sortStandings", () => {
  const squad = () =>
    buildLeagueTable([
      tally({ playerId: "p-ana", name: "Ana", played: 9, won: 4, lost: 3, drawn: 2, goalsFor: 12, goalsAgainst: 11 }),
      tally({ playerId: "p-ben", name: "Ben", played: 8, won: 6, lost: 1, drawn: 1, goalsFor: 20, goalsAgainst: 13 }),
      tally({ playerId: "p-cal", name: "Cal", played: 12, won: 2, lost: 8, drawn: 2, goalsFor: 7, goalsAgainst: 19 }),
    ]);

  it("leaves the league order alone under the default sort", () => {
    expect(sortStandings(squad(), "points").map((row) => row.playerId)).toEqual([
      "p-ben",
      "p-ana",
      "p-cal",
    ]);
  });

  it("puts the most-played player first", () => {
    expect(sortStandings(squad(), "played").map((row) => row.playerId)).toEqual([
      "p-cal",
      "p-ana",
      "p-ben",
    ]);
  });

  it("puts the most losses first, because that is what the column is asked for", () => {
    expect(sortStandings(squad(), "lost").map((row) => row.playerId)).toEqual([
      "p-cal",
      "p-ana",
      "p-ben",
    ]);
  });

  it("sorts the player column A to Z, the one column that reads upwards", () => {
    expect(sortStandings(squad(), "player").map((row) => row.name)).toEqual(["Ana", "Ben", "Cal"]);
  });

  it("sorts goal difference by the signed number, not its size", () => {
    expect(sortStandings(squad(), "gd").map((row) => row.goalDifference)).toEqual([7, 1, -12]);
  });

  /**
   * A null win percentage means "no games settled", and `buildLeagueTable`'s
   * own comment says why that is not nought: sorted as nought it would land
   * above every player who has settled a game and lost most of them, which
   * ranks a blank record above a real one.
   */
  it("sorts a player with no settled games last, never as nought", () => {
    const table = buildLeagueTable([
      tally({ playerId: "p-none", name: "None", played: 4 }),
      tally({ playerId: "p-poor", name: "Poor", played: 4, won: 1, lost: 3 }),
    ]);

    expect(sortStandings(table, "winpct").map((row) => row.playerId)).toEqual(["p-poor", "p-none"]);
  });

  /**
   * The comparator has to be total for the same reason `buildLeagueTable`'s
   * is: two players level on the sorted column must not swap places between
   * reloads. The league order underneath is what settles them.
   */
  it("settles a tie on the sorted column by the league order underneath", () => {
    const table = buildLeagueTable([
      tally({ playerId: "p-weak", name: "Weak", played: 5, won: 1, lost: 4 }),
      tally({ playerId: "p-strong", name: "Strong", played: 5, won: 4, lost: 1, goalsFor: 9, goalsAgainst: 2 }),
    ]);

    expect(sortStandings(table, "played").map((row) => row.playerId)).toEqual([
      "p-strong",
      "p-weak",
    ]);
  });

  it("does not disturb the table it was handed", () => {
    const table = squad();
    sortStandings(table, "played");

    expect(table.map((row) => row.playerId)).toEqual(["p-ben", "p-ana", "p-cal"]);
  });
});

/**
 * The stored value is `text` with no CHECK constraint behind it, so a row can
 * hold anything a past release wrote (see `test/stored-lookups.test.ts`).
 */
describe("standingsSortOrDefault", () => {
  it("keeps a sort the table knows", () => {
    expect(standingsSortOrDefault("won")).toBe("won");
  });

  it("falls back to the league order for a player who has never chosen", () => {
    expect(standingsSortOrDefault(null)).toBe("points");
  });

  it("falls back to the league order for a value no release of this table wrote", () => {
    expect(standingsSortOrDefault("goals-per-90")).toBe("points");
  });

  it("cannot be talked into an inherited property of the lookup", () => {
    expect(standingsSortOrDefault("toString")).toBe("points");
    expect(standingsSortOrDefault("__proto__")).toBe("points");
  });
});
