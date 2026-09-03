import { describe, expect, it } from "vitest";
import { renderStandingsSection } from "../../src/views/league-table.js";
import { buildLeagueTable, type LeagueTally } from "../../src/domain/league-table.js";
import { LEAGUE_CSS } from "../../src/views/styles.js";

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

/**
 * The own-row mark, asserted on the stylesheet rather than the markup.
 *
 * `renderStandingsSection` puts `class="you"` on the right row and that is
 * already covered above — but until M52 the CSS behind it read
 * `tr.you .league-player { background: var(--bg) }`, and `.league-player`
 * already sets exactly that for its sticky column. The rule changed nothing,
 * so the entire mark was `font-weight: 600`: in a fourteen-row squad at 390px,
 * finding your own row meant reading every name.
 *
 * The principle it serves is worth protecting — the row is marked where it
 * falls, never moved to the top, because a table that reprints your row above
 * the people above you is not a league table any more. That makes the strength
 * of the mark the whole feature.
 */
describe("LEAGUE_CSS own-row mark", () => {
  const ownRow = /table\.league tbody tr\.you\b[^{]*\{([^}]*)\}/g;

  /** Every declaration block that targets the viewer's own row. */
  function ownRowRules(): string[] {
    return [...LEAGUE_CSS.matchAll(ownRow)].map((m) => m[1]!);
  }

  it("marks the row with more than a font weight", () => {
    const declarations = ownRowRules().join(" ");

    expect(declarations).toMatch(/font-weight/);
    expect(
      /background/.test(declarations),
      "the own row needs a visible ground, not just bold text",
    ).toBe(true);
  });

  it("does not set the own row's background to the value the cell already has", () => {
    // The exact no-op that shipped: `.league-player` is `background: var(--bg)`
    // for its sticky column, so repeating it for `tr.you` is not a mark.
    const playerCell = /table\.league \.league-player\s*\{([^}]*)\}/.exec(LEAGUE_CSS)?.[1] ?? "";
    const cellBackground = /background:\s*var\((--[a-z-]+)\)/.exec(playerCell)?.[1];

    for (const rule of ownRowRules()) {
      const marked = /background:\s*var\((--[a-z-]+)\)/.exec(rule)?.[1];
      if (marked !== undefined) expect(marked).not.toBe(cellBackground);
    }
  });

  it("keeps the sticky player cell opaque, so a scrolled row shows no seam", () => {
    // The player column is `position: sticky`, so it must carry its own
    // background — a transparent cell lets the scrolled numbers slide under the
    // name. Tinting only the row's `td`s would reintroduce exactly that on the
    // one row the tint exists for, so the tint has to be restated here.
    const stickyOwnCell = [...LEAGUE_CSS.matchAll(ownRow)].find((m) =>
      m[0].includes(".league-player"),
    );

    expect(
      stickyOwnCell?.[1],
      "tr.you .league-player must restate the row tint, or the sticky cell keeps the plain ground",
    ).toMatch(/background:\s*var\(--[a-z-]+\)/);

    const rowTint = [...LEAGUE_CSS.matchAll(ownRow)]
      .filter((m) => !m[0].includes(".league-player"))
      .map((m) => /background:\s*var\((--[a-z-]+)\)/.exec(m[1]!)?.[1])
      .find((token) => token !== undefined);
    const cellTint = /background:\s*var\((--[a-z-]+)\)/.exec(stickyOwnCell?.[1] ?? "")?.[1];

    expect(cellTint, "the sticky cell's tint must match the row's").toBe(rowTint);
  });
});
