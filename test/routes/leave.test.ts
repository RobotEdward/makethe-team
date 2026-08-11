import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, players } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { signResponseToken } from "../../src/domain/token.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const SECRET = env.RESPONSE_TOKEN_SECRET;
const NOW = new Date("2026-08-13T09:00:00Z");
const KICKOFF = new Date("2026-08-13T18:00:00Z");

interface SeedResult {
  fixtureId: string;
  playerId: string;
}

async function seed(): Promise<SeedResult> {
  const gameId = await insertGame(db, { name: "Thursday 7-a-side", maxPlayers: 14 });
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: KICKOFF,
    minPlayers: 10,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });

  const playerId = crypto.randomUUID();
  await db.insert(players).values({ id: playerId, name: "Edward Cooper", email: "edward@example.com" });
  await db.insert(memberships).values({ id: crypto.randomUUID(), gameId, playerId, active: true });

  await openFixture(db, fixtureId, NOW);

  return { fixtureId, playerId };
}

async function tokenFor(fixtureId: string, playerId: string, expiresAt = KICKOFF.getTime() + 86_400_000) {
  return signResponseToken({ playerId, fixtureId, expiresAt }, SECRET);
}

beforeEach(async () => {
  await resetDatabase();
});

describe("GET /leave/:token", () => {
  it("renders a page naming the Game and saying leaving is not yet self-service", async () => {
    const { fixtureId, playerId } = await seed();
    const token = await tokenFor(fixtureId, playerId);

    const response = await SELF.fetch(`https://makethe.team/leave/${token}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Thursday 7-a-side");
    expect(body.toLowerCase()).toContain("self-service");
    expect(body.toLowerCase()).toContain("organis");
  });

  it("is a plain GET that never mutates: no response is recorded", async () => {
    const { fixtureId, playerId } = await seed();
    const token = await tokenFor(fixtureId, playerId);

    await SELF.fetch(`https://makethe.team/leave/${token}`);

    const [membership] = await db.select().from(memberships);
    expect(membership?.active).toBe(true);
  });

  it("does not offer a POST — the route only accepts GET", async () => {
    const { fixtureId, playerId } = await seed();
    const token = await tokenFor(fixtureId, playerId);

    const response = await SELF.fetch(`https://makethe.team/leave/${token}`, { method: "POST" });
    expect(response.status).not.toBe(200);
  });

  it("shows the same friendly failure page for a bad token as /r/:token does", async () => {
    const response = await SELF.fetch("https://makethe.team/leave/not-a-real-token");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("This link isn't working");
  });

  it("shows the friendly failure page for an expired token", async () => {
    const { fixtureId, playerId } = await seed();
    // The route verifies against the real wall clock, not the fictional `NOW`
    // used for fixture timing elsewhere in this file — an absolute instant
    // years in the past, not `NOW - 1000`, avoids any isolate-clock-skew
    // flake (see the identical comment in test/routes/respond-get.test.ts).
    const expired = await tokenFor(fixtureId, playerId, new Date("2020-01-01T00:00:00Z").getTime());

    const response = await SELF.fetch(`https://makethe.team/leave/${expired}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("This link isn't working");
  });

  it("shows the friendly failure page when the fixture no longer exists", async () => {
    const token = await tokenFor("no-such-fixture", "no-such-player");

    const response = await SELF.fetch(`https://makethe.team/leave/${token}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("This link isn't working");
  });
});
