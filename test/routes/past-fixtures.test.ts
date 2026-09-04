import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { players } from "../../src/db/schema.js";
import { fixturePath, gamePastFixturesPath } from "../../src/auth/paths.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  insertResultClaim,
  resetDatabase,
  testDb,
} from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";
import { kickoffIn } from "../support/clock.js";

/** Signs in and returns the viewer's own player id, as the sibling suites do. */
async function viewerSession(): Promise<{ cookie: string; viewerId: string }> {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  return { cookie, viewerId: viewer!.id };
}

function get(gameId: string, cookie?: string) {
  return SELF.fetch(`${ORIGIN}${gamePastFixturesPath(gameId)}`, {
    headers: cookie ? { cookie } : {},
    // Manual, or the guard's redirect is followed to the sign-in page and the
    // assertion sees that page's own 200 instead of the redirect.
    redirect: "manual",
  });
}

/**
 * `GET /g/:id/fixtures` (M27) — the list a game's fixtures leave the game page
 * for once they are over.
 *
 * The route dispatches by role exactly as `/g/:id` does, and the two roles
 * genuinely see different sets: an organiser every fixture that has been and
 * gone, cancelled ones included; a member the played ones they were in.
 * Anyone else gets the same 404 both refusals give, so a game id cannot be
 * probed (TR-18).
 */
