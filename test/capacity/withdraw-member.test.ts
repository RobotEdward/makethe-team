import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { fixtures, responses } from "../../src/db/schema.js";
import { insertFixture, insertGame, insertPlayer, insertResponse, resetDatabase, testDb } from "../support/factories.js";

const NOW = new Date("2026-08-13T12:00:00Z");
const OWNER = "owner-player-id";

function withdraw(fixtureId: string, playerId: string) {
  return env.FIXTURE_CAPACITY.getByName(fixtureId).withdrawMember({
    playerId,
    actorPlayerId: OWNER,
    now: NOW.getTime(),
  });
}

async function rowFor(fixtureId: string, playerId: string) {
  const [row] = await testDb()
    .select()
    .from(responses)
    .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
  return row ?? null;
}

describe("FixtureCapacity.withdrawMember", () => {
  beforeEach(async () => {
    await resetDatabase();
    // `setByPlayerId` has a foreign key on `players.id`, so the actor
    // recorded on a `withdrawn` row must itself be a real player row.
    await insertPlayer(testDb(), { id: OWNER });
  });

  it("turns an `in` row into `withdrawn` and frees the slot", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open", inCount: 1 });
    const playerId = await insertPlayer(db);
    await insertResponse(db, fixtureId, playerId, { status: "in" });

    const outcome = await withdraw(fixtureId, playerId);

    expect(outcome).toMatchObject({ kind: "removed", previousStatus: "in", inCount: 0 });
    const row = await rowFor(fixtureId, playerId);
    // `withdrawn`, never `out` — a leaver is never recorded as a decline (§1.5).
    expect(row).toMatchObject({ status: "withdrawn", setByPlayerId: OWNER, source: "owner" });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture!.inCount).toBe(0);
  });

  it("deletes a `pending` row", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), { lifecycle: "open" });
    const playerId = await insertPlayer(db);
    await insertResponse(db, fixtureId, playerId, { status: "pending" });

    expect(await withdraw(fixtureId, playerId)).toMatchObject({ kind: "removed", previousStatus: "pending" });
    expect(await rowFor(fixtureId, playerId)).toBeNull();
  });

  it("deletes an `out` row, so an ex-member never shows as having declined", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), { lifecycle: "open" });
    const playerId = await insertPlayer(db);
    await insertResponse(db, fixtureId, playerId, { status: "out" });

    // §3.1: BR-3 does not name this case; the spec's decision is to delete it.
    expect(await withdraw(fixtureId, playerId)).toMatchObject({ kind: "removed", previousStatus: "out" });
    expect(await rowFor(fixtureId, playerId)).toBeNull();
  });

  it("deletes a `waitlisted` row without promoting anyone", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), {
      lifecycle: "open",
      maxPlayers: 1,
      inCount: 1,
      waitlistCount: 1,
    });
    const holder = await insertPlayer(db);
    const waiter = await insertPlayer(db);
    await insertResponse(db, fixtureId, holder, { status: "in" });
    await insertResponse(db, fixtureId, waiter, { status: "waitlisted", waitlistPosition: 1 });

    const outcome = await withdraw(fixtureId, waiter);

    // No slot was freed, so nobody moves.
    expect(outcome).toMatchObject({ kind: "removed", previousStatus: "waitlisted", inCount: 1 });
    expect("promoted" in outcome && outcome.promoted).toBeFalsy();
    expect(await rowFor(fixtureId, holder)).toMatchObject({ status: "in" });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture!.waitlistCount).toBe(0);
  });

  it("promotes the longest-waiting player when an `in` row gives up its slot", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), {
      lifecycle: "open",
      maxPlayers: 1,
      inCount: 1,
      waitlistCount: 2,
    });
    const leaving = await insertPlayer(db);
    const first = await insertPlayer(db);
    const second = await insertPlayer(db);
    await insertResponse(db, fixtureId, leaving, { status: "in" });
    // Position 5 is *lower* than 9 and therefore the earlier arrival — the
    // positions are gappy, so "longest waiting" is the lowest live number and
    // never the smallest index or the first row returned.
    await insertResponse(db, fixtureId, first, { status: "waitlisted", waitlistPosition: 5 });
    await insertResponse(db, fixtureId, second, { status: "waitlisted", waitlistPosition: 9 });

    const outcome = await withdraw(fixtureId, leaving);

    expect(outcome).toMatchObject({
      kind: "removed",
      previousStatus: "in",
      inCount: 1,
      promoted: { playerId: first, previousWaitlistPosition: 5, promotedAt: NOW.getTime() },
    });
    expect(await rowFor(fixtureId, first)).toMatchObject({ status: "in", waitlistPosition: null, source: "system" });
    expect(await rowFor(fixtureId, second)).toMatchObject({ status: "waitlisted", waitlistPosition: 9 });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture!.inCount).toBe(1);
    expect(fixture!.waitlistCount).toBe(1);
  });

  it("is a no-op on a second call", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), { lifecycle: "open", inCount: 1 });
    const playerId = await insertPlayer(db);
    await insertResponse(db, fixtureId, playerId, { status: "in" });

    await withdraw(fixtureId, playerId);
    // Idempotence is what makes a partly-failed removal safe to retry (§3.3).
    // The `withdrawn` row is not a row to act on again.
    expect(await withdraw(fixtureId, playerId)).toEqual({ kind: "no-op", reason: "no-response-row" });
  });

  it("is a no-op for a player with no row", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), { lifecycle: "open" });
    expect(await withdraw(fixtureId, await insertPlayer(db))).toEqual({
      kind: "no-op",
      reason: "no-response-row",
    });
  });

  it("is a no-op on a scheduled fixture", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), { lifecycle: "scheduled" });
    expect(await withdraw(fixtureId, await insertPlayer(db))).toEqual({
      kind: "no-op",
      reason: "fixture-not-open",
    });
  });

  it("is a no-op on a cancelled fixture, so history is never rewritten", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "cancelled", inCount: 1 });
    const playerId = await insertPlayer(db);
    await insertResponse(db, fixtureId, playerId, { status: "in" });

    expect(await withdraw(fixtureId, playerId)).toEqual({ kind: "no-op", reason: "fixture-not-open" });
    expect(await rowFor(fixtureId, playerId)).toMatchObject({ status: "in" });
  });

  it("is a no-op for a fixture that does not exist", async () => {
    expect(await withdraw(crypto.randomUUID(), crypto.randomUUID())).toEqual({
      kind: "no-op",
      reason: "fixture-not-found",
    });
  });

  it("touches only the addressed fixture", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const target = await insertFixture(db, gameId, { lifecycle: "open", inCount: 1 });
    const other = await insertFixture(db, gameId, {
      lifecycle: "open",
      inCount: 1,
      kicksOffAt: new Date("2026-08-27T18:00:00Z"),
    });
    const playerId = await insertPlayer(db);
    await insertResponse(db, target, playerId, { status: "in" });
    await insertResponse(db, other, playerId, { status: "in" });

    await withdraw(target, playerId);

    expect(await rowFor(other, playerId)).toMatchObject({ status: "in" });
  });
});

