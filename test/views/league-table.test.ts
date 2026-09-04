import { describe, expect, it } from "vitest";
import { renderStandingsSection } from "../../src/views/league-table.js";
import {
  buildLeagueTable,
  type LeagueTally,
  type StandingsSort,
} from "../../src/domain/league-table.js";
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

const render = (
  tallies: readonly LeagueTally[],
  viewerPlayerId = "someone-else",
  sort: StandingsSort = "points",
) => renderStandingsSection(buildLeagueTable(tallies), viewerPlayerId, sort);

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

    expect(html).toContain(`<td class="count win-pct">—</td>`);
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

/**
 * The position column (M55), and the one thing it must not do: present the
 * comparator's stability tiebreak as a ranking. `buildLeagueTable` breaks a
 * remaining tie on name and then player id so that `Array.prototype.sort` is
 * given a total order — those two keys exist to stop rows swapping between
 * reloads, not to say who finished ahead of whom.
 */
describe("the position column", () => {
  it("heads the column and numbers the rows", () => {
    const html = render([
      tally({ playerId: "p-1", name: "Ada Okafor", won: 5, drawn: 0, lost: 1, played: 6 }),
      tally({ playerId: "p-2", name: "Ben Ash", won: 1, drawn: 0, lost: 5, played: 6 }),
    ]);

    expect(html).toContain(`<abbr title="Position">#</abbr>`);
    expect(html).toContain(`<td class="rank">1</td>`);
    expect(html).toContain(`<td class="rank">2</td>`);
  });

  it("gives players level on points, goal difference and wins the same place", () => {
    // Identical on every sporting key; only the names differ, and the name is
    // exactly the key that must not decide a position.
    const html = render([
      tally({ playerId: "p-1", name: "Ada Okafor", won: 2, drawn: 0, lost: 0, played: 2, goalsFor: 4, goalsAgainst: 2 }),
      tally({ playerId: "p-2", name: "Ben Ash", won: 2, drawn: 0, lost: 0, played: 2, goalsFor: 4, goalsAgainst: 2 }),
      tally({ playerId: "p-3", name: "Cara Vine", won: 0, drawn: 0, lost: 2, played: 2, goalsFor: 0, goalsAgainst: 6 }),
    ]);

    const ranks = [...html.matchAll(/<td class="rank">(\d+)<\/td>/g)].map((match) => match[1]);

    // Standard competition ranking: the shared place is used twice and the
    // place it consumed is skipped, as every published league table does.
    expect(ranks).toEqual(["1", "1", "3"]);
  });

  it("separates players level on points but not on goal difference", () => {
    const html = render([
      tally({ playerId: "p-1", name: "Ada Okafor", won: 2, drawn: 0, lost: 0, played: 2, goalsFor: 9, goalsAgainst: 1 }),
      tally({ playerId: "p-2", name: "Ben Ash", won: 2, drawn: 0, lost: 0, played: 2, goalsFor: 3, goalsAgainst: 2 }),
    ]);

    const ranks = [...html.matchAll(/<td class="rank">(\d+)<\/td>/g)].map((match) => match[1]);

    expect(ranks).toEqual(["1", "2"]);
  });
});

/**
 * Which columns a phone keeps, and which it drops (M60).
 *
 * 390px fits about six columns. The four that survive are the ones a player
 * opens the table to read — how many they have played, their goal difference,
 * their win rate and their points — and W, L and D are what pays for them:
 * each is one *part* of a record the other four already summarise, and Pts and
 * Win% between them say what W, L and D say in three columns.
 *
 * Until M60 it was Win% that stepped aside, which had the table dropping the
 * summary and keeping the parts.
 */
describe("the columns a phone keeps", () => {
  /** The declarations inside the one narrow-screen block. */
  const narrowBlock = () =>
    /@media \(max-width: 40rem\) \{([\s\S]*?)\n {2}\}/.exec(LEAGUE_CSS)?.[1] ?? "";

  it("marks the three record columns so one rule can hide them together", () => {
    const html = render([tally()]);

    // Six cells: three headings and three counts, for one player.
    expect(html.match(/record-col/g)).toHaveLength(6);
  });

  it("hides W, L and D on a narrow screen, and nothing else", () => {
    const narrow = narrowBlock();

    expect(narrow).toContain(".record-col { display: none; }");
    // Presence pinned as well as absence: an empty match would satisfy every
    // `not.toContain` below without hiding anything at all.
    expect(narrow).not.toBe("");
    expect(narrow).not.toContain(".rank { display: none");
    expect(narrow).not.toContain(".league-player { display: none");
  });

  it("keeps Win% and its note at every width, now that the column always renders", () => {
    const html = render([tally()]);
    const narrow = narrowBlock();

    expect(html).toContain(`class="count win-pct"`);
    expect(html).not.toContain("win-pct-note");
    expect(narrow).not.toContain(".win-pct { display: none");
  });
});

/**
 * The column being sorted on is never the hidden one (M60).
 *
 * A phone dropping W, L and D would otherwise leave a player who sorted by
 * wins looking at a table ordered by a column that is not on the screen, which
 * reads as no order at all. The page knows the sort, so it says so in a class
 * on the table and the stylesheet puts that one column back.
 */
