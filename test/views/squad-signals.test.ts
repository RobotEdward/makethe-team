import { describe, expect, it } from "vitest";
import { QUIET_DAYS, type SquadSignals } from "../../src/domain/presence.js";
import { renderSquadSignals } from "../../src/views/squad-signals.js";
import { renderGameOverviewPage } from "../../src/views/game-overview.js";
import { renderSquadMemberPage } from "../../src/views/squad-member.js";
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
  unconfirmed: false,
  signals,
});

const page = (signals: SquadSignals) =>
  renderGameOverviewPage({
      // No played fixtures here, so no standings (M49).
      standings: [],
      standingsSort: "points" as const,
    nav: { isAdmin: false, current: "games" },
    gameId: "g-1",
    gameName: "Thursday 7-a-side",
    venueName: "Venue Name",
    venueAddress: null,
    timezone: "Europe/London",
    maxPlayers: 14,
    prefersEvenNumbers: true,
    inviteToken: "invite-token",
    archivedOn: null,
    squad: [member(signals)],
    upcoming: [],
    lastResult: null,
    viewerPlayerId: "p-owner",
  });

describe("renderSquadSignals (M33)", () => {
  it("adds no markup at all to a member nothing is wrong with", () => {
    expect(renderSquadSignals(NONE, "all")).toBe("");
  });

  it("marks a member never seen in the installed app", () => {
    const html = renderSquadSignals({ ...NONE, notInstalled: true }, "all");
    expect(html).toContain("App not installed");
    expect(html).toContain("<svg");
  });

  it("marks a member with no registered device", () => {
    expect(renderSquadSignals({ ...NONE, noPush: true }, "all")).toContain("No push notifications");
  });

  it("marks a member whose sends are failing", () => {
    expect(renderSquadSignals({ ...NONE, deliveryTrouble: true }, "all")).toContain(
      "Messages are failing",
    );
  });

  it("words the quiet marker from the threshold it applies", () => {
    expect(renderSquadSignals({ ...NONE, quiet: true }, "all")).toContain(`Not seen for ${QUIET_DAYS} days`);
  });

  it("shows several markers on one member", () => {
    const html = renderSquadSignals({ ...NONE, notInstalled: true, noPush: true, quiet: true }, "all");
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
    }, "all");
    expect(html.match(/class="signal-label"/g)).toHaveLength(4);
  });

  // `hidden` and `display: none` take the label out of the accessibility tree
  // as well, which is the one thing this markup cannot afford.
  it("hides the label by clipping it, never by removing it", () => {
    // `aria-hidden` on the icon is not this: it is the label's own markup
    // that must carry no hiding attribute.
    expect(renderSquadSignals({ ...NONE, quiet: true }, "all")).not.toContain('class="signal-label" hidden');
    expect(SQUAD_SIGNALS_CSS).toContain("clip-path: inset(50%)");
    expect(SQUAD_SIGNALS_CSS).not.toContain(".signal-label { display: none");
  });

  it("keeps the icons out of the accessibility tree, so each marker speaks once", () => {
    const html = renderSquadSignals({ ...NONE, quiet: true }, "all");
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

/**
 * Which markers belong on a squad *row* (M52).
 *
 * This module's own header says a marker present on every row is a marker
 * nobody reads — but two of the four are true of almost every player, because
 * most people never install the app and never turn push on. So the squad list
 * carried two or three tiny glyphs on every single row, with no legend
 * anywhere on the page, and the two that actually mean "act on this" were not
 * separable from them at that size. The M52 design review found the shipped
 * page to be exactly the failure the header warns against.
 *
 * The split is by tone, which the markers already carry: `warn` means
 * something is wrong and an organiser can do something about it, `quiet` is
 * background. Rows show only the actionable ones; the member's own page, which
 * has room and is where somebody goes to find out about one person, shows all
 * of them with their labels visible.
 */
describe("marker scope", () => {
  const all: SquadSignals = {
    notInstalled: true,
    noPush: true,
    deliveryTrouble: true,
    quiet: true,
  };

  it("shows only the actionable markers on a squad row", () => {
    const row = renderSquadSignals(all, "actionable");

    expect(row).toContain("Messages are failing");
    expect(row).toContain("Not seen for");
    expect(row).not.toContain("App not installed");
    expect(row).not.toContain("No push notifications");
  });

  it("shows every marker where there is room to explain them", () => {
    const detail = renderSquadSignals(all, "all");

    for (const label of [
      "App not installed",
      "No push notifications",
      "Messages are failing",
      "Not seen for",
    ]) {
      expect(detail).toContain(label);
    }
  });

  it("renders nothing on a row whose only markers are background ones", () => {
    // The common case, and the whole point: an ordinary player who simply
    // uses email gets a clean row.
    const ordinary: SquadSignals = {
      notInstalled: true,
      noPush: true,
      deliveryTrouble: false,
      quiet: false,
    };

    expect(renderSquadSignals(ordinary, "actionable")).toBe("");
  });

  it("defaults to the row's scope, so a caller cannot leak the quiet pair by omission", () => {
    expect(renderSquadSignals(all)).toBe(renderSquadSignals(all, "actionable"));
  });
});

/**
 * Where the informational markers went (M52).
 *
 * Moving the quiet pair off the squad row only helps if they land somewhere.
 * The member's own page is the place: it is reached by going to find out about
 * one person, it has room for words rather than 12px glyphs, and the M52
 * review separately found that this page "knows less than the row that links
 * to it" — it showed an address and a join date while the row it came from
 * carried the markers.
 */
describe("the member's own page", () => {
  const render = (signals: SquadSignals | undefined) =>
    renderSquadMemberPage({
      nav: { isAdmin: false, current: "games" },
      gameId: "g-1",
      gameName: "Thursday 7-a-side",
      memberName: "Sam Okafor",
      email: "sam@example.test",
      isGuest: false,
      role: "player",
      joinedAtLocal: "5 March 2026",
      signals,
    });

  it("names every marker in words", () => {
    const html = render({ notInstalled: true, noPush: true, deliveryTrouble: true, quiet: true });

    for (const label of [
      "App not installed",
      "No push notifications",
      "Messages are failing",
      "Not seen for",
    ]) {
      expect(html).toContain(label);
    }
  });

  it("says how they hear about games, so the markers have a heading to sit under", () => {
    expect(render({ notInstalled: true, noPush: false, deliveryTrouble: false, quiet: false }))
      .toContain("How they hear");
  });

  it("says nothing at all when there is nothing to report", () => {
    const html = render({ notInstalled: false, noPush: false, deliveryTrouble: false, quiet: false });

    expect(html).not.toContain("How they hear");
  });

  /** A guest has no device and no address; the section would be four absences. */
  it("says nothing for a member whose signals were not gathered", () => {
    expect(render(undefined)).not.toContain("How they hear");
  });
});
