import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, games } from "../../src/db/schema.js";
import { materialiseFixtures } from "../../src/domain/materialise.js";

const db = getDb(env.DB);
const NOW = new Date("2026-08-10T08:00:00Z"); // a Monday

async function insertGame(overrides: Partial<typeof games.$inferInsert> = {}): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(games).values({
    id,
    name: "Thursday 7-a-side",
    venueName: "Oxford Sports Park",
    timezone: "Europe/London",
    recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=TH",
    recurrenceStartDate: "2026-08-13",
    kickoffTime: "19:00",
    durationMinutes: 60,
    minPlayers: 10,
    maxPlayers: 14,
    inviteToken: crypto.randomUUID(),
    ...overrides,
  });
  return id;
}

async function fixtureInstants(gameId: string): Promise<string[]> {
  const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, gameId));
  return rows.map((r) => r.kicksOffAt.toISOString()).sort();
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM fixtures");
  await env.DB.exec("DELETE FROM games");
});

describe("materialiseFixtures", () => {
  it("creates at least four weeks of fixtures (BR-10)", async () => {
    const gameId = await insertGame();

    const result = await materialiseFixtures(db, NOW);

    expect(result.gamesProcessed).toBe(1);
    expect(result.fixturesCreated).toBe(4);
    expect(await fixtureInstants(gameId)).toEqual([
      "2026-08-13T18:00:00.000Z",
      "2026-08-20T18:00:00.000Z",
      "2026-08-27T18:00:00.000Z",
      "2026-09-03T18:00:00.000Z",
    ]);
  });

  it("creates every fixture in scheduled lifecycle", async () => {
    await insertGame();
    await materialiseFixtures(db, NOW);

    const rows = await db.select().from(fixtures);
    expect(rows.every((r) => r.lifecycle === "scheduled")).toBe(true);
    expect(rows.every((r) => r.openedAt === null)).toBe(true);
    expect(rows.every((r) => r.inCount === 0)).toBe(true);
  });

  it("copies the game's settings onto each fixture", async () => {
    await insertGame({ minPlayers: 8, maxPlayers: 12, prefersEvenNumbers: false, shortWarningOffsetHours: 24 });
    await materialiseFixtures(db, NOW);

    const rows = await db.select().from(fixtures);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.minPlayers).toBe(8);
      expect(row.maxPlayers).toBe(12);
      expect(row.prefersEvenNumbers).toBe(false);
      expect(row.shortWarningOffsetHours).toBe(24);
      expect(row.durationMinutes).toBe(60);
    }
  });

  it("is idempotent — a second run creates nothing (TR-6)", async () => {
    const gameId = await insertGame();

    const first = await materialiseFixtures(db, NOW);
    const before = await fixtureInstants(gameId);
    const second = await materialiseFixtures(db, NOW);
    const after = await fixtureInstants(gameId);

    expect(first.fixturesCreated).toBe(4);
    expect(second.fixturesCreated).toBe(0);
    expect(after).toEqual(before);
  });

  it("extends the horizon as time passes", async () => {
    const gameId = await insertGame();
    await materialiseFixtures(db, NOW);

    const later = new Date("2026-08-24T08:00:00Z");
    const result = await materialiseFixtures(db, later);

    expect(result.fixturesCreated).toBe(2);
    expect(await fixtureInstants(gameId)).toEqual([
      "2026-08-13T18:00:00.000Z",
      "2026-08-20T18:00:00.000Z",
      "2026-08-27T18:00:00.000Z",
      "2026-09-03T18:00:00.000Z",
      "2026-09-10T18:00:00.000Z",
      "2026-09-17T18:00:00.000Z",
    ]);
  });

  it("ignores inactive games", async () => {
    await insertGame({ active: false });

    const result = await materialiseFixtures(db, NOW);

    expect(result.gamesProcessed).toBe(0);
    expect(result.fixturesCreated).toBe(0);
  });

  it("does not recreate a cancelled fixture (BR-16)", async () => {
    const gameId = await insertGame();
    await materialiseFixtures(db, NOW);

    await db
      .update(fixtures)
      .set({ lifecycle: "cancelled", cancelledAt: NOW, cancellationReason: "Pitch flooded" })
      .where(eq(fixtures.kicksOffAt, new Date("2026-08-20T18:00:00Z")));

    const result = await materialiseFixtures(db, NOW);

    expect(result.fixturesCreated).toBe(0);
    const [cancelled] = await db
      .select()
      .from(fixtures)
      .where(eq(fixtures.kicksOffAt, new Date("2026-08-20T18:00:00Z")));
    expect(cancelled?.lifecycle).toBe("cancelled");
    expect(await fixtureInstants(gameId)).toHaveLength(4);
  });

  it("holds the local kickoff time across a DST transition", async () => {
    const gameId = await insertGame({ recurrenceStartDate: "2026-10-15" });

    await materialiseFixtures(db, new Date("2026-10-14T08:00:00Z"));

    expect(await fixtureInstants(gameId)).toEqual([
      "2026-10-15T18:00:00.000Z",
      "2026-10-22T18:00:00.000Z",
      "2026-10-29T19:00:00.000Z",
      "2026-11-05T19:00:00.000Z",
    ]);
  });

  it("processes remaining games when one has a broken rule", async () => {
    await insertGame({ recurrenceRule: "FREQ=MONTHLY;BYDAY=TH" });
    const healthy = await insertGame();

    const result = await materialiseFixtures(db, NOW);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toMatch(/MONTHLY/);
    expect(await fixtureInstants(healthy)).toHaveLength(4);
  });

  it("handles many games in one run", async () => {
    for (let i = 0; i < 5; i++) await insertGame({ inviteToken: `token-${i}` });

    const result = await materialiseFixtures(db, NOW);

    expect(result.gamesProcessed).toBe(5);
    expect(result.fixturesCreated).toBe(20);
  });

  it("materialises a long horizon without hitting D1's bound-parameter ceiling", async () => {
    const gameId = await insertGame();

    const result = await materialiseFixtures(db, NOW, 365);

    expect(result.failures).toEqual([]);
    expect(result.fixturesCreated).toBeGreaterThanOrEqual(50);
    expect(result.fixturesCreated).toBeLessThanOrEqual(54);
    expect(await fixtureInstants(gameId)).toHaveLength(result.fixturesCreated);
  });

  it("stays idempotent and duplicate-free when runs overlap concurrently", async () => {
    const gameId = await insertGame();

    const [first, second, third] = await Promise.all([
      materialiseFixtures(db, NOW),
      materialiseFixtures(db, NOW),
      materialiseFixtures(db, NOW),
    ]);

    for (const result of [first, second, third]) {
      expect(result.failures).toEqual([]);
    }
    expect(first.fixturesCreated + second.fixturesCreated + third.fixturesCreated).toBe(4);
    expect(await fixtureInstants(gameId)).toHaveLength(4);
  });
});
