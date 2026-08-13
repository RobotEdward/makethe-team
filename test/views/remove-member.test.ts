import { describe, expect, it } from "vitest";
import { memberRemovePath, memberRolePath } from "../../src/auth/paths.js";
import { renderRemoveMemberPage } from "../../src/views/remove-member.js";

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
});
