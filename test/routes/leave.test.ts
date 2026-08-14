import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, memberships, notificationLog, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { leaveTokenExpiry, signLeaveToken, signResponseToken } from "../../src/domain/token.js";
import { insertFixture, insertGame, insertMembership, insertPlayer, resetDatabase } from "../support/factories.js";
import { ALLOWED, signIn } from "../support/sign-in.js";
import { NOW } from "../support/clock.js";

const db = getDb(env.DB);
const SECRET = env.RESPONSE_TOKEN_SECRET;

interface SeedOptions {
  role?: "player" | "owner";
  /** Owners besides the seeded player, when `role` is `"owner"`. */
  otherOwners?: number;
  alreadyLeft?: boolean;
}

interface SeedResult {
  token: string;
  /** A response token for the same player — the wrong kind, presented here. */
  responseToken: string;
  gameId: string;
  playerId: string;
  gameName: string;
}

/** Seed a game, a player, and a leave token scoped to both. */
async function seedLeavable(options: SeedOptions = {}): Promise<SeedResult> {
  const gameName = "Thursday 7-a-side";
  const gameId = await insertGame(db, { name: gameName });

  const playerId = await insertPlayer(db, { name: "Edward Cooper" });
  await insertMembership(db, gameId, playerId, {
    role: options.role ?? "player",
    active: !options.alreadyLeft,
    leftAt: options.alreadyLeft ? NOW : null,
  });

  for (let i = 0; i < (options.otherOwners ?? 0); i++) {
    const ownerId = await insertPlayer(db, { name: `Other Owner ${i}` });
    await insertMembership(db, gameId, ownerId, { role: "owner", active: true });
  }

  const token = await signLeaveToken({ gameId, playerId, expiresAt: leaveTokenExpiry(NOW).getTime() }, SECRET);
  const responseToken = await signResponseToken(
    { playerId, fixtureId: crypto.randomUUID(), expiresAt: NOW.getTime() + 86_400_000 },
    SECRET,
  );

  return { token, responseToken, gameId, playerId, gameName };
}

interface SeedFullFixtureResult {
  token: string;
  waitlistedId: string;
  fixtureId: string;
}

/**
 * A game whose sole open fixture has room for exactly one player — the
 * leaver — with a second member landed on the waitlist behind them, both
 * through the real capacity path (`FIXTURE_CAPACITY.setResponse`) rather than
 * a hand-written `responses` row, so the leaver's withdrawal has a genuine
 * promotion to make.
 */
async function seedLeavableOnFullFixture(): Promise<SeedFullFixtureResult> {
  const gameId = await insertGame(db, { maxPlayers: 1 });

  const leaverId = await insertPlayer(db, { name: "Edward Cooper" });
  await insertMembership(db, gameId, leaverId, { role: "player", active: true });

  const waitlistedId = await insertPlayer(db, { name: "Waitlisted Player" });
  await insertMembership(db, gameId, waitlistedId, { role: "player", active: true });

  const fixtureId = await insertFixture(db, gameId, { maxPlayers: 1, minPlayers: 1 });
  await openFixture(db, fixtureId, NOW);

  await env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
    playerId: leaverId,
    intent: "in",
    actorPlayerId: null,
    source: "system",
    whenFull: "waitlist",
    now: NOW.getTime(),
  });
  await env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
    playerId: waitlistedId,
    intent: "in",
    actorPlayerId: null,
    source: "system",
    whenFull: "waitlist",
    now: NOW.getTime(),
  });

  const token = await signLeaveToken(
    { gameId, playerId: leaverId, expiresAt: leaveTokenExpiry(NOW).getTime() },
    SECRET,
  );

  return { token, waitlistedId, fixtureId };
}

interface SeedWithOtherGameOptions {
  /**
   * `"self"` signs in as the harness's one real identity and mints the token
   * for *that same* player. `"someone-else"` signs in the same way but mints
   * the token for a freshly created, different player — the case that pins
   * BR-25's identity match: a forwarded link opened by a different signed-in
   * person must not show either party's squads. Omitted entirely mints the
   * token for an unrelated player and signs nobody in.
   */
  signedIn?: "self" | "someone-else";
}

