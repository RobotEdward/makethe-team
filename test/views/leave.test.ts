import { describe, expect, it } from "vitest";
import { renderLeavePage, type LeavePageParams } from "../../src/views/leave.js";
import { FIXTURE_STYLES_CSS, FORM_CSS, SQUAD_STYLES_CSS } from "../../src/views/styles.js";

const BASE: LeavePageParams = {
  token: "tok-1",
  gameId: "g-1",
  gameName: "Thursday 7-a-side",
  state: "confirm",
};

function params(over: Partial<LeavePageParams> = {}): LeavePageParams {
  return { ...BASE, ...over };
}

const THREE_GAMES = [
  { gameId: "g-2", gameName: "Monday five" },
  { gameId: "g-3", gameName: "Sunday league at the rec, back pitch" },
  { gameId: "g-4", gameName: "Wednesday" },
];

describe("renderLeavePage", () => {
  it("does not stack full-width buttons one per game", () => {
    const html = renderLeavePage(params({ otherGames: THREE_GAMES }));
    expect(html).toContain(`<ul class="squad">`);
    expect(html).not.toContain("<ul>");
  });

  it("offers a way back out of the page", () => {
    const html = renderLeavePage(params({ otherGames: THREE_GAMES }));
    expect(html).toContain(`class="back-link"`);
    expect(html).toContain(`href="/app"`);
  });

  it("keeps the back-link off a page whose visitor has no session to go back to", () => {
    // `otherGames: undefined` is the no-session case, and "Back to your games"
    // would land them on sign-in — which this page already offers, in words
    // that say what signing in gets them.
    const html = renderLeavePage(params());
    expect(html).not.toContain(`class="back-link"`);
  });

  it("lets the form block win the ul.squad row, so a row's shape is not the game name's length", () => {
    // SQUAD_STYLES_CSS and FORM_CSS both declare `ul.squad > li` at identical
    // specificity, so array order decides it. FORM_CSS's grid is the one that
    // survives a long game name; SQUAD_STYLES_CSS's flex is what made a row's
    // layout depend on its text.
    const html = renderLeavePage(params({ otherGames: THREE_GAMES }));
    const squadAt = html.indexOf(SQUAD_STYLES_CSS);
    const formAt = html.indexOf(FORM_CSS);
    // Both presence assertions are load-bearing: indexOf returns -1 for an
    // absent block, and -1 is less than everything, so the comparison below
    // passes vacuously on a page that ships neither block.
    expect(squadAt).toBeGreaterThan(-1);
    expect(formAt).toBeGreaterThan(-1);
    expect(squadAt).toBeLessThan(formAt);
  });

  it("ships the block .back-link is declared in", () => {
    const html = renderLeavePage(params({ otherGames: THREE_GAMES }));
    expect(html).toContain(FIXTURE_STYLES_CSS);
  });

  it("keeps the organiser warning as a nudge", () => {
    const html = renderLeavePage(params({ isOrganiser: true }));
    expect(html).toContain(`class="nudge"`);
  });

  it("spends the only filled button on the destructive action", () => {
    // M10 §3.2: never a filled --danger and a filled --accent on one screen.
    // Each other squad's Leave is the outlined .button, not .primary.
    const html = renderLeavePage(params({ otherGames: THREE_GAMES }));
    expect(html).toContain(`class="button danger"`);
    expect(html).not.toContain(`class="button primary"`);
  });

  it("posts each other squad's exit to that game's own path", () => {
    const html = renderLeavePage(params({ otherGames: THREE_GAMES }));
    expect(html).toContain(`action="/app/games/g-2/leave"`);
    expect(html).toContain(`action="/app/games/g-4/leave"`);
  });

  it("uses no inline style attribute (style-src hashes do not cover attributes)", () => {
    const html = renderLeavePage(params({ otherGames: THREE_GAMES }));
    expect(html).not.toMatch(/style="/);
  });
});

/**
 * The confirm state says what it is, and says that doing nothing is safe (M52).
 *
 * The h1 was the game's name in every state, so somebody who mis-tapped the
 * leave link in an email footer saw their game's name and a red button with
 * nothing telling them where they were. There was also no way out: unlike the
 * cancel page, which offers "Keep the game on", the only controls were the
 * danger button and a sign-in link.
 *
 * A back *link* is not available here and would be worse than none — this page
 * is reached from an email with a token and usually no session, so anything
 * pointing at the game would bounce the visitor to sign-in. The product
 * already has the right idiom for a page reached this way, on join-confirm:
 * say that closing the page does nothing.
 */
describe("the leave confirmation", () => {
  const confirm = () =>
    renderLeavePage({
      token: "t",
      gameId: "g-1",
      gameName: "Thursday 7-a-side",
      state: "confirm",
      isOrganiser: false,
    });

  it("names the act in the heading, not just the game", () => {
    expect(confirm()).toContain("<h1>Leave Thursday 7-a-side?</h1>");
  });

  it("says that doing nothing is safe", () => {
    const html = confirm();
    const escape = html.indexOf("close this page");
    const button = html.indexOf("Leave this game");

    expect(escape).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(-1);
    expect(escape).toBeLessThan(button);
  });

  it("leaves the other states' headings alone", () => {
    for (const state of ["done", "already-left"] as const) {
      const html = renderLeavePage({ token: "t", gameId: "g-1", gameName: "Thursday 7-a-side", state });
      expect(html).toContain("<h1>Thursday 7-a-side</h1>");
      expect(html).not.toContain("close this page");
    }
  });
});