/**
 * An organiser can put a fixture over its limit deliberately (BR-8). While it
 * is over there is no spare place to hand on, so a removal returns the fixture
 * towards its limit rather than promoting — including the removal of the very
 * guest who was squeezed in, which must be undoable.
 */
describe("FixtureCapacity.withdrawMember while over capacity", () => {
  beforeEach(async () => {
    await resetDatabase();
    await insertPlayer(testDb(), { id: OWNER });
  });

  it("promotes nobody when removing a member only brings the fixture back to its limit", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), {
      lifecycle: "open",
      maxPlayers: 2,
      inCount: 3,
      waitlistCount: 1,
    });
    const leaving = await insertPlayer(db);
    const held = [await insertPlayer(db), await insertPlayer(db)];
    const waiter = await insertPlayer(db);
    await insertResponse(db, fixtureId, leaving, { status: "in" });
    for (const playerId of held) await insertResponse(db, fixtureId, playerId, { status: "in" });
    await insertResponse(db, fixtureId, waiter, { status: "waitlisted", waitlistPosition: 1 });

    const outcome = await withdraw(fixtureId, leaving);

    expect(outcome).toMatchObject({ kind: "removed", previousStatus: "in", inCount: 2 });
    expect("promoted" in outcome && outcome.promoted).toBeFalsy();
    expect(await rowFor(fixtureId, waiter)).toMatchObject({ status: "waitlisted", waitlistPosition: 1 });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture!.inCount).toBe(2);
    expect(fixture!.waitlistCount).toBe(1);
  });

  it("lets an organiser undo a guest they added over capacity", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), {
      lifecycle: "open",
      maxPlayers: 2,
      inCount: 2,
      waitlistCount: 1,
    });
    const held = [await insertPlayer(db), await insertPlayer(db)];
    const waiter = await insertPlayer(db);
    for (const playerId of held) await insertResponse(db, fixtureId, playerId, { status: "in" });
    await insertResponse(db, fixtureId, waiter, { status: "waitlisted", waitlistPosition: 1 });

    const added = await env.FIXTURE_CAPACITY.getByName(fixtureId).addGuest({
      name: "Sam",
      actorPlayerId: OWNER,
      whenFull: "exceed",
      now: NOW.getTime(),
    });
    expect(added).toMatchObject({ kind: "added", inCount: 3 });
    const guestId = added.kind === "added" ? added.playerId : "";

    const outcome = await withdraw(fixtureId, guestId);

    // Removing the guest gives the place back to the fixture, not to the
    // waitlist — otherwise the override could never be undone.
    expect(outcome).toMatchObject({ kind: "removed", previousStatus: "in", inCount: 2 });
    expect("promoted" in outcome && outcome.promoted).toBeFalsy();
    expect(await rowFor(fixtureId, waiter)).toMatchObject({ status: "waitlisted", waitlistPosition: 1 });
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture!.inCount).toBe(2);
  });

  it("still promotes when the fixture was exactly at its limit", async () => {
    const db = testDb();
    const fixtureId = await insertFixture(db, await insertGame(db), {
      lifecycle: "open",
      maxPlayers: 2,
      inCount: 2,
      waitlistCount: 1,
    });
    const leaving = await insertPlayer(db);
    const other = await insertPlayer(db);
    const waiter = await insertPlayer(db);
    await insertResponse(db, fixtureId, leaving, { status: "in" });
    await insertResponse(db, fixtureId, other, { status: "in" });
    await insertResponse(db, fixtureId, waiter, { status: "waitlisted", waitlistPosition: 1 });

    const outcome = await withdraw(fixtureId, leaving);

    // The gate narrows BR-7 to over-capacity fixtures only; at the limit the
    // longest waiting player takes the freed place exactly as before.
    expect(outcome).toMatchObject({
      kind: "removed",
      inCount: 2,
      promoted: { playerId: waiter, previousWaitlistPosition: 1 },
    });
    expect(await rowFor(fixtureId, waiter)).toMatchObject({ status: "in", waitlistPosition: null });
  });
});
