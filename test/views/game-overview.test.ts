import { describe, expect, it } from "vitest";
import { renderGameOverviewPage } from "../../src/views/game-overview.js";

const BASE = {
  gameId: "g-1",
  gameName: "Thursday 7-a-side",
  venueName: "Venue Name",
  venueAddress: null,
  timezone: "Europe/London",
  maxPlayers: 14,
  prefersEvenNumbers: true,
  inviteToken: "invite-token",
  squad: [] as Array<{ playerId: string; name: string; role: "player" | "owner"; isGuest: boolean }>,
  upcoming: [],
};

describe("squad controls", () => {
  const squad = [
    { playerId: "p-owner", name: "Edward Charles", role: "owner" as const, isGuest: false },
    { playerId: "p-sam", name: "Sam Okafor", role: "player" as const, isGuest: false },
  ];

  it("offers a remove link for each member", () => {
    const html = renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad });
    expect(html).toContain('href="/g/g-1/squad/p-sam/remove"');
    expect(html).toContain('href="/g/g-1/squad/p-owner/remove"');
  });

  it("offers promotion for a player and demotion for an organiser", () => {
    const html = renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad });
    // Extract each member's row and verify the role form's value is opposite to their current role.
    // Sam Okafor (player) should have value="owner"; Edward Charles (organiser) should have value="player".
    // `[^<]` after `<li>` rather than `[\s\S]*?`: the lazy form starts at the
    // *first* `<li>` in the document and runs to the first `</li>` after the
    // name, so Sam's "row" spanned Edward's row too and the assertions below
    // could pass on Edward's markup.
    const samRow = html.match(/<li>(?:(?!<\/li>)[\s\S])*?Sam Okafor[\s\S]*?<\/li>/);
    expect(samRow).toBeTruthy();
    expect(samRow![0]).toContain('action="/g/g-1/squad/p-sam/role"');
    expect(samRow![0]).toContain('value="owner"');

    const edwardRow = html.match(/<li>[\s\S]*?Edward Charles[\s\S]*?<\/li>/);
    expect(edwardRow).toBeTruthy();
    expect(edwardRow![0]).toContain('action="/g/g-1/squad/p-owner/role"');
    expect(edwardRow![0]).toContain('value="player"');
  });

  it("marks the viewer's own row so they know which one they are", () => {
    const html = renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad });
    expect(html).toContain("(you)");
  });

  it("shows a problem message when one is passed", () => {
    const html = renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad, problem: "Nope." });
    expect(html).toContain("Nope.");
  });

  it("shows no problem message otherwise", () => {
    expect(renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad })).not.toContain("class=\"problem\"");
  });

  it("uses no inline style attribute", () => {
    expect(renderGameOverviewPage({ ...BASE, viewerPlayerId: "p-owner", squad })).not.toMatch(/style="/);
  });
});
