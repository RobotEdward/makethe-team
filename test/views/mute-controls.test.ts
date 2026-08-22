import { describe, expect, it } from "vitest";
import { renderMuteControls } from "../../src/views/mute-controls.js";
import { MUTE_CSS, PAGE_STYLE_BLOCKS } from "../../src/views/styles.js";

const OFF = {
  muteAction: "/g/g-1/mute",
  unmuteAction: "/g/g-1/unmute",
  state: { muted: false as const },
  otherGamesCount: 2,
};

describe("renderMuteControls, switched off", () => {
  it("offers exactly the four durations", () => {
    const html = renderMuteControls(OFF);
    for (const value of ["2w", "4w", "8w", "forever"]) {
      expect(html).toContain(`value="${value}"`);
    }
    expect(html).toContain("2 weeks");
    expect(html).toContain("4 weeks");
    expect(html).toContain("8 weeks");
    expect(html).toContain("Indefinitely");
  });

  it("posts to the mute path", () => {
    const html = renderMuteControls(OFF);
    expect(html).toContain('action="/g/g-1/mute"');
    expect(html).toContain('method="post"');
  });

  it("offers to apply it to the other squads, saying how many there are", () => {
    const html = renderMuteControls(OFF);
    expect(html).toContain('name="all-games"');
    expect(html).toContain("2 other squads");
  });

  it("says one other squad in the singular", () => {
    const html = renderMuteControls({ ...OFF, otherGamesCount: 1 });
    expect(html).toContain("1 other squad");
    expect(html).not.toContain("1 other squads");
  });

  it("hides the all-games checkbox for a player with only this squad", () => {
    const html = renderMuteControls({ ...OFF, otherGamesCount: 0 });
    expect(html).not.toContain('name="all-games"');
  });

  it("promises that accepting stays possible, which is the whole point", () => {
    expect(renderMuteControls(OFF)).toContain("You can still say yes");
  });
});

describe("renderMuteControls, switched on", () => {
  it("names the date it runs out and offers the way off", () => {
    const html = renderMuteControls({
      ...OFF,
      state: { muted: true, untilLocal: "Tue 29 Sep 2026, 1:00 pm" },
    });
    expect(html).toContain("Tue 29 Sep 2026, 1:00 pm");
    expect(html).toContain('action="/g/g-1/unmute"');
    expect(html).toContain("Turn auto-decline off");
    // The form for turning it *on* is gone: two live forms would let a player
    // re-mute a mute that is already running and read as though nothing worked.
    expect(html).not.toContain('action="/g/g-1/mute"');
  });

  it("says so plainly when there is no end date", () => {
    const html = renderMuteControls({ ...OFF, state: { muted: true, untilLocal: null } });
    expect(html).toContain("until you turn it back on");
  });

  it("escapes a formatted date rather than trusting it", () => {
    const html = renderMuteControls({
      ...OFF,
      state: { muted: true, untilLocal: '<script>alert("x")</script>' },
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("offers to turn it off everywhere when there are other squads", () => {
    const html = renderMuteControls({
      ...OFF,
      state: { muted: true, untilLocal: null },
    });
    expect(html).toContain('name="all-games"');
  });
});

describe("MUTE_CSS", () => {
  it("is registered, so the browser does not drop it under the CSP", () => {
    expect(PAGE_STYLE_BLOCKS).toContain(MUTE_CSS);
  });
});
