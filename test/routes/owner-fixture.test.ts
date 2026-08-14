import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, fixtures, notificationLog, players, responses } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { insertGame, insertMembership, insertPlayer, playerRow, resetDatabase, testDb } from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";

/** A form POST with the origin the app requires, matching `test/routes/squad.test.ts`. */
function appPost(path: string, fields: Record<string, string>, cookie: string, origin: string = ORIGIN) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

/**
 * Drains the N-2 `waitUntil` so it cannot land after the next test's
 * `resetDatabase()` — the same race `test/routes/squad.test.ts` documents on
 * `settleNotifications`. Never asserted on.
 */
async function settleNotifications(atLeast: number, timeoutMs = 3000) {
  const db = testDb();
  const deadline = Date.now() + timeoutMs;
  const settled = (rows: Array<{ status: string }>) =>
    rows.length >= atLeast && rows.every((row) => row.status !== "queued");

  let rows = await db.select().from(notificationLog);
  while (!settled(rows) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    rows = await db.select().from(notificationLog);
  }
}

const NOW = new Date("2026-08-13T09:00:00Z");

function stubFor(fixtureId: string) {
  return env.FIXTURE_CAPACITY.getByName(fixtureId);
}

/**
 * Insert a player at a fixed id, or reuse it if a previous seed in the same
 * test already created it — several seeds below reuse `p-0`/`p-9` on purpose,
 * so Task 5's tests can name the row an override touches directly rather than
 * threading a random id through every assertion.
 */
async function ensurePlayer(db: ReturnType<typeof testDb>, id: string, name: string): Promise<string> {
  await db.insert(players).values({ ...playerRow(), id, name }).onConflictDoNothing();
  return id;
}

/** Signs in and returns the signed-in player's own id alongside the cookie. */
async function ownerSession(): Promise<{ cookie: string; viewerId: string }> {
  const { cookie } = await signIn();
  const db = testDb();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  return { cookie, viewerId: viewer!.id };
}

/**
 * A game owned by `ownerPlayerId`, with one open fixture and one ordinary
 * member ("Player 0", id `p-0`) who has not yet answered — built by driving
 * the app's own domain functions (`openFixture`) rather than writing rows by
 * hand, so the world this test loads is one the app itself could have
 * produced. `p-0`'s id is fixed rather than random so Task 5's tests, which
 * assert on the exact response and audit rows an owner override produces, can
 * name it directly.
 */
async function seedOpenFixtureOwnedBy(ownerPlayerId: string): Promise<{ gameId: string; fixtureId: string }> {
  const db = testDb();
  const gameId = await insertGame(db, { maxPlayers: 14 });
  await insertMembership(db, gameId, ownerPlayerId, { role: "owner" });
  // Idempotent: some tests seed two games in the same run (e.g. "404s for a
  // fixture belonging to a different game"), and `p-0` names the same fixed
  // player id both times rather than colliding on it.
  const memberPlayerId = await ensurePlayer(db, "p-0", "Player 0");
  await insertMembership(db, gameId, memberPlayerId);

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

  return { gameId, fixtureId };
}

/**
 * A game owned by `ownerPlayerId`, with one open fixture already at its own
 * `maxPlayers` (one member, id `p-0`, marked in) and one further member (id
 * `p-9`) who has not yet answered — so posting `p-9` in is exactly the case
 * that needs BR-8's confirmation.
 */
async function seedFullFixtureOwnedBy(
  ownerPlayerId: string,
): Promise<{ gameId: string; fixtureId: string }> {
  const db = testDb();
  const gameId = await insertGame(db, { maxPlayers: 1 });
  await insertMembership(db, gameId, ownerPlayerId, { role: "owner" });
  await ensurePlayer(db, "p-0", "Player 0");
  await insertMembership(db, gameId, "p-0");
  await ensurePlayer(db, "p-9", "Player 9");
  await insertMembership(db, gameId, "p-9");

  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: new Date("2026-08-20T18:00:00Z"),
    minPlayers: 1,
    maxPlayers: 1,
    prefersEvenNumbers: false,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });
  await openFixture(db, fixtureId, NOW);

  await stubFor(fixtureId).setResponse({
    playerId: "p-0",
    intent: "in",
    actorPlayerId: null,
    source: "token",
    whenFull: "waitlist",
    now: NOW.getTime(),
  });

  return { gameId, fixtureId };
}

