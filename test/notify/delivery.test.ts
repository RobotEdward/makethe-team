import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { notificationLog } from "../../src/db/schema.js";
import { insertQueuedLogRows, type PendingNotification } from "../../src/notify/delivery.js";
import type { PushMessage } from "../../src/notify/notifier.js";
import { insertPlayer, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);

beforeEach(async () => {
  await resetDatabase();
});

describe("the log row's channel (M14)", () => {
  it("records the channel the message was actually for", async () => {
    // insertQueuedLogRows hardcoded `channel: "email"` on every row it wrote,
    // which was true until this milestone and is now a lie that would file
    // every push under email and make the two channels indistinguishable in
    // the log.
    //
    // `notification_log.player_id` is a real foreign key, so the brief's
    // literal `playerId: "p"` needs a matching row in `players` before D1's
    // FK enforcement will accept the insert; `fixtureId` is left `null`
    // (nullable since N-6/welcome) rather than inventing a `fixtures` row
    // this test does not otherwise need.
    const playerId = await insertPlayer(db);
    const pending: PendingNotification[] = [
      { logId: "log-1", dedupeKey: "push:n1:f:p", playerId, message: pushMessage() },
    ];

    await insertQueuedLogRows(db, { fixtureId: null, notificationType: "n1" }, pending);

    const [row] = await db.select().from(notificationLog).where(eq(notificationLog.id, "log-1"));
    expect(row?.channel).toBe("push");
  });
});

function pushMessage(): PushMessage {
  return {
    channel: "push",
    to: "player-1",
    dedupeKey: "push:n1:f:p",
    title: "You're in for Thursday",
    body: "19:00 · Goals Vauxhall",
    url: "https://makethe.team/r/token",
    tag: "fixture-f",
  };
}
