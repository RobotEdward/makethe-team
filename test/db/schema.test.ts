import { beforeEach, describe, expect, it } from "vitest";
import { games, players } from "../../src/db/schema.js";
import { gameRow, resetDatabase, testDb } from "../support/factories.js";

const db = testDb();

beforeEach(resetDatabase);

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
