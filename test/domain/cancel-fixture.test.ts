import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { auditLog, fixtures, memberships, players, responses } from "../../src/db/schema.js";
import type { Lifecycle } from "../../src/domain/lifecycle.js";
import type { ResponseStatus } from "../../src/domain/response-status.js";
import { cancelFixture } from "../../src/domain/cancel-fixture.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const NOW = new Date("2026-08-12T09:00:00Z");
const KICKOFF = new Date("2026-08-13T18:00:00Z");

const OWNER = "owner-1";

interface Member {
  id: string;
  role?: "player" | "owner";
  active?: boolean;
  isGuest?: boolean;
  /** Omit for no response row at all. */
  status?: ResponseStatus;
}

async function seed(
  members: readonly Member[],
  opts: { lifecycle?: Lifecycle } = {},
): Promise<{ gameId: string; fixtureId: string }> {
  const gameId = await insertGame(db);
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: KICKOFF,
    lifecycle: opts.lifecycle ?? "open",
    minPlayers: 10,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });

  for (const member of members) {
    const isGuest = member.isGuest ?? false;
    await db.insert(players).values({
      id: member.id,
      name: `Name ${member.id}`,
      email: isGuest ? null : `${member.id}@example.com`,
      isGuest,
    });
    await db.insert(memberships).values({
      id: `m-${member.id}`,
      gameId,
      playerId: member.id,
      role: member.role ?? "player",
      active: member.active ?? true,
    });
    if (member.status) {
      await db.insert(responses).values({
        id: `r-${member.id}`,
        fixtureId,
        playerId: member.id,
        status: member.status,
        waitlistPosition: member.status === "waitlisted" ? 1 : null,
        source: "web",
      });
    }
  }
  return { gameId, fixtureId };
}

/** The default: one active owner and nobody else. */
async function seedOwnerOnly(opts: { lifecycle?: Lifecycle } = {}) {
  return seed([{ id: OWNER, role: "owner" }], opts);
}

async function lifecycleOf(fixtureId: string): Promise<Lifecycle | undefined> {
  const [row] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  return row?.lifecycle;
}

beforeEach(async () => {
  await resetDatabase();
});

