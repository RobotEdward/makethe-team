import { SELF, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, players, responses } from "../../src/db/schema.js";
import { ALLOWED, ORIGIN, signIn } from "../support/sign-in.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  resetDatabase,
  insertResponse,
} from "../support/factories.js";
import { kickoffIn } from "../support/clock.js";

const db = getDb(env.DB);

function appPost(path: string, fields: Record<string, string>, cookie: string) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
}

/**
 * A full, open fixture (one place, taken) with one player waiting behind it —
 * the only state anybody is ever waitlisted in, since BR-7 promotes the queue
 * the moment a slot frees.
 */
async function fullFixtureWithAWaitlist() {
  const { cookie } = await signIn();
  const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
  const ownerId = viewer!.id;

  const gameId = await insertGame(db, { minPlayers: 1, maxPlayers: 1 });
  await insertMembership(db, gameId, ownerId, { role: "owner" });
  const holderId = await insertPlayer(db, { name: "Holds The Slot", email: "holder@example.com" });
  await insertMembership(db, gameId, holderId, { role: "player" });
  const waiterId = await insertPlayer(db, { name: "Wait Ing", email: "waiter@example.com" });
  await insertMembership(db, gameId, waiterId, { role: "player" });

  const fixtureId = await insertFixture(db, gameId, {
    kicksOffAt: kickoffIn(48),
    lifecycle: "open",
    minPlayers: 1,
    maxPlayers: 1,
    inCount: 1,
    waitlistCount: 1,
  });
  await insertResponse(db, fixtureId, ownerId, { status: "out" });
  await insertResponse(db, fixtureId, holderId, { status: "in" });
  await insertResponse(db, fixtureId, waiterId, { status: "waitlisted", waitlistPosition: 1 });

  return { cookie, ownerId, gameId, fixtureId, waiterId, holderId };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("promoting a waitlisted player by hand (BR-6, BR-8)", () => {
  it("offers Promote on a waitlisted row rather than an In that reads as pressed", async () => {
    const { cookie, gameId, fixtureId } = await fullFixtureWithAWaitlist();

    const html = await (
      await SELF.fetch(`${ORIGIN}/g/${gameId}/f/${fixtureId}`, { headers: { cookie } })
    ).text();

    expect(html).toContain(">Promote<");
    // The rank still has to be on the row: "Promote" says what the button
    // does, not where in the queue this player is.
    expect(html).toContain("Waitlisted (1st)");
  });

  it("asks before jumping the queue into a full fixture, then records that it did", async () => {
    const { cookie, ownerId, gameId, fixtureId, waiterId } = await fullFixtureWithAWaitlist();

    // Every waitlisted player is behind a full fixture, so a promotion is
    // always BR-8's deliberate over-capacity act. The first press asks.
    const asked = await appPost(`/g/${gameId}/f/${fixtureId}/response/${waiterId}`, { intent: "in" }, cookie);
    expect(asked.status).toBe(422);
    expect(await asked.text()).toContain("Add them anyway");

    const done = await appPost(
      `/g/${gameId}/f/${fixtureId}/response/${waiterId}`,
      { intent: "in", override: "1" },
      cookie,
    );
    expect(done.status).toBe(303);

    const [row] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, waiterId)));
    expect(row?.status).toBe("in");

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, fixtureId), eq(auditLog.action, "fixture.response_overridden")));
    expect(audit?.actorPlayerId).toBe(ownerId);
    // Without this the row is indistinguishable from marking a pending player
    // in, and the trail cannot show that somebody was moved past the queue.
    expect(JSON.parse(audit?.afterJson ?? "{}")).toMatchObject({
      playerId: waiterId,
      status: "in",
      overCapacity: true,
      fromWaitlist: true,
      waitlistRank: 1,
    });
  });

  it("does not claim a promotion when the owner marks a pending player in", async () => {
    const { cookie } = await signIn();
    const [viewer] = await db.select().from(players).where(eq(players.email, ALLOWED));
    const gameId = await insertGame(db, { minPlayers: 1, maxPlayers: 4 });
    await insertMembership(db, gameId, viewer!.id, { role: "owner" });
    const memberId = await insertPlayer(db, { name: "Pend Ing", email: "pending@example.com" });
    await insertMembership(db, gameId, memberId, { role: "player" });
    const fixtureId = await insertFixture(db, gameId, { kicksOffAt: kickoffIn(48), lifecycle: "open", maxPlayers: 4 });
    await insertResponse(db, fixtureId, memberId, { status: "pending" });

    await appPost(`/g/${gameId}/f/${fixtureId}/response/${memberId}`, { intent: "in" }, cookie);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, fixtureId), eq(auditLog.action, "fixture.response_overridden")));
    const after = JSON.parse(audit?.afterJson ?? "{}");
    expect(after.fromWaitlist).toBe(false);
    expect(after.waitlistRank).toBeNull();
  });
});
