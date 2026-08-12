import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createGame } from "../../src/domain/create-game.js";
import { parseGameForm } from "../../src/domain/game-form.js";
import { auditLog, fixtures, games, memberships } from "../../src/db/schema.js";
import { insertPlayer, resetDatabase, testDb } from "../support/factories.js";

function values() {
  const result = parseGameForm({
    name: "Thursday 7-a-side",
    venueName: "Oxford Sports Park",
    weekday: "TH",
    interval: "1",
    kickoffTime: "19:00",
    durationMinutes: "60",
    minPlayers: "10",
    maxPlayers: "14",
    prefersEvenNumbers: "on",
  });
  if (!result.ok) throw new Error("fixture form values must be valid");
  return result.values;
}

describe("createGame", () => {
  beforeEach(resetDatabase);

  const now = new Date(Date.UTC(2026, 7, 12, 9, 0));

  it("writes the game, the owner membership, and four weeks of fixtures", async () => {
    const db = testDb();
    const ownerPlayerId = await insertPlayer(db, { name: "Edward" });

    const created = await createGame({ db, values: values(), ownerPlayerId, now });

    const [game] = await db.select().from(games).where(eq(games.id, created.gameId));
    expect(game?.name).toBe("Thursday 7-a-side");
    expect(game?.recurrenceRule).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=TH");

    const [membership] = await db.select().from(memberships).where(eq(memberships.gameId, created.gameId));
    expect(membership?.playerId).toBe(ownerPlayerId);
    expect(membership?.role).toBe("owner");
    expect(membership?.active).toBe(true);

    // J1's "no further action needed" is only true if they are already there.
    const rows = await db.select().from(fixtures).where(eq(fixtures.gameId, created.gameId));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(created.fixturesCreated).toBe(rows.length);
  });

  it("anchors the recurrence to today in the game's own timezone", async () => {
    const db = testDb();
    const ownerPlayerId = await insertPlayer(db);

    const created = await createGame({ db, values: values(), ownerPlayerId, now });

    const [game] = await db.select().from(games).where(eq(games.id, created.gameId));
    expect(game?.recurrenceStartDate).toBe("2026-08-12");
  });

  it("mints an unguessable invite token", async () => {
    const db = testDb();
    const ownerPlayerId = await insertPlayer(db);

    const first = await createGame({ db, values: values(), ownerPlayerId, now });
    const second = await createGame({ db, values: values(), ownerPlayerId, now });

    expect(first.inviteToken).not.toBe(second.inviteToken);
    expect(first.inviteToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("records the creation in audit_log (BR-27)", async () => {
    const db = testDb();
    const ownerPlayerId = await insertPlayer(db);

    const created = await createGame({ db, values: values(), ownerPlayerId, now });

    const [row] = await db.select().from(auditLog).where(eq(auditLog.entityId, created.gameId));
    expect(row?.action).toBe("game.created");
    expect(row?.actorPlayerId).toBe(ownerPlayerId);
  });
});
