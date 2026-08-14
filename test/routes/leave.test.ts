import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, memberships } from "../../src/db/schema.js";
import { leaveTokenExpiry, signLeaveToken, signResponseToken } from "../../src/domain/token.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase } from "../support/factories.js";
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
