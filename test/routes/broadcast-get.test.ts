import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { players } from "../../src/db/schema.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  insertSubscription,
  resetDatabase,
  testDb,
} from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

/** Signs in and returns the signed-in player's own id alongside the cookie. */
async function ownerSession(): Promise<{ cookie: string; viewerId: string }> {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  return { cookie, viewerId: viewer!.id };
}

describe("GET /g/:id/message", () => {
  beforeEach(resetDatabase);

  it("shows the game-scoped page to the owner, with the member count", async () => {
    const { cookie, viewerId } = await ownerSession();
    const db = testDb();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, viewerId, { role: "owner" });
    const memberId = await insertPlayer(db, { name: "Player 0" });
    await insertMembership(db, gameId, memberId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/message`, { headers: { cookie } });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Message everyone in Thursday 7-a-side");
    // The owner plus one addressable member.
    expect(html).toContain("Send to 2 players");
  });

  it("404s for a player who is a member but not an owner", async () => {
    const { cookie, viewerId } = await ownerSession();
    const db = testDb();
    const strangerOwner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, strangerOwner, { role: "owner" });
    await insertMembership(db, gameId, viewerId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/message`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("404s for a signed-in stranger", async () => {
    const { cookie } = await ownerSession();
    const db = testDb();
    const otherOwner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, otherOwner, { role: "owner" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/message`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("404s for an unknown game id", async () => {
    const { cookie } = await ownerSession();

    const response = await SELF.fetch(`${ORIGIN}/g/${crypto.randomUUID()}/message`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("redirects an anonymous visitor to sign in, matching the other owner routes", async () => {
    const db = testDb();
    const owner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, owner, { role: "owner" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/message`, { redirect: "manual" });

    expect(response.status).toBe(302);
  });

  it("excludes a guest and an unaddressable member from the count", async () => {
    const { cookie, viewerId } = await ownerSession();
    const db = testDb();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, viewerId, { role: "owner" });
    // A guest: no channel is ever offered to one (BR-32), whatever their row holds.
    const guestId = await insertPlayer(db, { name: "Guest", email: null, isGuest: true });
    await insertMembership(db, gameId, guestId);
    // A real member with neither an email nor a registered device.
    const unreachableId = await insertPlayer(db, { name: "Unreachable", email: null });
    await insertMembership(db, gameId, unreachableId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/message`, { headers: { cookie } });

    expect(response.status).toBe(200);
    const html = await response.text();
    // Only the owner themselves is addressable.
    expect(html).toContain("Send to 1 player<");
  });
});

describe("GET /g/:id/f/:fixtureId/message", () => {
  beforeEach(resetDatabase);

  /**
   * A game owned by `ownerPlayerId`, with one open fixture and a seeded
   * squad covering all four fixture audiences, so the counts test can check
   * every one in a single page load.
   */
  async function seedFixtureWithSquad(ownerPlayerId: string): Promise<{ gameId: string; fixtureId: string }> {
    const db = testDb();
    const gameId = await insertGame(db, { maxPlayers: 14 });
    await insertMembership(db, gameId, ownerPlayerId, { role: "owner" });
    const fixtureId = await insertFixture(db, gameId, { maxPlayers: 14 });

    const playingId = await insertPlayer(db, { name: "Playing Player" });
    await insertMembership(db, gameId, playingId);
    await insertResponse(db, fixtureId, playingId, { status: "in" });

    const waitlistedId = await insertPlayer(db, { name: "Waitlisted Player" });
    await insertMembership(db, gameId, waitlistedId);
    await insertResponse(db, fixtureId, waitlistedId, { status: "waitlisted", waitlistPosition: 1 });

    const pendingId = await insertPlayer(db, { name: "Pending Player" });
    await insertMembership(db, gameId, pendingId);
    await insertResponse(db, fixtureId, pendingId, { status: "pending" });

    const outId = await insertPlayer(db, { name: "Out Player" });
    await insertMembership(db, gameId, outId);
    await insertResponse(db, fixtureId, outId, { status: "out" });

    // Unaddressable: playing, but with no email and no device — must not
    // count towards "Playing", or the button would promise a send that
    // reaches nobody for this row.
    const unreachablePlayingId = await insertPlayer(db, { name: "Unreachable Playing", email: null });
    await insertMembership(db, gameId, unreachablePlayingId);
    await insertResponse(db, fixtureId, unreachablePlayingId, { status: "in" });

    return { gameId, fixtureId };
  }

  it("shows the fixture-scoped page with correct counts for all four audiences", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFixtureWithSquad(viewerId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}/message`, { headers: { cookie } });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Playing (1)");
    expect(html).toContain("On the waitlist (1)");
    expect(html).toContain("Not answered yet (1)");
    expect(html).toContain("Can&#39;t play (1)");
  });

  it("counts exclude guests and unaddressable players, matching what a send would do", async () => {
    const { cookie, viewerId } = await ownerSession();
    const db = testDb();
    const gameId = await insertGame(db, { maxPlayers: 14 });
    await insertMembership(db, gameId, viewerId, { role: "owner" });
    const fixtureId = await insertFixture(db, gameId, { maxPlayers: 14 });

    const reachableId = await insertPlayer(db, { name: "Reachable" });
    await insertMembership(db, gameId, reachableId);
    await insertResponse(db, fixtureId, reachableId, { status: "in" });

    const guestId = await insertPlayer(db, { name: "Guest", email: null, isGuest: true });
    await insertResponse(db, fixtureId, guestId, { status: "in" });

    const noEmailNoDeviceId = await insertPlayer(db, { name: "No channel", email: null });
    await insertMembership(db, gameId, noEmailNoDeviceId);
    await insertResponse(db, fixtureId, noEmailNoDeviceId, { status: "in" });

    // A player with no email but a registered device is still addressable.
    const deviceOnlyId = await insertPlayer(db, { name: "Device only", email: null });
    await insertMembership(db, gameId, deviceOnlyId);
    await insertResponse(db, fixtureId, deviceOnlyId, { status: "in" });
    await insertSubscription(db, deviceOnlyId, "https://push.example.com/device-only");

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}/message`, { headers: { cookie } });

    expect(response.status).toBe(200);
    const html = await response.text();
    // Reachable + device-only, not the guest and not the no-channel player.
    expect(html).toContain("Playing (2)");
  });

  it("404s for a player who is a member but not an owner", async () => {
    const { cookie, viewerId } = await ownerSession();
    const db = testDb();
    const strangerOwner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, strangerOwner, { role: "owner" });
    await insertMembership(db, gameId, viewerId);
    const fixtureId = await insertFixture(db, gameId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}/message`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("404s for a signed-in stranger", async () => {
    const { cookie } = await ownerSession();
    const db = testDb();
    const otherOwner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, otherOwner, { role: "owner" });
    const fixtureId = await insertFixture(db, gameId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}/message`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("404s for a fixture belonging to a different game", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId } = await seedFixtureWithSquad(viewerId);
    const other = await seedFixtureWithSquad(viewerId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${other.fixtureId}/message`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("404s for an unknown fixture id", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId } = await seedFixtureWithSquad(viewerId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${crypto.randomUUID()}/message`, {
      headers: { cookie },
    });

    expect(response.status).toBe(404);
  });

  it("404s for an unknown game id", async () => {
    const { cookie } = await ownerSession();

    const response = await SELF.fetch(`${ORIGIN}/g/${crypto.randomUUID()}/f/${crypto.randomUUID()}/message`, {
      headers: { cookie },
    });

    expect(response.status).toBe(404);
  });

  it("redirects an anonymous visitor to sign in, matching the other owner routes", async () => {
    const db = testDb();
    const owner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, owner, { role: "owner" });
    const fixtureId = await insertFixture(db, gameId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}/message`, { redirect: "manual" });

    expect(response.status).toBe(302);
  });
});
