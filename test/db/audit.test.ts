import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { recordAudit } from "../../src/db/audit.js";
import { getDb } from "../../src/db/client.js";
import { auditLog, fixtures, players } from "../../src/db/schema.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const now = new Date("2026-08-13T18:00:00Z");

async function insertFixture(): Promise<string> {
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
  return fixtureId;
}

beforeEach(async () => {
  await resetDatabase();
});

describe("recordAudit", () => {
  it("accepts a null actor for a system/cron action", async () => {
    const fixtureId = await insertFixture();
    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "fixture",
      entityId: fixtureId,
      action: "fixture.cancelled",
      before: { lifecycle: "open" },
      after: { lifecycle: "cancelled" },
      now,
    });

    const [saved] = await db.select().from(auditLog);
    expect(saved?.actorPlayerId).toBeNull();
  });

  it("round-trips before/after through JSON", async () => {
    const fixtureId = await insertFixture();
    const playerId = crypto.randomUUID();
    await db.insert(players).values({ id: playerId, name: "Edward Cooper", email: "e@example.com" });

    await recordAudit(db, {
      actorPlayerId: playerId,
      entityType: "fixture",
      entityId: fixtureId,
      action: "fixture.cancelled",
      before: { lifecycle: "open", inCount: 12 },
      after: { lifecycle: "cancelled", inCount: 12 },
      now,
    });

    const [saved] = await db.select().from(auditLog);
    expect(saved?.beforeJson).toBeTruthy();
    expect(saved?.afterJson).toBeTruthy();
    expect(JSON.parse(saved?.beforeJson ?? "null")).toEqual({ lifecycle: "open", inCount: 12 });
    expect(JSON.parse(saved?.afterJson ?? "null")).toEqual({ lifecycle: "cancelled", inCount: 12 });
    expect(saved?.createdAt).toEqual(now);
  });

  it("distinguishes omitted before/after (SQL NULL) from an explicit null (stored as the JSON string \"null\")", async () => {
    const fixtureId = await insertFixture();

    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "fixture",
      entityId: fixtureId,
      action: "fixture.cancelled",
      // before omitted entirely
      after: null,
      now,
    });

    const [saved] = await db.select().from(auditLog);
    expect(saved?.beforeJson).toBeNull();
    expect(saved?.afterJson).toBe("null");
    expect(JSON.parse(saved?.afterJson ?? "")).toBeNull();
  });

  it("retains two entries for the same entity — this is a log, not a state table", async () => {
    const fixtureId = await insertFixture();
    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "fixture",
      entityId: fixtureId,
      action: "fixture.cancelled",
      now,
    });
    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "fixture",
      entityId: fixtureId,
      action: "fixture.cancelled",
      now,
    });

    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(2);
  });

  it("resetDatabase empties audit_log", async () => {
    const fixtureId = await insertFixture();
    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "fixture",
      entityId: fixtureId,
      action: "fixture.cancelled",
      now,
    });
    expect(await db.select().from(auditLog)).toHaveLength(1);

    await resetDatabase();

    expect(await db.select().from(auditLog)).toHaveLength(0);
  });
});
