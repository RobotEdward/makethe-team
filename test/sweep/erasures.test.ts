import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, players } from "../../src/db/schema.js";
import { ERASED_NAME } from "../../src/domain/erase-player.js";
import { runDueErasures } from "../../src/sweep/erasures.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  resetDatabase,
  testDb,
} from "../support/factories.js";

const db = testDb();
const NOW = new Date("2026-08-17T09:00:00Z");
const HOUR_MS = 3_600_000;

/**
 * Nobody in these tests has an open fixture, so the factory must never be
 * asked for a withdrawal. A throwing default means a test that accidentally
 * grows a fixture fails loudly here rather than silently exercising a
 * different path than it claims to.
 */
const noWithdraw = () => async () => {
  throw new Error("withdraw should not have been called");
};

async function playerRowOf(playerId: string) {
  const [row] = await db.select().from(players).where(eq(players.id, playerId));
  return row;
}

beforeEach(resetDatabase);

describe("runDueErasures", () => {
  it("erases a player whose window has elapsed", async () => {
    const playerId = await insertPlayer(db, {
      name: "Edward Cooper",
      email: "edward@example.test",
      erasesAt: new Date(NOW.getTime() - HOUR_MS),
    });

    const result = await runDueErasures(db, NOW, noWithdraw);

    expect(result).toEqual({ erased: 1, blocked: 0, blockedPlayers: [], failures: [], promotions: [] });
    const row = await playerRowOf(playerId);
    expect(row?.name).toBe(ERASED_NAME);
    expect(row?.email).toBeNull();
    expect(row?.erasedAt?.getTime()).toBe(NOW.getTime());
  });

  it("leaves a player whose window has not yet elapsed alone", async () => {
    const playerId = await insertPlayer(db, {
      name: "Edward Cooper",
      email: "edward@example.test",
      erasesAt: new Date(NOW.getTime() + HOUR_MS),
    });

    const result = await runDueErasures(db, NOW, noWithdraw);

    expect(result).toEqual({ erased: 0, blocked: 0, blockedPlayers: [], failures: [], promotions: [] });
    const row = await playerRowOf(playerId);
    expect(row?.name).toBe("Edward Cooper");
    expect(row?.erasedAt).toBeNull();
  });

  it("never touches a player who has not asked at all", async () => {
    const playerId = await insertPlayer(db, { name: "Edward Cooper", email: "edward@example.test" });

    const result = await runDueErasures(db, NOW, noWithdraw);

    expect(result.erased).toBe(0);
    const row = await playerRowOf(playerId);
    expect(row?.name).toBe("Edward Cooper");
    expect(row?.erasesAt).toBeNull();
    expect(row?.erasedAt).toBeNull();
  });

  // An `erased_at` that is already set means the work is done. Selecting the
  // row again would re-run `erasePlayer` every hour forever, and each run
  // would write a second `player.erased` audit row asserting an erasure that
  // never happened.
  it("does not re-erase a player who is already erased", async () => {
    const playerId = await insertPlayer(db, {
      name: ERASED_NAME,
      email: null,
      erasesAt: new Date(NOW.getTime() - 2 * HOUR_MS),
      erasedAt: new Date(NOW.getTime() - HOUR_MS),
    });

    const result = await runDueErasures(db, NOW, noWithdraw);

    expect(result).toEqual({ erased: 0, blocked: 0, blockedPlayers: [], failures: [], promotions: [] });
    const row = await playerRowOf(playerId);
    expect(row?.erasedAt?.getTime()).toBe(NOW.getTime() - HOUR_MS);
    const audit = await db.select().from(auditLog).where(eq(auditLog.entityId, playerId));
    expect(audit).toHaveLength(0);
  });

  // Becoming a game's last active organiser between requesting erasure and the
  // window elapsing is a handover the player still has to do — not a fault.
  // The request stays pending so the next run picks it up unchanged.
  it("counts a blocked player as blocked, not failed, and leaves the request pending", async () => {
    const erasesAt = new Date(NOW.getTime() - HOUR_MS);
    const playerId = await insertPlayer(db, { name: "Edward Cooper", email: "edward@example.test", erasesAt });
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, playerId, { role: "owner" });

    const result = await runDueErasures(db, NOW, noWithdraw);

    expect(result.blocked).toBe(1);
    expect(result.erased).toBe(0);
    expect(result.failures).toEqual([]);
    // Named as well as counted. A bare count told an operator that somebody
    // was stuck and gave them no way to find out who, on the one path where
    // being stuck is otherwise invisible to everyone but the person it
    // happens to.
    expect(result.blockedPlayers).toEqual([{ playerId, gameIds: [gameId] }]);
    const row = await playerRowOf(playerId);
    expect(row?.name).toBe("Edward Cooper");
    expect(row?.erasesAt?.getTime()).toBe(erasesAt.getTime());
    expect(row?.erasedAt).toBeNull();
  });

  // The failure this whole module is shaped around: one player's erasure
  // throwing must not deny every other player theirs.
  it("keeps going when one player's erasure throws", async () => {
    const erasesAt = new Date(NOW.getTime() - HOUR_MS);
    const doomedId = await insertPlayer(db, { name: "Doomed Dave", email: "dave@example.test", erasesAt });
    const healthyId = await insertPlayer(db, { name: "Healthy Hana", email: "hana@example.test", erasesAt });

    // Both players sit in a squad with an open fixture, so both reach the
    // withdraw callback; only the first player's rejects.
    const gameId = await insertGame(db);
    const otherOwnerId = await insertPlayer(db, { email: "owner@example.test" });
    await insertMembership(db, gameId, otherOwnerId, { role: "owner" });
    await insertMembership(db, gameId, doomedId);
    await insertMembership(db, gameId, healthyId);
    await insertFixture(db, gameId, { lifecycle: "open" });

    const withdrawnBy: string[] = [];
    const withdraw = (playerId: string) => async () => {
      if (playerId === doomedId) throw new Error("capacity object unreachable");
      withdrawnBy.push(playerId);
      return { kind: "no-op", reason: "no-response-row" } as const;
    };

    const result = await runDueErasures(db, NOW, withdraw);

    expect(result.erased).toBe(1);
    expect(result.blocked).toBe(0);
    expect(result.failures).toEqual([
      { playerId: doomedId, message: "capacity object unreachable" },
    ]);

    // The healthy player is fully erased, and the withdraw factory was keyed
    // to *them* rather than to whoever the sweep happened to see first.
    expect(withdrawnBy).toEqual([healthyId]);
    expect((await playerRowOf(healthyId))?.erasedAt?.getTime()).toBe(NOW.getTime());

    // The thrown one is untouched and still pending, so the next run retries.
    const doomed = await playerRowOf(doomedId);
    expect(doomed?.name).toBe("Doomed Dave");
    expect(doomed?.erasedAt).toBeNull();
    expect(doomed?.erasesAt?.getTime()).toBe(erasesAt.getTime());
  });

  // The caller sends N-2. Swallowing these here would move someone off a
  // waitlist and into a fixture without ever telling them — and this sweep is
  // the only production path on which an erasure-driven promotion happens.
  it("hands back every promotion its erasures caused, for the caller to notify", async () => {
    const erasingId = await insertPlayer(db, {
      email: "edward@example.test",
      erasesAt: new Date(NOW.getTime() - HOUR_MS),
    });
    const gameId = await insertGame(db);
    const otherOwnerId = await insertPlayer(db, { email: "owner@example.test" });
    await insertMembership(db, gameId, otherOwnerId, { role: "owner" });
    await insertMembership(db, gameId, erasingId);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open" });

    const promoted = { playerId: "waiting-player", previousWaitlistPosition: 1, promotedAt: NOW.getTime() };
    const withdraw = () => async () =>
      ({ kind: "removed", previousStatus: "in", inCount: 1, promoted }) as const;

    const result = await runDueErasures(db, NOW, withdraw);

    expect(result.erased).toBe(1);
    expect(result.promotions).toEqual([{ fixtureId, promoted }]);
  });

  it("erases exactly at the boundary instant, not a millisecond later", async () => {
    const playerId = await insertPlayer(db, { email: "edward@example.test", erasesAt: NOW });

    const before = await runDueErasures(db, new Date(NOW.getTime() - 1), noWithdraw);
    expect(before.erased).toBe(0);

    const at = await runDueErasures(db, NOW, noWithdraw);
    expect(at.erased).toBe(1);
    expect((await playerRowOf(playerId))?.erasedAt?.getTime()).toBe(NOW.getTime());
  });
});
