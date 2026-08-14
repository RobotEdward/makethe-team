import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, players } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { signResponseToken } from "../../src/domain/token.js";
import { insertGame, resetDatabase } from "../support/factories.js";
import { kickoffIn, NOW } from "../support/clock.js";

/**
 * `app.onError` — the unexpected-failure path on the product's critical path.
 *
 * Every *expected* failure on `/r/:token` already had a friendly page; an
 * unexpected throw did not, and fell through to Hono's bare 500. The error
 * induced here is the realistic one: a Game row whose `timezone` is not a
 * real IANA zone makes `formatLocalDateTime` throw a `LocalTimeError` while
 * rendering the fixture page, after the token has verified.
 */
const db = getDb(env.DB);
const SECRET = env.RESPONSE_TOKEN_SECRET;
// Relative to the real clock, not pinned to a date — the route verifies its
// token against the real wall clock, so a fixed kickoff eventually falls into
// the past and every token here reads as expired. See test/support/clock.ts.
const KICKOFF = kickoffIn(9);

async function seedFixtureWithBrokenTimezone(): Promise<string> {
  const gameId = await insertGame(db, { timezone: "Not/ARealZone" });
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

  return signResponseToken({ playerId, fixtureId, expiresAt: KICKOFF.getTime() + 86_400_000 }, SECRET);
}

beforeEach(async () => {
  await resetDatabase();
});

describe("app.onError", () => {
  it("renders the shared link-problem page instead of a bare Hono 500", async () => {
    const token = await seedFixtureWithBrokenTimezone();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await SELF.fetch(`https://makethe.team/r/${token}`);

      // 500, because something really did break server-side and Cloudflare's
      // metrics must record it — but the *body* is the friendly page.
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain("This link isn't working");
      expect(body).toContain("Ask whoever organises your game");
      expect(response.headers.get("content-type")).toMatch(/text\/html/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs the real error server-side and leaks none of it to the player", async () => {
    const token = await seedFixtureWithBrokenTimezone();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const body = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();

      const logged = errorSpy.mock.calls.flat().join("\n");
      expect(logged).toMatch(/unhandled error serving GET \/r\//);
      expect(logged).toMatch(/Not\/ARealZone|time ?zone/i);

      // Nothing internal reaches the page: no zone name, no stack frame, no
      // error class, no file path.
      expect(body).not.toContain("Not/ARealZone");
      expect(body).not.toMatch(/LocalTimeError|at .+\.ts:|src\//);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("is byte-identical to the page a rejected token gets, so it is not an oracle", async () => {
    const token = await seedFixtureWithBrokenTimezone();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const thrown = await (await SELF.fetch(`https://makethe.team/r/${token}`)).text();
      const rejected = await (await SELF.fetch("https://makethe.team/r/not-a-real-token")).text();

      // A prober cannot tell a broken database or a broken Game apart from a
      // wrong guess by reading the response body.
      expect(thrown).toBe(rejected);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