interface SeedWithOtherGameResult {
  token: string;
  otherGameName: string;
  cookie: string;
}

/**
 * A leavable game plus a *second* active game the token's player also
 * belongs to — the "your other squads" list's raw material. Follows
 * `test/routes/owner-fixture.test.ts`'s pattern for this harness's one real
 * signed-in identity: rather than trying to sign in as two different people,
 * only *which player the token names* varies.
 */
async function seedLeavableWithAnotherGame(
  options: SeedWithOtherGameOptions = {},
): Promise<SeedWithOtherGameResult> {
  const gameId = await insertGame(db, { name: "Thursday 7-a-side" });
  const otherGameName = "Sunday Kickabout";
  const otherGameId = await insertGame(db, { name: otherGameName });

  let cookie = "";
  let tokenPlayerId: string;

  if (options.signedIn === "self") {
    const signedIn = await signIn();
    cookie = signedIn.cookie;
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    tokenPlayerId = viewer!.id;
  } else if (options.signedIn === "someone-else") {
    const signedIn = await signIn();
    cookie = signedIn.cookie;
    // Deliberately a different player from the one just signed in — the
    // token must name somebody the session is *not*.
    tokenPlayerId = await insertPlayer(db, { name: "A Different Player" });
  } else {
    tokenPlayerId = await insertPlayer(db, { name: "Edward Cooper" });
  }

  await insertMembership(db, gameId, tokenPlayerId, { role: "player", active: true });
  await insertMembership(db, otherGameId, tokenPlayerId, { role: "player", active: true });

  const token = await signLeaveToken(
    { gameId, playerId: tokenPlayerId, expiresAt: leaveTokenExpiry(NOW).getTime() },
    SECRET,
  );

  return { token, otherGameName, cookie };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("GET /leave/:token", () => {
  it("offers to leave, naming the game", async () => {
    const { token, gameName } = await seedLeavable();

    const response = await SELF.fetch(`https://makethe.team/leave/${token}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(gameName);
    expect(body).toContain("Leave this game");
  });

  it("changes nothing at all", async () => {
    // The prefetcher guarantee. Mail scanners GET every URL in a message; if
    // this route wrote, they would unsubscribe people who never clicked.
    const { token, gameId, playerId } = await seedLeavable();

    await SELF.fetch(`https://makethe.team/leave/${token}`);

    const [membership] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, playerId)));
    expect(membership?.active).toBe(true);
    expect(membership?.leftAt).toBeNull();
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("tells a sole organiser why they cannot leave, and offers no button", async () => {
    const { token } = await seedLeavable({ role: "owner", otherOwners: 0 });

    const body = await (await SELF.fetch(`https://makethe.team/leave/${token}`)).text();

    expect(body).toContain("needs an organiser");
    expect(body).not.toContain("Leave this game");
  });

  it("offers the button to an organiser who is not the only one", async () => {
    const { token } = await seedLeavable({ role: "owner", otherOwners: 1 });

    const body = await (await SELF.fetch(`https://makethe.team/leave/${token}`)).text();

    expect(body).toContain("Leave this game");
  });

  it("says so when the player already left", async () => {
    const { token } = await seedLeavable({ alreadyLeft: true });

    const body = await (await SELF.fetch(`https://makethe.team/leave/${token}`)).text();

    expect(body).toContain("already out");
    expect(body).not.toContain("Leave this game");
  });

  it("shows the same link-problem page for a bad token as /r/ does", async () => {
    const body = await (await SELF.fetch("https://makethe.team/leave/not-a-real-token")).text();

    expect(body).toContain("link isn't working");
  });

  it("shows the link-problem page for a response token presented here", async () => {
    // Same secret, different kind. An attacker swapping paths learns nothing.
    const { responseToken } = await seedLeavable();

    const body = await (await SELF.fetch(`https://makethe.team/leave/${responseToken}`)).text();

    expect(body).toContain("link isn't working");
  });
});

describe("POST /leave/:token", () => {
  it("takes the player out of the squad", async () => {
    const { token, gameId, playerId } = await seedLeavable();

    const response = await SELF.fetch(new Request(`https://makethe.team/leave/${token}`, { method: "POST" }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("out of");
    const [membership] = await db.select().from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, playerId)));
    expect(membership?.active).toBe(false);
    expect(membership?.leftAt).not.toBeNull();
  });

  it("records the leaver as their own actor, so the trail reads as leaving", async () => {
    const { token, playerId } = await seedLeavable();

    await SELF.fetch(new Request(`https://makethe.team/leave/${token}`, { method: "POST" }));

    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.removed"));
    expect(row?.actorPlayerId).toBe(playerId);
  });

  it("frees their place and promotes the longest-waiting player", async () => {
    const { token, waitlistedId, fixtureId } = await seedLeavableOnFullFixture();

    await SELF.fetch(new Request(`https://makethe.team/leave/${token}`, { method: "POST" }));

    const [promoted] = await db.select().from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, waitlistedId)));
    expect(promoted?.status).toBe("in");
  });

  it("sends the leaver no email", async () => {
    // §1.11's catalogue is closed and N-7 tells someone something happened
    // *to* them. A self-leaver did it and is reading the confirmation.
    const { token, playerId } = await seedLeavable();

    await SELF.fetch(new Request(`https://makethe.team/leave/${token}`, { method: "POST" }));

    const rows = await db.select().from(notificationLog).where(eq(notificationLog.playerId, playerId));
    expect(rows).toEqual([]);
  });

  it("refuses a sole organiser and explains, without leaving them out", async () => {
    const { token, gameId, playerId } = await seedLeavable({ role: "owner", otherOwners: 0 });

    const response = await SELF.fetch(new Request(`https://makethe.team/leave/${token}`, { method: "POST" }));

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("needs an organiser");
    const [membership] = await db.select().from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, playerId)));
    expect(membership?.active).toBe(true);
  });

  it("is safe to submit twice", async () => {
    const { token } = await seedLeavable();
    const url = `https://makethe.team/leave/${token}`;

    await SELF.fetch(new Request(url, { method: "POST" }));
    const second = await SELF.fetch(new Request(url, { method: "POST" }));

    expect(second.status).toBe(200);
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "membership.removed"));
    expect(rows.length).toBe(1);
  });

  it("shows the link-problem page for a bad token and writes nothing", async () => {
    const response = await SELF.fetch(
      new Request("https://makethe.team/leave/not-a-real-token", { method: "POST" }),
    );

    expect(await response.text()).toContain("link isn't working");
    expect(await db.select().from(auditLog)).toEqual([]);
  });
});

describe("the other-squads list", () => {
  it("is absent for a visitor with no session", async () => {
    const { token, otherGameName } = await seedLeavableWithAnotherGame();

    const body = await (await SELF.fetch(`https://makethe.team/leave/${token}`)).text();

    expect(body).not.toContain(otherGameName);
    expect(body).toContain("Sign in");
  });

  it("lists the player's other squads when they are signed in as themselves", async () => {
    const { token, otherGameName, cookie } = await seedLeavableWithAnotherGame({ signedIn: "self" });

    const body = await (await SELF.fetch(
      new Request(`https://makethe.team/leave/${token}`, { headers: { cookie } }),
    )).text();

    expect(body).toContain(otherGameName);
  });

  it("is absent when the session belongs to somebody else", async () => {
    // A forwarded link opened by a different signed-in person must not show
    // either party's squads.
    const { token, otherGameName, cookie } = await seedLeavableWithAnotherGame({ signedIn: "someone-else" });

    const body = await (await SELF.fetch(
      new Request(`https://makethe.team/leave/${token}`, { headers: { cookie } }),
    )).text();

    expect(body).not.toContain(otherGameName);
  });
});