describe("cancelFixture", () => {
  it("cancels an open fixture, stamping cancelled_at and the reason (BR-14)", async () => {
    const { fixtureId } = await seedOwnerOnly();

    const result = await cancelFixture(db, {
      fixtureId,
      actorPlayerId: OWNER,
      reason: "Pitch flooded",
      now: NOW,
    });

    expect(result.cancelled).toBe(true);
    const [row] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(row?.lifecycle).toBe("cancelled");
    expect(row?.cancelledAt?.toISOString()).toBe(NOW.toISOString());
    expect(row?.cancellationReason).toBe("Pitch flooded");
  });

  it("cancels a scheduled fixture too (BR-14)", async () => {
    const { fixtureId } = await seedOwnerOnly({ lifecycle: "scheduled" });

    const result = await cancelFixture(db, {
      fixtureId,
      actorPlayerId: OWNER,
      reason: "Called off early",
      now: NOW,
    });

    expect(result).toMatchObject({ cancelled: true });
    expect(await lifecycleOf(fixtureId)).toBe("cancelled");
  });

  it("stores an empty reason verbatim rather than turning it into null", async () => {
    const { fixtureId } = await seedOwnerOnly();

    await cancelFixture(db, { fixtureId, actorPlayerId: OWNER, reason: "", now: NOW });

    const [row] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(row?.cancellationReason).toBe("");
  });

  it("stores a whitespace-only reason verbatim — trimming belongs to the template", async () => {
    const { fixtureId } = await seedOwnerOnly();

    await cancelFixture(db, { fixtureId, actorPlayerId: OWNER, reason: "  \n ", now: NOW });

    const [row] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(row?.cancellationReason).toBe("  \n ");
  });

  it("refuses a fixture that is already cancelled, leaving the first cancellation intact", async () => {
    const { fixtureId } = await seedOwnerOnly();
    await cancelFixture(db, { fixtureId, actorPlayerId: OWNER, reason: "First", now: NOW });

    const later = new Date(NOW.getTime() + 3_600_000);
    const result = await cancelFixture(db, {
      fixtureId,
      actorPlayerId: OWNER,
      reason: "Second",
      now: later,
    });

    expect(result).toEqual({ cancelled: false, reason: "already-cancelled" });
    const [row] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(row?.cancellationReason).toBe("First");
    expect(row?.cancelledAt?.toISOString()).toBe(NOW.toISOString());
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it("refuses a played fixture", async () => {
    const { fixtureId } = await seedOwnerOnly({ lifecycle: "played" });

    const result = await cancelFixture(db, {
      fixtureId,
      actorPlayerId: OWNER,
      reason: "Too late",
      now: NOW,
    });

    expect(result).toEqual({ cancelled: false, reason: "played" });
    expect(await lifecycleOf(fixtureId)).toBe("played");
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("reports a missing fixture rather than throwing", async () => {
    const result = await cancelFixture(db, {
      fixtureId: "no-such-fixture",
      actorPlayerId: OWNER,
      reason: "",
      now: NOW,
    });

    expect(result).toEqual({ cancelled: false, reason: "not-found" });
  });

  describe("entitlement", () => {
    it("refuses a member who is only a player", async () => {
      const { fixtureId } = await seed([
        { id: OWNER, role: "owner" },
        { id: "player-1", role: "player" },
      ]);

      const result = await cancelFixture(db, {
        fixtureId,
        actorPlayerId: "player-1",
        reason: "Not mine to cancel",
        now: NOW,
      });

      expect(result).toEqual({ cancelled: false, reason: "not-entitled" });
      expect(await lifecycleOf(fixtureId)).toBe("open");
      expect(await db.select().from(auditLog)).toHaveLength(0);
    });

    it("refuses an owner whose membership is no longer active", async () => {
      const { fixtureId } = await seed([
        { id: OWNER, role: "owner" },
        { id: "ex-owner", role: "owner", active: false },
      ]);

      const result = await cancelFixture(db, {
        fixtureId,
        actorPlayerId: "ex-owner",
        reason: "Removed from the squad after the email went out",
        now: NOW,
      });

      expect(result).toEqual({ cancelled: false, reason: "not-entitled" });
      expect(await lifecycleOf(fixtureId)).toBe("open");
      expect(await db.select().from(auditLog)).toHaveLength(0);
    });

    it("refuses a stranger with no membership at all", async () => {
      const { fixtureId } = await seedOwnerOnly();

      const result = await cancelFixture(db, {
        fixtureId,
        actorPlayerId: "nobody",
        reason: "hello",
        now: NOW,
      });

      expect(result).toEqual({ cancelled: false, reason: "not-entitled" });
      expect(await lifecycleOf(fixtureId)).toBe("open");
    });

    it("refuses an owner of a different Game", async () => {
      const { fixtureId } = await seedOwnerOnly();
      const otherGameId = await insertGame(db, { inviteToken: crypto.randomUUID() });
      await db.insert(players).values({ id: "other-owner", name: "Other", email: "other@example.com" });
      await db.insert(memberships).values({
        id: "m-other-owner",
        gameId: otherGameId,
        playerId: "other-owner",
        role: "owner",
        active: true,
      });

      const result = await cancelFixture(db, {
        fixtureId,
        actorPlayerId: "other-owner",
        reason: "wrong game",
        now: NOW,
      });

      expect(result).toEqual({ cancelled: false, reason: "not-entitled" });
      expect(await lifecycleOf(fixtureId)).toBe("open");
    });

    it("refuses a stranger, a player and a former owner identically", async () => {
      const { fixtureId } = await seed([
        { id: OWNER, role: "owner" },
        { id: "player-1", role: "player" },
        { id: "ex-owner", role: "owner", active: false },
      ]);

      const refusals = [];
      for (const actorPlayerId of ["nobody", "player-1", "ex-owner"]) {
        refusals.push(
          await cancelFixture(db, { fixtureId, actorPlayerId, reason: "x", now: NOW }),
        );
      }

      expect(refusals[0]).toEqual(refusals[1]);
      expect(refusals[1]).toEqual(refusals[2]);
    });
  });

  describe("audit (BR-27)", () => {
    it("records the actor and the before and after lifecycle", async () => {
      const { fixtureId } = await seedOwnerOnly();

      await cancelFixture(db, { fixtureId, actorPlayerId: OWNER, reason: "Frozen", now: NOW });

      const rows = await db.select().from(auditLog);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row?.actorPlayerId).toBe(OWNER);
      expect(row?.entityType).toBe("fixture");
      expect(row?.entityId).toBe(fixtureId);
      expect(row?.action).toBe("fixture.cancelled");
      expect(JSON.parse(row?.beforeJson ?? "null")).toEqual({ lifecycle: "open" });
      expect(JSON.parse(row?.afterJson ?? "null")).toEqual({
        lifecycle: "cancelled",
        reason: "Frozen",
      });
      expect(row?.createdAt?.toISOString()).toBe(NOW.toISOString());
    });

    it("records the real prior lifecycle when it was scheduled, not a fixed 'open'", async () => {
      const { fixtureId } = await seedOwnerOnly({ lifecycle: "scheduled" });

      await cancelFixture(db, { fixtureId, actorPlayerId: OWNER, reason: "Early", now: NOW });

      const [row] = await db.select().from(auditLog);
      expect(JSON.parse(row?.beforeJson ?? "null")).toEqual({ lifecycle: "scheduled" });
    });
  });

  describe("recipients (BR-20)", () => {
    it("returns exactly the in and waitlisted players", async () => {
      const { fixtureId } = await seed([
        { id: OWNER, role: "owner", status: "in" },
        { id: "in-1", status: "in" },
        { id: "wait-1", status: "waitlisted" },
        { id: "pending-1", status: "pending" },
        { id: "out-1", status: "out" },
        { id: "no-response" },
      ]);

      const result = await cancelFixture(db, {
        fixtureId,
        actorPlayerId: OWNER,
        reason: "Pitch flooded",
        now: NOW,
      });

      expect(result.cancelled).toBe(true);
      const ids = result.cancelled ? result.recipients.map((r) => r.playerId).sort() : [];
      expect(ids).toEqual([OWNER, "in-1", "wait-1"].sort());
    });

    it("excludes guests, who have no address to mail (BR-32)", async () => {
      const { fixtureId } = await seed([
        { id: OWNER, role: "owner" },
        { id: "in-1", status: "in" },
        { id: "guest-1", status: "in", isGuest: true },
        { id: "guest-2", status: "waitlisted", isGuest: true },
      ]);

      const result = await cancelFixture(db, {
        fixtureId,
        actorPlayerId: OWNER,
        reason: "",
        now: NOW,
      });

      const ids = result.cancelled ? result.recipients.map((r) => r.playerId) : [];
      expect(ids).toEqual(["in-1"]);
    });

    it("carries the name, address and status each recipient's email needs", async () => {
      const { fixtureId } = await seed([
        { id: OWNER, role: "owner" },
        { id: "wait-1", status: "waitlisted" },
      ]);

      const result = await cancelFixture(db, {
        fixtureId,
        actorPlayerId: OWNER,
        reason: "",
        now: NOW,
      });

      expect(result.cancelled && result.recipients).toEqual([
        { playerId: "wait-1", name: "Name wait-1", email: "wait-1@example.com", status: "waitlisted" },
      ]);
    });

    it("returns no recipients when nobody had answered", async () => {
      const { fixtureId } = await seed([
        { id: OWNER, role: "owner", status: "pending" },
        { id: "p-1", status: "pending" },
      ]);

      const result = await cancelFixture(db, {
        fixtureId,
        actorPlayerId: OWNER,
        reason: "",
        now: NOW,
      });

      expect(result.cancelled && result.recipients).toEqual([]);
    });

    it("ignores responses belonging to another fixture", async () => {
      const { gameId, fixtureId } = await seed([
        { id: OWNER, role: "owner" },
        { id: "in-1", status: "in" },
      ]);
      const otherFixtureId = crypto.randomUUID();
      await db.insert(fixtures).values({
        id: otherFixtureId,
        gameId,
        kicksOffAt: new Date(KICKOFF.getTime() + 604_800_000),
        lifecycle: "open",
        minPlayers: 10,
        maxPlayers: 14,
        prefersEvenNumbers: true,
        shortWarningOffsetHours: 12,
        durationMinutes: 60,
      });
      await db.insert(players).values({ id: "other-in", name: "Other", email: "other-in@example.com" });
      await db.insert(memberships).values({
        id: "m-other-in",
        gameId,
        playerId: "other-in",
        role: "player",
        active: true,
      });
      await db.insert(responses).values({
        id: "r-other-in",
        fixtureId: otherFixtureId,
        playerId: "other-in",
        status: "in",
        source: "web",
      });

      const result = await cancelFixture(db, {
        fixtureId,
        actorPlayerId: OWNER,
        reason: "",
        now: NOW,
      });

      const ids = result.cancelled ? result.recipients.map((r) => r.playerId) : [];
      expect(ids).toEqual(["in-1"]);
    });

    it("returns no recipients on a refusal", async () => {
      const { fixtureId } = await seed([
        { id: OWNER, role: "owner" },
        { id: "in-1", status: "in" },
        { id: "player-1", role: "player" },
      ]);

      const result = await cancelFixture(db, {
        fixtureId,
        actorPlayerId: "player-1",
        reason: "",
        now: NOW,
      });

      expect(result).toEqual({ cancelled: false, reason: "not-entitled" });
    });
  });
});