/**
 * A game owned by `ownerPlayerId`, with one open fixture at `maxPlayers: 1`:
 * `p-0` marked in, and a further member already waitlisted behind them — so
 * marking `p-0` out is exactly the case that must promote the waitlisted
 * member (BR-7), the same way any other dropout does.
 *
 * Built as its own fixture, rather than by extending
 * `seedFullFixtureOwnedBy`, because eligibility is fixed at the moment
 * `openFixture` runs (BR-1/BR-2): every member who is to hold a row here,
 * waitlisted one included, must join the squad *before* the fixture opens.
 */
async function seedFullFixtureWithWaitlist(
  ownerPlayerId: string,
): Promise<{ gameId: string; fixtureId: string; waitlistedId: string }> {
  const db = testDb();
  const gameId = await insertGame(db, { maxPlayers: 1 });
  await insertMembership(db, gameId, ownerPlayerId, { role: "owner" });
  await ensurePlayer(db, "p-0", "Player 0");
  await insertMembership(db, gameId, "p-0");
  const waitlistedId = await insertPlayer(db, { name: "Waiting Player" });
  await insertMembership(db, gameId, waitlistedId);

  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: new Date("2026-08-20T18:00:00Z"),
    minPlayers: 1,
    maxPlayers: 1,
    prefersEvenNumbers: false,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });
  await openFixture(db, fixtureId, NOW);

  await stubFor(fixtureId).setResponse({
    playerId: "p-0",
    intent: "in",
    actorPlayerId: null,
    source: "token",
    whenFull: "waitlist",
    now: NOW.getTime(),
  });
  await stubFor(fixtureId).setResponse({
    playerId: waitlistedId,
    intent: "in",
    actorPlayerId: null,
    source: "token",
    whenFull: "waitlist",
    now: NOW.getTime(),
  });

  return { gameId, fixtureId, waitlistedId };
}

/**
 * A fixture whose squad has been driven past its own `maxPlayers` (BR-8), by
 * setting responses with `whenFull: "exceed"` — the only supported way to
 * reach that state, so this seed exercises exactly the path the Durable
 * Object provides for it.
 */
async function seedFullFixtureOverCapacity(ownerPlayerId: string): Promise<{ gameId: string; fixtureId: string }> {
  const db = testDb();
  const gameId = await insertGame(db, { maxPlayers: 2 });
  await insertMembership(db, gameId, ownerPlayerId, { role: "owner" });

  const memberIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const playerId = await insertPlayer(db, { name: `Player ${i}` });
    await insertMembership(db, gameId, playerId);
    memberIds.push(playerId);
  }

  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: new Date("2026-08-20T18:00:00Z"),
    minPlayers: 1,
    maxPlayers: 2,
    prefersEvenNumbers: false,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });
  await openFixture(db, fixtureId, NOW);

  for (const playerId of memberIds) {
    await stubFor(fixtureId).setResponse({
      playerId,
      intent: "in",
      actorPlayerId: ownerPlayerId,
      source: "owner",
      whenFull: "exceed",
      now: NOW.getTime(),
    });
  }

  return { gameId, fixtureId };
}

