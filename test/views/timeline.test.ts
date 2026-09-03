import { describe, expect, it } from "vitest";
import { renderTimelinePage, type RenderableEntry } from "../../src/views/timeline.js";

/**
 * The reading order of a fixture's history (M52).
 *
 * Every entry led with the full date and time in its own line, above the
 * event. Several entries usually share an instant — a sweep opening a fixture
 * invites everybody in the same second — so the page opened with three or four
 * identical dates stacked above each other, each repeating the fixture date
 * already printed two lines up. The M52 design review put it as "the timestamp
 * outranks the event".
 *
 * So: the event first, the time alone beside its attribution, and the date
 * once per day as a subhead over the entries it covers.
 */
const entry = (over: Partial<RenderableEntry> = {}): RenderableEntry => ({
  dayLocal: "Wednesday 2 September",
  timeLocal: "16:35",
  actor: null,
  subject: null,
  title: "Opened for answers",
  detail: "14 players asked",
  ...over,
});

const render = (entries: RenderableEntry[]) =>
  renderTimelinePage({
    nav: { isAdmin: false, current: "games" },
    gameId: "g-1",
    fixtureId: "f-1",
    gameName: "Thursday 7-a-side",
    kicksOffAtLocal: "Thursday 3 September at 19:00",
    entries,
  });

describe("timeline reading order", () => {
  it("puts the event before its time", () => {
    const html = render([entry()]);
    const what = html.indexOf("Opened for answers");
    const when = html.indexOf("16:35");

    expect(what).toBeGreaterThan(-1);
    expect(when).toBeGreaterThan(-1);
    expect(what).toBeLessThan(when);
  });

  it("prints the day once over the entries it covers, not on every row", () => {
    const html = render([
      entry({ timeLocal: "16:35", title: "Teams announced" }),
      entry({ timeLocal: "16:35", title: "Teams saved" }),
      entry({ timeLocal: "16:34", title: "Opened for answers" }),
    ]);

    expect(html.match(/Wednesday 2 September/g) ?? []).toHaveLength(1);
  });

  it("starts a new day heading when the day changes", () => {
    const html = render([
      entry({ dayLocal: "Wednesday 2 September", title: "Teams announced" }),
      entry({ dayLocal: "Tuesday 1 September", title: "Opened for answers" }),
    ]);

    expect(html).toContain("Wednesday 2 September");
    expect(html).toContain("Tuesday 1 September");
  });

  it("still says who, and still says Automatically for the app's own acts", () => {
    // The distinction the page exists for: a fixture that opened on schedule
    // and one an organiser opened early are otherwise the same row.
    expect(render([entry()])).toContain("Automatically");
    expect(render([entry({ actor: "Ed" })])).toContain("by Ed");
  });

  it("keeps its own note about what it cannot know", () => {
    expect(render([entry()])).toContain("Only what has happened since");
  });

  it("says so when there is nothing recorded", () => {
    expect(render([])).toContain("Nothing yet");
  });
});
