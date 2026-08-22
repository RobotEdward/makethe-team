import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, memberships, responses } from "../../src/db/schema.js";
import { setMute } from "../../src/domain/set-mute.js";
import type { SetResponseOutcome } from "../../src/capacity/types.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
} from "../support/factories.js";

const db = getDb(env.DB);
const NOW = new Date("2026-09-01T12:00:00.000Z");

/**
 * Stands in for `FIXTURE_CAPACITY.getByName(id).setResponse({intent: "out"})`,
 * recording which fixtures it was asked to decline and applying the write the
 * real object would.
 */
function recordingDecline() {
  const called: string[] = [];
  const decline = async (fixtureId: string, playerId: string): Promise<SetResponseOutcome> => {
    called.push(fixtureId);
    await db
      .update(responses)
      .set({ status: "out", respondedAt: NOW, source: "web" })
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
    return { kind: "recorded", status: "out", inCount: 0, spotsLeft: 1 };
  };
  return { called, decline };
}

beforeEach(async () => {
  await resetDatabase();
});

describe("setMute", () => {
  it("stamps mutedAt and the expiry on the one game", async () => {
    const gameId = await insertGame(db);
    const otherGameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Alice", email: "alice@example.com" });
    await insertMembership(db, gameId, playerId);
    await insertMembership(db, otherGameId, playerId);
    const { decline } = recordingDecline();

    const result = await setMute({
      db, playerId, gameId, duration: "4w", applyToAll: false, now: NOW, decline,
    });

    expect(result).toMatchObject({ kind: "muted", gamesAffected: 1 });
    const rows = await db.select().from(memberships).where(eq(memberships.playerId, playerId));
    const here = rows.find((r) => r.gameId === gameId);
    const elsewhere = rows.find((r) => r.gameId === otherGameId);
    expect(here?.mutedAt?.toISOString()).toBe(NOW.toISOString());
    expect(here?.mutedUntil?.toISOString()).toBe("2026-09-29T12:00:00.000Z");
    expect(elsewhere?.mutedAt).toBe(null);
  });

  it("leaves mutedUntil null for the indefinite choice", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Alice" });
    await insertMembership(db, gameId, playerId);
    const { decline } = recordingDecline();

    await setMute({ db, playerId, gameId, duration: "forever", applyToAll: false, now: NOW, decline });

    const [row] = await db.select().from(memberships).where(eq(memberships.gameId, gameId));
    expect(row?.mutedAt?.toISOString()).toBe(NOW.toISOString());
    expect(row?.mutedUntil).toBe(null);
  });

  it("applies to every game the player is currently in when asked to", async () => {
    const gameId = await insertGame(db);
    const otherGameId = await insertGame(db);
    const leftGameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Alice" });
    await insertMembership(db, gameId, playerId);
    await insertMembership(db, otherGameId, playerId);
    await insertMembership(db, leftGameId, playerId, { active: false, leftAt: NOW });
    const { decline } = recordingDecline();

    const result = await setMute({
      db, playerId, gameId, duration: "2w", applyToAll: true, now: NOW, decline,
    });

    expect(result).toMatchObject({ kind: "muted", gamesAffected: 2 });
    const rows = await db.select().from(memberships).where(eq(memberships.playerId, playerId));
    expect(rows.filter((r) => r.mutedAt !== null).map((r) => r.gameId).sort()).toEqual(
      [gameId, otherGameId].sort(),
    );
    // A squad they have left is not silently re-muted for whenever they return.
    expect(rows.find((r) => r.gameId === leftGameId)?.mutedAt).toBe(null);
  });

  it("does not touch another player's membership of the same game", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Alice" });
    const otherId = await insertPlayer(db, { name: "Bob" });
    await insertMembership(db, gameId, playerId);
    await insertMembership(db, gameId, otherId);
    const { decline } = recordingDecline();

    await setMute({ db, playerId, gameId, duration: "2w", applyToAll: true, now: NOW, decline });

    const [bob] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, otherId)));
    expect(bob?.mutedAt).toBe(null);
  });

  it("declines the fixtures they had not answered yet", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Alice" });
    await insertMembership(db, gameId, playerId);
    const openId = await insertFixture(db, gameId, { lifecycle: "open" });
    await insertResponse(db, openId, playerId, { status: "pending" });
    const { called, decline } = recordingDecline();

    const result = await setMute({
      db, playerId, gameId, duration: "4w", applyToAll: false, now: NOW, decline,
    });

    expect(called).toEqual([openId]);
    expect(result).toMatchObject({ declined: 1 });
    const [row] = await db.select().from(responses).where(eq(responses.fixtureId, openId));
    expect(row?.status).toBe("out");
  });

  it("leaves a place they already hold alone, and a waitlist place too", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Alice" });
    await insertMembership(db, gameId, playerId);
    const inId = await insertFixture(db, gameId, { lifecycle: "open" });
    const waitId = await insertFixture(db, gameId, {
      lifecycle: "open",
      kicksOffAt: new Date("2026-09-10T18:00:00.000Z"),
    });
    await insertResponse(db, inId, playerId, { status: "in" });
    await insertResponse(db, waitId, playerId, { status: "waitlisted", waitlistPosition: 1 });
    const { called, decline } = recordingDecline();

    const result = await setMute({
      db, playerId, gameId, duration: "4w", applyToAll: false, now: NOW, decline,
    });

    expect(called).toEqual([]);
    expect(result).toMatchObject({ declined: 0 });
    const rows = await db.select().from(responses).where(eq(responses.playerId, playerId));
    expect(rows.map((r) => r.status).sort()).toEqual(["in", "waitlisted"]);
  });

  it("declines pending fixtures across every game when applied to all", async () => {
    const gameId = await insertGame(db);
    const otherGameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Alice" });
    await insertMembership(db, gameId, playerId);
    await insertMembership(db, otherGameId, playerId);
    const here = await insertFixture(db, gameId, { lifecycle: "open" });
    const there = await insertFixture(db, otherGameId, { lifecycle: "open" });
    await insertResponse(db, here, playerId, { status: "pending" });
    await insertResponse(db, there, playerId, { status: "pending" });
    const { called, decline } = recordingDecline();

    const result = await setMute({
      db, playerId, gameId, duration: "4w", applyToAll: true, now: NOW, decline,
    });

    expect(called.sort()).toEqual([here, there].sort());
    expect(result).toMatchObject({ declined: 2 });
  });

  it("ignores a scheduled fixture, which has no response rows to decline", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Alice" });
    await insertMembership(db, gameId, playerId);
    await insertFixture(db, gameId, { lifecycle: "scheduled" });
    const { called } = recordingDecline();
    const { decline } = recordingDecline();

    await setMute({ db, playerId, gameId, duration: "4w", applyToAll: false, now: NOW, decline });

    expect(called).toEqual([]);
  });

  it("refuses a player who is not in the game", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Stranger" });
    const { called, decline } = recordingDecline();

    const result = await setMute({
      db, playerId, gameId, duration: "4w", applyToAll: false, now: NOW, decline,
    });

    expect(result).toMatchObject({ kind: "not-a-member" });
    expect(called).toEqual([]);
  });

  it("records an audit row naming the player as their own actor", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Alice" });
    const membershipId = await insertMembership(db, gameId, playerId);
    const { decline } = recordingDecline();

    await setMute({ db, playerId, gameId, duration: "4w", applyToAll: false, now: NOW, decline });

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "membership.muted"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "membership", entityId: membershipId, actorPlayerId: playerId });
    expect(JSON.parse(rows[0]!.afterJson!)).toMatchObject({
      mutedUntil: "2026-09-29T12:00:00.000Z",
      appliedToAllGames: false,
    });
  });

  it("writes one audit row per game when applied to all", async () => {
    const gameId = await insertGame(db);
    const otherGameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Alice" });
    await insertMembership(db, gameId, playerId);
    await insertMembership(db, otherGameId, playerId);
    const { decline } = recordingDecline();

    await setMute({ db, playerId, gameId, duration: "2w", applyToAll: true, now: NOW, decline });

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "membership.muted"));
    expect(rows).toHaveLength(2);
  });
});