describe("GET /g/:id/f/:fixtureId", () => {
  beforeEach(resetDatabase);

  it("shows the squad to an owner", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Player 0");
  });

  it("404s for a player who is not an owner", async () => {
    const { cookie, viewerId } = await ownerSession();
    const db = testDb();
    const strangerOwner = await insertPlayer(db);
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(strangerOwner);
    // The viewer is a real member of this game, just not an organiser of it.
    await insertMembership(db, gameId, viewerId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("404s for a fixture belonging to a different game", async () => {
    const { viewerId, cookie } = await ownerSession();
    const { gameId } = await seedOpenFixtureOwnedBy(viewerId);
    // The owner owns both games, so this is specifically the scoping check:
    // the fixture is real and they are entitled to it — just not at this path.
    const other = await seedOpenFixtureOwnedBy(viewerId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${other.fixtureId}`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("404s for an unknown fixture id", async () => {
    const { viewerId, cookie } = await ownerSession();
    const { gameId } = await seedOpenFixtureOwnedBy(viewerId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${crypto.randomUUID()}`, { headers: { cookie } });

    expect(response.status).toBe(404);
  });

  it("redirects an anonymous visitor to sign in", async () => {
    const db = testDb();
    const owner = await insertPlayer(db);
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(owner);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { redirect: "manual" });

    expect(response.status).toBe(302);
  });

  it("says a fixture is over capacity", async () => {
    const { viewerId, cookie } = await ownerSession();
    const { gameId, fixtureId } = await seedFullFixtureOverCapacity(viewerId);

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    expect(html).toContain("Over capacity");
  });
});

describe("POST /g/:id/f/:fixtureId/response/:playerId", () => {
  beforeEach(resetDatabase);

  it("marks a player in on their behalf", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "in" }, cookie);

    expect(response.status).toBe(303);
    const db = testDb();
    const [row] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-0")));
    expect(row).toMatchObject({ status: "in", source: "owner", setByPlayerId: viewerId });
  });

  it("writes an audit row naming the previous status", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "in" }, cookie);

    const db = testDb();
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "fixture.response_overridden"));
    expect(row).toMatchObject({ actorPlayerId: viewerId, entityType: "fixture", entityId: fixtureId });
    expect(JSON.parse(row!.beforeJson!)).toEqual({ playerId: "p-0", status: "pending" });
    expect(JSON.parse(row!.afterJson!)).toEqual({ playerId: "p-0", status: "in", overCapacity: false });
  });

  it("asks before going over capacity, and writes nothing", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFullFixtureOwnedBy(viewerId);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/response/p-9`, { intent: "in" }, cookie);

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("is full");
    expect(html).toContain("Add them anyway");
    const db = testDb();
    const [row] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-9")));
    expect(row?.status).toBe("pending");
  });

  it("goes over capacity when the owner confirms", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFullFixtureOwnedBy(viewerId);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/response/p-9`,
      { intent: "in", override: "1" },
      cookie,
    );

    expect(response.status).toBe(303);
    const db = testDb();
    const [row] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-9")));
    expect(row?.status).toBe("in");
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "fixture.response_overridden"));
    expect(JSON.parse(audit!.afterJson!).overCapacity).toBe(true);
  });

  it("promotes the longest-waiting player when an override frees a slot", async () => {
    // The assertion this milestone most needs: an override touching M4's
    // waitlist behaviour must behave exactly as a self-response does.
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, waitlistedId } = await seedFullFixtureWithWaitlist(viewerId);

    await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "out" }, cookie);
    await settleNotifications(1);

    const db = testDb();
    const [promoted] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, waitlistedId)));
    expect(promoted?.status).toBe("in");
  });

  it("records the previous status when marking an `in` player out", async () => {
    // `p-0` starts `in` here, unlike the "writes an audit row naming the
    // previous status" case above (which starts `pending`, a state the
    // `?? "pending"` fallback would also produce if the read were broken or
    // misordered) — this is the case where reading the status *after* the
    // write, rather than before it, would wrongly capture `"out"`.
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFullFixtureOwnedBy(viewerId);

    // No waitlisted candidate exists on this fixture, so nothing is promoted
    // and there is no background send to drain.
    await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "out" }, cookie);

    const db = testDb();
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "fixture.response_overridden"));
    expect(JSON.parse(audit!.beforeJson!)).toEqual({ playerId: "p-0", status: "in" });
  });

  it("records the previous status when overriding a waitlisted player", async () => {
    // The third distinct prior state a real fixture produces (pending, in,
    // waitlisted) — and the one most likely to be got wrong by a future
    // refactor, since the waitlisted branch is the one place `setResponse`
    // decides `in` without going through the `full` check at all.
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, waitlistedId } = await seedFullFixtureWithWaitlist(viewerId);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/response/${waitlistedId}`,
      { intent: "in", override: "1" },
      cookie,
    );

    expect(response.status).toBe(303);
    const db = testDb();
    const [row] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, waitlistedId)));
    expect(row?.status).toBe("in");
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "fixture.response_overridden"));
    expect(JSON.parse(audit!.beforeJson!)).toEqual({ playerId: waitlistedId, status: "waitlisted" });
  });

  it("404s for a player who is not an owner", async () => {
    const { cookie, viewerId } = await ownerSession();
    const db = testDb();
    const strangerOwner = await insertPlayer(db);
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(strangerOwner);
    // The viewer is a real member of this game, just not an organiser of it.
    await insertMembership(db, gameId, viewerId);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "in" }, cookie);

    expect(response.status).toBe(404);
  });

  it("400s on an intent that is neither in nor out", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "maybe" }, cookie);

    expect(response.status).toBe(400);
  });

  it("403s a cross-site post", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/response/p-0`,
      { intent: "in" },
      cookie,
      "https://evil.example",
    );

    expect(response.status).toBe(403);
  });
});
