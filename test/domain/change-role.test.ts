import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, memberships } from "../../src/db/schema.js";
import { changeMemberRole, parseRole } from "../../src/domain/change-role.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";

const NOW = new Date("2026-08-13T12:00:00Z");

describe("parseRole", () => {
  it("accepts exactly the two roles", () => {
    expect(parseRole("owner")).toBe("owner");
    expect(parseRole("player")).toBe("player");
  });

  it("rejects anything else", () => {
    for (const value of ["Owner", "admin", "", undefined, null, 1, ["owner"]]) {
      expect(parseRole(value)).toBeNull();
    }
  });
});

describe("changeMemberRole", () => {
  beforeEach(resetDatabase);

  it("promotes a player to owner and audits it", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const actor = await insertPlayer(db);
    const player = await insertPlayer(db);
    await insertMembership(db, gameId, actor, { role: "owner" });
    const membershipId = await insertMembership(db, gameId, player);

    expect(await changeMemberRole({ db, gameId, playerId: player, actorPlayerId: actor, role: "owner", now: NOW }))
      .toEqual({ kind: "changed", role: "owner" });

    const [row] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
    expect(row!.role).toBe("owner");
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "membership.role_changed"));
    expect(audit).toMatchObject({ actorPlayerId: actor, entityId: membershipId });
    expect(JSON.parse(audit!.beforeJson!)).toMatchObject({ role: "player" });
    expect(JSON.parse(audit!.afterJson!)).toMatchObject({ role: "owner" });
  });

  it("demotes an owner when a co-owner remains", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const actor = await insertPlayer(db);
    const other = await insertPlayer(db);
    await insertMembership(db, gameId, actor, { role: "owner" });
    await insertMembership(db, gameId, other, { role: "owner" });

    expect(await changeMemberRole({ db, gameId, playerId: other, actorPlayerId: actor, role: "player", now: NOW }))
      .toEqual({ kind: "changed", role: "player" });
  });

  it("refuses to demote the last active owner", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const actor = await insertPlayer(db);
    const membershipId = await insertMembership(db, gameId, actor, { role: "owner" });

    expect(await changeMemberRole({ db, gameId, playerId: actor, actorPlayerId: actor, role: "player", now: NOW }))
      .toEqual({ kind: "refused", reason: "last-owner" });
    const [row] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
    expect(row!.role).toBe("owner");
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("writes nothing when the role is already what was asked for", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const actor = await insertPlayer(db);
    const other = await insertPlayer(db);
    await insertMembership(db, gameId, actor, { role: "owner" });
    await insertMembership(db, gameId, other, { role: "owner" });

    expect(await changeMemberRole({ db, gameId, playerId: other, actorPlayerId: actor, role: "owner", now: NOW }))
      .toEqual({ kind: "unchanged", role: "owner" });
    // No audit row: nothing changed, and an audit trail of non-events is noise.
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("reports a player who is not in this squad", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    expect(
      await changeMemberRole({
        db,
        gameId,
        playerId: await insertPlayer(db),
        actorPlayerId: await insertPlayer(db),
        role: "owner",
        now: NOW,
      }),
    ).toEqual({ kind: "not-a-member" });
  });
});
