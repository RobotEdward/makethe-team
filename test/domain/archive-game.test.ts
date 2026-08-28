import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, fixtures, games } from "../../src/db/schema.js";
import { archiveGame, unarchiveGame } from "../../src/domain/archive-game.js";
import { materialiseFixtures } from "../../src/domain/materialise.js";
import { insertFixture, insertGame, insertMembership, insertPlayer, insertResponse, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const NOW = new Date("2026-08-28T09:00:00Z");
const LATER = new Date("2026-09-04T18:00:00Z");
const LATER_STILL = new Date("2026-09-11T18:00:00Z");
const EARLIER = new Date("2026-08-21T18:00:00Z");
const EARLIER_STILL = new Date("2026-08-14T18:00:00Z");

async function seed(opts: { archivedAt?: Date } = {}) {
  const gameId = await insertGame(db, { archivedAt: opts.archivedAt ?? null });
  const ownerId = await insertPlayer(db, { name: "Owner", email: "owner@example.com" });
  await insertMembership(db, gameId, ownerId, { role: "owner" });
  const memberId = await insertPlayer(db, { name: "Member", email: "member@example.com" });
  await insertMembership(db, gameId, memberId);
  return { gameId, ownerId, memberId };
}

describe("archiveGame", () => {
  beforeEach(resetDatabase);

  it("cancels every scheduled and open fixture, leaves played and cancelled ones alone, and stamps the game", async () => {
    const { gameId, ownerId, memberId } = await seed();
    const scheduled = await insertFixture(db, gameId, { lifecycle: "scheduled", kicksOffAt: LATER });
    const open = await insertFixture(db, gameId, { lifecycle: "open", kicksOffAt: LATER_STILL, inCount: 1 });
    await insertResponse(db, open, memberId, { status: "in" });
    const played = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: EARLIER });
    const already = await insertFixture(db, gameId, { lifecycle: "cancelled", kicksOffAt: EARLIER_STILL });

    const result = await archiveGame(db, { gameId, actorPlayerId: ownerId, now: NOW });

    expect(result.archived).toBe(true);
    if (!result.archived) throw new Error("unreachable");
    expect(result.cancelled.map((c) => c.fixture.id).sort()).toEqual([open, scheduled].sort());
    const forOpen = result.cancelled.find((c) => c.fixture.id === open)!;
    expect(forOpen.recipients.map((r) => r.playerId)).toEqual([memberId]);

    const rows = await db.select({ id: fixtures.id, lifecycle: fixtures.lifecycle }).from(fixtures);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.lifecycle]));
    expect(byId).toEqual({ [scheduled]: "cancelled", [open]: "cancelled", [played]: "played", [already]: "cancelled" });

    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    expect(game!.archivedAt?.getTime()).toBe(NOW.getTime());

    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "game.archived"));
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.afterJson!)).toEqual({ archivedAt: NOW.toISOString(), fixturesCancelled: 2 });
    const fixtureAudits = await db.select().from(auditLog).where(eq(auditLog.action, "fixture.cancelled"));
    expect(fixtureAudits).toHaveLength(2);
  });

  it("refuses a plain member and a stranger with the same reason", async () => {
    const { gameId, memberId } = await seed();
    const stranger = await insertPlayer(db, { name: "Stranger", email: "s@example.com" });
    expect(await archiveGame(db, { gameId, actorPlayerId: memberId, now: NOW })).toEqual({ archived: false, reason: "not-entitled" });
    expect(await archiveGame(db, { gameId, actorPlayerId: stranger, now: NOW })).toEqual({ archived: false, reason: "not-entitled" });
    expect(await archiveGame(db, { gameId: "nope", actorPlayerId: memberId, now: NOW })).toEqual({ archived: false, reason: "not-entitled" });
  });

  it("refuses to archive twice", async () => {
    const { gameId, ownerId } = await seed({ archivedAt: EARLIER });
    expect(await archiveGame(db, { gameId, actorPlayerId: ownerId, now: NOW })).toEqual({ archived: false, reason: "already-archived" });
  });

  it("stops the sweep materialising fixtures for the game", async () => {
    const { gameId, ownerId } = await seed();
    await archiveGame(db, { gameId, actorPlayerId: ownerId, now: NOW });
    const result = await materialiseFixtures(db, NOW);
    expect(result.gamesProcessed).toBe(0);
    expect(result.fixturesCreated).toBe(0);
  });
});

describe("unarchiveGame", () => {
  beforeEach(resetDatabase);

  it("clears the stamp, audits it, and does not resurrect cancelled fixtures", async () => {
    const { gameId, ownerId } = await seed({ archivedAt: EARLIER });
    const off = await insertFixture(db, gameId, { lifecycle: "cancelled", kicksOffAt: LATER });

    expect(await unarchiveGame(db, { gameId, actorPlayerId: ownerId, now: NOW })).toEqual({ unarchived: true });

    const [game] = await db.select().from(games).where(eq(games.id, gameId));
    expect(game!.archivedAt).toBeNull();
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, off));
    expect(fixture!.lifecycle).toBe("cancelled");
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "game.unarchived"));
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.beforeJson!)).toEqual({ archivedAt: EARLIER.toISOString() });

    // Live again: the sweep picks it up.
    const sweep = await materialiseFixtures(db, NOW);
    expect(sweep.gamesProcessed).toBe(1);
  });

  it("refuses a live game and a non-owner", async () => {
    const { gameId, ownerId, memberId } = await seed();
    expect(await unarchiveGame(db, { gameId, actorPlayerId: ownerId, now: NOW })).toEqual({ unarchived: false, reason: "not-archived" });
    expect(await unarchiveGame(db, { gameId, actorPlayerId: memberId, now: NOW })).toEqual({ unarchived: false, reason: "not-entitled" });
  });
});
