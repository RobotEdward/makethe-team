import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { emailQuota, fixtures, notificationLog, players } from "../../src/db/schema.js";
import { attentionKey, promotionKey, welcomeKey } from "../../src/notify/dedupe-key.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);

async function seedFixtureAndPlayer(): Promise<{ fixtureId: string; playerId: string }> {
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
  const playerId = crypto.randomUUID();
  await db.insert(players).values({ id: playerId, name: "Edward Cooper", email: "e@example.com" });
  return { fixtureId, playerId };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("notification_log", () => {
  it("rejects a second row with the same dedupe key", async () => {
    const { fixtureId, playerId } = await seedFixtureAndPlayer();
    await db.insert(notificationLog).values({
      id: crypto.randomUUID(),
      dedupeKey: attentionKey(fixtureId, playerId),
      notificationType: "n4",
      fixtureId,
      playerId,
    });

    await expect(
      db.insert(notificationLog).values({
        id: crypto.randomUUID(),
        dedupeKey: attentionKey(fixtureId, playerId),
        notificationType: "n4",
        fixtureId,
        playerId,
      }),
    ).rejects.toThrow();
  });

  it("accepts a null fixture_id for an N-6 welcome key", async () => {
    const { playerId } = await seedFixtureAndPlayer();
    const membershipId = crypto.randomUUID();
    await db.insert(notificationLog).values({
      id: crypto.randomUUID(),
      dedupeKey: welcomeKey(membershipId),
      notificationType: "n6",
      fixtureId: null,
      playerId,
    });

    const [saved] = await db.select().from(notificationLog);
    expect(saved?.fixtureId).toBeNull();
  });

  it("N-2/N-4 asymmetry: two promotions at different timestamps both insert; two attention rows for the same owner and fixture collide", async () => {
    const { fixtureId, playerId } = await seedFixtureAndPlayer();

    // Two genuine promotions produce two distinct keys, so both insert.
    await db.insert(notificationLog).values({
      id: crypto.randomUUID(),
      dedupeKey: promotionKey(fixtureId, playerId, "2026-08-12T09:00:00.000Z"),
      notificationType: "n2",
      fixtureId,
      playerId,
    });
    await db.insert(notificationLog).values({
      id: crypto.randomUUID(),
      dedupeKey: promotionKey(fixtureId, playerId, "2026-08-13T09:00:00.000Z"),
      notificationType: "n2",
      fixtureId,
      playerId,
    });
    const promotions = await db.select().from(notificationLog);
    expect(promotions).toHaveLength(2);

    // A second attention row for the same owner and fixture collides.
    await db.insert(notificationLog).values({
      id: crypto.randomUUID(),
      dedupeKey: attentionKey(fixtureId, playerId),
      notificationType: "n4",
      fixtureId,
      playerId,
    });
    await expect(
      db.insert(notificationLog).values({
        id: crypto.randomUUID(),
        dedupeKey: attentionKey(fixtureId, playerId),
        notificationType: "n4",
        fixtureId,
        playerId,
      }),
    ).rejects.toThrow();
  });

  it("defaults status to queued and channel to email", async () => {
    const { fixtureId, playerId } = await seedFixtureAndPlayer();
    await db.insert(notificationLog).values({
      id: crypto.randomUUID(),
      dedupeKey: attentionKey(fixtureId, playerId),
      notificationType: "n4",
      fixtureId,
      playerId,
    });

    const [saved] = await db.select().from(notificationLog);
    expect(saved?.status).toBe("queued");
    expect(saved?.channel).toBe("email");
    expect(saved?.providerMessageId).toBeNull();
    expect(saved?.sentAt).toBeNull();
    expect(saved?.error).toBeNull();
  });

  it("resetDatabase empties notification_log and email_quota", async () => {
    const { fixtureId, playerId } = await seedFixtureAndPlayer();
    await db.insert(notificationLog).values({
      id: crypto.randomUUID(),
      dedupeKey: attentionKey(fixtureId, playerId),
      notificationType: "n4",
      fixtureId,
      playerId,
    });
    await db.insert(emailQuota).values({ day: "2026-08-13", sentCount: 5 });

    await resetDatabase();

    expect(await db.select().from(notificationLog)).toHaveLength(0);
    expect(await db.select().from(emailQuota)).toHaveLength(0);
  });
});

describe("email_quota", () => {
  it("keys on day and defaults sent_count to 0", async () => {
    await db.insert(emailQuota).values({ day: "2026-08-13" });

    const [saved] = await db.select().from(emailQuota);
    expect(saved?.day).toBe("2026-08-13");
    expect(saved?.sentCount).toBe(0);
  });

  it("rejects a second row for the same day", async () => {
    await db.insert(emailQuota).values({ day: "2026-08-13" });

    await expect(db.insert(emailQuota).values({ day: "2026-08-13" })).rejects.toThrow();
  });
});
