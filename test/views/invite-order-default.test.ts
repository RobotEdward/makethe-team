import { describe, expect, it } from "vitest";
import { renderInviteOrderPage, type OrderTier } from "../../src/views/invite-order.js";

/**
 * The state every game starts in: priority order on, no groups defined yet.
 *
 * `tiers` is never empty — the implicit final tier always exists (BR-38) — so
 * with no explicit groups `tiers[0]` *is* that implicit tier. The page then
 * headed it "Core group — asked when the game opens" while every select under
 * it correctly read "Everyone else": a heading asserting membership its own
 * controls denied. And the "no further groups yet" line was gated on
 * `rest.length === 1`, which is false when `rest` is empty, so the second card
 * rendered as a heading with nothing beneath it.
 *
 * Both together meant the first thing an organiser saw on this page was
 * incoherent, and the M52 design review found it as "an organiser cannot tell
 * what this editor currently does".
 */
const implicitOnly: OrderTier[] = [
  {
    tierId: null,
    name: "Everyone else",
    position: 0,
    members: [
      { playerId: "p-1", name: "Alex Morgan" },
      { playerId: "p-2", name: "Lauren Legacy" },
    ],
  },
];

const withGroup: OrderTier[] = [
  {
    tierId: "t-1",
    name: "Regulars",
    position: 1,
    members: [{ playerId: "p-1", name: "Alex Morgan" }],
  },
  {
    tierId: null,
    name: "Everyone else",
    position: 0,
    members: [{ playerId: "p-2", name: "Lauren Legacy" }],
  },
];

const render = (tiers: OrderTier[]) =>
  renderInviteOrderPage({
    nav: { isAdmin: false, current: "games" },
    gameId: "g-1",
    gameName: "Thursday 7-a-side",
    squadSize: tiers.reduce((n, t) => n + t.members.length, 0),
    tiers,
  });

describe("invite order with no groups defined", () => {
  it("does not call the implicit tier the core group", () => {
    const html = render(implicitOnly);

    expect(html).not.toContain("Core group");
  });

  it("says plainly that everyone is asked together", () => {
    expect(render(implicitOnly)).toContain("asked together");
  });

  it("still offers a control for every member, so a new group can be filled", () => {
    // The reason the implicit tier gets assignment controls at all: without
    // them, adding a first group leaves every member unplaced and unmovable.
    const html = render(implicitOnly);

    expect(html).toContain("Alex Morgan");
    expect(html).toContain("Lauren Legacy");
    expect(html.match(/<select/g) ?? []).toHaveLength(2);
  });

  it("never renders a heading with nothing under it", () => {
    const html = render(implicitOnly);

    // Not just `</h2>` straight to `</section>`: the card that shipped held an
    // *empty* `<ol class="invite-ord">`, which is markup without being
    // content, so a naive check passed while the page showed a bare heading.
    const cards = [...html.matchAll(/<section class="invite-box">([\s\S]*?)<\/section>/g)];
    expect(cards.length, "no invite-box cards rendered at all").toBeGreaterThan(0);

    for (const [, inner] of cards) {
      const withoutHeading = inner!.replace(/<h2 class="invite-cap">[\s\S]*?<\/h2>/, "");
      const withoutEmptyLists = withoutHeading.replace(/<ol class="invite-ord">\s*<\/ol>/, "");
      expect(
        withoutEmptyLists.replace(/\s/g, ""),
        `a card rendered as a heading over nothing: ${inner!.slice(0, 80)}`,
      ).not.toBe("");
    }
  });
});

describe("invite order once a group exists", () => {
  it("names the first group as the one asked when the game opens", () => {
    expect(render(withGroup)).toContain("Core group");
  });

  it("names the members of the implicit tier rather than leaving them unsaid", () => {
    // §3.8: an owner who cannot see who is in "everyone else" cannot tell
    // whether a new joiner has landed somewhere sensible.
    expect(render(withGroup)).toContain("Lauren Legacy");
  });
});

describe("the way back", () => {
  it("ends in one text back-link to the game", () => {
    expect(render(implicitOnly)).toContain('href="/g/g-1"');
  });
});
