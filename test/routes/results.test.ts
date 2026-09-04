import { SELF } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, fixtureResultClaims, games, players } from "../../src/db/schema.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  insertResultClaim,
  resetDatabase,
  testDb,
} from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";
import { kickoffIn } from "../support/clock.js";

/** A form POST with the origin the app requires, matching `test/routes/owner-fixture.test.ts`. */
function appPost(path: string, fields: Record<string, string>, cookie: string, origin: string = ORIGIN) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

/** Signs in and returns the signed-in player's own id alongside the cookie. */
async function viewerSession(): Promise<{ cookie: string; viewerId: string }> {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  return { cookie, viewerId: viewer!.id };
}

/**
 * A played fixture the viewer was `in` for, in a game owned by someone else —
 * the ordinary case of a squad member with standing to file (BR-37 §6).
 * `kickoffIn(-24)` keeps the window open: full time was 23 hours ago, so the
 * default 24-hour deadline (M57) is an hour from now, not yet passed.
 */
async function seedPlayedFixtureFor(viewerId: string): Promise<{ gameId: string; fixtureId: string }> {
  const db = testDb();
  const otherOwner = await insertPlayer(db);
  const gameId = await insertGame(db);
  await insertMembership(db, gameId, otherOwner, { role: "owner" });
  await insertMembership(db, gameId, viewerId);
  const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: kickoffIn(-24) });
  await insertResponse(db, fixtureId, viewerId, { status: "in" });
  return { gameId, fixtureId };
}

