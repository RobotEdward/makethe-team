import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, memberships, responses } from "../../src/db/schema.js";
import { removeMember } from "../../src/domain/remove-member.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
  testDb,
} from "../support/factories.js";

const NOW = new Date("2026-08-13T12:00:00Z");

/** The real Durable Object, addressed the way the route will address it. */
const withdraw = (fixtureId: string) =>
  env.FIXTURE_CAPACITY.getByName(fixtureId).withdrawMember({
    playerId: CURRENT_PLAYER,
    actorPlayerId: CURRENT_ACTOR,
    now: NOW.getTime(),
  });

let CURRENT_PLAYER = "";
let CURRENT_ACTOR = "";

async function remove(gameId: string, playerId: string, actorPlayerId: string) {
  CURRENT_PLAYER = playerId;
  CURRENT_ACTOR = actorPlayerId;
  return removeMember({ db: testDb(), gameId, playerId, actorPlayerId, now: NOW, withdraw });
}

describe("removeMember", () => {
  beforeEach(resetDatabase);

  it("deactivates the membership and audits it", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const owner = await insertPlayer(db);
    const player = await insertPlayer(db);
    await insertMembership(db, gameId, owner, { role: "owner" });
    const membershipId = await insertMembership(db, gameId, player);

    const result = await remove(gameId, player, owner);

    expect(result).toMatchObject({ kind: "removed", membershipId, leftAt: NOW, promotions: [] });
    const [row] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
    expect(row).toMatchObject({ active: false, leftAt: NOW });

    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.removed"));
    expect(audit).toMatchObject({ actorPlayerId: owner, entityType: "membership", entityId: membershipId });
    expect(JSON.parse(audit!.beforeJson!)).toMatchObject({ active: true });
    expect(JSON.parse(audit!.afterJson!)).toMatchObject({ active: false });
  });

  it("applies BR-3 to every open fixture and reports each promotion", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const owner = await insertPlayer(db);
    const player = await insertPlayer(db);
    const waiter = await insertPlayer(db);
    await insertMembership(db, gameId, owner, { role: "owner" });
    await insertMembership(db, gameId, player);

    const a = await insertFixture(db, gameId, { lifecycle: "open", maxPlayers: 1, inCount: 1, waitlistCount: 1 });
    const b = await insertFixture(db, gameId, {
      lifecycle: "open",
      inCount: 1,
      kicksOffAt: new Date("2026-08-27T18:00:00Z"),
    });
    const scheduled = await insertFixture(db, gameId, {
      lifecycle: "scheduled",
      kicksOffAt: new Date("2026-09-03T18:00:00Z"),
    });
    await insertResponse(db, a, player, { status: "in" });
    await insertResponse(db, a, waiter, { status: "waitlisted", waitlistPosition: 3 });
    await insertResponse(db, b, player, { status: "pending" });

    const result = await remove(gameId, player, owner);

    expect(result).toMatchObject({
      kind: "removed",
      promotions: [{ fixtureId: a, promoted: { playerId: waiter, previousWaitlistPosition: 3 } }],
    });
    const rows = await db.select().from(responses).where(eq(responses.playerId, player));
    // The `in` row became `withdrawn`; the `pending` row is gone; the
    // `scheduled` fixture never had a row to begin with (BR-1).
    expect(rows.map((row) => row.status)).toEqual(["withdrawn"]);
    expect(rows[0]!.fixtureId).toBe(a);
    expect(scheduled).toBeDefined();
  });

  it("touches only the target game's fixtures", async () => {
    const db = testDb();
    const owner = await insertPlayer(db);
    const player = await insertPlayer(db);
    const target = await insertGame(db);
    const other = await insertGame(db);
    await insertMembership(db, target, owner, { role: "owner" });
    await insertMembership(db, target, player);
    await insertMembership(db, other, player);
    const mine = await insertFixture(db, target, { lifecycle: "open", inCount: 1 });
    const theirs = await insertFixture(db, other, { lifecycle: "open", inCount: 1 });
    await insertResponse(db, mine, player, { status: "in" });
    await insertResponse(db, theirs, player, { status: "in" });

    await remove(target, player, owner);

    const [untouched] = await db.select().from(responses).where(eq(responses.fixtureId, theirs));
    // Removal from one squad must not disturb the same person's place in
    // another. A `listOpenFixtureIds` that lost its gameId filter fails here.
    expect(untouched).toMatchObject({ status: "in" });
    const [stillAMember] = await db.select().from(memberships).where(eq(memberships.gameId, other));
    expect(stillAMember!.active).toBe(true);
  });

  it("refuses to remove the last active owner", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const owner = await insertPlayer(db);
    const membershipId = await insertMembership(db, gameId, owner, { role: "owner" });

    expect(await remove(gameId, owner, owner)).toEqual({ kind: "refused", reason: "last-owner" });
    const [row] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
    expect(row!.active).toBe(true);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("allows an owner to remove themselves when a co-owner remains", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const leaving = await insertPlayer(db);
    const staying = await insertPlayer(db);
    await insertMembership(db, gameId, leaving, { role: "owner" });
    await insertMembership(db, gameId, staying, { role: "owner" });

    expect(await remove(gameId, leaving, leaving)).toMatchObject({ kind: "removed" });
  });

  it("reports a player who is not in this squad", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    expect(await remove(gameId, await insertPlayer(db), await insertPlayer(db))).toEqual({ kind: "not-a-member" });
  });

  it("reports an already-inactive membership as not-a-member", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const player = await insertPlayer(db);
    await insertMembership(db, gameId, player, { active: false });

    expect(await remove(gameId, player, await insertPlayer(db))).toEqual({ kind: "not-a-member" });
  });
});
