import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const NOW = new Date("2026-08-13T09:00:00Z");
const KICKOFF = new Date("2026-08-13T18:00:00Z");

async function seedOpenFixture(squadSize: number, maxPlayers = 14): Promise<string> {
  const gameId = await insertGame(db, { maxPlayers });
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId, gameId, kicksOffAt: KICKOFF, minPlayers: 10, maxPlayers,
    prefersEvenNumbers: true, shortWarningOffsetHours: 12, durationMinutes: 60,
  });
  for (let i = 0; i < squadSize; i++) {
    await db.insert(players).values({ id: `p-${i}`, name: `Player ${i}`, email: `p${i}@example.com` });
    await db.insert(memberships).values({ id: `m-${i}`, gameId, playerId: `p-${i}`, active: true });
  }
  await openFixture(db, fixtureId, NOW);
  return fixtureId;
}

function stubFor(fixtureId: string) {
  return env.FIXTURE_CAPACITY.getByName(fixtureId);
}

beforeEach(async () => {
  await resetDatabase();
});

describe("addGuest", () => {
  it("creates the player and the in response together", async () => {
    const fixtureId = await seedOpenFixture(3);

    const outcome = await stubFor(fixtureId).addGuest({
      name: "Sam Whitlock", actorPlayerId: "p-0", whenFull: "refuse", now: NOW.getTime(),
    });

    expect(outcome).toMatchObject({ kind: "added", inCount: 1, spotsLeft: 13 });
    const guestId = outcome.kind === "added" ? outcome.playerId : "";
    const [player] = await db.select().from(players).where(eq(players.id, guestId));
    expect(player).toMatchObject({ name: "Sam Whitlock", email: null, isGuest: true });
    const [response] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, guestId)));
    expect(response).toMatchObject({ status: "in", source: "owner", setByPlayerId: "p-0" });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.inCount).toBe(1);
  });

  it("gives a guest no membership — they are one fixture only", async () => {
    const fixtureId = await seedOpenFixture(3);

    const outcome = await stubFor(fixtureId).addGuest({
      name: "Sam Whitlock", actorPlayerId: "p-0", whenFull: "refuse", now: NOW.getTime(),
    });
    const guestId = outcome.kind === "added" ? outcome.playerId : "";

    const rows = await db.select().from(memberships).where(eq(memberships.playerId, guestId));
    expect(rows).toEqual([]);
  });

  it("refuses on a full fixture and leaves no orphaned player row", async () => {
    const fixtureId = await seedOpenFixture(2, 2);
    await stubFor(fixtureId).setResponse({
      playerId: "p-0", intent: "in", actorPlayerId: null, source: "token", whenFull: "waitlist", now: NOW.getTime(),
    });
    await stubFor(fixtureId).setResponse({
      playerId: "p-1", intent: "in", actorPlayerId: null, source: "token", whenFull: "waitlist", now: NOW.getTime(),
    });
    const playersBefore = (await db.select().from(players)).length;

    const outcome = await stubFor(fixtureId).addGuest({
      name: "Sam Whitlock", actorPlayerId: "p-0", whenFull: "refuse", now: NOW.getTime(),
    });

    expect(outcome).toEqual({ kind: "rejected", reason: "would-exceed-capacity" });
    // The whole point of creating the row inside the lock: a refusal leaves
    // no person behind in the database.
    expect((await db.select().from(players)).length).toBe(playersBefore);
  });

  it("goes over capacity when the owner confirms", async () => {
    const fixtureId = await seedOpenFixture(2, 2);
    await stubFor(fixtureId).setResponse({
      playerId: "p-0", intent: "in", actorPlayerId: null, source: "token", whenFull: "waitlist", now: NOW.getTime(),
    });
    await stubFor(fixtureId).setResponse({
      playerId: "p-1", intent: "in", actorPlayerId: null, source: "token", whenFull: "waitlist", now: NOW.getTime(),
    });

    const outcome = await stubFor(fixtureId).addGuest({
      name: "Sam Whitlock", actorPlayerId: "p-0", whenFull: "exceed", now: NOW.getTime(),
    });

    expect(outcome).toMatchObject({ kind: "added", inCount: 3, spotsLeft: 0 });
  });

  it("refuses on a fixture that is not open", async () => {
    const gameId = await insertGame(db);
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId, gameId, kicksOffAt: KICKOFF, minPlayers: 10, maxPlayers: 14,
      prefersEvenNumbers: true, shortWarningOffsetHours: 12, durationMinutes: 60,
    });

    const outcome = await stubFor(fixtureId).addGuest({
      name: "Sam Whitlock", actorPlayerId: "p-0", whenFull: "refuse", now: NOW.getTime(),
    });

    expect(outcome).toEqual({ kind: "rejected", reason: "fixture-not-open" });
  });

  it("adds the same name twice as two separate guests", async () => {
    const fixtureId = await seedOpenFixture(3);

    const first = await stubFor(fixtureId).addGuest({
      name: "Sam Whitlock", actorPlayerId: "p-0", whenFull: "refuse", now: NOW.getTime(),
    });
    const second = await stubFor(fixtureId).addGuest({
      name: "Sam Whitlock", actorPlayerId: "p-0", whenFull: "refuse", now: NOW.getTime(),
    });

    // Two people can genuinely share a name, and deduplicating would guess
    // otherwise. Both occupy a slot (§5).
    expect(first.kind).toBe("added");
    expect(second).toMatchObject({ kind: "added", inCount: 2 });
  });
});
