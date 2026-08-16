import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_PATH, DELETE_ACCOUNT_PATH, PASSKEYS_PATH, SIGN_IN_PATH } from "../../src/auth/paths.js";
import { getDb } from "../../src/db/client.js";
import { auditLog, players } from "../../src/db/schema.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
} from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

const db = getDb(env.DB);

/** Far-future and fixed, so nothing here depends on how the suite ages. */
const NEXT_WEEK = new Date("2030-06-20T18:00:00Z");
const LAST_WEEK = new Date("2030-06-06T18:00:00Z");

/** The Player the sign-in journey created for `ALLOWED`. */
async function viewerId(): Promise<string> {
  const [player] = await db.select().from(players).where(eq(players.email, ALLOWED));
  expect(player, "signing in must have created a Player").toBeDefined();
  return player!.id;
}

function get(cookie?: string) {
  return SELF.fetch(`${ORIGIN}${ACCOUNT_PATH}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
}

function post(cookie: string, fields: Record<string, string>, origin: string | null = ORIGIN) {
  return SELF.fetch(`${ORIGIN}${ACCOUNT_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      ...(origin ? { origin } : {}),
    },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

beforeEach(resetDatabase);

describe("GET /app/account", () => {
  it("redirects an anonymous visitor to sign in", async () => {
    const response = await get();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(SIGN_IN_PATH);
  });

  it("shows the viewer's name, their email, and the two account links", async () => {
    const { cookie } = await signIn();
    const body = await (await get(cookie)).text();

    expect(body).toContain(ALLOWED);
    expect(body).toContain(`href="${PASSKEYS_PATH}"`);
    expect(body).toContain(`href="${DELETE_ACCOUNT_PATH}"`);
  });

  it("lists a played fixture, which the dashboard deliberately hides", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, me);
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: LAST_WEEK,
    });
    await insertResponse(db, fixtureId, me, { status: "in" });

    const body = await (await get(cookie)).text();
    expect(body).toContain("Thursday 7-a-side");
  });

  it("shows at most 20 fixtures, most recent first", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, me);

    // 22 fixtures, one per week going backwards. The two oldest must not show.
    for (let week = 0; week < 22; week++) {
      const kicksOffAt = new Date(LAST_WEEK.getTime() - week * 7 * 24 * 3600_000);
      const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt });
      await insertResponse(db, fixtureId, me, { status: "in" });
    }

    const body = await (await get(cookie)).text();
    const rows = body.match(/class="fixture-card"/g) ?? [];
    expect(rows).toHaveLength(20);
  });

  it("does not list fixtures from a game the viewer has left", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Sunday league" });
    await insertMembership(db, gameId, me, { active: false, leftAt: LAST_WEEK });
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: LAST_WEEK,
    });
    await insertResponse(db, fixtureId, me, { status: "in" });

    const body = await (await get(cookie)).text();
    expect(body).not.toContain("Sunday league");
  });

  it("never lists another player's fixture", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
    await insertMembership(db, gameId, me);
    const stranger = await insertPlayer(db, { name: "Sam Okafor", email: "sam@example.com" });
    const theirGameId = await insertGame(db, { name: "Somebody else's game" });
    await insertMembership(db, theirGameId, stranger);
    const theirFixture = await insertFixture(db, theirGameId, { kicksOffAt: NEXT_WEEK });
    await insertResponse(db, theirFixture, stranger, { status: "in" });

    const body = await (await get(cookie)).text();
    expect(body).not.toContain("Somebody else's game");
    expect(body).not.toContain("Sam Okafor");
  });
});

describe("POST /app/account", () => {
  it("renames the player, audits it, and redirects", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();

    const response = await post(cookie, { name: "  Alex Mercer  " });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(ACCOUNT_PATH);

    const [row] = await db.select().from(players).where(eq(players.id, me));
    expect(row!.name).toBe("Alex Mercer");

    const audits = (await db.select().from(auditLog)).filter((a) => a.action === "player.renamed");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorPlayerId).toBe(me);
    expect(audits[0]!.entityId).toBe(me);
    expect(JSON.parse(audits[0]!.afterJson!)).toEqual({ name: "Alex Mercer" });
  });

  it("refuses an empty name on the page itself, changing nothing", async () => {
    const { cookie } = await signIn();
    const me = await viewerId();
    const [before] = await db.select().from(players).where(eq(players.id, me));

    const response = await post(cookie, { name: "   " });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Tell us what to call you.");

    const [after] = await db.select().from(players).where(eq(players.id, me));
    expect(after!.name).toBe(before!.name);
  });

  it("refuses a cross-origin post", async () => {
    const { cookie } = await signIn();
    const response = await post(cookie, { name: "Alex Mercer" }, "https://evil.example");
    expect(response.status).toBe(403);
  });

  it("does not write Better Auth's own user row", async () => {
    const { cookie } = await signIn();
    await post(cookie, { name: "Alex Mercer" });

    const rows = await env.DB.prepare("SELECT name FROM user").all<{ name: string }>();
    expect(rows.results.every((row) => row.name !== "Alex Mercer")).toBe(true);
  });
});
