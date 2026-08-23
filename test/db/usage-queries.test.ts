import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { getActivityCounts, getLimitCounts, getOutcomeCounts, getScaleCounts, listGameUsage } from "../../src/db/usage-queries.js";
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
import { emailQuota, fixtureResults, notificationLog, session, user } from "../../src/db/schema.js";
import { dayKey } from "../../src/notify/quota.js";
import { ERASED_DISPLAY_NAME } from "../../src/domain/display-name.js";

const HOUR = 60 * 60 * 1000;
const since = new Date(NOW.getTime() - 24 * HOUR);
const inside = new Date(NOW.getTime() - 1 * HOUR);
const outside = new Date(NOW.getTime() - 48 * HOUR);

/** A signed-in session, which is what the activity count reads as a sign-in. */
async function insertSession(at: Date): Promise<void> {
  const id = crypto.randomUUID();
  await db.insert(user).values({
    id,
    name: "Operator",
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(session).values({
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    userId: id,
    expiresAt: new Date(at.getTime() + 30 * 24 * HOUR),
    createdAt: at,
    updatedAt: at,
  });
}

const db = getDb(env.DB);

beforeEach(async () => {
  await resetDatabase();
});

describe("getScaleCounts", () => {
  it("reports zero for every count on an empty database", async () => {
    expect(await getScaleCounts(db)).toEqual({
      games: 0,
      activeMemberships: 0,
      players: 0,
      guests: 0,
      signedIn: 0,
      erased: 0,
      pushDevices: 0,
    });
  });

  it("counts games", async () => {
    await insertGame(db);
    await insertGame(db);

    expect((await getScaleCounts(db)).games).toBe(2);
  });

  it("counts only active memberships", async () => {
    const gameId = await insertGame(db);
    const stayed = await insertPlayer(db);
    const left = await insertPlayer(db);
    await insertMembership(db, gameId, stayed);
    await insertMembership(db, gameId, left, { active: false, leftAt: NOW });

    expect((await getScaleCounts(db)).activeMemberships).toBe(1);
  });

  it("splits players into guests, signed-in and erased", async () => {
    await insertPlayer(db);
    await insertPlayer(db, { email: null, isGuest: true });
    await insertPlayer(db, { authUserId: "auth-1" });
    await insertPlayer(db, { erasedAt: NOW });

    const counts = await getScaleCounts(db);

    expect(counts.players).toBe(4);
    expect(counts.guests).toBe(1);
    expect(counts.signedIn).toBe(1);
    expect(counts.erased).toBe(1);
  });

  it("counts every registered device, including two belonging to one player", async () => {
    const playerId = await insertPlayer(db);
    await insertSubscription(db, playerId, "https://push.example/one");
    await insertSubscription(db, playerId, "https://push.example/two");

    expect((await getScaleCounts(db)).pushDevices).toBe(2);
  });

  it("does not count a fixture as a game", async () => {
    const gameId = await insertGame(db);
    await insertFixture(db, gameId);

    expect((await getScaleCounts(db)).games).toBe(1);
  });
});

describe("getActivityCounts", () => {
  it("reports zero for every count on an empty database", async () => {
    expect(await getActivityCounts(db, since)).toEqual({
      gamesCreated: 0,
      fixturesCreated: 0,
      fixturesOpened: 0,
      fixturesCancelled: 0,
      responsesRecorded: 0,
      signIns: 0,
    });
  });

  it("counts a game created inside the window and not one created before it", async () => {
    await insertGame(db, { createdAt: inside });
    await insertGame(db, { createdAt: outside });

    expect((await getActivityCounts(db, since)).gamesCreated).toBe(1);
  });

  it("counts fixtures by when they were created, opened and cancelled separately", async () => {
    const gameId = await insertGame(db, { createdAt: outside });
    await insertFixture(db, gameId, { createdAt: inside });
    await insertFixture(db, gameId, {
      createdAt: outside,
      openedAt: inside,
      kicksOffAt: new Date(NOW.getTime() + 48 * HOUR),
    });
    await insertFixture(db, gameId, {
      createdAt: outside,
      cancelledAt: inside,
      kicksOffAt: new Date(NOW.getTime() + 72 * HOUR),
    });

    const counts = await getActivityCounts(db, since);

    expect(counts.fixturesCreated).toBe(1);
    expect(counts.fixturesOpened).toBe(1);
    expect(counts.fixturesCancelled).toBe(1);
  });

  it("counts a response only once the player actually answered", async () => {
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId);
    const answered = await insertPlayer(db);
    const silent = await insertPlayer(db);
    await insertResponse(db, fixtureId, answered, { status: "in", respondedAt: inside });
    await insertResponse(db, fixtureId, silent, { createdAt: inside });

    expect((await getActivityCounts(db, since)).responsesRecorded).toBe(1);
  });

  it("counts a sign-in inside the window and not one before it", async () => {
    await insertSession(inside);
    await insertSession(outside);

    expect((await getActivityCounts(db, since)).signIns).toBe(1);
  });
});

const windowFrom = new Date(NOW.getTime() - 28 * 24 * HOUR);

/** Cache the agreed result of a played fixture, as the results cron does. */
async function insertResult(fixtureId: string): Promise<void> {
  await db.insert(fixtureResults).values({
    fixtureId,
    outcome: "a",
    outcomeBackers: 3,
    marginBackers: 3,
    voterCount: 3,
    eligibleCount: 10,
    distinctOutcomes: 1,
    distinctScores: 1,
    rostered: true,
    teamsAccurate: true,
    lockedAt: NOW,
  });
}

describe("getOutcomeCounts", () => {
  it("reports zero for every count when nothing kicked off in the window", async () => {
    const gameId = await insertGame(db);
    await insertFixture(db, gameId, { kicksOffAt: new Date(NOW.getTime() + 24 * HOUR) });

    expect(await getOutcomeCounts(db, windowFrom, NOW)).toEqual({
      total: 0,
      cancelled: 0,
      played: 0,
      reachedMin: 0,
      teamsPublished: 0,
      resultFiled: 0,
    });
  });

  it("excludes a fixture that kicked off before the window opened", async () => {
    const gameId = await insertGame(db);
    await insertFixture(db, gameId, { kicksOffAt: new Date(NOW.getTime() - 40 * 24 * HOUR) });

    expect((await getOutcomeCounts(db, windowFrom, NOW)).total).toBe(0);
  });

  it("counts a cancelled fixture in the total but not as played", async () => {
    const gameId = await insertGame(db);
    await insertFixture(db, gameId, { kicksOffAt: new Date(NOW.getTime() - 2 * HOUR), cancelledAt: NOW });

    const counts = await getOutcomeCounts(db, windowFrom, NOW);

    expect(counts.total).toBe(1);
    expect(counts.cancelled).toBe(1);
    expect(counts.played).toBe(0);
  });

  it("counts a fixture as reaching min players only when it filled", async () => {
    const gameId = await insertGame(db);
    await insertFixture(db, gameId, {
      kicksOffAt: new Date(NOW.getTime() - 2 * HOUR),
      minPlayers: 10,
      inCount: 10,
    });
    await insertFixture(db, gameId, {
      kicksOffAt: new Date(NOW.getTime() - 3 * HOUR),
      minPlayers: 10,
      inCount: 9,
    });

    const counts = await getOutcomeCounts(db, windowFrom, NOW);

    expect(counts.played).toBe(2);
    expect(counts.reachedMin).toBe(1);
  });

  it("does not credit a cancelled fixture that had filled before it was called off", async () => {
    const gameId = await insertGame(db);
    await insertFixture(db, gameId, {
      kicksOffAt: new Date(NOW.getTime() - 2 * HOUR),
      minPlayers: 10,
      inCount: 12,
      cancelledAt: NOW,
      teamsPublishedAt: NOW,
    });

    const counts = await getOutcomeCounts(db, windowFrom, NOW);

    expect(counts.reachedMin).toBe(0);
    expect(counts.teamsPublished).toBe(0);
  });

  it("counts published teams and a filed result", async () => {
    const gameId = await insertGame(db);
    const withBoth = await insertFixture(db, gameId, {
      kicksOffAt: new Date(NOW.getTime() - 2 * HOUR),
      teamsPublishedAt: NOW,
    });
    await insertResult(withBoth);
    await insertFixture(db, gameId, { kicksOffAt: new Date(NOW.getTime() - 3 * HOUR) });

    const counts = await getOutcomeCounts(db, windowFrom, NOW);

    expect(counts.teamsPublished).toBe(1);
    expect(counts.resultFiled).toBe(1);
  });
});

/** One `notification_log` row, which needs a real player to hang off. */
async function insertNotification(
  status: "queued" | "sent" | "failed",
  createdAt: Date,
): Promise<void> {
  const playerId = await insertPlayer(db);
  await db.insert(notificationLog).values({
    id: crypto.randomUUID(),
    dedupeKey: crypto.randomUUID(),
    notificationType: "n2",
    playerId,
    status,
    createdAt,
  });
}

describe("getLimitCounts", () => {
  it("reports an empty database as nothing sent and nothing overdue", async () => {
    const counts = await getLimitCounts(db, NOW);

    expect(counts.emailsToday).toBe(0);
    expect(counts.notificationFailures).toBe(0);
    expect(counts.unopenedPastFixtures).toBe(0);
  });

  it("reads today's send count from the row the quota itself writes", async () => {
    await db.insert(emailQuota).values({ day: dayKey(NOW), sentCount: 17 });
    await db.insert(emailQuota).values({ day: "1999-01-01", sentCount: 400 });

    expect((await getLimitCounts(db, NOW)).emailsToday).toBe(17);
  });

  it("counts only failed notifications, and only recent ones", async () => {
    await insertNotification("failed", inside);
    await insertNotification("failed", new Date(NOW.getTime() - 30 * 24 * HOUR));
    await insertNotification("sent", inside);

    expect((await getLimitCounts(db, NOW)).notificationFailures).toBe(1);
  });

  it("counts a fixture that kicked off having never been opened", async () => {
    const gameId = await insertGame(db);
    await insertFixture(db, gameId, { kicksOffAt: new Date(NOW.getTime() - 2 * HOUR) });

    expect((await getLimitCounts(db, NOW)).unopenedPastFixtures).toBe(1);
  });

  it("does not count a past fixture that was opened, or one that was cancelled", async () => {
    const gameId = await insertGame(db);
    await insertFixture(db, gameId, {
      kicksOffAt: new Date(NOW.getTime() - 2 * HOUR),
      openedAt: outside,
    });
    await insertFixture(db, gameId, {
      kicksOffAt: new Date(NOW.getTime() - 3 * HOUR),
      cancelledAt: outside,
    });

    expect((await getLimitCounts(db, NOW)).unopenedPastFixtures).toBe(0);
  });

  it("does not count a future fixture that has not been opened yet", async () => {
    const gameId = await insertGame(db);
    await insertFixture(db, gameId, { kicksOffAt: new Date(NOW.getTime() + 48 * HOUR) });

    expect((await getLimitCounts(db, NOW)).unopenedPastFixtures).toBe(0);
  });

  it("reports a row count for each of the tables that grow with use", async () => {
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId);
    await insertResponse(db, fixtureId, await insertPlayer(db));

    const rows = (await getLimitCounts(db, NOW)).tableRows;

    expect(rows.find((r) => r.table === "responses")?.rows).toBe(1);
    expect(rows.find((r) => r.table === "fixtures")?.rows).toBe(1);
    expect(rows.find((r) => r.table === "notification_log")?.rows).toBe(0);
  });
});

