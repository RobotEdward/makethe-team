import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { games, memberships, notificationLog, responses } from "../../src/db/schema.js";
import { ConsoleNotifier } from "../../src/notify/console-notifier.js";
import { openAndRemind } from "../../src/sweep/open-and-remind.js";
import {
  insertFixture,
  insertGame,
  insertInviteTier,
  insertMembership,
  insertPlayer,
  resetDatabase,
} from "../support/factories.js";

const db = getDb(env.DB);
const notifier = new ConsoleNotifier();
const SECRET = "test-only-secret-not-used-in-any-real-environment";

// The reminder instant for a game reminding one day before at 09:00
// Europe/London, kicking off on the 25th, is 2026-08-24T08:00:00Z.
const NOW = new Date("2026-08-24T09:30:00Z");
const KICKOFF = new Date("2026-08-25T18:00:00Z");

async function dueGatedGame(coreSize: number, subSize: number) {
  const gameId = await insertGame(db, {
    gatedInvitesEnabled: true,
    reminderDaysBefore: 1,
    reminderLocalTime: "09:00",
    timezone: "Europe/London",
  });
  const fixtureId = await insertFixture(db, gameId, {
    kicksOffAt: KICKOFF,
    minPlayers: 2,
    maxPlayers: 10,
  });
  const core = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
  const subs = await insertInviteTier(db, gameId, { name: "Subs", position: 2 });
  for (let i = 0; i < coreSize + subSize; i++) {
    const playerId = await insertPlayer(db, { id: `p-${i}`, email: `p${i}@example.com` });
    await insertMembership(db, gameId, playerId, {
      inviteTierId: i < coreSize ? core : subs,
    });
  }
  return { gameId, fixtureId };
}

async function emailedN1(fixtureId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(notificationLog)
    .where(eq(notificationLog.fixtureId, fixtureId));
  return rows
    .filter((row) => row.notificationType === "n1" && row.channel === "email")
    .map((row) => row.playerId);
}

beforeEach(async () => {
  await resetDatabase();
});

describe("the sweep and gated invites", () => {
  it("opens, claims the core, and mails only the core", async () => {
    const { fixtureId } = await dueGatedGame(3, 4);

    const result = await openAndRemind(db, notifier, NOW, SECRET, env.FIXTURE_CAPACITY);

    expect(result.fixturesOpened).toBe(1);
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    // BR-1 is unchanged: every active member still gets an eligible row.
    expect(rows).toHaveLength(7);
    expect(rows.filter((row) => row.invitedAt !== null)).toHaveLength(3);
    expect((await emailedN1(fixtureId)).sort()).toEqual(["p-0", "p-1", "p-2"]);
  });

  it("mails a tier released by a decline on the next tick, once only", async () => {
    const { fixtureId } = await dueGatedGame(3, 2);
    await openAndRemind(db, notifier, NOW, SECRET, env.FIXTURE_CAPACITY);
    await db
      .update(responses)
      .set({ status: "out", respondedAt: NOW })
      .where(eq(responses.playerId, "p-0"));

    await openAndRemind(db, notifier, new Date("2026-08-24T10:30:00Z"), SECRET, env.FIXTURE_CAPACITY);
    await openAndRemind(db, notifier, new Date("2026-08-24T11:30:00Z"), SECRET, env.FIXTURE_CAPACITY);

    // 3 core + 2 subs, and no repeats on the third tick.
    expect((await emailedN1(fixtureId)).sort()).toEqual(["p-0", "p-1", "p-2", "p-3", "p-4"]);
  });

  it("mails a player whose stamp landed but whose send never happened", async () => {
    const { fixtureId } = await dueGatedGame(2, 1);
    await openAndRemind(db, notifier, NOW, SECRET, env.FIXTURE_CAPACITY);
    // The request-path failure: stamped inside the lock, but the send that
    // should have followed it never wrote a log row.
    await db.update(responses).set({ invitedAt: NOW }).where(eq(responses.playerId, "p-2"));

    await openAndRemind(db, notifier, new Date("2026-08-24T10:30:00Z"), SECRET, env.FIXTURE_CAPACITY);

    expect(await emailedN1(fixtureId)).toContain("p-2");
  });

  it("counts what it claimed", async () => {
    const { fixtureId } = await dueGatedGame(3, 2);

    const result = await openAndRemind(db, notifier, NOW, SECRET, env.FIXTURE_CAPACITY);

    expect(result.tiersClaimed).toBe(1);
    expect(result.invitationsClaimed).toBe(3);
    expect(fixtureId).toBeTruthy();
  });

  it("mails the whole squad for an ungated game (BR-39)", async () => {
    const gameId = await insertGame(db, {
      reminderDaysBefore: 1,
      reminderLocalTime: "09:00",
      timezone: "Europe/London",
    });
    const fixtureId = await insertFixture(db, gameId, { kicksOffAt: KICKOFF });
    for (let i = 0; i < 5; i++) {
      const playerId = await insertPlayer(db, { id: `u-${i}`, email: `u${i}@example.com` });
      await insertMembership(db, gameId, playerId);
    }

    await openAndRemind(db, notifier, NOW, SECRET, env.FIXTURE_CAPACITY);

    expect(await emailedN1(fixtureId)).toHaveLength(5);
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    // Never written for an ungated game, so nothing can come to depend on it.
    expect(rows.every((row) => row.invitedAt === null)).toBe(true);
  });
});

