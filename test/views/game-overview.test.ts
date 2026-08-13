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
    expect(html).toContain('action="/g/g-1/squad/p-sam/role"');
    expect(html).toContain('value="owner"');
    expect(html).toContain('action="/g/g-1/squad/p-owner/role"');
    expect(html).toContain('value="player"');
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
