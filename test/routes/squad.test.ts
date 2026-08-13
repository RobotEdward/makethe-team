import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
// `notificationLog` is imported for exactly one purpose below: draining the
// N-7 `waitUntil` before a test ends. This suite asserts nothing about its
// rows — that behaviour belongs to `test/notify/send-removed.test.ts` — but a
// row landing *after* the next test's `resetDatabase()` breaks that reset's
// `DELETE FROM players` on the table's foreign key, exactly the race
// `test/routes/join.test.ts` documents on `waitForNotificationRows`.
import { auditLog, memberships, notificationLog, players, responses } from "../../src/db/schema.js";
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

/**
 * Drains the N-7 `waitUntil` so it cannot land after the next test's
 * `resetDatabase()`. Never asserted on — see the import comment above.
 */
async function settleNotifications(atLeast: number, timeoutMs = 3000) {
  const db = testDb();
  const deadline = Date.now() + timeoutMs;
  const settled = (rows: Array<{ status: string }>) =>
    rows.length >= atLeast && rows.every((row) => row.status !== "queued");

  let rows = await db.select().from(notificationLog);
  while (!settled(rows) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    rows = await db.select().from(notificationLog);
  }
}

async function post(path: string, cookie: string, fields: Record<string, string> = {}) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

/** A game owned by the signed-in player, plus one ordinary member. */
async function ownedGame() {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
  await insertMembership(db, gameId, viewer!.id, { role: "owner" });
  const memberId = await insertPlayer(db, { name: "Sam Okafor", email: "sam@example.com" });
  await insertMembership(db, gameId, memberId);
  return { cookie, gameId, ownerId: viewer!.id, memberId, db };
}

describe("GET /g/:id/squad/:playerId/remove", () => {
  beforeEach(resetDatabase);

  it("shows the confirmation with the member's commitments", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open", inCount: 1 });
    await insertResponse(db, fixtureId, memberId, { status: "in" });

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}/remove`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Sam Okafor");
    expect(html).toContain("1 upcoming fixture");
  });

  it("404s for a game the viewer does not own", async () => {
    const { cookie } = await signIn();
    const db = testDb();
    const gameId = await insertGame(db);
    const memberId = await insertPlayer(db);
    await insertMembership(db, gameId, memberId);

    // 404, not 403: a 403 confirms the game exists (TR-18).
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}/remove`, { headers: { cookie } });
    expect(response.status).toBe(404);
  });

  it("404s for a player who is in another game's squad", async () => {
    const { cookie, gameId } = await ownedGame();
    const db = testDb();
    const stranger = await insertPlayer(db);
    await insertMembership(db, await insertGame(db), stranger);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${stranger}/remove`, { headers: { cookie } });
    expect(response.status).toBe(404);
  });

  it("redirects an anonymous visitor to sign in", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${crypto.randomUUID()}/remove`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in");
  });
});

describe("POST /g/:id/squad/:playerId/remove", () => {
  beforeEach(resetDatabase);

  it("removes the member, frees their place and redirects", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open", inCount: 1 });
    await insertResponse(db, fixtureId, memberId, { status: "in" });

    const response = await post(`/g/${gameId}/squad/${memberId}/remove`, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}`);

    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, memberId));
    expect(membership!.active).toBe(false);
    const [row] = await db.select().from(responses).where(eq(responses.playerId, memberId));
    expect(row!.status).toBe("withdrawn");
    await settleNotifications(1);
  });

  it("redirects a self-removing owner to the dashboard, not to a page they can no longer see", async () => {
    const { cookie, gameId, ownerId, db } = await ownedGame();
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });

    const response = await post(`/g/${gameId}/squad/${ownerId}/remove`, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/app");
    await settleNotifications(1);
  });

  it("refuses to remove the last organiser, with the reason on the page", async () => {
    const { cookie, gameId, ownerId, db } = await ownedGame();

    const response = await post(`/g/${gameId}/squad/${ownerId}/remove`, cookie);
    expect(response.status).toBe(422);
    expect((await response.text()).toLowerCase()).toContain("at least one organiser");
    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, ownerId));
    expect(membership!.active).toBe(true);
  });

  it("rejects a cross-site post", async () => {
    const { cookie, gameId, memberId } = await ownedGame();
    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/squad/${memberId}/remove`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie },
      body: new URLSearchParams(),
      redirect: "manual",
    });
    expect(response.status).toBe(403);
  });

  it("404s for a member of another game", async () => {
    const { cookie, gameId } = await ownedGame();
    const db = testDb();
    const stranger = await insertPlayer(db);
    await insertMembership(db, await insertGame(db), stranger);

    expect((await post(`/g/${gameId}/squad/${stranger}/remove`, cookie)).status).toBe(404);
  });
});

describe("POST /g/:id/squad/:playerId/role", () => {
  beforeEach(resetDatabase);

  it("promotes a player to organiser", async () => {
    const { cookie, gameId, memberId, db } = await ownedGame();

    const response = await post(`/g/${gameId}/squad/${memberId}/role`, cookie, { role: "owner" });
    expect(response.status).toBe(303);
    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, memberId));
    expect(membership!.role).toBe("owner");
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.role_changed"));
    expect(audit).toBeDefined();
  });

  it("refuses to demote the last organiser", async () => {
    const { cookie, gameId, ownerId, db } = await ownedGame();

    const response = await post(`/g/${gameId}/squad/${ownerId}/role`, cookie, { role: "player" });
    expect(response.status).toBe(422);
    const [membership] = await db.select().from(memberships).where(eq(memberships.playerId, ownerId));
    expect(membership!.role).toBe("owner");
  });

  it("400s on a role it did not offer", async () => {
    const { cookie, gameId, memberId } = await ownedGame();
    expect((await post(`/g/${gameId}/squad/${memberId}/role`, cookie, { role: "admin" })).status).toBe(400);
  });
});