describe("switching gating on after a fixture has already been mailed", () => {
  it("leaves that fixture ungated for the rest of its life", async () => {
    // An ordinary ungated game opens and the whole squad is invited.
    const gameId = await insertGame(db, {
      reminderDaysBefore: 1,
      reminderLocalTime: "09:00",
      timezone: "Europe/London",
    });
    const fixtureId = await insertFixture(db, gameId, {
      kicksOffAt: KICKOFF,
      minPlayers: 2,
      maxPlayers: 10,
    });
    for (let i = 0; i < 6; i++) {
      const playerId = await insertPlayer(db, { id: `p-${i}`, email: `p${i}@example.com` });
      await insertMembership(db, gameId, playerId);
    }
    await openAndRemind(db, notifier, NOW, SECRET, env.FIXTURE_CAPACITY);
    expect(await emailedN1(fixtureId)).toHaveLength(6);

    // Only now does the owner switch gating on and define an order.
    const core = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
    await db.update(games).set({ gatedInvitesEnabled: true }).where(eq(games.id, gameId));
    for (const playerId of ["p-0", "p-1"]) {
      await db
        .update(memberships)
        .set({ inviteTierId: core })
        .where(eq(memberships.playerId, playerId));
    }

    await openAndRemind(db, notifier, new Date("2026-08-24T10:30:00Z"), SECRET, env.FIXTURE_CAPACITY);

    // Nothing stamped, so no screen can claim a tier is held while the people
    // in it are holding the invitation, and nobody is mailed a second time.
    const rows = await db.select().from(responses).where(eq(responses.fixtureId, fixtureId));
    expect(rows.every((row) => row.invitedAt === null)).toBe(true);
    expect(await emailedN1(fixtureId)).toHaveLength(6);
  });

  it("gates the next fixture normally", async () => {
    const gameId = await insertGame(db, {
      gatedInvitesEnabled: true,
      reminderDaysBefore: 1,
      reminderLocalTime: "09:00",
      timezone: "Europe/London",
    });
    const core = await insertInviteTier(db, gameId, { name: "Core", position: 1 });
    await insertInviteTier(db, gameId, { name: "Subs", position: 2 });
    for (let i = 0; i < 4; i++) {
      const playerId = await insertPlayer(db, { id: `q-${i}`, email: `q${i}@example.com` });
      await insertMembership(db, gameId, playerId, {
        inviteTierId: i < 2 ? core : null,
      });
    }
    const fixtureId = await insertFixture(db, gameId, {
      kicksOffAt: KICKOFF,
      minPlayers: 2,
      maxPlayers: 10,
    });

    await openAndRemind(db, notifier, NOW, SECRET, env.FIXTURE_CAPACITY);

    expect((await emailedN1(fixtureId)).sort()).toEqual(["q-0", "q-1"]);
  });
});
