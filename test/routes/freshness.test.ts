import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_PATH, gamePath, ownerFixturePath } from "../../src/auth/paths.js";
import { fixtures, players } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { signResponseToken } from "../../src/domain/token.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";
import { expectFreshness } from "../support/freshness.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";
import { kickoffIn, NOW } from "../support/clock.js";

/**
 * The freshness bar's scope, enumerated (M24).
 *
 * Five pages carry it, and the reason is the same for all five: each one
 * shows facts that move while it is on screen — who has answered, how many
 * places are left, whether the teams are up. An installed app resumed after
 * twenty minutes re-shows the document the browser already had, so without
 * this bar the only way to see today's answers is to navigate away and back.
 *
 * Written as one file rather than an assertion added to each page's own suite
 * so that "which pages carry it" is answered in one place. A sixth page
 * joining the set belongs here, next to the five, with its own path.
 */
const SECRET = env.RESPONSE_TOKEN_SECRET;

async function viewerId(): Promise<string> {
  const [viewer] = await testDb().select().from(players).where(eq(players.email, ALLOWED));
  return viewer!.id;
}

/**
 * A game with one open fixture. The signed-in identity is a member at
 * `viewerRole`; a second identity always owns the game, so the viewer's own
 * role varies independently (the shape `test/routes/player-game.test.ts`
 * uses, for the same reason: this harness signs in exactly one identity).
 */
async function seed(viewerRole: "owner" | "player") {
  const db = testDb();
  const { cookie } = await signIn();
  const me = await viewerId();

  const gameId = await insertGame(db, { maxPlayers: 14 });
  await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });
  await insertMembership(db, gameId, me, viewerRole === "owner" ? { role: "owner" } : {});

  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: kickoffIn(24 * 7),
    minPlayers: 1,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });
  await openFixture(db, fixtureId, NOW);

  return { cookie, gameId, fixtureId, me };
}

async function html(path: string, cookie: string): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie } });
  expect(response.status, `${path} must render`).toBe(200);
  return response.text();
}

describe("the freshness bar", () => {
  beforeEach(resetDatabase);

  it("is on the dashboard, refreshing at the dashboard", async () => {
    const { cookie } = await seed("player");
    expectFreshness(await html(DASHBOARD_PATH, cookie), DASHBOARD_PATH);
  });

  it("is on the organiser's game page, refreshing at that game", async () => {
    const { cookie, gameId } = await seed("owner");
    expectFreshness(await html(gamePath(gameId), cookie), gamePath(gameId));
  });

  it("is on a member's game page, refreshing at that game", async () => {
    const { cookie, gameId } = await seed("player");
    expectFreshness(await html(gamePath(gameId), cookie), gamePath(gameId));
  });

  it("is on the organiser's fixture page, refreshing at that fixture", async () => {
    const { cookie, gameId, fixtureId } = await seed("owner");
    const path = ownerFixturePath(gameId, fixtureId);
    expectFreshness(await html(path, cookie), path);
  });

  it("is on the response page, refreshing at the same token", async () => {
    // Not the path the *organiser* would use: this page is reached by a
    // signed token rather than a session, so its own URL — the only one that
    // renders it — is the one the link has to carry back.
    const { fixtureId, me } = await seed("player");
    const token = await signResponseToken(
      { playerId: me, fixtureId, expiresAt: NOW.getTime() + 86_400_000 },
      SECRET,
    );
    const response = await SELF.fetch(`${ORIGIN}/r/${token}`);
    expect(response.status).toBe(200);
    expectFreshness(await response.text(), `/r/${encodeURIComponent(token)}`);
  });

  it("is not on a page whose facts do not move", async () => {
    // The guard on the scope: the account page is a settings screen, and a
    // "Updated 3 minutes ago" under a list of your own devices says nothing.
    // A bar that spread to every page would stop meaning anything on the five
    // that need it.
    const { cookie } = await seed("player");
    const body = await html("/app/account", cookie);
    expect(body).not.toContain('class="freshness"');
  });
});
