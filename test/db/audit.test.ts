import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { recordAudit } from "../../src/db/audit.js";
import { getDb } from "../../src/db/client.js";
import { auditLog, players } from "../../src/db/schema.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const now = new Date("2026-08-13T18:00:00Z");

beforeEach(async () => {
  await resetDatabase();
});

describe("recordAudit", () => {
  it("accepts a null actor for a system/cron action", async () => {
    const gameId = await insertGame(db);
    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "fixture",
      entityId: gameId,
      action: "cancelled",
      before: { lifecycle: "confirmed" },
      after: { lifecycle: "cancelled" },
      now,
    });

    const [saved] = await db.select().from(auditLog);
    expect(saved?.actorPlayerId).toBeNull();
  });

  it("round-trips before/after through JSON", async () => {
    const playerId = crypto.randomUUID();
    await db.insert(players).values({ id: playerId, name: "Edward Cooper", email: "e@example.com" });

    await recordAudit(db, {
      actorPlayerId: playerId,
      entityType: "fixture",
      entityId: "fixture-1",
      action: "cancelled",
      before: { lifecycle: "confirmed", inCount: 12 },
      after: { lifecycle: "cancelled", inCount: 12 },
      now,
    });

    const [saved] = await db.select().from(auditLog);
    expect(saved?.beforeJson).toBeTruthy();
    expect(saved?.afterJson).toBeTruthy();
    expect(JSON.parse(saved?.beforeJson ?? "null")).toEqual({ lifecycle: "confirmed", inCount: 12 });
    expect(JSON.parse(saved?.afterJson ?? "null")).toEqual({ lifecycle: "cancelled", inCount: 12 });
    expect(saved?.createdAt).toEqual(now);
  });

  it("retains two entries for the same entity — this is a log, not a state table", async () => {
    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "fixture",
      entityId: "fixture-1",
      action: "opened",
      now,
    });
    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "fixture",
      entityId: "fixture-1",
      action: "cancelled",
      now,
    });

    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(2);
  });

  it("resetDatabase empties audit_log", async () => {
    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "fixture",
      entityId: "fixture-1",
      action: "opened",
      now,
    });
    expect(await db.select().from(auditLog)).toHaveLength(1);

    await resetDatabase();

    expect(await db.select().from(auditLog)).toHaveLength(0);
  });
});
