import { env } from "cloudflare:test";
import { getDb, type Db } from "../../src/db/client.js";
import { fixtures, games, memberships, players, responses } from "../../src/db/schema.js";
import { kickoffIn, NOW } from "./clock.js";

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
  await env.DB.exec("DELETE FROM audit_log");
  await env.DB.exec("DELETE FROM notification_log");
  await env.DB.exec("DELETE FROM email_quota");
  await env.DB.exec("DELETE FROM responses");
  await env.DB.exec("DELETE FROM memberships");
  await env.DB.exec("DELETE FROM fixtures");
  await env.DB.exec("DELETE FROM games");
  await env.DB.exec("DELETE FROM players");
  // Better Auth tables (M5). Children before parent: session, account and
  // passkey all hold a FK to user.id (ON DELETE cascade would make this
  // order optional, but delete explicitly rather than relying on it — this
  // project has already been bitten once by a `resetDatabase` that omitted a
  // table and leant on an implicit cascade to cover the gap).
  await env.DB.exec("DELETE FROM session");
  await env.DB.exec("DELETE FROM account");
  await env.DB.exec("DELETE FROM passkey");
  await env.DB.exec("DELETE FROM verification");
  await env.DB.exec("DELETE FROM user");
}

/** The Drizzle handle bound to the test D1 database. */
export function testDb(): Db {
  return getDb(env.DB);
}

export type PlayerInsert = typeof players.$inferInsert;

/** A plausible player row. Pass `email: null, isGuest: true` for a guest. */
export function playerRow(overrides: Partial<PlayerInsert> = {}): PlayerInsert {
  return {
    id: crypto.randomUUID(),
    name: "Edward Charles",
    email: `player-${crypto.randomUUID()}@example.com`,
    ...overrides,
  };
}

export async function insertPlayer(db: Db, overrides: Partial<PlayerInsert> = {}): Promise<string> {
  const row = playerRow(overrides);
  await db.insert(players).values(row);
  return row.id;
}

/** Put a player in a squad. Defaults to an active ordinary member. */
export async function insertMembership(
  db: Db,
  gameId: string,
  playerId: string,
  overrides: Partial<typeof memberships.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  // `joinedAt` is pinned to the suite's own `NOW` rather than left to the
  // column's default (the wall clock at insert). `/leave/:token` compares a
  // token's mint time against this column, and a test that mints its token at
  // `NOW` would otherwise be racing the few milliseconds between the two — the
  // same class of clock-relative fragility `clock.ts` exists to remove.
  await db.insert(memberships).values({ id, gameId, playerId, joinedAt: NOW, ...overrides });
  return id;
}

export async function insertFixture(
  db: Db,
  gameId: string,
  overrides: Partial<typeof fixtures.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(fixtures).values({
    id,
    gameId,
    kicksOffAt: kickoffIn(24 * 7),
    minPlayers: 10,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
    ...overrides,
  });
  return id;
}

export async function insertResponse(
  db: Db,
  fixtureId: string,
  playerId: string,
  overrides: Partial<typeof responses.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(responses).values({ id, fixtureId, playerId, source: "system", ...overrides });
  return id;
}
