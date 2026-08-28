import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures, games, notificationLog, players } from "../../src/db/schema.js";
import { kickoffIn } from "../support/clock.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
  testDb,
} from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

const ARCHIVED_AT = new Date("2026-08-20T09:00:00Z");

async function post(path: string, cookie: string) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams(),
    redirect: "manual",
  });
}

async function get(path: string, cookie: string) {
  return SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie } });
}

async function ownedGame(overrides: { archivedAt?: Date } = {}) {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const gameId = await insertGame(db, { name: "Thursday 7-a-side", archivedAt: overrides.archivedAt ?? null });
  await insertMembership(db, gameId, viewer!.id, { role: "owner" });
  const memberId = await insertPlayer(db, { name: "Sam Okafor", email: "sam@example.com" });
  await insertMembership(db, gameId, memberId);
  return { cookie, gameId, ownerId: viewer!.id, memberId, db };
}

async function memberOfGame(overrides: { archivedAt?: Date } = {}) {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const gameId = await insertGame(db, { name: "Thursday 7-a-side", archivedAt: overrides.archivedAt ?? null });
  await insertMembership(db, gameId, viewer!.id);
  const ownerId = await insertPlayer(db, { name: "Owner", email: "owner@example.com" });
  await insertMembership(db, gameId, ownerId, { role: "owner" });
  return { cookie, gameId, db };
}

async function settle(db: ReturnType<typeof testDb>, atLeast: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let rows = await db.select().from(notificationLog);
  while (!(rows.length >= atLeast && rows.every((r) => r.status !== "queued")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    rows = await db.select().from(notificationLog);
  }
  return rows;
}

describe("GET /g/:id/archive", () => {
  beforeEach(resetDatabase);

  it("names what will be called off and who will be told", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();
    const open = await insertFixture(db, gameId, { lifecycle: "open", kicksOffAt: kickoffIn(48), inCount: 1 });
    await insertResponse(db, open, memberId, { status: "in" });
    await insertFixture(db, gameId, { lifecycle: "scheduled", kicksOffAt: kickoffIn(24 * 9) });
    await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: kickoffIn(-24 * 5) });

    const response = await get(`/g/${gameId}/archive`, cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Archive Thursday 7-a-side?");
    expect(html).toContain("2 upcoming fixtures will be called off, and 1 player who said they");
    expect(html).toContain(`action="/g/${gameId}/archive"`);
    expect(html).toContain(`href="/g/${gameId}"`);
  });

  it("says so when there is nothing to call off", async () => {
    const { cookie, gameId } = await ownedGame();
    const html = await (await get(`/g/${gameId}/archive`, cookie)).text();
    expect(html).toContain("There are no upcoming fixtures, so nobody needs telling.");
  });

  it("404s for a member, and for an already archived game", async () => {
    const member = await memberOfGame();
    expect((await get(`/g/${member.gameId}/archive`, member.cookie)).status).toBe(404);
    await resetDatabase();
    const archived = await ownedGame({ archivedAt: ARCHIVED_AT });
    expect((await get(`/g/${archived.gameId}/archive`, archived.cookie)).status).toBe(404);
  });
});

