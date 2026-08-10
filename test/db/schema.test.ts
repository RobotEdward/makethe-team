import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { games, players } from "../../src/db/schema.js";

const db = getDb(env.DB);

function gameRow(overrides: Partial<typeof games.$inferInsert> = {}): typeof games.$inferInsert {
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

beforeEach(async () => {
  await env.DB.exec("DELETE FROM memberships");
  await env.DB.exec("DELETE FROM fixtures");
  await env.DB.exec("DELETE FROM games");
  await env.DB.exec("DELETE FROM players");
});

describe("players", () => {
  it("allows many guests with no email", async () => {
    await db.insert(players).values([
      { id: crypto.randomUUID(), name: "Ringer One", isGuest: true },
      { id: crypto.randomUUID(), name: "Ringer Two", isGuest: true },
    ]);

    const rows = await db.select().from(players);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.email === null)).toBe(true);
  });

  it("rejects a duplicate email", async () => {
    await db.insert(players).values({ id: crypto.randomUUID(), name: "Edward", email: "e@example.com" });

    await expect(
      db.insert(players).values({ id: crypto.randomUUID(), name: "Impostor", email: "e@example.com" }),
    ).rejects.toThrow();
  });
});

describe("games", () => {
  it("defaults prefersEvenNumbers to true and the reminder to 09:00 the day before", async () => {
    const row = gameRow();
    await db.insert(games).values(row);

    const [saved] = await db.select().from(games);
    expect(saved?.prefersEvenNumbers).toBe(true);
    expect(saved?.reminderDaysBefore).toBe(1);
    expect(saved?.reminderLocalTime).toBe("09:00");
    expect(saved?.shortWarningOffsetHours).toBe(12);
    expect(saved?.active).toBe(true);
  });
});
