import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, games, memberships, notificationLog, players } from "../../src/db/schema.js";
import { joinTokenExpiry, signJoinToken, signLeaveToken, leaveTokenExpiry } from "../../src/domain/token.js";
import { insertGame, insertPlayer, resetDatabase, testDb } from "../support/factories.js";
import { ORIGIN } from "../support/sign-in.js";

const SECRET = env.RESPONSE_TOKEN_SECRET;
const NOW = new Date(Date.now());

async function seed() {
  const db = testDb();
  const gameId = await insertGame(db, { inviteToken: "inv-1" });
  const jtoken = await signJoinToken(
    { gameId, inviteToken: "inv-1", email: "jack@example.com", name: "Jack Hart", expiresAt: joinTokenExpiry(NOW).getTime() },
    SECRET,
  );
  return { db, gameId, jtoken };
}
const get = (t: string) => SELF.fetch(`${ORIGIN}/join/${t}`);
const post = (t: string, origin: string | null = ORIGIN) =>
  SELF.fetch(`${ORIGIN}/join/${t}`, { method: "POST", headers: origin ? { origin } : {}, redirect: "manual" });

/**
 * The N-6 welcome is handed to `ctx.waitUntil`, so it is still in flight when
 * the response arrives. Copied from `test/routes/join.test.ts` rather than
 * shared, per the task brief — waits for the row to reach a terminal status
 * so it cannot land after the next test's `resetDatabase` and break that
 * reset's `DELETE FROM players` on `notification_log`'s foreign key.
 */
async function waitForNotificationRows(atLeast: number, timeoutMs = 3000) {
  const db = testDb();
  const deadline = Date.now() + timeoutMs;
  const settled = (rows: Array<{ status: string }>) =>
    rows.length >= atLeast && rows.every((row) => row.status !== "queued");

  let rows = await db.select().from(notificationLog);
  while (!settled(rows) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    rows = await db.select().from(notificationLog);
  }
  return rows;
}

describe("GET /join/:jtoken", () => {
  beforeEach(resetDatabase);

  it("asks 'Join X as Name?' and writes nothing (BR-50)", async () => {
    const { db, jtoken } = await seed();
    const response = await get(jtoken);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Jack Hart");
    expect(html).toContain("Thursday 7-a-side");
    expect(html).toContain(`action="/join/${jtoken}"`);
    expect(await db.select().from(players)).toHaveLength(0);
    expect(await db.select().from(memberships)).toHaveLength(0);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("escapes the typed name", async () => {
    const { gameId } = await seed();
    const jtoken = await signJoinToken({ gameId, inviteToken: "inv-1", email: "x@example.com", name: "<img src=x>", expiresAt: joinTokenExpiry(NOW).getTime() }, SECRET);
    const html = await (await get(jtoken)).text();
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img src=x&gt;");
  });

  it("404s a rotated invite link without explaining (BR-49)", async () => {
    const { db, gameId, jtoken } = await seed();
    await db.update(games).set({ inviteToken: "inv-2" }).where(eq(games.id, gameId));
    expect((await get(jtoken)).status).toBe(404);
    expect((await post(jtoken)).status).toBe(404);
  });

  it("404s garbage, an expired token and a leave token", async () => {
    const { gameId } = await seed();
    expect((await get("not-a-token")).status).toBe(404);
    const expired = await signJoinToken({ gameId, inviteToken: "inv-1", email: "a@b.co", name: "A", expiresAt: NOW.getTime() - 1 }, SECRET);
    expect((await get(expired)).status).toBe(404);
    const leave = await signLeaveToken({ gameId, playerId: "p", expiresAt: leaveTokenExpiry(NOW).getTime() }, SECRET);
    expect((await get(leave)).status).toBe(404);
  });
});

describe("POST /join/:jtoken", () => {
  beforeEach(resetDatabase);

  it("creates the player verified, seats them, and welcomes them (BR-48)", async () => {
    const { db, gameId, jtoken } = await seed();
    const response = await post(jtoken);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("You're in");
    const [player] = await db.select().from(players).where(eq(players.email, "jack@example.com"));
    expect(player?.name).toBe("Jack Hart");
    expect(player?.emailVerifiedAt).not.toBeNull();
    expect(await db.select().from(memberships).where(eq(memberships.gameId, gameId))).toHaveLength(1);
    await waitForNotificationRows(1);
  });

  it("verifies a legacy unverified row instead of creating a second person", async () => {
    const { db, jtoken } = await seed();
    const legacyId = await insertPlayer(db, { email: "jack@example.com", emailVerifiedAt: null, name: "Jack H" });
    await post(jtoken);
    const rows = await db.select().from(players).where(eq(players.email, "jack@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(legacyId);
    expect(rows[0]!.emailVerifiedAt).not.toBeNull();
    await waitForNotificationRows(1);
  });

  it("never moves an earlier verification forward", async () => {
    const { db, jtoken } = await seed();
    const earlier = new Date("2026-01-01T00:00:00Z");
    await insertPlayer(db, { email: "jack@example.com", emailVerifiedAt: earlier });
    await post(jtoken);
    const [row] = await db.select().from(players).where(eq(players.email, "jack@example.com"));
    expect(row!.emailVerifiedAt).toEqual(earlier);
    await waitForNotificationRows(1);
  });

  it("is idempotent: a second click says already in", async () => {
    const { jtoken } = await seed();
    await post(jtoken);
    await waitForNotificationRows(1);
    expect(await (await post(jtoken)).text()).toContain("already in this squad");
  });

  it("refuses a cross-site post", async () => {
    const { jtoken } = await seed();
    expect((await post(jtoken, "https://evil.example")).status).toBe(403);
  });

  it("records the join as arriving by invite link, actor null", async () => {
    const { db, jtoken } = await seed();
    await post(jtoken);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.joined"));
    expect(row!.actorPlayerId).toBeNull();
    expect(JSON.parse(row!.afterJson!)).toMatchObject({ via: "invite_link" });
    await waitForNotificationRows(1);
  });
});