describe("POST /g/:id/archive", () => {
  beforeEach(resetDatabase);

  it("archives, cancels the upcoming fixtures, emails whoever was in, and redirects to the game", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();
    const open = await insertFixture(db, gameId, { lifecycle: "open", kicksOffAt: kickoffIn(48), inCount: 1 });
    await insertResponse(db, open, memberId, { status: "in" });
    const scheduled = await insertFixture(db, gameId, { lifecycle: "scheduled", kicksOffAt: kickoffIn(24 * 9) });

    const response = await post(`/g/${gameId}/archive`, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}`);

    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    expect(game!.archivedAt).not.toBeNull();
    const rows = await db.select({ id: fixtures.id, lifecycle: fixtures.lifecycle }).from(fixtures);
    expect(rows.find((r) => r.id === open)!.lifecycle).toBe("cancelled");
    expect(rows.find((r) => r.id === scheduled)!.lifecycle).toBe("cancelled");

    const log = await settle(db, 1);
    const n3 = log.filter((r) => r.notificationType === "n3");
    expect(n3).toHaveLength(1);
    expect(n3[0]!.playerId).toBe(memberId);
  });

  it("404s a member and a second archive alike, and refuses a cross-origin POST", async () => {
    const member = await memberOfGame();
    expect((await post(`/g/${member.gameId}/archive`, member.cookie)).status).toBe(404);
    await resetDatabase();
    const archived = await ownedGame({ archivedAt: ARCHIVED_AT });
    expect((await post(`/g/${archived.gameId}/archive`, archived.cookie)).status).toBe(404);
    const foreign = await SELF.fetch(`${ORIGIN}/g/${archived.gameId}/archive`, {
      method: "POST",
      headers: { origin: "https://evil.example", cookie: archived.cookie },
      redirect: "manual",
    });
    expect(foreign.status).toBe(403);
  });
});

describe("POST /g/:id/unarchive", () => {
  beforeEach(resetDatabase);

  it("reopens the game for its owner and redirects", async () => {
    const { cookie, gameId, db } = await ownedGame({ archivedAt: ARCHIVED_AT });
    const response = await post(`/g/${gameId}/unarchive`, cookie);
    expect(response.status).toBe(303);
    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    expect(game!.archivedAt).toBeNull();
  });

  it("404s a member, and a live game", async () => {
    const member = await memberOfGame({ archivedAt: ARCHIVED_AT });
    expect((await post(`/g/${member.gameId}/unarchive`, member.cookie)).status).toBe(404);
    await resetDatabase();
    const live = await ownedGame();
    expect((await post(`/g/${live.gameId}/unarchive`, live.cookie)).status).toBe(404);
  });
});

describe("an archived game, as seen", () => {
  beforeEach(resetDatabase);

  it("by its owner: a banner with the date, an unarchive form, and no edit link or invite panel", async () => {
    const { cookie, gameId } = await ownedGame({ archivedAt: ARCHIVED_AT });
    const response = await get(`/g/${gameId}`, cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Archived on 20 Aug 2026");
    expect(html).toContain(`action="/g/${gameId}/unarchive"`);
    expect(html).not.toContain("Edit this game");
    expect(html).not.toContain("Invite people");
    expect(html).not.toContain("Message everyone");
    expect(html).toContain("Past fixtures");
  });

  it("by a member: the banner, the history, no mute controls", async () => {
    const { cookie, gameId } = await memberOfGame({ archivedAt: ARCHIVED_AT });
    const html = await (await get(`/g/${gameId}`, cookie)).text();
    expect(html).toContain("This game was archived on 20 Aug 2026");
    expect(html).not.toContain("unarchive");
    expect(html).not.toContain("auto-decline");
  });

  it("has no edit page", async () => {
    const { cookie, gameId } = await ownedGame({ archivedAt: ARCHIVED_AT });
    expect((await get(`/g/${gameId}/edit`, cookie)).status).toBe(404);
  });

  it("offers the archive link from the edit page while live", async () => {
    const { cookie, gameId } = await ownedGame();
    const html = await (await get(`/g/${gameId}/edit`, cookie)).text();
    expect(html).toContain(`href="/g/${gameId}/archive"`);
    expect(html).toContain("Archive this game");
  });

  it("has a dead invite link", async () => {
    const { gameId, db } = await ownedGame({ archivedAt: ARCHIVED_AT });
    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    const response = await SELF.fetch(`${ORIGIN}/j/${game!.inviteToken}`);
    expect(response.status).toBe(404);
  });

  it("is folded under the live games on the dashboard", async () => {
    const { cookie, gameId, db } = await ownedGame({ archivedAt: ARCHIVED_AT });
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    const liveId = await insertGame(db, { name: "Sunday league" });
    await insertMembership(db, liveId, viewer!.id, { role: "owner" });

    const html = await (await get("/app", cookie)).text();
    expect(html).toContain("<h2>Your squads</h2>");
    expect(html).toContain("Archived game (1)");
    expect(html.indexOf("Sunday league")).toBeLessThan(html.indexOf("Thursday 7-a-side"));
    expect(html).toContain(`href="/g/${gameId}"`);
  });

  it("still lists on the dashboard when it is the only game", async () => {
    const { cookie } = await ownedGame({ archivedAt: ARCHIVED_AT });
    const html = await (await get("/app", cookie)).text();
    expect(html).not.toContain("<h2>Your squads</h2>");
    expect(html).toContain("Archived game (1)");
    expect(html).toContain("Thursday 7-a-side");
  });
});
