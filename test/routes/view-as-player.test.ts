import { SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtureAsPlayerPath, gameAsPlayerPath } from "../../src/auth/paths.js";
import { players } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  playerRow,
  resetDatabase,
  testDb,
} from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

const NOW = new Date("2026-08-13T09:00:00Z");

/**
 * M61's preview: `?as=player` on the two pages that already branch owner /
 * member, so an organiser can read their own page as the squad reads it.
 *
 * The flag is read *after* entitlement and only ever narrows, so the tests
 * that matter most here are the ones proving it cannot widen — a stranger
 * carrying it still gets the 404 they get without it — and the ones proving
 * the preview is the real member page rather than a costume: a game with its
 * squad list switched off must show the organiser no squad at all.
 */

/** Signs in and returns the signed-in player's own id alongside the cookie. */
async function ownerSession(): Promise<{ cookie: string; viewerId: string }> {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  return { cookie, viewerId: viewer!.id };
}

/**
 * A game with one open fixture and a second, ordinary member ("Player 0") in
 * the squad, so there is always somebody for the squad list to name or hide.
 * The signed-in identity's own membership row is what `viewerRole` varies —
 * this harness supports one real session (see `test/routes/player-game.test.ts`).
 */
async function seed(options: {
  viewerRole: "owner" | "player" | "none";
  squadVisibleToPlayers?: boolean;
}): Promise<{ gameId: string; fixtureId: string; cookie: string }> {
  const db = testDb();
  const { cookie, viewerId } = await ownerSession();

  const gameId = await insertGame(db, {
    maxPlayers: 14,
    squadVisibleToPlayers: options.squadVisibleToPlayers ?? true,
  });

  // Somebody else always owns the game, so the viewer's own role is free to
  // vary independently of the game having an owner at all.
  const otherOwnerId = await insertPlayer(db);
  await insertMembership(db, gameId, otherOwnerId, { role: "owner" });

  await db.insert(players).values({ ...playerRow(), id: "p-0", name: "Player 0" }).onConflictDoNothing();
  await insertMembership(db, gameId, "p-0");

  if (options.viewerRole === "owner") {
    await insertMembership(db, gameId, viewerId, { role: "owner" });
  } else if (options.viewerRole === "player") {
    await insertMembership(db, gameId, viewerId);
  }

  const fixtureId = await insertFixture(db, gameId, { minPlayers: 1 });
  await openFixture(db, fixtureId, NOW);

  return { gameId, fixtureId, cookie };
}

function appFetch(path: string, cookie: string) {
  return SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie } });
}

/** The organiser page's tell: the invite link is a capability, not a decoration. */
const OWNER_TELL = "Invite people";
const BANNER = "You're seeing this as a player";

describe("?as=player on the game page", () => {
  beforeEach(resetDatabase);

  it("offers the organiser the link", async () => {
    const { gameId, cookie } = await seed({ viewerRole: "owner" });

    const html = await (await appFetch(`/g/${gameId}`, cookie)).text();

    expect(html).toContain("See this as a player");
    expect(html).toContain(gameAsPlayerPath(gameId));
  });

  it("gives the organiser the member page, with a way back", async () => {
    const { gameId, cookie } = await seed({ viewerRole: "owner" });

    const response = await appFetch(gameAsPlayerPath(gameId), cookie);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).not.toContain(OWNER_TELL);
    expect(html).toContain(BANNER);
    expect(html).toContain(`href="/g/${gameId}"`);
  });

  it("applies the squad gate to the organiser for real", async () => {
    const { gameId, cookie } = await seed({ viewerRole: "owner", squadVisibleToPlayers: false });

    const html = await (await appFetch(gameAsPlayerPath(gameId), cookie)).text();

    expect(html).not.toContain("Player 0");
  });

  it("leaves the organiser's own page alone without the flag", async () => {
    const { gameId, cookie } = await seed({ viewerRole: "owner" });

    const html = await (await appFetch(`/g/${gameId}`, cookie)).text();

    expect(html).toContain(OWNER_TELL);
    expect(html).not.toContain(BANNER);
  });

  it("changes nothing for an ordinary member, banner included", async () => {
    const { gameId, cookie } = await seed({ viewerRole: "player" });

    const html = await (await appFetch(gameAsPlayerPath(gameId), cookie)).text();

    expect(html).not.toContain(OWNER_TELL);
    expect(html).not.toContain(BANNER);
    expect(html).not.toContain("See this as a player");
  });

  it("cannot widen anything: a stranger carrying it still gets 404", async () => {
    const { gameId, cookie } = await seed({ viewerRole: "none" });

    expect((await appFetch(gameAsPlayerPath(gameId), cookie)).status).toBe(404);
  });
});

describe("?as=player on the fixture page", () => {
  beforeEach(resetDatabase);

  it("offers the organiser the link", async () => {
    const { gameId, fixtureId, cookie } = await seed({ viewerRole: "owner" });

    const html = await (await appFetch(`/g/${gameId}/f/${fixtureId}`, cookie)).text();

    expect(html).toContain("See this as a player");
    expect(html).toContain(fixtureAsPlayerPath(gameId, fixtureId));
  });

  it("gives the organiser the member page, with a way back", async () => {
    const { gameId, fixtureId, cookie } = await seed({ viewerRole: "owner" });

    const response = await appFetch(fixtureAsPlayerPath(gameId, fixtureId), cookie);
    const html = await response.text();

    expect(response.status).toBe(200);
    // The per-member mark-in controls are the organiser fixture page's tell.
    expect(html).not.toContain("/response/p-0");
    expect(html).toContain(BANNER);
    expect(html).toContain(`href="/g/${gameId}/f/${fixtureId}"`);
  });

  it("applies the squad gate to the organiser for real", async () => {
    const { gameId, fixtureId, cookie } = await seed({
      viewerRole: "owner",
      squadVisibleToPlayers: false,
    });

    const html = await (await appFetch(fixtureAsPlayerPath(gameId, fixtureId), cookie)).text();

    expect(html).not.toContain("Player 0");
  });

  it("leaves the organiser's own page alone without the flag", async () => {
    const { gameId, fixtureId, cookie } = await seed({ viewerRole: "owner" });

    const html = await (await appFetch(`/g/${gameId}/f/${fixtureId}`, cookie)).text();

    expect(html).toContain("/response/p-0");
    expect(html).not.toContain(BANNER);
  });

  it("changes nothing for an ordinary member, banner included", async () => {
    const { gameId, fixtureId, cookie } = await seed({ viewerRole: "player" });

    const html = await (await appFetch(fixtureAsPlayerPath(gameId, fixtureId), cookie)).text();

    expect(html).not.toContain(BANNER);
    expect(html).not.toContain("See this as a player");
  });

  it("cannot widen anything: a stranger carrying it still gets 404", async () => {
    const { gameId, fixtureId, cookie } = await seed({ viewerRole: "none" });

    expect((await appFetch(fixtureAsPlayerPath(gameId, fixtureId), cookie)).status).toBe(404);
  });
});
