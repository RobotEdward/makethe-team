import { describe, expect, it } from "vitest";
import { QUIET_DAYS, type SquadSignals } from "../../src/domain/presence.js";
import { renderSquadSignals } from "../../src/views/squad-signals.js";
import { renderGameOverviewPage } from "../../src/views/game-overview.js";
import { PAGE_STYLE_BLOCKS, SQUAD_SIGNALS_CSS } from "../../src/views/styles.js";

const NONE: SquadSignals = {
  notInstalled: false,
  noPush: false,
  deliveryTrouble: false,
  quiet: false,
};

const member = (signals: SquadSignals) => ({
  playerId: "p-sam",
  name: "Sam Okafor",
  role: "player" as const,
  isGuest: false,
  muted: false,
  signals,
});

const page = (signals: SquadSignals) =>
  renderGameOverviewPage({
    nav: { isAdmin: false, current: "games" },
    gameId: "g-1",
    gameName: "Thursday 7-a-side",
    venueName: "Venue Name",
    venueAddress: null,
    timezone: "Europe/London",
    maxPlayers: 14,
    prefersEvenNumbers: true,
    inviteToken: "invite-token",
    squad: [member(signals)],
    upcoming: [],
    lastResult: null,
    viewerPlayerId: "p-owner",
  });

describe("renderSquadSignals (M33)", () => {
  it("adds no markup at all to a member nothing is wrong with", () => {
    expect(renderSquadSignals(NONE)).toBe("");
  });

  it("marks a member never seen in the installed app", () => {
    const html = renderSquadSignals({ ...NONE, notInstalled: true });
    expect(html).toContain("App not installed");
    expect(html).toContain("<svg");
  });

  it("marks a member with no registered device", () => {
    expect(renderSquadSignals({ ...NONE, noPush: true })).toContain("No push notifications");
  });

  it("marks a member whose sends are failing", () => {
    expect(renderSquadSignals({ ...NONE, deliveryTrouble: true })).toContain(
      "Messages are failing",
    );
  });

  it("words the quiet marker from the threshold it applies", () => {
    expect(renderSquadSignals({ ...NONE, quiet: true })).toContain(`Not seen for ${QUIET_DAYS} days`);
  });

  it("shows several markers on one member", () => {
    const html = renderSquadSignals({ ...NONE, notInstalled: true, noPush: true, quiet: true });
    expect(html.match(/<svg/g)).toHaveLength(3);
    expect(html).not.toContain("Messages are failing");
  });

  // A title attribute reaches a mouse and nothing else. The words have to be
  // in the markup for a screen reader or a phone to get at them at all.
  it("gives every marker readable words, not an icon alone", () => {
    const html = renderSquadSignals({
      notInstalled: true,
      noPush: true,
      deliveryTrouble: true,
      quiet: true,
    });
    expect(html.match(/class="signal-label"/g)).toHaveLength(4);
  });

  // `hidden` and `display: none` take the label out of the accessibility tree
  // as well, which is the one thing this markup cannot afford.
  it("hides the label by clipping it, never by removing it", () => {
    // `aria-hidden` on the icon is not this: it is the label's own markup
    // that must carry no hiding attribute.
    expect(renderSquadSignals({ ...NONE, quiet: true })).not.toContain('class="signal-label" hidden');
    expect(SQUAD_SIGNALS_CSS).toContain("clip-path: inset(50%)");
    expect(SQUAD_SIGNALS_CSS).not.toContain(".signal-label { display: none");
  });

  it("keeps the icons out of the accessibility tree, so each marker speaks once", () => {
    const html = renderSquadSignals({ ...NONE, quiet: true });
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<title>");
  });
});

describe("the markers on the organiser's squad row", () => {
  it("renders inside the member's own span, not as a third grid item", () => {
    // FORM_CSS pins the name to column 1 and the disclosure to column 2, and
    // auto-places anything else — a third child lands in whichever cell is
    // free and moves the controls. Nesting is what makes that impossible.
    const html = page({ ...NONE, quiet: true });
    expect(html).toMatch(/<span class="member">[^<]*Sam Okafor[^<]*<span class="member-signals">/);
  });

  it("carries the block that styles them", () => {
    expect(page({ ...NONE, quiet: true })).toContain(SQUAD_SIGNALS_CSS);
  });

  it("is registered, so the CSP hashes it and the browser does not drop it", () => {
    expect(PAGE_STYLE_BLOCKS).toContain(SQUAD_SIGNALS_CSS);
  });

  // The cascade test only sees two blocks declaring the *same* selector. These
  // three are declared nowhere else, which is what makes this block safe to
  // pass last on a page that already carries six others.
  it("declares selectors no other style block does", () => {
    for (const selector of [".member-signals", ".signal ", ".signal-label"]) {
      const declaring = PAGE_STYLE_BLOCKS.filter((block) => block.includes(selector));
      expect(declaring, `${selector} is declared in more than one block`).toHaveLength(1);
    }
  });

  it("says nothing on the row of a member nothing is wrong with", () => {
    // The class name is in the style block regardless; what must be absent is
    // the markup that renders it.
    expect(page(NONE)).not.toContain('<span class="member-signals">');
  });

  it("escapes nothing into an attribute it cannot survive", () => {
    expect(page({ ...NONE, notInstalled: true })).not.toMatch(/title="[^"]*<[^"]*"/);
  });
});
