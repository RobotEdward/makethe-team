import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, memberships, responses } from "../../src/db/schema.js";
import { joinSquad } from "../../src/domain/join-squad.js";
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

  it("demotes an organiser it removes, and records the role change", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const staying = await insertPlayer(db);
    const leaving = await insertPlayer(db);
    await insertMembership(db, gameId, staying, { role: "owner" });
    const membershipId = await insertMembership(db, gameId, leaving, { role: "owner" });

    await remove(gameId, leaving, staying);

    const [row] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
    // `active: false` alone leaves `owner` on the row for `joinSquad` to
    // reactivate, which is how a removed organiser walked back in as one.
    expect(row).toMatchObject({ active: false, role: "player" });

    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.removed"));
    expect(JSON.parse(audit!.beforeJson!)).toMatchObject({ role: "owner" });
    expect(JSON.parse(audit!.afterJson!)).toMatchObject({ role: "player" });
  });

  /**
   * The whole point of finding 1: this is the *real* path, driven through both
   * modules rather than by seeding an inactive `owner` row by hand — which
   * would prove only that `joinSquad` handles a state `removeMember` no longer
   * produces.
   */
  it("a removed organiser who rejoins through the invite link comes back as a player", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const staying = await insertPlayer(db);
    const leaving = await insertPlayer(db, { email: "ada@example.com" });
    await insertMembership(db, gameId, staying, { role: "owner" });
    await insertMembership(db, gameId, leaving, { role: "owner" });

    await remove(gameId, leaving, staying);

    const outcome = await joinSquad({
      db,
      gameId,
      name: "Ada Byron",
      email: "Ada@Example.com",
      now: new Date("2026-08-14T12:00:00Z"),
    });
    expect(outcome.kind).toBe("rejoined");

    const [row] = await db.select().from(memberships).where(eq(memberships.playerId, leaving));
    expect(row).toMatchObject({ active: true, role: "player" });
  });

  it("resumes a removal whose fixture loop did not finish, without a second audit row", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const owner = await insertPlayer(db);
    const player = await insertPlayer(db);
    await insertMembership(db, gameId, owner, { role: "owner" });
    const leftAt = new Date("2026-08-13T11:00:00Z");
    // The state a failed removal leaves: membership out, response row stale.
    const membershipId = await insertMembership(db, gameId, player, { active: false, leftAt });
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open", inCount: 1 });
    await insertResponse(db, fixtureId, player, { status: "in" });

    const result = await remove(gameId, player, owner);

    expect(result).toMatchObject({ kind: "resumed", membershipId, promotions: [] });
    // The original `left_at`, not `now`. N-7's dedupe key is built from it, so
    // re-running must produce the same key and therefore no second email.
    expect((result as { leftAt: Date }).leftAt).toEqual(leftAt);
    const [row] = await db.select().from(responses).where(eq(responses.playerId, player));
    expect(row!.status).toBe("withdrawn");
    // Nothing was re-written, so nothing is re-audited.
    expect(await db.select().from(auditLog)).toHaveLength(0);
    const [membership] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
    expect(membership).toMatchObject({ active: false, leftAt });
  });

  it("reports a player who was never in this squad as not-a-member, unlike one who left", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    expect(await remove(gameId, await insertPlayer(db), await insertPlayer(db))).toEqual({ kind: "not-a-member" });
  });
});
