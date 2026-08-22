import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { signResponseToken } from "../../src/domain/token.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";
import { kickoffIn, NOW } from "../support/clock.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

const db = getDb(env.DB);
const SECRET = env.RESPONSE_TOKEN_SECRET;
const KICKOFF = kickoffIn(9);

beforeEach(resetDatabase);

async function signedInPlayer(): Promise<{ cookie: string; viewerId: string }> {
  const { cookie } = await signIn();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  return { cookie, viewerId: viewer!.id };
}

/** A game the signed-in identity is an ordinary member of, with one open fixture. */
async function seedMemberGame(): Promise<{ gameId: string; fixtureId: string; cookie: string; viewerId: string }> {
  const { cookie, viewerId } = await signedInPlayer();
  const gameId = await insertGame(db, { maxPlayers: 14 });
  const ownerId = await insertPlayer(db, { name: "Owner" });
  await insertMembership(db, gameId, ownerId, { role: "owner" });
  await insertMembership(db, gameId, viewerId);

  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId, gameId, kicksOffAt: KICKOFF, minPlayers: 1, maxPlayers: 14,
    prefersEvenNumbers: true, shortWarningOffsetHours: 12, durationMinutes: 60,
  });
  await openFixture(db, fixtureId, NOW);

  return { gameId, fixtureId, cookie, viewerId };
}

function post(path: string, cookie: string, fields: Record<string, string>) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

describe("the auto-decline panel on the pages that carry it", () => {
  it("appears on the player's game page", async () => {
    const { gameId, cookie } = await seedMemberGame();

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Can't play for a while?");
    expect(html).toContain(`action="/g/${gameId}/mute"`);
  });

  it("appears on the player's fixture page", async () => {
    const { gameId, fixtureId, cookie } = await seedMemberGame();

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    expect(html).toContain("Can't play for a while?");
    expect(html).toContain(`action="/g/${gameId}/mute"`);
  });

  it("appears on the emailed fixture link", async () => {
    const { fixtureId, viewerId } = await seedMemberGame();
    const token = await signResponseToken(
      { playerId: viewerId, fixtureId, expiresAt: KICKOFF.getTime() + 86_400_000 },
      SECRET,
    );

    const html = await (await SELF.fetch(`${ORIGIN}/r/${token}`)).text();

    expect(html).toContain("Can't play for a while?");
    expect(html).toContain(`action="/r/${token}/mute"`);
  });

  it("shows the on-state, with the date, once it is switched on", async () => {
    const { gameId, cookie, viewerId } = await seedMemberGame();
    await db
      .update(memberships)
      .set({ mutedAt: NOW, mutedUntil: null })
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, viewerId)));

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } })).text();

    expect(html).toContain("until you turn it back on");
    expect(html).toContain(`action="/g/${gameId}/unmute"`);
    expect(html).not.toContain("Can't play for a while?");
  });
});

describe("POST /g/:id/mute", () => {
  it("mutes the membership and declines the open fixture", async () => {
    const { gameId, fixtureId, cookie, viewerId } = await seedMemberGame();

    const response = await post(`/g/${gameId}/mute`, cookie, { duration: "4w" });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}`);
    const [row] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, viewerId)));
    expect(row?.mutedAt).not.toBe(null);
    expect(row?.mutedUntil).not.toBe(null);
    const [answer] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, viewerId)));
    expect(answer?.status).toBe("out");
  });

  it("refuses a duration it does not recognise rather than picking one", async () => {
    const { gameId, cookie, viewerId } = await seedMemberGame();

    const response = await post(`/g/${gameId}/mute`, cookie, { duration: "99w" });

    expect(response.status).toBe(400);
    const [row] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, viewerId)));
    expect(row?.mutedAt).toBe(null);
  });

  it("answers 404 for a game the player is not in, the same as every other entitlement failure", async () => {
    const { cookie } = await signedInPlayer();
    const strangersGame = await insertGame(db);

    expect((await post(`/g/${strangersGame}/mute`, cookie, { duration: "4w" })).status).toBe(404);
  });

  it("refuses a cross-origin submission", async () => {
    const { gameId, cookie } = await seedMemberGame();

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/mute`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie },
      body: new URLSearchParams({ duration: "4w" }),
      redirect: "manual",
    });

    expect(response.status).toBe(403);
  });

  it("applies to every squad when the checkbox is ticked", async () => {
    const { gameId, cookie, viewerId } = await seedMemberGame();
    const otherGameId = await insertGame(db);
    await insertMembership(db, otherGameId, viewerId);

    await post(`/g/${gameId}/mute`, cookie, { duration: "2w", "all-games": "on" });

    const rows = await db.select().from(memberships).where(eq(memberships.playerId, viewerId));
    expect(rows.filter((r) => r.mutedAt !== null)).toHaveLength(2);
  });

  it("leaves the other squads alone when it is not", async () => {
    const { gameId, cookie, viewerId } = await seedMemberGame();
    const otherGameId = await insertGame(db);
    await insertMembership(db, otherGameId, viewerId);

    await post(`/g/${gameId}/mute`, cookie, { duration: "2w" });

    const rows = await db.select().from(memberships).where(eq(memberships.playerId, viewerId));
    expect(rows.filter((r) => r.mutedAt !== null)).toHaveLength(1);
  });
});