describe("the sorted column on a narrow screen", () => {
  it("names the sorted record column on the table itself", () => {
    expect(render([tally()], "someone-else", "won")).toContain(`class="league sorted-won"`);
    expect(render([tally()], "someone-else", "lost")).toContain(`class="league sorted-lost"`);
    expect(render([tally()], "someone-else", "drawn")).toContain(`class="league sorted-drawn"`);
  });

  it("says nothing when the sorted column is one a phone shows anyway", () => {
    const html = render([tally()], "someone-else", "gd");

    expect(html).toContain(`class="league"`);
    expect(html).not.toContain("sorted-");
  });

  it("puts that column back at phone width, one rule per column", () => {
    const narrow = /@media \(max-width: 40rem\) \{([\s\S]*?)\n {2}\}/.exec(LEAGUE_CSS)?.[1] ?? "";

    for (const column of ["won", "lost", "drawn"]) {
      expect(narrow).toContain(`table.league.sorted-${column} .col-${column} { display: table-cell; }`);
    }
  });

  it("gives every record column the class its restore rule selects on", () => {
    const html = render([tally()]);

    for (const column of ["won", "lost", "drawn"]) {
      // A heading and a cell each, and the restore rule matches neither
      // without them.
      expect(html.match(new RegExp(`col-${column}`, "g"))).toHaveLength(2);
    }
  });
});

/**
 * Sorting the table from its column headings (M59).
 *
 * The links are plain query strings on the page's own path, so the whole
 * feature works with no script — and the choice a player makes is stored
 * against them by the route behind the link, not by anything here.
 */
describe("the standings sort headings", () => {
  const squad = () => [
    tally({ playerId: "p-ana", name: "Ana", played: 9, won: 4, lost: 3, drawn: 2 }),
    tally({ playerId: "p-ben", name: "Ben", played: 8, won: 6, lost: 1, drawn: 1, goalsFor: 20, goalsAgainst: 4 }),
    tally({ playerId: "p-cal", name: "Cal", played: 12, won: 2, lost: 8, drawn: 2, goalsFor: 3, goalsAgainst: 19 }),
  ];

  it("makes every sortable heading a link to its own column", () => {
    const html = render(squad());

    for (const sort of ["player", "played", "won", "lost", "drawn", "gd", "winpct"]) {
      expect(html).toContain(`href="?sort=${sort}"`);
    }
  });

  it("does not link the column already sorted on, which has nowhere to go", () => {
    const html = render(squad(), "someone-else", "won");

    expect(html).not.toContain(`href="?sort=won"`);
    // …and the one it came from is a link again, which is the way back.
    expect(html).toContain(`href="?sort=points"`);
  });

  it("gives the position column no link of its own, because Pts is that sort", () => {
    expect(render(squad())).not.toContain(`href="?sort=pos"`);
  });

  it("marks the sorted column for a screen reader as well as an eye", () => {
    const html = render(squad(), "someone-else", "played");

    expect(html).toContain(`aria-sort="descending"`);
    expect(html.match(/aria-sort=/g)).toHaveLength(1);
  });

  it("calls the player column's direction ascending, because it reads A to Z", () => {
    expect(render(squad(), "someone-else", "player")).toContain(`aria-sort="ascending"`);
  });

  it("renders the rows in the sorted order", () => {
    const html = render(squad(), "someone-else", "played");

    expect(html.indexOf("Cal")).toBeLessThan(html.indexOf("Ana"));
    expect(html.indexOf("Ana")).toBeLessThan(html.indexOf("Ben"));
  });

  /**
   * Under the league sort the position column is the *league position*, ties
   * sharing a place — `leaguePositions` exists for that, and numbering the
   * rendered order there would print the alphabetical tiebreak as a place
   * somebody finished in.
   */
  it("keeps true league positions, shared ties and all, under the league sort", () => {
    const html = render([
      tally({ playerId: "p-a", name: "Ann", played: 2, won: 1, lost: 1, drawn: 0, goalsFor: 3, goalsAgainst: 3 }),
      tally({ playerId: "p-b", name: "Bea", played: 2, won: 1, lost: 1, drawn: 0, goalsFor: 3, goalsAgainst: 3 }),
      tally({ playerId: "p-c", name: "Cyd", played: 2, won: 0, lost: 2, drawn: 0, goalsFor: 0, goalsAgainst: 4 }),
    ]);

    expect(ranks(html)).toEqual(["1", "1", "3"]);
  });

  /**
   * Under any other sort the column can only be the row number: a position
   * column reading 3, 1, 5 beside rows ordered by something else is two
   * orderings printed on one table.
   */
  it("numbers the rows 1..n under any other sort", () => {
    expect(ranks(render(squad(), "someone-else", "played"))).toEqual(["1", "2", "3"]);
  });
});

/** The rendered contents of the position column, top row first. */
function ranks(html: string): string[] {
  return [...html.matchAll(/<td class="rank">([^<]*)<\/td>/g)].map((match) => match[1]!);
}
