import { describe, expect, it } from "vitest";
import { memberRemovePath, memberRolePath } from "../../src/auth/paths.js";
import { renderRemoveMemberPage } from "../../src/views/remove-member.js";
import { CANCEL_STYLES_CSS, FORM_CSS } from "../../src/views/styles.js";

const BASE = {
  gameId: "g-1",
  playerId: "p-1",
  gameName: "Thursday 7-a-side",
  memberName: "Sam Okafor",
  isOwner: false,
};

describe("paths", () => {
  it("builds the two squad paths", () => {
    expect(memberRolePath("g-1", "p-1")).toBe("/g/g-1/squad/p-1/role");
    expect(memberRemovePath("g-1", "p-1")).toBe("/g/g-1/squad/p-1/remove");
  });
});

describe("renderRemoveMemberPage", () => {
  it("names the member and the game, and posts back to the same path", () => {
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 0, waitlisted: 0 } });
    expect(html).toContain("Sam Okafor");
    expect(html).toContain("Thursday 7-a-side");
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/g/g-1/squad/p-1/remove"');
  });

  it("states a confirmed place in the singular", () => {
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 1, waitlisted: 0 } });
    expect(html).toContain("1 upcoming fixture");
    expect(html).not.toContain("1 upcoming fixtures");
  });

  it("states several confirmed places in the plural", () => {
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 2, waitlisted: 0 } });
    expect(html).toContain("2 upcoming fixtures");
  });

  it("mentions the member's own waiting-list places only when they hold some", () => {
    // Scoped to *their* places, not the word "waiting list" anywhere on the
    // page: a confirmed place now also names the waiting list, because
    // somebody is promoted into the place being freed (see below).
    const none = renderRemoveMemberPage({ ...BASE, commitments: { in: 1, waitlisted: 0 } });
    expect(none.toLowerCase()).not.toContain("is on the waiting list");
    const some = renderRemoveMemberPage({ ...BASE, commitments: { in: 0, waitlisted: 2 } });
    expect(some.toLowerCase()).toContain("is on the waiting list");
  });

  it("says who takes the place a removal frees, which is what the owner needs to know", () => {
    // The consequence the spec's copy names and the page previously dropped:
    // freeing a place is not the end of it — the next person on each waiting
    // list is moved in, and emailed about it.
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 1, waitlisted: 0 } });
    expect(html.toLowerCase()).toContain("the next person on each waiting list takes the place");
    // Not said when there is no place to free — there is nobody to promote.
    const nothing = renderRemoveMemberPage({ ...BASE, commitments: { in: 0, waitlisted: 0 } });
    expect(nothing.toLowerCase()).not.toContain("takes the place");
  });

  it("names the site in its title, like every other page", () => {
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 0, waitlisted: 0 } });
    expect(html).toContain("<title>Remove Sam Okafor — Make The Team</title>");
  });

  it("says plainly when there is nothing upcoming to affect", () => {
    // Rather than a sentence about freed places that quietly does not apply.
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 0, waitlisted: 0 } });
    expect(html).toContain("no upcoming fixtures");
  });

  it("warns when the member being removed is an organiser", () => {
    const html = renderRemoveMemberPage({ ...BASE, isOwner: true, commitments: { in: 0, waitlisted: 0 } });
    expect(html.toLowerCase()).toContain("organiser");
  });

  it("offers a way back that changes nothing", () => {
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 0, waitlisted: 0 } });
    expect(html).toContain('href="/g/g-1"');
  });

  it("gives the escape the same weight as the one on the cancel page", () => {
    // A heavy red button beside a faint text link is not two choices, it is
    // one choice and a footnote — `cancel.ts` settled this shape already.
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 0, waitlisted: 0 } });
    expect(html).toContain(`class="button keep-link"`);
    expect(html).toContain("No, leave the squad as it is");
    // Immediately after the form, never inside it: a second submit-shaped
    // control in a form that removes somebody is a mis-tap waiting to happen.
    expect(html).not.toMatch(/<a class="button keep-link"[\s\S]*<\/form>/);
  });

  it("ships the block .keep-link is declared in", () => {
    // Without it the escape renders as an underlined, unstyled anchor rather
    // than the outlined button the class names.
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 0, waitlisted: 0 } });
    const cancelAt = html.indexOf(CANCEL_STYLES_CSS);
    const formAt = html.indexOf(FORM_CSS);
    // -1 is less than everything, so an order assertion alone would pass on a
    // page carrying neither block. These two are what make it mean something.
    expect(cancelAt).toBeGreaterThan(-1);
    expect(formAt).toBeGreaterThan(-1);
    expect(cancelAt).toBeLessThan(formAt);
  });

  it("escapes a name containing markup", () => {
    const html = renderRemoveMemberPage({
      ...BASE,
      memberName: "<script>alert(1)</script>",
      commitments: { in: 0, waitlisted: 0 },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("uses no inline style attribute (style-src hashes do not cover attributes)", () => {
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 1, waitlisted: 1 } });
    expect(html).not.toMatch(/style="/);
  });

  it("styles the irreversible action as dangerous, never as primary", () => {
    const html = renderRemoveMemberPage({ ...BASE, commitments: { in: 0, waitlisted: 0 } });
    expect(html).toContain(`class="button danger"`);
    expect(html).not.toContain(`class="button primary"`);
  });
});
