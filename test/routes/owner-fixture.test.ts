import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  auditLog,
  fixtureResultClaims,
  fixtures,
  memberships,
  notificationLog,
  players,
  responses,
} from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  insertResultClaim,
  playerRow,
  resetDatabase,
  testDb,
} from "../support/factories.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";
import { kickoffIn } from "../support/clock.js";

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
    kicksOffAt: kickoffIn(24 * 7),
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
 * A played fixture (M25) in a game owned by `ownerPlayerId`, with `p-0`
 * already `in` and having filed a claim for side "a" — so the organiser's
 * own page has a candidate to show and, since kickoff was only an hour ago,
 * the result window (`resultDeadline`) is still open to agree with.
 *
 * Deliberately does not give `ownerPlayerId` a `responses` row: an owner is
 * part of the electorate (`resultElectorate` counts every active owner)
 * whether or not they played, and a seed that gave them one would leave the
 * "an organiser who did not play can still agree" case untested.
 */
async function seedPlayedFixtureOwnedBy(ownerPlayerId: string): Promise<{ gameId: string; fixtureId: string }> {
  const db = testDb();
  const gameId = await insertGame(db, { maxPlayers: 14 });
  await insertMembership(db, gameId, ownerPlayerId, { role: "owner" });
  const memberPlayerId = await ensurePlayer(db, "p-0", "Player 0");
  await insertMembership(db, gameId, memberPlayerId);

  const fixtureId = await insertFixture(db, gameId, {
    lifecycle: "played",
    kicksOffAt: kickoffIn(-1),
  });
  await insertResponse(db, fixtureId, memberPlayerId, { status: "in" });
  await insertResultClaim(db, fixtureId, memberPlayerId, { outcome: "a" });

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
    kicksOffAt: kickoffIn(24 * 7),
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
    kicksOffAt: kickoffIn(24 * 7),
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
 * A game owned by `ownerPlayerId`, with one open fixture at `maxPlayers: 1`: a
 * guest already `in`, occupying the one slot, and a further real member
 * waitlisted behind them — so removing the guest is exactly the case that
 * must promote the waitlisted member (BR-7), the same way any other freed
 * slot does.
 *
 * The guest is added through `addGuest` directly (not the HTTP route) so this
 * seed produces the same shape `seedFullFixtureWithWaitlist` does, without a
 * second app round-trip the test itself doesn't care about.
 */
async function seedFullFixtureOwnedByWithGuestAndWaitlist(
  ownerPlayerId: string,
): Promise<{ gameId: string; fixtureId: string; waitlistedId: string }> {
  const db = testDb();
  const gameId = await insertGame(db, { maxPlayers: 1 });
  await insertMembership(db, gameId, ownerPlayerId, { role: "owner" });
  const waitlistedId = await insertPlayer(db, { name: "Waiting Player" });
  await insertMembership(db, gameId, waitlistedId);

  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: kickoffIn(24 * 7),
    minPlayers: 1,
    maxPlayers: 1,
    prefersEvenNumbers: false,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });
  await openFixture(db, fixtureId, NOW);

  const guestOutcome = await stubFor(fixtureId).addGuest({
    name: "Sam Whitlock",
    actorPlayerId: ownerPlayerId,
    whenFull: "refuse",
    now: NOW.getTime(),
  });
  if (guestOutcome.kind !== "added") throw new Error(`seed expected the guest to be added, got ${guestOutcome.kind}`);

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
    kicksOffAt: kickoffIn(24 * 7),
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

  it("gives a non-owner member the player page, not this owner page", async () => {
    const { cookie, viewerId } = await ownerSession();
    const db = testDb();
    const strangerOwner = await insertPlayer(db);
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(strangerOwner);
    // The viewer is a real member of this game, just not an organiser of it.
    await insertMembership(db, gameId, viewerId);

    const response = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } });

    // Since M25 this no longer 404s — it dispatches to the player page
    // instead (full coverage in test/routes/player-fixture.test.ts). This
    // asserts only that a non-owner member does not get *this* page: no
    // guest-management control, which only `renderOwnerFixturePage` emits.
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("Add a guest");
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

  it("shows a member's current answer in the segment that changes it", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);
    await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "in" }, cookie);

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    // The visual state must not be the only statement of it: a screen reader
    // user gets the same fact from aria-pressed, and a viewer who cannot see
    // colour gets it from the pressed styling plus the label.
    expect(html).toContain(`aria-pressed="true"`);
    expect(html).toMatch(/name="intent" value="in"[^>]*aria-pressed="true"/);
  });

  it("does not mark a control pressed for a member who has not answered", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    expect(html).not.toContain(`aria-pressed="true"`);
  });

  it("does not repeat a pending member's status beside their segment", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    // The segment's neither half pressed already reads as "no answer yet" —
    // nothing is lost by dropping the label the segment would otherwise repeat.
    expect(html).not.toContain(`<span class="status`);
    expect(html).not.toContain("Not yet responded");
  });

  it("does not repeat an in member's status beside their segment", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);
    await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "in" }, cookie);

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    // The segment's pressed In half plus aria-pressed already state this —
    // repeating it as a status span beside the control would be pure
    // duplication (M10 §3.3).
    expect(html).not.toContain(`<span class="status`);
  });

  it("still states a waitlisted member's rank beside their segment", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFullFixtureWithWaitlist(viewerId);

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    // The segment shows the waitlisted member's In half as pressed — correct,
    // they were marked in — but "In, pressed" and "In, but on the waitlist"
    // are different facts, and only this label carries which. A deliberate
    // exception to the "segment already says it" rule above, not an
    // oversight left over from before this task.
    expect(html).toContain(`class="status status-waitlisted"`);
    expect(html).toContain("Waitlisted");
    // Scoped to the waitlisted member's own name, so a passing test cannot be
    // the label having landed on the wrong row.
    expect(html).toMatch(/Waiting Player[\s\S]*?class="status status-waitlisted"/);
  });

  it("shows the result panel on a played fixture", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedPlayedFixtureOwnedBy(viewerId);

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    expect(html).toContain("<h2>Result</h2>");
  });

  it("shows no result panel on an open fixture", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    // An open fixture has nothing to have a result about, and Task 9's write
    // route 404s a claim posted to one — so no panel, not merely a blank one.
    expect(html).not.toContain("<h2>Result</h2>");
  });

  it("lets an organiser who did not play agree from their own page", async () => {
    const { cookie, viewerId } = await ownerSession();
    // `seedPlayedFixtureOwnedBy` deliberately gives the owner no `responses`
    // row — this is the case that tests, not the ordinary "organiser also
    // played" one.
    const { gameId, fixtureId } = await seedPlayedFixtureOwnedBy(viewerId);

    const page = await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    // `resultElectorate` counts every active owner as eligible whether or not
    // they played, so the Agree control on `p-0`'s filed claim must render
    // for this viewer.
    expect(html).toContain(">Agree<");

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/result`, { outcome: "a" }, cookie);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/g/${gameId}/f/${fixtureId}`);
    const db = testDb();
    const [row] = await db
      .select()
      .from(fixtureResultClaims)
      .where(and(eq(fixtureResultClaims.fixtureId, fixtureId), eq(fixtureResultClaims.playerId, viewerId)));
    expect(row).toMatchObject({ outcome: "a", scoreA: null, scoreB: null });
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
    expect(JSON.parse(row!.afterJson!)).toEqual({
      playerId: "p-0",
      status: "in",
      overCapacity: false,
      // M46: false here, not absent — a pending player marked in jumped
      // nobody's queue.
      fromWaitlist: false,
      waitlistRank: null,
    });
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

describe("guests", () => {
  beforeEach(resetDatabase);

  it("adds a guest who occupies a slot", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam Whitlock" }, cookie);

    expect(response.status).toBe(303);
    const db = testDb();
    const [guest] = await db.select().from(players).where(eq(players.isGuest, true));
    expect(guest).toMatchObject({ name: "Sam Whitlock", email: null });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.inCount).toBe(1);
  });

  it("gives the guest no membership", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam Whitlock" }, cookie);

    const db = testDb();
    const [guest] = await db.select().from(players).where(eq(players.isGuest, true));
    expect(await db.select().from(memberships).where(eq(memberships.playerId, guest!.id))).toEqual([]);
  });

  it("writes an audit row", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam Whitlock" }, cookie);

    const db = testDb();
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "fixture.guest_added"));
    expect(row).toMatchObject({ actorPlayerId: viewerId, entityType: "fixture", entityId: fixtureId });
    expect(JSON.parse(row!.afterJson!).name).toBe("Sam Whitlock");
  });

  it("refuses an empty name without creating anybody", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "  " }, cookie);

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Give your guest a name");
    const db = testDb();
    expect(await db.select().from(players).where(eq(players.isGuest, true))).toEqual([]);
  });

  it("asks before adding a guest over capacity", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFullFixtureOwnedBy(viewerId);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam Whitlock" }, cookie);

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Add them anyway");
    const db = testDb();
    expect(await db.select().from(players).where(eq(players.isGuest, true))).toEqual([]);
  });

  it("adds the guest over capacity once confirmed", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedFullFixtureOwnedBy(viewerId);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/guest`,
      { name: "Sam Whitlock", override: "1" },
      cookie,
    );

    expect(response.status).toBe(303);
    const db = testDb();
    expect((await db.select().from(players).where(eq(players.isGuest, true))).length).toBe(1);
  });

  it("removes a guest and frees their slot", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);
    await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam Whitlock" }, cookie);
    const db = testDb();
    const [guest] = await db.select().from(players).where(eq(players.isGuest, true));

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/guest/${guest!.id}/remove`, {}, cookie);

    expect(response.status).toBe(303);
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.inCount).toBe(0);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "fixture.guest_removed"));
    expect(JSON.parse(audit!.beforeJson!).name).toBe("Sam Whitlock");
  });

  it("refuses to remove a squad member through the guest route", async () => {
    // `p-0` is a real member, not a guest. The guest route must not become a
    // second, unconfirmed way to remove people from a squad.
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/guest/p-0/remove`, {}, cookie);

    expect(response.status).toBe(404);
  });

  it("refuses to remove a guest seated on a different fixture", async () => {
    // `players.isGuest` is global; the guest's attachment to a *fixture*
    // lives only in `responses`. Naming a real guest, but on a fixture they
    // are not seated on, must 404 rather than silently no-op into a 303.
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);
    await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam Whitlock" }, cookie);
    const db = testDb();
    const [guest] = await db.select().from(players).where(eq(players.isGuest, true));

    // The same owner's second game — the point is that the guest isn't on
    // this fixture, not that the owner lacks access to it.
    const other = await seedOpenFixtureOwnedBy(viewerId);

    const response = await appPost(`/g/${other.gameId}/f/${other.fixtureId}/guest/${guest!.id}/remove`, {}, cookie);

    expect(response.status).toBe(404);
    const [row] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, guest!.id)));
    expect(row?.status).toBe("in");
  });

  it("promotes a waitlisted player when a guest is removed", async () => {
    // The route wiring, not the Durable Object's promotion logic (already
    // unit-tested) or the override path's already-tested wiring — this is
    // the assertion that *this* route's `withdrawMember` call actually
    // promotes and sends exactly one N-2.
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, waitlistedId } = await seedFullFixtureOwnedByWithGuestAndWaitlist(viewerId);
    const db = testDb();
    const [guest] = await db.select().from(players).where(eq(players.isGuest, true));

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/guest/${guest!.id}/remove`, {}, cookie);
    await settleNotifications(1);

    expect(response.status).toBe(303);
    const [promoted] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, waitlistedId)));
    expect(promoted?.status).toBe("in");
    const sent = await db.select().from(notificationLog).where(eq(notificationLog.playerId, waitlistedId));
    expect(sent.length).toBe(1);
  });

  it("404s for a player who is not an owner", async () => {
    const { cookie, viewerId } = await ownerSession();
    const db = testDb();
    const strangerOwner = await insertPlayer(db);
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(strangerOwner);
    // The viewer is a real member of this game, just not an organiser of it.
    await insertMembership(db, gameId, viewerId);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam" }, cookie);

    expect(response.status).toBe(404);
  });

  it("403s a cross-site post", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);

    const response = await appPost(
      `/g/${gameId}/f/${fixtureId}/guest`,
      { name: "Sam" },
      cookie,
      "https://evil.example",
    );

    expect(response.status).toBe(403);
  });
});

