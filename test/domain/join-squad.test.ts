import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, memberships, players } from "../../src/db/schema.js";
import { isPlausibleEmail, joinSquad, normaliseEmail } from "../../src/domain/join-squad.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";

const NOW = new Date(Date.UTC(2026, 7, 12, 9, 0));

describe("joinSquad", () => {
  beforeEach(resetDatabase);

  it("creates a player and an active membership for a new address", async () => {
    const db = testDb();
    const gameId = await insertGame(db);

    const outcome = await joinSquad({ db, gameId, name: "Alex Smith", email: "alex@example.com", now: NOW });

    expect(outcome.kind).toBe("joined");
    const [player] = await db.select().from(players).where(eq(players.email, "alex@example.com"));
    expect(player?.name).toBe("Alex Smith");
    const [membership] = await db.select().from(memberships).where(eq(memberships.gameId, gameId));
    expect(membership?.active).toBe(true);
    expect(membership?.role).toBe("player");
  });

  it("reuses an existing player and keeps their stored name", async () => {
    // One address is one person, and joining a second squad must not rename
    // them in the first (spec §4.4).
    const db = testDb();
    const gameId = await insertGame(db);
    const existingId = await insertPlayer(db, { name: "Alexandra Smith", email: "alex@example.com" });

    const outcome = await joinSquad({ db, gameId, name: "Al", email: "alex@example.com", now: NOW });

    expect(outcome.kind).toBe("joined");
    expect(outcome.playerId).toBe(existingId);
    const [player] = await db.select().from(players).where(eq(players.id, existingId));
    expect(player?.name).toBe("Alexandra Smith");
  });

  it("is idempotent for someone already in the squad", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    await insertMembership(db, gameId, playerId);

    const outcome = await joinSquad({ db, gameId, name: "Alex", email: "alex@example.com", now: NOW });

    expect(outcome.kind).toBe("already-member");
    expect(await db.select().from(memberships).where(eq(memberships.gameId, gameId))).toHaveLength(1);
    // No write at all, so nothing to audit and nothing to email.
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("reactivates a membership someone previously left, with a fresh joinedAt", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    const membershipId = await insertMembership(db, gameId, playerId, {
      active: false,
      leftAt: new Date(Date.UTC(2026, 5, 1)),
      joinedAt: new Date(Date.UTC(2026, 0, 1)),
    });

    const outcome = await joinSquad({ db, gameId, name: "Alex", email: "alex@example.com", now: NOW });
    if (outcome.kind !== "rejoined") throw new Error("expected a rejoin");

    expect(outcome.kind).toBe("rejoined");
    expect(outcome.membershipId).toBe(membershipId);
    const [membership] = await db.select().from(memberships).where(eq(memberships.id, membershipId));
    expect(membership?.active).toBe(true);
    expect(membership?.leftAt).toBeNull();
    // The fresh joinedAt is what makes the N-6 dedupe key differ (§4.4).
    expect(membership?.joinedAt.getTime()).toBe(NOW.getTime());
  });

  /**
   * The double-tap. D1 has no interactive transactions, so both calls see no
   * player, both insert, and one loses on `UNIQUE (email)`. Before the retry
   * that loser threw, the route turned it into a 500, and the person had no
   * way to tell whether they had joined — for an operation that had in fact
   * succeeded. Both calls must now report a coherent outcome over exactly one
   * player row and one membership row.
   */
  it("survives two concurrent joins with the same new address", async () => {
    const db = testDb();
    const gameId = await insertGame(db);

    const outcomes = await Promise.all([
      joinSquad({ db, gameId, name: "Alex Smith", email: "alex@example.com", now: NOW }),
      joinSquad({ db, gameId, name: "Alex Smith", email: "alex@example.com", now: NOW }),
    ]);

    for (const outcome of outcomes) {
      expect(["joined", "already-member"]).toContain(outcome.kind);
    }
    expect(await db.select().from(players).where(eq(players.email, "alex@example.com"))).toHaveLength(1);
    expect(await db.select().from(memberships).where(eq(memberships.gameId, gameId))).toHaveLength(1);
  });

  it("does not disturb a membership in another game", async () => {
    const db = testDb();
    const first = await insertGame(db);
    const second = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    await insertMembership(db, first, playerId);

    await joinSquad({ db, gameId: second, name: "Alex", email: "alex@example.com", now: NOW });

    expect(await db.select().from(memberships).where(eq(memberships.playerId, playerId))).toHaveLength(2);
  });

  it("records the join in audit_log", async () => {
    const db = testDb();
    const gameId = await insertGame(db);

    const outcome = await joinSquad({ db, gameId, name: "Alex", email: "alex@example.com", now: NOW });
    if (outcome.kind === "already-member") throw new Error("expected a join");

    const [row] = await db.select().from(auditLog).where(eq(auditLog.entityId, outcome.membershipId));
    expect(row?.action).toBe("membership.joined");
    // The joiner acted on their own behalf; nobody else did anything.
    expect(row?.actorPlayerId).toBe(outcome.playerId);
  });

  it("matches an address case-insensitively", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const existingId = await insertPlayer(db, { email: "alex@example.com" });

    const outcome = await joinSquad({ db, gameId, name: "Alex", email: "ALEX@Example.com", now: NOW });

    expect(outcome.playerId).toBe(existingId);
  });
});

describe("normaliseEmail", () => {
  it("trims and lowercases", () => {
    expect(normaliseEmail("  Alex@Example.COM ")).toBe("alex@example.com");
  });
});

describe("isPlausibleEmail", () => {
  it("accepts an ordinary address", () => {
    expect(isPlausibleEmail("alex@example.com")).toBe(true);
    expect(isPlausibleEmail("alex+squad@example.co.uk")).toBe(true);
  });

  it("rejects what is obviously not one", () => {
    expect(isPlausibleEmail("")).toBe(false);
    expect(isPlausibleEmail("alex")).toBe(false);
    expect(isPlausibleEmail("alex@")).toBe(false);
    expect(isPlausibleEmail("@example.com")).toBe(false);
    expect(isPlausibleEmail("alex @example.com")).toBe(false);
    expect(isPlausibleEmail("alex@example")).toBe(false);
  });
});