describe("listGameUsage", () => {
  it("returns nothing when there are no games", async () => {
    expect(await listGameUsage(db, windowFrom, NOW, 25)).toEqual([]);
  });

  it("reports a game nobody has used yet, dated from its creation", async () => {
    const gameId = await insertGame(db, { name: "Sunday League", createdAt: outside });

    expect(await listGameUsage(db, windowFrom, NOW, 25)).toEqual([
      {
        gameId,
        name: "Sunday League",
        owners: [],
        squadSize: 0,
        recentFixtures: 0,
        invited: 0,
        responded: 0,
        lastActivityAt: outside,
      },
    ]);
  });

  it("counts the active squad and ignores members who left", async () => {
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, await insertPlayer(db));
    await insertMembership(db, gameId, await insertPlayer(db), { active: false, leftAt: NOW });

    expect((await listGameUsage(db, windowFrom, NOW, 25))[0]?.squadSize).toBe(1);
  });

  it("names the active owners alphabetically and leaves ordinary members out", async () => {
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, await insertPlayer(db, { name: "Sam Doe" }), {
      role: "owner",
    });
    await insertMembership(db, gameId, await insertPlayer(db, { name: "Ali Khan" }), {
      role: "owner",
    });
    await insertMembership(db, gameId, await insertPlayer(db, { name: "Just A Player" }));

    expect((await listGameUsage(db, windowFrom, NOW, 25))[0]?.owners).toEqual([
      "Ali Khan",
      "Sam Doe",
    ]);
  });

  it("leaves out an owner who has left the squad", async () => {
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, await insertPlayer(db, { name: "Gone" }), {
      role: "owner",
      active: false,
      leftAt: NOW,
    });

    expect((await listGameUsage(db, windowFrom, NOW, 25))[0]?.owners).toEqual([]);
  });

  it("shows an erased owner as the placeholder, never the stored name", async () => {
    const gameId = await insertGame(db);
    await insertMembership(
      db,
      gameId,
      await insertPlayer(db, { name: "[erased player]", erasedAt: NOW }),
      { role: "owner" },
    );

    expect((await listGameUsage(db, windowFrom, NOW, 25))[0]?.owners).toEqual([
      ERASED_DISPLAY_NAME,
    ]);
  });

  it("keeps each game's owners to that game", async () => {
    const mine = await insertGame(db, { name: "Mine", createdAt: outside });
    const theirs = await insertGame(db, { name: "Theirs", createdAt: since });
    await insertMembership(db, mine, await insertPlayer(db, { name: "Ali" }), { role: "owner" });
    await insertMembership(db, theirs, await insertPlayer(db, { name: "Sam" }), { role: "owner" });

    const rows = await listGameUsage(db, windowFrom, NOW, 25);

    expect(rows.find((r) => r.name === "Mine")?.owners).toEqual(["Ali"]);
    expect(rows.find((r) => r.name === "Theirs")?.owners).toEqual(["Sam"]);
  });

  it("counts fixtures and answers inside the window only", async () => {
    const gameId = await insertGame(db);
    const recent = await insertFixture(db, gameId, { kicksOffAt: new Date(NOW.getTime() - 2 * HOUR) });
    const old = await insertFixture(db, gameId, {
      kicksOffAt: new Date(NOW.getTime() - 40 * 24 * HOUR),
    });
    await insertResponse(db, recent, await insertPlayer(db), { status: "in", respondedAt: inside });
    await insertResponse(db, recent, await insertPlayer(db));
    await insertResponse(db, old, await insertPlayer(db), { status: "in", respondedAt: outside });

    const row = (await listGameUsage(db, windowFrom, NOW, 25))[0];

    expect(row?.recentFixtures).toBe(1);
    expect(row?.invited).toBe(2);
    expect(row?.responded).toBe(1);
  });

  it("dates a game by its most recent answer, even one older than the window", async () => {
    const gameId = await insertGame(db, { createdAt: new Date(NOW.getTime() - 90 * 24 * HOUR) });
    const fixtureId = await insertFixture(db, gameId, {
      kicksOffAt: new Date(NOW.getTime() - 40 * 24 * HOUR),
    });
    await insertResponse(db, fixtureId, await insertPlayer(db), {
      status: "in",
      respondedAt: outside,
    });

    expect((await listGameUsage(db, windowFrom, NOW, 25))[0]?.lastActivityAt).toEqual(outside);
  });

  it("puts the most recently active game first", async () => {
    const quiet = await insertGame(db, { name: "Quiet", createdAt: outside });
    const busy = await insertGame(db, { name: "Busy", createdAt: outside });
    const fixtureId = await insertFixture(db, busy, { kicksOffAt: new Date(NOW.getTime() - 2 * HOUR) });
    await insertResponse(db, fixtureId, await insertPlayer(db), { status: "in", respondedAt: inside });

    const names = (await listGameUsage(db, windowFrom, NOW, 25)).map((r) => r.name);

    expect(names).toEqual(["Busy", "Quiet"]);
    expect(quiet).not.toBe(busy);
  });

  it("returns at most the requested number of games", async () => {
    await insertGame(db);
    await insertGame(db);
    await insertGame(db);

    expect(await listGameUsage(db, windowFrom, NOW, 2)).toHaveLength(2);
  });
});
