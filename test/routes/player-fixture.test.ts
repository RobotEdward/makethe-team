import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { players } from "../../src/db/schema.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  resetDatabase,
  testDb,
} from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";
import { kickoffIn } from "../support/clock.js";

/**
 * Signs in and returns the signed-in player's own id alongside the cookie —
 * the same shape `test/routes/owner-fixture.test.ts`'s `ownerSession` uses,
 * named without "owner" here since the viewer plays either role depending on
 * which seed puts them where.
 */
async function viewerSession(): Promise<{ cookie: string; viewerId: string }> {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  return { cookie, viewerId: viewer!.id };
}

describe("GET /g/:id/f/:fixtureId dispatches by role (M25)", () => {
  beforeEach(resetDatabase);

  it("gives an active owner the organiser's page", async () => {
    const { cookie, viewerId } = await viewerSession();
    const db = testDb();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, viewerId, { role: "owner" });
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } });

    expect(response.status).toBe(200);
    const html = await response.text();
    // Only `renderOwnerFixturePage` emits the guest-management form.
    expect(html).toContain("Add a guest");
  });

  it("gives an active squad member the player page", async () => {
    const { cookie, viewerId } = await viewerSession();
    const db = testDb();
    const otherOwner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, otherOwner, { role: "owner" });
    await insertMembership(db, gameId, viewerId);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } });

    expect(response.status).toBe(200);
    const html = await response.text();
    // Only `renderPlayerFixturePage` renders the result panel — the owner
    // page has none (this task adds no result panel to it).
    expect(html).toContain("<h2>Result</h2>");
    // And the owner-only guest form must not leak to a non-owner.
    expect(html).not.toContain("Add a guest");
  });

  it("404s someone who is not a member", async () => {
    const { cookie, viewerId } = await viewerSession();
    const db = testDb();
    const otherOwner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, otherOwner, { role: "owner" });
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open" });
    // The viewer is a real, active member of a *different* game — as
    // distinct from the next test, where they hold no membership anywhere —
    // so this exercises `findGameForMember`'s own-game scoping rather than a
    // viewer the system has never seen in a squad.
    const otherGameId = await insertGame(db);
    await insertMembership(db, otherGameId, viewerId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("404s a signed-in stranger", async () => {
    // The signed-in player holds no membership anywhere in the system, as
    // distinct from the previous case, where they belong to other games —
    // both must answer the same 404 (TR-18).
    const { cookie } = await viewerSession();
    const db = testDb();
    const otherOwner = await insertPlayer(db);
    const otherMember = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, otherOwner, { role: "owner" });
    await insertMembership(db, gameId, otherMember);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("404s when the fixture belongs to another game", async () => {
    const { cookie, viewerId } = await viewerSession();
    const db = testDb();
    // The viewer is a genuine, active member of gameA — just not of gameB,
    // whose fixture id they are pasting in.
    const otherOwner = await insertPlayer(db);
    const gameA = await insertGame(db);
    await insertMembership(db, gameA, otherOwner, { role: "owner" });
    await insertMembership(db, gameA, viewerId);

    const gameB = await insertGame(db);
    await insertMembership(db, gameB, otherOwner, { role: "owner" });
    const fixtureIdInGameB = await insertFixture(db, gameB, { lifecycle: "open" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameA}/f/${fixtureIdInGameB}`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("serves a played fixture, not only an open one", async () => {
    const { cookie, viewerId } = await viewerSession();
    const db = testDb();
    const otherOwner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, otherOwner, { role: "owner" });
    await insertMembership(db, gameId, viewerId);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: kickoffIn(-72),
    });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<h2>Result</h2>");
  });
});