describe("GET /g/:id/fixtures", () => {
  beforeEach(resetDatabase);

  describe("as the organiser", () => {
    it("lists a played fixture, linking to it", async () => {
      const { cookie, viewerId } = await viewerSession();
      const db = testDb();
      const gameId = await insertGame(db);
      await insertMembership(db, gameId, viewerId, { role: "owner" });
      const fixtureId = await insertFixture(db, gameId, {
        lifecycle: "played",
        kicksOffAt: kickoffIn(-72),
      });

      const response = await get(gameId, cookie);

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Past fixtures");
      expect(html).toContain(`href="${fixturePath(gameId, fixtureId)}"`);
    });

    it("lists a cancelled one too", async () => {
      const { cookie, viewerId } = await viewerSession();
      const db = testDb();
      const gameId = await insertGame(db);
      await insertMembership(db, gameId, viewerId, { role: "owner" });
      const fixtureId = await insertFixture(db, gameId, {
        lifecycle: "cancelled",
        kicksOffAt: kickoffIn(-72),
        cancellationReason: "Pitch waterlogged",
      });

      const html = await (await get(gameId, cookie)).text();

      expect(html).toContain(`href="${fixturePath(gameId, fixtureId)}"`);
      expect(html).toContain("Cancelled");
    });

    it("leaves out a fixture that has not kicked off yet", async () => {
      const { cookie, viewerId } = await viewerSession();
      const db = testDb();
      const gameId = await insertGame(db);
      await insertMembership(db, gameId, viewerId, { role: "owner" });
      const upcoming = await insertFixture(db, gameId, { kicksOffAt: kickoffIn(48) });

      const html = await (await get(gameId, cookie)).text();

      expect(html).not.toContain(`href="${fixturePath(gameId, upcoming)}"`);
    });

    it("names a settled result, and says nothing about an unsettled one", async () => {
      const { cookie, viewerId } = await viewerSession();
      const db = testDb();
      const gameId = await insertGame(db);
      await insertMembership(db, gameId, viewerId, { role: "owner" });
      const locked = await insertFixture(db, gameId, {
        lifecycle: "played",
        kicksOffAt: kickoffIn(-72),
      });
      await insertResultClaim(db, locked, viewerId, { outcome: "a", scoreA: 3, scoreB: 2 });
      // Inside its window, so the same claim on this one is still arguable.
      const open = await insertFixture(db, gameId, {
        lifecycle: "played",
        kicksOffAt: kickoffIn(-2),
      });
      await insertResultClaim(db, open, viewerId, { outcome: "a", scoreA: 5, scoreB: 1 });

      const html = await (await get(gameId, cookie)).text();

      expect(html).toContain("Team A won 3–2");
      expect(html).not.toContain("Team A won 5–1");
    });

    it("404s another game's id", async () => {
      const { cookie, viewerId } = await viewerSession();
      const db = testDb();
      const mine = await insertGame(db);
      await insertMembership(db, mine, viewerId, { role: "owner" });
      const theirs = await insertGame(db, { name: "Someone Else's Game" });
      await insertFixture(db, theirs, { lifecycle: "played", kicksOffAt: kickoffIn(-72) });

      expect((await get(theirs, cookie)).status).toBe(404);
    });
  });

  describe("as a squad member", () => {
    async function seedMemberGame() {
      const { cookie, viewerId } = await viewerSession();
      const db = testDb();
      const owner = await insertPlayer(db);
      const gameId = await insertGame(db);
      await insertMembership(db, gameId, owner, { role: "owner" });
      await insertMembership(db, gameId, viewerId);
      return { cookie, viewerId, db, gameId };
    }

    it("lists a played fixture they were in", async () => {
      const { cookie, viewerId, db, gameId } = await seedMemberGame();
      const fixtureId = await insertFixture(db, gameId, {
        lifecycle: "played",
        kicksOffAt: kickoffIn(-72),
      });
      await insertResponse(db, fixtureId, viewerId, { status: "in" });

      const response = await get(gameId, cookie);

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`href="${fixturePath(gameId, fixtureId)}"`);
    });

    it("does not list a cancelled fixture — nobody played it", async () => {
      const { cookie, viewerId, db, gameId } = await seedMemberGame();
      const fixtureId = await insertFixture(db, gameId, {
        lifecycle: "cancelled",
        kicksOffAt: kickoffIn(-72),
        cancellationReason: "Pitch waterlogged",
      });
      await insertResponse(db, fixtureId, viewerId, { status: "in" });

      const html = await (await get(gameId, cookie)).text();

      expect(html).not.toContain(`href="${fixturePath(gameId, fixtureId)}"`);
    });

    it("does not list a played fixture they had no response row for", async () => {
      // Somebody who joined the squad after this one was played. The fixture
      // is the same one the positive case shows; the only difference is the
      // missing row, which is `entitledTo`'s own condition (TR-18).
      const { cookie, db, gameId } = await seedMemberGame();
      const fixtureId = await insertFixture(db, gameId, {
        lifecycle: "played",
        kicksOffAt: kickoffIn(-72),
      });

      const html = await (await get(gameId, cookie)).text();

      expect(html).not.toContain(`href="${fixturePath(gameId, fixtureId)}"`);
    });

    it("404s somebody who has left the game", async () => {
      const { cookie, viewerId } = await viewerSession();
      const db = testDb();
      const owner = await insertPlayer(db);
      const gameId = await insertGame(db);
      await insertMembership(db, gameId, owner, { role: "owner" });
      await insertMembership(db, gameId, viewerId, { active: false });
      const fixtureId = await insertFixture(db, gameId, {
        lifecycle: "played",
        kicksOffAt: kickoffIn(-72),
      });
      await insertResponse(db, fixtureId, viewerId, { status: "in" });

      expect((await get(gameId, cookie)).status).toBe(404);
    });

    it("404s somebody who was never a member", async () => {
      const { cookie } = await viewerSession();
      const db = testDb();
      const owner = await insertPlayer(db);
      const gameId = await insertGame(db);
      await insertMembership(db, gameId, owner, { role: "owner" });

      expect((await get(gameId, cookie)).status).toBe(404);
    });
  });

  it("sends a signed-out visitor to sign in rather than answering", async () => {
    const db = testDb();
    const owner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, owner, { role: "owner" });

    const response = await get(gameId);

    expect([302, 303]).toContain(response.status);
  });
});