describe("POST /g/:id/f/:fixtureId/result (M25)", () => {
  beforeEach(resetDatabase);

  it("files a claim and redirects back to the fixture", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { gameId, fixtureId } = await seedPlayedFixtureFor(viewerId);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/result`,
      { outcome: "a" },
      cookie,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}/f/${fixtureId}`);
    const db = testDb();
    const [row] = await db
      .select()
      .from(fixtureResultClaims)
      .where(
        and(eq(fixtureResultClaims.fixtureId, fixtureId), eq(fixtureResultClaims.playerId, viewerId)),
      );
    expect(row).toMatchObject({ outcome: "a", scoreA: null, scoreB: null });
  });

  it("derives the outcome from the score and ignores a contradicting one", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { gameId, fixtureId } = await seedPlayedFixtureFor(viewerId);

    // The submitted `outcome` says "draw"; the score says the away side won.
    // `parseClaim` must win, not the form's own outcome field.
    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/result`,
      { outcome: "draw", scoreA: "1", scoreB: "3" },
      cookie,
    );

    expect(response.status).toBe(303);
    const db = testDb();
    const [row] = await db
      .select()
      .from(fixtureResultClaims)
      .where(
        and(eq(fixtureResultClaims.fixtureId, fixtureId), eq(fixtureResultClaims.playerId, viewerId)),
      );
    expect(row).toMatchObject({ outcome: "b", scoreA: 1, scoreB: 3 });
  });

  it("moves an existing claim rather than adding a second", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { gameId, fixtureId } = await seedPlayedFixtureFor(viewerId);

    await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "a" }, cookie);
    await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "b" }, cookie);

    const db = testDb();
    const rows = await db
      .select()
      .from(fixtureResultClaims)
      .where(
        and(eq(fixtureResultClaims.fixtureId, fixtureId), eq(fixtureResultClaims.playerId, viewerId)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "b" });
  });

  it("agreeing posts values and joins the existing candidate", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { gameId, fixtureId } = await seedPlayedFixtureFor(viewerId);
    const db = testDb();
    const otherPlayer = await insertPlayer(db);
    await insertMembership(db, gameId, otherPlayer);
    await insertResponse(db, fixtureId, otherPlayer, { status: "in" });
    await insertResultClaim(db, fixtureId, otherPlayer, { outcome: "a", scoreA: 3, scoreB: 1 });

    // The form the "Agree" button submits: values copied off the existing
    // candidate, never its id (BR-37 §7) — nothing here names the other
    // player's claim.
    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/result`,
      { outcome: "a", scoreA: "3", scoreB: "1" },
      cookie,
    );

    expect(response.status).toBe(303);
    const rows = await db.select().from(fixtureResultClaims).where(eq(fixtureResultClaims.fixtureId, fixtureId));
    expect(rows).toHaveLength(2);
    const mine = rows.find((row) => row.playerId === viewerId);
    expect(mine).toMatchObject({ outcome: "a", scoreA: 3, scoreB: 1 });
  });

  it("withdraws the caller's own claim only", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { gameId, fixtureId } = await seedPlayedFixtureFor(viewerId);
    const db = testDb();
    const otherPlayer = await insertPlayer(db);
    await insertMembership(db, gameId, otherPlayer);
    await insertResponse(db, fixtureId, otherPlayer, { status: "in" });
    await insertResultClaim(db, fixtureId, viewerId, { outcome: "a" });
    await insertResultClaim(db, fixtureId, otherPlayer, { outcome: "b" });

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/result/clear`, {}, cookie);

    expect(response.status).toBe(303);
    const rows = await db.select().from(fixtureResultClaims).where(eq(fixtureResultClaims.fixtureId, fixtureId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ playerId: otherPlayer });
  });

  it("renders the owner page, not the player page, when an owner trips clear's locked-window 422", async () => {
    const { cookie, viewerId } = await viewerSession();
    const db = testDb();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, viewerId, { role: "owner" });
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: kickoffIn(-72) });
    const otherPlayer = await insertPlayer(db);
    await insertMembership(db, gameId, otherPlayer);
    await insertResponse(db, fixtureId, otherPlayer, { status: "in" });
    await insertResultClaim(db, fixtureId, otherPlayer, { outcome: "a" });

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/result/clear`, {}, cookie);

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("Back to the game");
  });

  it("404s a non-member", async () => {
    const { cookie } = await viewerSession();
    const db = testDb();
    const otherOwner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, otherOwner, { role: "owner" });
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: kickoffIn(-24) });

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "a" }, cookie);

    expect(response.status).toBe(404);
  });

  it("404s a member who was neither in nor an owner", async () => {
    const { cookie, viewerId } = await viewerSession();
    const db = testDb();
    const otherOwner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, otherOwner, { role: "owner" });
    await insertMembership(db, gameId, viewerId);
    // A member of the game, but never marked `in` for this fixture.
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: kickoffIn(-24) });

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "a" }, cookie);

    expect(response.status).toBe(404);
  });

  it("404s when the fixture is open, scheduled or cancelled, even for a player who is in", async () => {
    const { cookie, viewerId } = await viewerSession();
    const db = testDb();
    const otherOwner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, otherOwner, { role: "owner" });
    await insertMembership(db, gameId, viewerId);

    // The viewer is marked `in` on every one of these fixtures — so each
    // *would* pass `resultElectorate` — deliberately, so this 404 can only be
    // coming from the explicit `lifecycle !== "played"` check, not from the
    // electorate refusal a non-participant gets (that case has its own test
    // above). BR-37 §7 gives "not played" its own 404 row, distinct from the
    // 422 a locked-but-eligible fixture gets.
    const lifecycles = ["open", "scheduled", "cancelled"] as const;
    for (const [index, lifecycle] of lifecycles.entries()) {
      // A distinct kickoff per lifecycle: `fixtures` has a unique index on
      // `(game_id, kicks_off_at)`, and this loop seeds three fixtures in one
      // game.
      const fixtureId = await insertFixture(db, gameId, { lifecycle, kicksOffAt: kickoffIn(24 + index) });
      await insertResponse(db, fixtureId, viewerId, { status: "in" });
      const response = await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "a" }, cookie);
      expect(response.status).toBe(404);
    }
  });

  it("422s once the result is locked, and writes nothing", async () => {
    const { cookie, viewerId } = await viewerSession();
    const db = testDb();
    const otherOwner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, otherOwner, { role: "owner" });
    await insertMembership(db, gameId, viewerId);
    // Kicked off 72 hours ago: the default 24-hour window closed two days ago.
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: kickoffIn(-72) });
    await insertResponse(db, fixtureId, viewerId, { status: "in" });
    // Somebody filed, so `isResultLocked` is true rather than the empty case.
    const otherPlayer = await insertPlayer(db);
    await insertMembership(db, gameId, otherPlayer);
    await insertResponse(db, fixtureId, otherPlayer, { status: "in" });
    await insertResultClaim(db, fixtureId, otherPlayer, { outcome: "a" });

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "b" }, cookie);

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("taking a result any more");
    // The caller is an ordinary member, not an owner — the player page, never
    // the owner page's unconditional "Back to the game" link (M25 review fix
    // pins the two roles apart).
    expect(html).not.toContain("Back to the game");
    const rows = await db
      .select()
      .from(fixtureResultClaims)
      .where(and(eq(fixtureResultClaims.fixtureId, fixtureId), eq(fixtureResultClaims.playerId, viewerId)));
    expect(rows).toHaveLength(0);
  });

  /**
   * The reason `result_lock_hours_after` lives on `games` and is read live,
   * rather than being copied onto each fixture the way `duration_minutes` is.
   * `updateGame` propagates a copied column only to *scheduled* fixtures — and
   * an owner widens this setting because of the fixture played last night,
   * which is exactly the one a copy could never reach.
   */
  it("applies an owner's longer window to a fixture that has already been played", async () => {
    const { cookie, viewerId } = await viewerSession();
    const db = testDb();
    const otherOwner = await insertPlayer(db);
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, otherOwner, { role: "owner" });
    await insertMembership(db, gameId, viewerId);
    // Full time was 71 hours ago: past the default 24, inside a week.
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: kickoffIn(-72) });
    await insertResponse(db, fixtureId, viewerId, { status: "in" });
    const otherPlayer = await insertPlayer(db);
    await insertMembership(db, gameId, otherPlayer);
    await insertResponse(db, fixtureId, otherPlayer, { status: "in" });
    await insertResultClaim(db, fixtureId, otherPlayer, { outcome: "a" });

    // Refused first, so the widening below is what changes the answer rather
    // than the seed having been writable all along.
    expect((await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "b" }, cookie)).status)
      .toBe(422);

    await db.update(games).set({ resultLockHoursAfter: 168 }).where(eq(games.id, gameId));

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "b" }, cookie);

    expect(response.status).toBe(303);
    const [row] = await db
      .select()
      .from(fixtureResultClaims)
      .where(
        and(eq(fixtureResultClaims.fixtureId, fixtureId), eq(fixtureResultClaims.playerId, viewerId)),
      );
    expect(row).toMatchObject({ outcome: "b" });
  });

  it("422s half a score, and writes nothing", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { gameId, fixtureId } = await seedPlayedFixtureFor(viewerId);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/result`,
      { scoreA: "2" },
      cookie,
    );

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("Give both scores");
    expect(html).not.toContain("Back to the game");
    const db = testDb();
    const rows = await db
      .select()
      .from(fixtureResultClaims)
      .where(and(eq(fixtureResultClaims.fixtureId, fixtureId), eq(fixtureResultClaims.playerId, viewerId)));
    expect(rows).toHaveLength(0);
  });

  it("renders the owner page, not the player page, when an owner trips the locked-window 422", async () => {
    const { cookie, viewerId } = await viewerSession();
    const db = testDb();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, viewerId, { role: "owner" });
    // Kicked off 72 hours ago and already carrying a claim, so the window is
    // shut (`isResultLocked`) rather than the empty, still-writable case.
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: kickoffIn(-72) });
    const otherPlayer = await insertPlayer(db);
    await insertMembership(db, gameId, otherPlayer);
    await insertResponse(db, fixtureId, otherPlayer, { status: "in" });
    await insertResultClaim(db, fixtureId, otherPlayer, { outcome: "a" });

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "b" }, cookie);

    expect(response.status).toBe(422);
    const html = await response.text();
    // `renderOwnerFixturePage` alone emits this link (`src/views/owner-fixture.ts`
    // — unconditional, unlike its guest form, which only shows while the
    // fixture is still open and so would not appear on this played one);
    // `src/views/player-fixture.ts` has no such link at all.
    expect(html).toContain("Back to the game");
  });

  it("renders the owner page, not the player page, when an owner trips the bad-claim 422", async () => {
    const { cookie, viewerId } = await viewerSession();
    const db = testDb();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, viewerId, { role: "owner" });
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: kickoffIn(-24) });

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/result`, { scoreA: "2" }, cookie);

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("Back to the game");
  });

  it("403s a request from the wrong origin", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { gameId, fixtureId } = await seedPlayedFixtureFor(viewerId);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/result`,
      { outcome: "a" },
      cookie,
      "https://evil.example",
    );

    expect(response.status).toBe(403);
  });

  it("is idempotent under a replayed form", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { gameId, fixtureId } = await seedPlayedFixtureFor(viewerId);

    await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "a" }, cookie);
    await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "a" }, cookie);

    const db = testDb();
    const rows = await db
      .select()
      .from(fixtureResultClaims)
      .where(and(eq(fixtureResultClaims.fixtureId, fixtureId), eq(fixtureResultClaims.playerId, viewerId)));
    expect(rows).toHaveLength(1);
  });

  it("writes fixture.result_filed then fixture.result_changed to audit_log", async () => {
    const { cookie, viewerId } = await viewerSession();
    const { gameId, fixtureId } = await seedPlayedFixtureFor(viewerId);

    await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "a" }, cookie);
    await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "b" }, cookie);

    const db = testDb();
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, fixtureId))
      .orderBy(auditLog.createdAt);
    expect(rows.map((row) => row.action)).toEqual(["fixture.result_filed", "fixture.result_changed"]);
    expect(rows[0]).toMatchObject({ actorPlayerId: viewerId, entityType: "fixture" });
    expect(JSON.parse(rows[1]!.beforeJson!)).toEqual({ outcome: "a", scoreA: null, scoreB: null });
    expect(JSON.parse(rows[1]!.afterJson!)).toEqual({ outcome: "b", scoreA: null, scoreB: null });
  });

  it("lets an organiser who did not play file", async () => {
    const { cookie, viewerId } = await viewerSession();
    const db = testDb();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, viewerId, { role: "owner" });
    // No `insertResponse` for the organiser at all — `resultElectorate`
    // grants standing to every active owner regardless of whether they
    // played (BR-37 §6).
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: kickoffIn(-24) });

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "a" }, cookie);

    expect(response.status).toBe(303);
    const rows = await db
      .select()
      .from(fixtureResultClaims)
      .where(and(eq(fixtureResultClaims.fixtureId, fixtureId), eq(fixtureResultClaims.playerId, viewerId)));
    expect(rows).toHaveLength(1);
  });
});