describe("clearMute", () => {
  it("clears both columns on the one game and audits it", async () => {
    const gameId = await insertGame(db);
    const otherGameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Alice" });
    const membershipId = await insertMembership(db, gameId, playerId, {
      mutedAt: NOW, mutedUntil: null,
    });
    await insertMembership(db, otherGameId, playerId, { mutedAt: NOW, mutedUntil: null });

    const { clearMute } = await import("../../src/domain/set-mute.js");
    const result = await clearMute({ db, playerId, gameId, applyToAll: false, now: NOW });

    expect(result).toMatchObject({ kind: "cleared", gamesAffected: 1 });
    const rows = await db.select().from(memberships).where(eq(memberships.playerId, playerId));
    expect(rows.find((r) => r.gameId === gameId)?.mutedAt).toBe(null);
    expect(rows.find((r) => r.gameId === gameId)?.mutedUntil).toBe(null);
    expect(rows.find((r) => r.gameId === otherGameId)?.mutedAt?.toISOString()).toBe(NOW.toISOString());

    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "membership.unmuted"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityId: membershipId, actorPlayerId: playerId });
  });

  it("clears every game when asked to", async () => {
    const gameId = await insertGame(db);
    const otherGameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Alice" });
    await insertMembership(db, gameId, playerId, { mutedAt: NOW, mutedUntil: null });
    await insertMembership(db, otherGameId, playerId, { mutedAt: NOW, mutedUntil: null });

    const { clearMute } = await import("../../src/domain/set-mute.js");
    const result = await clearMute({ db, playerId, gameId, applyToAll: true, now: NOW });

    expect(result).toMatchObject({ kind: "cleared", gamesAffected: 2 });
    const rows = await db.select().from(memberships).where(eq(memberships.playerId, playerId));
    expect(rows.every((r) => r.mutedAt === null)).toBe(true);
  });

  it("refuses a player who is not in the game", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Stranger" });

    const { clearMute } = await import("../../src/domain/set-mute.js");
    expect(await clearMute({ db, playerId, gameId, applyToAll: false, now: NOW })).toMatchObject({
      kind: "not-a-member",
    });
  });

  it("does not audit a membership that was not muted, so the trail is transitions only", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { name: "Alice" });
    await insertMembership(db, gameId, playerId);

    const { clearMute } = await import("../../src/domain/set-mute.js");
    const result = await clearMute({ db, playerId, gameId, applyToAll: false, now: NOW });

    expect(result).toMatchObject({ kind: "cleared", gamesAffected: 0 });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "membership.unmuted"))).toHaveLength(0);
  });
});
