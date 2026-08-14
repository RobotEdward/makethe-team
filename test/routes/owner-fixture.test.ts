import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures, players } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

const NOW = new Date("2026-08-13T09:00:00Z");

function stubFor(fixtureId: string) {
  return env.FIXTURE_CAPACITY.getByName(fixtureId);
}

/** Signs in and returns the signed-in player's own id alongside the cookie. */
async function ownerSession(): Promise<{ cookie: string; viewerId: string }> {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  return { cookie, viewerId: viewer!.id };
}

/**
 * A game owned by `ownerPlayerId`, with one open fixture and one ordinary
 * member ("Player 0") marked in — built by driving the app's own domain
 * functions (`openFixture`, the capacity Durable Object's `setResponse`)
 * rather than writing rows by hand, so the world this test loads is one the
 * app itself could have produced.
 */
async function seedOpenFixtureOwnedBy(ownerPlayerId: string): Promise<{ gameId: string; fixtureId: string }> {
  const db = testDb();
  const gameId = await insertGame(db, { maxPlayers: 14 });
  await insertMembership(db, gameId, ownerPlayerId, { role: "owner" });
  const memberPlayerId = await insertPlayer(db, { name: "Player 0" });
  await insertMembership(db, gameId, memberPlayerId);

  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: new Date("2026-08-20T18:00:00Z"),
    minPlayers: 1,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });
  await openFixture(db, fixtureId, NOW);

  await stubFor(fixtureId).setResponse({
    playerId: memberPlayerId,
    intent: "in",
    actorPlayerId: null,
    source: "token",
    whenFull: "waitlist",
    now: NOW.getTime(),
  });

  return { gameId, fixtureId };
}

/**
 * A fixture whose squad has been driven past its own `maxPlayers` (BR-8), by
 * setting responses with `whenFull: "exceed"` — the only supported way to
 * reach that state, so this seed exercises exactly the path the Durable
 * Object provides for it.
 */
async function seedFullFixtureOverCapacity(ownerPlayerId: string): Promise<{ gameId: string; fixtureId: string }> {
  const db = testDb();
  const gameId = await insertGame(db, { maxPlayers: 2 });
  await insertMembership(db, gameId, ownerPlayerId, { role: "owner" });

  const memberIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const playerId = await insertPlayer(db, { name: `Player ${i}` });
    await insertMembership(db, gameId, playerId);
    memberIds.push(playerId);
  }

  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: new Date("2026-08-20T18:00:00Z"),
    minPlayers: 1,
    maxPlayers: 2,
    prefersEvenNumbers: false,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });
  await openFixture(db, fixtureId, NOW);

  for (const playerId of memberIds) {
    await stubFor(fixtureId).setResponse({
      playerId,
      intent: "in",
      actorPlayerId: ownerPlayerId,
      source: "owner",
      whenFull: "exceed",
      now: NOW.getTime(),
    });
  }

  return { gameId, fixtureId };
}

describe("GET /g/:id/f/:fixtureId", () => {
  beforeEach(resetDatabase);

  it("shows the squad to an owner", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Player 0");
  });

  it("404s for a player who is not an owner", async () => {
    const { cookie, viewerId } = await ownerSession();
    const db = testDb();
    const strangerOwner = await insertPlayer(db);
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(strangerOwner);
    // The viewer is a real member of this game, just not an organiser of it.
    await insertMembership(db, gameId, viewerId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("404s for a fixture belonging to a different game", async () => {
    const { viewerId, cookie } = await ownerSession();
    const { gameId } = await seedOpenFixtureOwnedBy(viewerId);
    // The owner owns both games, so this is specifically the scoping check:
    // the fixture is real and they are entitled to it — just not at this path.
    const other = await seedOpenFixtureOwnedBy(viewerId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${other.fixtureId}`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("404s for an unknown fixture id", async () => {
    const { viewerId, cookie } = await ownerSession();
    const { gameId } = await seedOpenFixtureOwnedBy(viewerId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${crypto.randomUUID()}`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("redirects an anonymous visitor to sign in", async () => {
    const db = testDb();
    const owner = await insertPlayer(db);
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(owner);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { redirect: "manual" });

    expect(response.status).toBe(302);
  });

  it("says a fixture is over capacity", async () => {
    const { viewerId, cookie } = await ownerSession();
    const { gameId, fixtureId } = await seedFullFixtureOverCapacity(viewerId);

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    expect(html).toContain("Over capacity");
  });
});
