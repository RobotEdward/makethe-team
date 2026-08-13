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

  it("mentions the waiting list only when they are on one", () => {
    const none = renderRemoveMemberPage({ ...BASE, commitments: { in: 1, waitlisted: 0 } });
    expect(none.toLowerCase()).not.toContain("waiting list");
    const some = renderRemoveMemberPage({ ...BASE, commitments: { in: 0, waitlisted: 2 } });
    expect(some.toLowerCase()).toContain("waiting list");
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
