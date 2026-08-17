import { describe, expect, it } from "vitest";
import { renderDeleteAccountPage, type DeleteAccountPageParams } from "../../src/views/delete-account.js";
import { FIXTURE_STYLES_CSS } from "../../src/views/styles.js";

const BASE: DeleteAccountPageParams = {
  playerName: "Ada Okafor",
  state: "offer",
};

const BLOCKING = [{ gameId: "g-2", gameName: "Monday five" }];

/**
 * Every state this page can render, including the ones only a field beyond
 * `state` distinguishes: `held-up` is two pages, one with a cancel button and
 * one without, and `problem` puts a paragraph above any of them.
 */
const STATES: readonly { name: string; params: DeleteAccountPageParams }[] = [
  { name: "offer", params: BASE },
  { name: "offer, after a refused POST", params: { ...BASE, problem: "Not just now." } },
  { name: "sole-organiser", params: { ...BASE, state: "sole-organiser", blockingGames: BLOCKING } },
  { name: "pending", params: { ...BASE, state: "pending", erasesAtLocal: "Thursday 5 March at 19:00" } },
  {
    name: "held-up, nothing blocking it",
    params: { ...BASE, state: "held-up", erasesAtLocal: "Thursday 5 March at 19:00", blockingGames: [] },
  },
  {
    name: "held-up, a game blocking it",
    params: { ...BASE, state: "held-up", erasesAtLocal: "Thursday 5 March at 19:00", blockingGames: BLOCKING },
  },
  {
    name: "held-up, already begun",
    params: {
      ...BASE,
      state: "held-up",
      erasesAtLocal: "Thursday 5 March at 19:00",
      blockingGames: BLOCKING,
      started: true,
    },
  },
];

/** `.button.primary` and `.button.danger` — the two filled treatments. */
const filledButtons = (html: string) => html.match(/class="button (?:primary|danger)"/g) ?? [];

describe("one filled button per screen", () => {
  /**
   * This page owns both fills — `.button.danger` on "Delete my data" and
   * `.button.primary` on "Keep my account" — and Global Constraint 8 forbids
   * them appearing together. They are mutually exclusive by construction:
   * `renderDeleteAccountPage` renders exactly one body, and no body renders
   * both. This test is what keeps that true of a fifth state somebody adds.
   */
  it.each(STATES)("spends at most one fill on $name", ({ name, params }) => {
    const filled = filledButtons(renderDeleteAccountPage(params));
    expect(filled.length, `${name} renders ${filled.length} filled buttons`).toBeLessThanOrEqual(1);
  });

  it("puts the red on the destructive act and the green on the way out of it", () => {
    const offer = renderDeleteAccountPage(BASE);
    expect(offer).toContain(`<button class="button danger" type="submit">Delete my data</button>`);
    expect(offer).not.toContain(`class="button primary"`);

    const pending = renderDeleteAccountPage({
      ...BASE,
      state: "pending",
      erasesAtLocal: "Thursday 5 March at 19:00",
    });
    expect(pending).toContain(`<button class="button primary" type="submit">Keep my account</button>`);
    expect(pending).not.toContain(`class="button danger"`);
  });

  it("offers nothing to press where there is nothing that pressing would do", () => {
    // `sole-organiser` and a started `held-up` both render no button at all,
    // rather than a disabled one: a control that exists but refuses invites
    // the press.
    for (const state of ["sole-organiser", "held-up-started"] as const) {
      const html = renderDeleteAccountPage(
        state === "sole-organiser"
          ? { ...BASE, state: "sole-organiser", blockingGames: BLOCKING }
          : {
              ...BASE,
              state: "held-up",
              erasesAtLocal: "Thursday 5 March at 19:00",
              blockingGames: BLOCKING,
              started: true,
            },
      );
      expect(html, `${state} must render no button`).not.toContain("<button");
    }
  });
});

/**
 * §2.5: every page behind a session ends in one back link wearing the
 * existing `.back-link` class. This page had the link and not the class, so
 * the 1.5rem that separates it from the block above it was never applied.
 */
describe("the back link", () => {
  it("carries the class, and the block that declares it", () => {
    const html = renderDeleteAccountPage(BASE);
    expect(html).toContain(`<p class="back-link">`);
    expect(html).toContain(FIXTURE_STYLES_CSS);
    expect(FIXTURE_STYLES_CSS).toContain(".back-link {");
  });

  it("offers exactly one way back up, in every state this page has", () => {
    for (const state of STATES) {
      const html = renderDeleteAccountPage(state.params);
      expect(html.match(/class="back-link"/g), state.name).toHaveLength(1);
    }
  });
});
