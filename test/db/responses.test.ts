import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, players, responses } from "../../src/db/schema.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);

async function seedFixtureAndPlayer(): Promise<{ fixtureId: string; playerId: string }> {
  const gameId = await insertGame(db);
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: new Date("2026-08-13T18:00:00Z"),
    minPlayers: 10,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });
  const playerId = crypto.randomUUID();
  await db.insert(players).values({ id: playerId, name: "Edward Cooper", email: "e@example.com" });
  return { fixtureId, playerId };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("responses", () => {
  it("defaults to pending with no responded_at", async () => {
    const { fixtureId, playerId } = await seedFixtureAndPlayer();
    await db.insert(responses).values({ id: crypto.randomUUID(), fixtureId, playerId, source: "system" });

    const [saved] = await db.select().from(responses);
    expect(saved?.status).toBe("pending");
    expect(saved?.respondedAt).toBeNull();
    expect(saved?.waitlistPosition).toBeNull();
    expect(saved?.setByPlayerId).toBeNull();
  });

  it("allows only one response per player per fixture", async () => {
    const { fixtureId, playerId } = await seedFixtureAndPlayer();
    await db.insert(responses).values({ id: crypto.randomUUID(), fixtureId, playerId, source: "system" });

    await expect(
      db.insert(responses).values({ id: crypto.randomUUID(), fixtureId, playerId, source: "token" }),
    ).rejects.toThrow();
  });

  it("accepts a guest with no email as a respondent", async () => {
    const { fixtureId } = await seedFixtureAndPlayer();
    const guestId = crypto.randomUUID();
    await db.insert(players).values({ id: guestId, name: "Dave from work", isGuest: true });
    await db.insert(responses).values({
      id: crypto.randomUUID(), fixtureId, playerId: guestId, status: "in",
      source: "owner", respondedAt: new Date("2026-08-12T10:00:00Z"),
    });

    const [saved] = await db.select().from(responses);
    expect(saved?.status).toBe("in");
  });

  it("is cleared by resetDatabase so tests cannot leak rows into each other", async () => {
    const { fixtureId, playerId } = await seedFixtureAndPlayer();
    await db.insert(responses).values({ id: crypto.randomUUID(), fixtureId, playerId, source: "system" });

    await resetDatabase();

    const row = await env.DB.prepare("SELECT COUNT(*) as count FROM responses").first<{ count: number }>();
    expect(row?.count).toBe(0);
  });
});
