import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { notificationLog, players } from "../../src/db/schema.js";
import {
  DELIVERY_FAILURE_WINDOW_DAYS,
  getSquadPresence,
} from "../../src/db/presence-queries.js";
import { eq } from "drizzle-orm";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  insertSubscription,
  resetDatabase,
} from "../support/factories.js";
import { NOW } from "../support/clock.js";

const db = getDb(env.DB);
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDatabase();
});

/** A game with one member, which is the shape every test here needs. */
async function gameWithMember(overrides: Parameters<typeof insertPlayer>[1] = {}) {
  const gameId = await insertGame(db);
  const playerId = await insertPlayer(db, overrides);
  await insertMembership(db, gameId, playerId);
  return { gameId, playerId };
}

async function logFailure(playerId: string, fixtureId: string, at: Date) {
  await db.insert(notificationLog).values({
    id: crypto.randomUUID(),
    dedupeKey: crypto.randomUUID(),
    notificationType: "n4",
    fixtureId,
    playerId,
    status: "failed",
    createdAt: at,
  });
}

describe("getSquadPresence", () => {
  it("returns nothing for a game with no squad", async () => {
    const gameId = await insertGame(db);

    expect(await getSquadPresence(db, gameId, NOW)).toEqual([]);
  });

  it("reports a member nobody has ever seen as blank rather than absent", async () => {
    const { gameId, playerId } = await gameWithMember();

    expect(await getSquadPresence(db, gameId, NOW)).toEqual([
      {
        playerId,
        lastSeenAt: null,
        lastAnsweredAt: null,
        lastStandaloneAt: null,
        pushDevices: 0,
        deliveryFailing: false,
      },
    ]);
  });

  it("carries the player's own two stamps through", async () => {
    const seen = new Date(NOW.getTime() - 2 * DAY);
    const installed = new Date(NOW.getTime() - 3 * DAY);
    const { gameId, playerId } = await gameWithMember();
    await db
      .update(players)
      .set({ lastSeenAt: seen, lastStandaloneAt: installed })
      .where(eq(players.id, playerId));

    const [row] = await getSquadPresence(db, gameId, NOW);

    expect(row?.lastSeenAt).toEqual(seen);
    expect(row?.lastStandaloneAt).toEqual(installed);
  });

  it("counts a member's registered devices", async () => {
    const { gameId, playerId } = await gameWithMember();
    await insertSubscription(db, playerId, "https://push.example/a");
    await insertSubscription(db, playerId, "https://push.example/b");

    expect((await getSquadPresence(db, gameId, NOW))[0]?.pushDevices).toBe(2);
  });

  // The classic fan-out: joining devices and responses to memberships in one
  // statement multiplies one by the other, and two devices on a member who
  // answered three fixtures reads as six devices.
  it("does not multiply devices by answers", async () => {
    const { gameId, playerId } = await gameWithMember();
    await insertSubscription(db, playerId, "https://push.example/a");
    for (const week of [1, 2, 3]) {
      // Distinct kickoffs: (game_id, kicks_off_at) is unique.
      const fixtureId = await insertFixture(db, gameId, {
        kicksOffAt: new Date(NOW.getTime() + week * 7 * DAY),
      });
      await insertResponse(db, fixtureId, playerId, { status: "in", respondedAt: NOW });
    }

    expect((await getSquadPresence(db, gameId, NOW))[0]?.pushDevices).toBe(1);
  });

  it("reports a device whose last send failed after its last success", async () => {
    const { gameId, playerId } = await gameWithMember();
    await insertSubscription(db, playerId, "https://push.example/a", {
      lastSuccessAt: new Date(NOW.getTime() - 2 * DAY),
      lastFailureAt: new Date(NOW.getTime() - DAY),
    });

    expect((await getSquadPresence(db, gameId, NOW))[0]?.deliveryFailing).toBe(true);
  });

  it("says nothing about a device that failed once and has since succeeded", async () => {
    const { gameId, playerId } = await gameWithMember();
    await insertSubscription(db, playerId, "https://push.example/a", {
      lastFailureAt: new Date(NOW.getTime() - 2 * DAY),
      lastSuccessAt: new Date(NOW.getTime() - DAY),
    });

    expect((await getSquadPresence(db, gameId, NOW))[0]?.deliveryFailing).toBe(false);
  });

  it("reports a failed send in the log, which is how an email failure shows", async () => {
    const { gameId, playerId } = await gameWithMember();
    const fixtureId = await insertFixture(db, gameId);
    await logFailure(playerId, fixtureId, new Date(NOW.getTime() - DAY));

    expect((await getSquadPresence(db, gameId, NOW))[0]?.deliveryFailing).toBe(true);
  });

  it("forgets a failure older than the window", async () => {
    const { gameId, playerId } = await gameWithMember();
    const fixtureId = await insertFixture(db, gameId);
    await logFailure(
      playerId,
      fixtureId,
      new Date(NOW.getTime() - (DELIVERY_FAILURE_WINDOW_DAYS + 1) * DAY),
    );

    expect((await getSquadPresence(db, gameId, NOW))[0]?.deliveryFailing).toBe(false);
  });

  it("takes the member's newest answer in this game", async () => {
    const { gameId, playerId } = await gameWithMember();
    const older = await insertFixture(db, gameId, { kicksOffAt: new Date(NOW.getTime() - 10 * DAY) });
    const newer = await insertFixture(db, gameId, { kicksOffAt: new Date(NOW.getTime() - DAY) });
    await insertResponse(db, older, playerId, {
      status: "in",
      respondedAt: new Date(NOW.getTime() - 10 * DAY),
    });
    await insertResponse(db, newer, playerId, {
      status: "in",
      respondedAt: new Date(NOW.getTime() - DAY),
    });

    expect((await getSquadPresence(db, gameId, NOW))[0]?.lastAnsweredAt).toEqual(
      new Date(NOW.getTime() - DAY),
    );
  });

  // Materialisation writes a response row per member the moment a fixture
  // appears. Counting those as answers would make every member of a live game
  // look active whether or not they had said a word.
  it("ignores a response row nobody has answered", async () => {
    const { gameId, playerId } = await gameWithMember();
    const fixtureId = await insertFixture(db, gameId);
    await insertResponse(db, fixtureId, playerId);

    expect((await getSquadPresence(db, gameId, NOW))[0]?.lastAnsweredAt).toBeNull();
  });

  it("does not read an answer the member gave in a different game", async () => {
    const { gameId, playerId } = await gameWithMember();
    const elsewhere = await insertGame(db);
    await insertMembership(db, elsewhere, playerId);
    const fixtureId = await insertFixture(db, elsewhere);
    await insertResponse(db, fixtureId, playerId, { status: "in", respondedAt: NOW });

    expect((await getSquadPresence(db, gameId, NOW))[0]?.lastAnsweredAt).toBeNull();
  });

  it("leaves out a member who has left the squad", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db);
    await insertMembership(db, gameId, playerId, { active: false, leftAt: NOW });

    expect(await getSquadPresence(db, gameId, NOW)).toEqual([]);
  });

  it("keeps each member's row to that member", async () => {
    const gameId = await insertGame(db);
    const quiet = await insertPlayer(db, { name: "Quiet" });
    const pushed = await insertPlayer(db, { name: "Pushed" });
    await insertMembership(db, gameId, quiet);
    await insertMembership(db, gameId, pushed);
    await insertSubscription(db, pushed, "https://push.example/a");

    const rows = await getSquadPresence(db, gameId, NOW);

    expect(rows.find((r) => r.playerId === pushed)?.pushDevices).toBe(1);
    expect(rows.find((r) => r.playerId === quiet)?.pushDevices).toBe(0);
  });
});
