import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures, games } from "../../src/db/schema.js";
import { fixtureRowsFor, materialiseFixtures, materialiseGame } from "../../src/domain/materialise.js";
import {
  insertGame as insertGameRow,
  resetDatabase,
  testDb,
  type GameInsert,
} from "../support/factories.js";

const db = testDb();
const NOW = new Date("2026-08-10T08:00:00Z"); // a Monday

async function insertGame(overrides: Partial<GameInsert> = {}): Promise<string> {
  return insertGameRow(db, overrides);
}

async function fixtureInstants(gameId: string): Promise<string[]> {
  const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, gameId));
  return rows.map((r) => r.kicksOffAt.toISOString()).sort();
}

beforeEach(resetDatabase);

describe("materialiseFixtures", () => {
  it("creates at least four weeks of fixtures (BR-10)", async () => {
    const gameId = await insertGame();

    const result = await materialiseFixtures(db, NOW);

    expect(result.gamesProcessed).toBe(1);
    // Five, not four: the 35-day horizon deliberately overshoots the four weeks
    // BR-10 demands, so the guarantee survives a day (or a missed run) of decay.
    expect(result.fixturesCreated).toBe(5);
    expect(await fixtureInstants(gameId)).toEqual([
      "2026-08-13T18:00:00.000Z",
      "2026-08-20T18:00:00.000Z",
      "2026-08-27T18:00:00.000Z",
      "2026-09-03T18:00:00.000Z",
      "2026-09-10T18:00:00.000Z",
    ]);
  });

  it("still has four weeks of fixtures ahead the day before the next run", async () => {
    const gameId = await insertGame();
    await materialiseFixtures(db, NOW);

    // The horizon is measured from `now`, so it decays between daily runs. The
    // margin is what keeps BR-10 true at the worst moment rather than only
    // immediately after a run.
    const fourWeeksOn = new Date(NOW.getTime() + 28 * 86_400_000);
    const instants = await fixtureInstants(gameId);
    const beyond = instants.filter((iso) => new Date(iso).getTime() > fourWeeksOn.getTime());

    expect(beyond.length).toBeGreaterThan(0);
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

    expect(first.fixturesCreated).toBe(5);
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
      "2026-09-24T18:00:00.000Z",
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
      .where(
        and(eq(fixtures.gameId, gameId), eq(fixtures.kicksOffAt, new Date("2026-08-20T18:00:00Z"))),
      );

    const result = await materialiseFixtures(db, NOW);

    expect(result.fixturesCreated).toBe(0);
    const [cancelled] = await db
      .select()
      .from(fixtures)
      .where(eq(fixtures.kicksOffAt, new Date("2026-08-20T18:00:00Z")));
    expect(cancelled?.lifecycle).toBe("cancelled");
    expect(await fixtureInstants(gameId)).toHaveLength(5);
  });

  it("holds the local kickoff time across a DST transition", async () => {
    const gameId = await insertGame({ recurrenceStartDate: "2026-10-15" });

    await materialiseFixtures(db, new Date("2026-10-14T08:00:00Z"));

    expect(await fixtureInstants(gameId)).toEqual([
      "2026-10-15T18:00:00.000Z",
      "2026-10-22T18:00:00.000Z",
      "2026-10-29T19:00:00.000Z",
      "2026-11-05T19:00:00.000Z",
      "2026-11-12T19:00:00.000Z",
    ]);
  });

  it("processes remaining games when one has a broken rule", async () => {
    await insertGame({ recurrenceRule: "FREQ=MONTHLY;BYDAY=TH" });
    const healthy = await insertGame();

    const result = await materialiseFixtures(db, NOW);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toMatch(/MONTHLY/);
    expect(await fixtureInstants(healthy)).toHaveLength(5);
  });

  it("handles many games in one run", async () => {
    for (let i = 0; i < 5; i++) await insertGame({ inviteToken: `token-${i}` });

    const result = await materialiseFixtures(db, NOW);

    expect(result.gamesProcessed).toBe(5);
    expect(result.fixturesCreated).toBe(25);
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
    expect(first.fixturesCreated + second.fixturesCreated + third.fixturesCreated).toBe(5);
    expect(await fixtureInstants(gameId)).toHaveLength(5);
  });
});

describe("materialiseGame", () => {
  it("materialises one game and returns the count created", async () => {
    const gameId = await insertGame();
    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    const now = new Date(Date.UTC(2026, 7, 12, 9, 0));

    const created = await materialiseGame(db, game!, now);

    const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, gameId));
    expect(created).toBe(rows.length);
    expect(created).toBeGreaterThan(0);
  });

  it("is idempotent — a second call creates nothing", async () => {
    const gameId = await insertGame();
    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    const now = new Date(Date.UTC(2026, 7, 12, 9, 0));

    await materialiseGame(db, game!, now);
    expect(await materialiseGame(db, game!, now)).toBe(0);
  });
});

describe("fixtureRowsFor", () => {
  it("builds rows without touching the database", async () => {
    const gameId = await insertGame();
    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    const now = new Date(Date.UTC(2026, 7, 12, 9, 0));

    const rows = fixtureRowsFor(game!, now, new Date(now.getTime() + 35 * 86_400_000));

    expect(rows.length).toBeGreaterThan(0);
    // The five columns §2.8 copies at materialisation.
    expect(rows[0]!.minPlayers).toBe(game!.minPlayers);
    expect(rows[0]!.maxPlayers).toBe(game!.maxPlayers);
    expect(rows[0]!.prefersEvenNumbers).toBe(game!.prefersEvenNumbers);
    expect(rows[0]!.shortWarningOffsetHours).toBe(game!.shortWarningOffsetHours);
    expect(rows[0]!.durationMinutes).toBe(game!.durationMinutes);
    // Nothing was written.
    expect(await db.select().from(fixtures)).toHaveLength(0);
  });
});
