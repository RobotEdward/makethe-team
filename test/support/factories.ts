import { env } from "cloudflare:test";
import { getDb, type Db } from "../../src/db/client.js";
import { games } from "../../src/db/schema.js";

/**
 * Shared builders for database fixtures used by the tests.
 *
 * Each test file used to carry its own near-identical game builder, which meant
 * a schema change was three edits and the three copies had already begun to
 * drift. Everything the tests need to vary goes through `overrides`.
 */

export type GameInsert = typeof games.$inferInsert;

/** A plausible, complete game row: Thursdays at 19:00 in Oxford. */
export function gameRow(overrides: Partial<GameInsert> = {}): GameInsert {
  return {
    id: crypto.randomUUID(),
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
  };
}

/** Insert a game and return its id. */
export async function insertGame(db: Db, overrides: Partial<GameInsert> = {}): Promise<string> {
  const row = gameRow(overrides);
  await db.insert(games).values(row);
  return row.id;
}

/**
 * Empty every table a test might have written, in foreign-key-safe order.
 * Call from `beforeEach` so tests never inherit another test's rows.
 */
export async function resetDatabase(): Promise<void> {
  await env.DB.exec("DELETE FROM memberships");
  await env.DB.exec("DELETE FROM fixtures");
  await env.DB.exec("DELETE FROM games");
  await env.DB.exec("DELETE FROM players");
}

/** The Drizzle handle bound to the test D1 database. */
export function testDb(): Db {
  return getDb(env.DB);
}
