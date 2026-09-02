import { describe, expect, it } from "vitest";
import { renderStandingsSection } from "../../src/views/league-table.js";
import { buildLeagueTable, type LeagueTally } from "../../src/domain/league-table.js";

function tally(overrides: Partial<LeagueTally> = {}): LeagueTally {
  return {
    playerId: "p-1",
    name: "Ada Okafor",
    erasedAt: null,
    played: 6,
    won: 3,
    lost: 2,
    drawn: 1,
    goalsFor: 14,
    goalsAgainst: 9,
    ...overrides,
  };
}

const render = (tallies: readonly LeagueTally[], viewerPlayerId = "someone-else") =>
  renderStandingsSection(buildLeagueTable(tallies), viewerPlayerId);

describe("the standings section", () => {
  it("heads the columns with the league-table abbreviations", () => {
    const html = render([tally()]);

    expect(html).toContain("Standings");
    expect(html).toContain(`<abbr title="Played">P</abbr>`);
    expect(html).toContain(`<abbr title="Won">W</abbr>`);
    expect(html).toContain(`<abbr title="Lost">L</abbr>`);
    expect(html).toContain(`<abbr title="Drawn">D</abbr>`);
    expect(html).toContain(`<abbr title="Goal difference">GD</abbr>`);
    expect(html).toContain(`<abbr title="Points">Pts</abbr>`);
  });

  it("shows a player's record, points and win percentage", () => {
    const html = render([tally()]);

    expect(html).toContain("Ada Okafor");
    // Three wins and a draw.
    expect(html).toContain(`<td class="count">10</td>`);
    // 14 for, 9 against.
    expect(html).toContain(`<td class="count">+5</td>`);
    // Three of six settled.
    expect(html).toContain("50%");
  });

  it("signs a negative goal difference and writes a level one as nought", () => {
    expect(render([tally({ goalsFor: 2, goalsAgainst: 7 })])).toContain(
      `<td class="count">−5</td>`,
    );
    expect(render([tally({ goalsFor: 4, goalsAgainst: 4 })])).toContain(
      `<td class="count">0</td>`,
    );
  });

  it("leaves the win percentage blank for a player with no settled games", () => {
    const html = render([tally({ won: 0, lost: 0, drawn: 0, goalsFor: 0, goalsAgainst: 0 })]);

    expect(html).toContain(`<td class="count">—</td>`);
    expect(html).not.toContain("0%");
  });

  it("marks the viewer's own row", () => {
    const html = render([tally({ playerId: "p-me" })], "p-me");

    expect(html).toContain(`class="you"`);
  });

  it("leaves every other row unmarked", () => {
    expect(render([tally({ playerId: "p-them" })], "p-me")).not.toContain(`class="you"`);
  });

  it("escapes a player's name", () => {
    const html = render([tally({ name: `Bob <script>alert(1)</script>` })]);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Bob &lt;script&gt;");
  });

  it("calls an erased player by the label, never by the stored placeholder", () => {
    const html = render([
      tally({ name: "[erased player]", erasedAt: new Date("2026-01-01T00:00:00Z") }),
    ]);

    expect(html).toContain("a former player");
    expect(html).not.toContain("[erased player]");
  });

  it("carries the full name in a title, since the column truncates a long one", () => {
    const html = render([tally({ name: "Christopher Wetherby-Smythe" })]);

    expect(html).toContain(`<span class="league-name" title="Christopher Wetherby-Smythe">`);
  });

  it("escapes the name in the title as well as in the cell", () => {
    const html = render([tally({ name: `Bo "The Wall" <b>` })]);

    expect(html).toContain(`title="Bo &quot;The Wall&quot; &lt;b&gt;"`);
  });

  it("says goal difference only counts the games with an agreed score", () => {
    expect(render([tally()])).toContain("agreed score");
  });

  it("renders nothing at all when nobody in the squad has played", () => {
    expect(renderStandingsSection([], "p-me")).toBe("");
  });

  it("renders nothing at all when the standings are not this viewer's to see", () => {
    expect(renderStandingsSection(null, "p-me")).toBe("");
  });
});
