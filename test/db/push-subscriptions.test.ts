import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { pushSubscriptions } from "../../src/db/schema.js";
import { insertPlayer, resetDatabase, testDb } from "../support/factories.js";

const db = testDb();

describe("push_subscriptions", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("lets one player register several devices", async () => {
    // The point of the table. A phone and a tablet are two rows, and a
    // notification reaches both.
    const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });

    await db.insert(pushSubscriptions).values([
      { id: "sub-phone", playerId, endpoint: "https://push.example/1", p256dh: "k1", auth: "a1" },
      { id: "sub-tablet", playerId, endpoint: "https://push.example/2", p256dh: "k2", auth: "a2" },
    ]);

    const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.playerId, playerId));
    expect(rows).toHaveLength(2);
  });

  it("refuses a second row for the same endpoint", async () => {
    // A device that re-subscribes produces the same endpoint. Without this
    // constraint, a player who taps the button twice receives every
    // notification twice, forever, and nothing in the product would show it.
    const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
    const row = { playerId, endpoint: "https://push.example/1", p256dh: "k", auth: "a" };

    await db.insert(pushSubscriptions).values({ id: "sub-1", ...row });

    await expect(db.insert(pushSubscriptions).values({ id: "sub-2", ...row })).rejects.toThrow();
  });
});