/**
 * A fixture that has stopped taking changes still shows its squad — that is
 * the record of who played, or who was going to — but the controls that would
 * change it are gone, and a hand-built post to one of them is refused rather
 * than answered as success.
 */
describe("a fixture that is no longer taking changes", () => {
  beforeEach(resetDatabase);

  /** An open fixture with a member in and a guest added, then cancelled. */
  async function seedCancelledWithGuest(
    ownerPlayerId: string,
    cookie: string,
  ): Promise<{ gameId: string; fixtureId: string; guestId: string }> {
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(ownerPlayerId);
    await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "in" }, cookie);
    await appPost(`/g/${gameId}/f/${fixtureId}/guest`, { name: "Sam Whitlock" }, cookie);
    const db = testDb();
    const [guest] = await db.select().from(players).where(eq(players.isGuest, true));
    await db.update(fixtures).set({ lifecycle: "cancelled" }).where(eq(fixtures.id, fixtureId));
    return { gameId, fixtureId, guestId: guest!.id };
  }

  it("still shows the squad, without any controls", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedCancelledWithGuest(viewerId, cookie);

    const html = await (await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })).text();

    // Everyone and their state still render.
    expect(html).toContain("Player 0");
    expect(html).toContain("Sam Whitlock");
    // Nothing left to act with.
    expect(html).not.toContain("Mark in");
    expect(html).not.toContain("Mark out");
    expect(html).not.toContain(">Remove<");
    expect(html).not.toContain("Add a guest");
  });

  it("refuses a hand-built guest removal instead of answering as success", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId, guestId } = await seedCancelledWithGuest(viewerId, cookie);

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/guest/${guestId}/remove`, {}, cookie);

    expect(response.status).toBe(422);
    expect(await response.text()).toContain("isn&#39;t taking changes any more");
    const db = testDb();
    const [row] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, guestId)));
    expect(row?.status).toBe("in");
    expect((await db.select().from(auditLog).where(eq(auditLog.action, "fixture.guest_removed"))).length).toBe(0);
  });
});

/**
 * A player an organiser has removed is not eligible to be answered for, so
 * the override route cannot quietly put them back into the fixture.
 */
describe("an override for a removed player", () => {
  beforeEach(resetDatabase);

  it("404s and leaves the removal standing", async () => {
    const { cookie, viewerId } = await ownerSession();
    const { gameId, fixtureId } = await seedOpenFixtureOwnedBy(viewerId);
    await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "in" }, cookie);
    await stubFor(fixtureId).withdrawMember({
      playerId: "p-0",
      actorPlayerId: viewerId,
      now: NOW.getTime(),
    });

    const response = await appPost(`/g/${gameId}/f/${fixtureId}/response/p-0`, { intent: "in" }, cookie);

    expect(response.status).toBe(404);
    const db = testDb();
    const [row] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, "p-0")));
    expect(row?.status).toBe("withdrawn");
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.inCount).toBe(0);
  });
});
