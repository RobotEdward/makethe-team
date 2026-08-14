import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures, players } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { insertGame, insertMembership, insertPlayer, playerRow, resetDatabase, testDb } from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

const NOW = new Date("2026-08-13T09:00:00Z");

/** Signs in and returns the signed-in player's own id alongside the cookie. */
async function ownerSession(): Promise<{ cookie: string; viewerId: string }> {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  return { cookie, viewerId: viewer!.id };
}

/**
 * Insert a player at a fixed id, or reuse it if a previous seed in the same
 * test already created it — matches `test/routes/owner-fixture.test.ts`'s
 * helper of the same name, so `p-0` names the same row both times.
 */
async function ensurePlayer(db: ReturnType<typeof testDb>, id: string, name: string): Promise<string> {
  await db.insert(players).values({ ...playerRow(), id, name }).onConflictDoNothing();
  return id;
}

/**
 * A game with one open fixture, whose squad the signed-in identity views
 * under `viewerRole`. This harness supports one real signed-in identity, so
 * the *membership row* is what varies, not the session (matching
 * `test/routes/owner-fixture.test.ts`):
 *
 * - `"owner"`: the signed-in identity is the game's active owner.
 * - `"player"`: the signed-in identity is an active ordinary member.
 * - `"removed"`: the signed-in identity has an inactive membership row.
 * - `"none"`: the signed-in identity has no membership row at all.
 *
 * A separate real member ("Player 0", id `p-0`) always joins before the
 * fixture opens, so the squad has someone in it to assert on regardless of
 * the viewer's own role.
 */
async function seedGameWithOpenFixture(options: {
  viewerRole: "owner" | "player" | "removed" | "none";
  squadVisibleToPlayers: boolean;
}): Promise<{ gameId: string; fixtureId: string; cookie: string }> {
  const db = testDb();
  const { cookie, viewerId } = await ownerSession();

  const gameId = await insertGame(db, { maxPlayers: 14, squadVisibleToPlayers: options.squadVisibleToPlayers });

  // Someone else always owns the game, so the viewer's own role can be set
  // independently — an "owner"-role viewer gets a *second* owner membership.
  const otherOwnerId = await insertPlayer(db);
  await insertMembership(db, gameId, otherOwnerId, { role: "owner" });

  const memberPlayerId = await ensurePlayer(db, "p-0", "Player 0");
  await insertMembership(db, gameId, memberPlayerId);

  if (options.viewerRole === "owner") {
    await insertMembership(db, gameId, viewerId, { role: "owner" });
  } else if (options.viewerRole === "player") {
    await insertMembership(db, gameId, viewerId);
  } else if (options.viewerRole === "removed") {
    await insertMembership(db, gameId, viewerId, { active: false, leftAt: NOW });
  }
  // "none": no membership row for the viewer at all.

  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: new Date("2026-08-20T18:00:00Z"),
    minPlayers: 1,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });
  await openFixture(db, fixtureId, NOW);

  return { gameId, fixtureId, cookie };
}

/** A game with no fixture yet materialised, viewed by the given role. */
async function seedGameWithNoOpenFixture(options: {
  viewerRole: "owner" | "player" | "removed" | "none";
}): Promise<{ gameId: string; cookie: string }> {
  const db = testDb();
  const { cookie, viewerId } = await ownerSession();

  const gameId = await insertGame(db, { maxPlayers: 14 });

  const otherOwnerId = await insertPlayer(db);
  await insertMembership(db, gameId, otherOwnerId, { role: "owner" });

  if (options.viewerRole === "owner") {
    await insertMembership(db, gameId, viewerId, { role: "owner" });
  } else if (options.viewerRole === "player") {
    await insertMembership(db, gameId, viewerId);
  } else if (options.viewerRole === "removed") {
    await insertMembership(db, gameId, viewerId, { active: false, leftAt: NOW });
  }

  return { gameId, cookie };
}

function appFetch(path: string, cookie: string) {
  return SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie } });
}

describe("GET /g/:id as a member", () => {
  beforeEach(resetDatabase);

  it("shows the open fixture's squad to a member", async () => {
    const { gameId, cookie } = await seedGameWithOpenFixture({ viewerRole: "player", squadVisibleToPlayers: true });

    const response = await appFetch(`/g/${gameId}`, cookie);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Player 0");
  });

  it("hides other players when the organiser has turned it off", async () => {
    const { gameId, cookie } = await seedGameWithOpenFixture({ viewerRole: "player", squadVisibleToPlayers: false });

    const html = await (await appFetch(`/g/${gameId}`, cookie)).text();

    expect(html).not.toContain("Player 0");
    expect(html).toContain("in so far");
  });

  it("still gives an owner the owner's page", async () => {
    const { gameId, cookie } = await seedGameWithOpenFixture({ viewerRole: "owner", squadVisibleToPlayers: false });

    const html = await (await appFetch(`/g/${gameId}`, cookie)).text();

    // The invite link is the owner page's tell, and it must never appear on
    // the player's — it is a capability, not a decoration.
    expect(html).toContain("Invite people");
  });

  it("never shows a member the invite link", async () => {
    const { gameId, cookie } = await seedGameWithOpenFixture({ viewerRole: "player", squadVisibleToPlayers: true });

    const html = await (await appFetch(`/g/${gameId}`, cookie)).text();

    expect(html).not.toContain("Invite people");
    expect(html).not.toContain("/j/");
  });

  it("404s a removed member", async () => {
    const { gameId, cookie } = await seedGameWithOpenFixture({ viewerRole: "removed", squadVisibleToPlayers: true });

    expect((await appFetch(`/g/${gameId}`, cookie)).status).toBe(404);
  });

  it("404s a non-member", async () => {
    const { gameId, cookie } = await seedGameWithOpenFixture({ viewerRole: "none", squadVisibleToPlayers: true });

    expect((await appFetch(`/g/${gameId}`, cookie)).status).toBe(404);
  });

  it("says so when no fixture is open, and names nobody", async () => {
    const { gameId, cookie } = await seedGameWithNoOpenFixture({ viewerRole: "player" });

    const html = await (await appFetch(`/g/${gameId}`, cookie)).text();

    expect(html).toContain("Nothing open yet");
    expect(html).not.toContain("Player 0");
  });
});