describe("POST /g/:id/unmute", () => {
  it("clears the switch", async () => {
    const { gameId, cookie, viewerId } = await seedMemberGame();
    await post(`/g/${gameId}/mute`, cookie, { duration: "4w" });

    const response = await post(`/g/${gameId}/unmute`, cookie, {});

    expect(response.status).toBe(303);
    const [row] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, viewerId)));
    expect(row?.mutedAt).toBe(null);
    expect(row?.mutedUntil).toBe(null);
  });

  it("does not put the player back into the fixtures it declined", async () => {
    const { gameId, fixtureId, cookie, viewerId } = await seedMemberGame();
    await post(`/g/${gameId}/mute`, cookie, { duration: "4w" });

    await post(`/g/${gameId}/unmute`, cookie, {});

    const [answer] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, viewerId)));
    expect(answer?.status).toBe("out");
  });

  it("answers 404 for a game the player is not in", async () => {
    const { cookie } = await signedInPlayer();
    const strangersGame = await insertGame(db);

    expect((await post(`/g/${strangersGame}/unmute`, cookie, {})).status).toBe(404);
  });
});

describe("POST /r/:token/mute", () => {
  it("mutes from the emailed link, with no session at all", async () => {
    const { gameId, fixtureId, viewerId } = await seedMemberGame();
    const token = await signResponseToken(
      { playerId: viewerId, fixtureId, expiresAt: KICKOFF.getTime() + 86_400_000 },
      SECRET,
    );

    const response = await SELF.fetch(`${ORIGIN}/r/${token}/mute`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ duration: "8w" }),
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/r/${token}`);
    const [row] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, viewerId)));
    expect(row?.mutedAt).not.toBe(null);
  });

  it("shows the link-problem page for a token that does not verify, and writes nothing", async () => {
    const { gameId, viewerId } = await seedMemberGame();

    const response = await SELF.fetch(`${ORIGIN}/r/not-a-real-token/mute`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ duration: "8w" }),
      redirect: "manual",
    });

    expect(response.status).toBe(200);
    const [row] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, viewerId)));
    expect(row?.mutedAt).toBe(null);
  });

  it("turns it back off from the emailed link too", async () => {
    const { gameId, fixtureId, viewerId } = await seedMemberGame();
    const token = await signResponseToken(
      { playerId: viewerId, fixtureId, expiresAt: KICKOFF.getTime() + 86_400_000 },
      SECRET,
    );
    await SELF.fetch(`${ORIGIN}/r/${token}/mute`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ duration: "8w" }),
      redirect: "manual",
    });

    const response = await SELF.fetch(`${ORIGIN}/r/${token}/unmute`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({}),
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    const [row] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, viewerId)));
    expect(row?.mutedAt).toBe(null);
  });
});

describe("accepting while muted", () => {
  it("puts the player in for that fixture and leaves the mute running", async () => {
    const { gameId, fixtureId, cookie, viewerId } = await seedMemberGame();
    await post(`/g/${gameId}/mute`, cookie, { duration: "4w" });
    const token = await signResponseToken(
      { playerId: viewerId, fixtureId, expiresAt: KICKOFF.getTime() + 86_400_000 },
      SECRET,
    );

    await SELF.fetch(`${ORIGIN}/r/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "in" }),
      redirect: "manual",
    });

    const [answer] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, viewerId)));
    expect(answer?.status).toBe("in");
    const [row] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, viewerId)));
    expect(row?.mutedAt).not.toBe(null);
  });

  it("says so on the page, so the player is not surprised next week", async () => {
    const { gameId, fixtureId, cookie, viewerId } = await seedMemberGame();
    await post(`/g/${gameId}/mute`, cookie, { duration: "4w" });
    const token = await signResponseToken(
      { playerId: viewerId, fixtureId, expiresAt: KICKOFF.getTime() + 86_400_000 },
      SECRET,
    );

    const response = await SELF.fetch(`${ORIGIN}/r/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "in" }),
      redirect: "manual",
    });
    const html = await response.text();

    expect(html).toContain("You're auto-declining this squad until");
  });
});

describe("the muted marker the organiser sees", () => {
  it("marks a muted member on the organiser's squad list, so a permanent out is accounted for", async () => {
    const { cookie } = await signedInPlayer();
    const db2 = testDb();
    const [viewer] = await db2.select().from(players).where(eq(players.email, ALLOWED));
    const gameId = await insertGame(db2);
    await insertMembership(db2, gameId, viewer!.id, { role: "owner" });
    const mutedId = await insertPlayer(db2, { name: "Quiet Sam" });
    await insertMembership(db2, gameId, mutedId, { mutedAt: NOW, mutedUntil: null });

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } })).text();

    expect(html).toContain("Quiet Sam");
    expect(html).toContain("Auto-declining");
  });

  it("does not mark a member whose mute has run out", async () => {
    const { cookie } = await signedInPlayer();
    const db2 = testDb();
    const [viewer] = await db2.select().from(players).where(eq(players.email, ALLOWED));
    const gameId = await insertGame(db2);
    await insertMembership(db2, gameId, viewer!.id, { role: "owner" });
    const pastId = await insertPlayer(db2, { name: "Back Again" });
    await insertMembership(db2, gameId, pastId, {
      mutedAt: new Date(NOW.getTime() - 60 * 86_400_000),
      mutedUntil: new Date(NOW.getTime() - 86_400_000),
    });

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}`, { headers: { cookie } })).text();

    expect(html).toContain("Back Again");
    expect(html).not.toContain("Auto-declining");
  });
});
