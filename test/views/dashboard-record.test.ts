import { describe, expect, it } from "vitest";
import { renderDashboardPage, type RecordRow } from "../../src/views/dashboard.js";

/** The dashboard with nothing on it but the record section under test. */
function page(record: readonly RecordRow[]): string {
  return renderDashboardPage({
    nav: { isAdmin: false, current: "games" },
    playerName: "Ada Okafor",
    rows: [],
    squads: [],
    resultsNeeded: [],
    recentlyPlayed: null,
    record,
  });
}

const THURSDAY: RecordRow = {
  gameId: "g-1",
  gameName: "Thursday 7-a-side",
  played: 9,
  won: 5,
  lost: 3,
  drawn: 1,
};

describe("the dashboard's record section", () => {
  it("shows one row per game, with the four numbers", () => {
    const html = page([THURSDAY]);

    expect(html).toContain("Your record");
    expect(html).toContain("Thursday 7-a-side");
    expect(html).toContain(`<td class="count">9</td>`);
    expect(html).toContain(`<td class="count">5</td>`);
    expect(html).toContain(`<td class="count">3</td>`);
    expect(html).toContain(`<td class="count">1</td>`);
  });

  it("links each game's name to its own page", () => {
    expect(page([THURSDAY])).toContain(`<a href="/g/g-1">Thursday 7-a-side</a>`);
  });

  it("escapes a game's name", () => {
    const html = page([{ ...THURSDAY, gameName: `Bob's <script>alert(1)</script>` }]);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Bob&#39;s &lt;script&gt;");
  });

  it("totals every game when there is more than one", () => {
    const html = page([THURSDAY, { ...THURSDAY, gameId: "g-2", gameName: "Sunday League" }]);

    expect(html).toContain("All games");
    expect(html).toContain(`<td class="count">18</td>`);
    expect(html).toContain(`<td class="count">10</td>`);
  });

  it("does not total a single game against itself", () => {
    expect(page([THURSDAY])).not.toContain("All games");
  });

  it("accounts for played fixtures that never settled, and says what they are", () => {
    const html = page([{ ...THURSDAY, played: 12 }]);

    expect(html).toContain("No result");
    expect(html).toContain(`<td class="count">3</td>`);
    expect(html).toContain("nobody agreed a result");
  });

  it("leaves out the no-result column when every played fixture settled", () => {
    const html = page([THURSDAY]);

    expect(html).not.toContain("No result");
    expect(html).not.toContain("nobody agreed a result");
  });

  it("renders no record section at all for a player who has played nothing", () => {
    expect(page([])).not.toContain("Your record");
  });
});
