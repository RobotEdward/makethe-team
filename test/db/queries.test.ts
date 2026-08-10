import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, players, responses } from "../../src/db/schema.js";
import { getFixtureWithSquad } from "../../src/db/queries.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const NOW = new Date("2026-08-13T18:00:00Z");

async function insertPlayer(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(players).values({ id, name });
  return id;
}

beforeEach(async () => {
  await resetDatabase();
});

describe("getFixtureWithSquad", () => {
  it("returns null for a fixture that does not exist", async () => {
    const result = await getFixtureWithSquad(db, crypto.randomUUID());
    expect(result).toBeNull();
  });

  it("orders the squad in, waitlisted (by rank), pending, out — and excludes withdrawn", async () => {
    const gameId = await insertGame(db);
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId,
      gameId,
      kicksOffAt: NOW,
      minPlayers: 1,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
    });

    const inPlayerEarly = await insertPlayer("In Early");
    const inPlayerLate = await insertPlayer("In Late");
    const waitlisted1 = await insertPlayer("Waitlisted First");
    const waitlisted2 = await insertPlayer("Waitlisted Second");
    const pendingPlayer = await insertPlayer("Still Pending");
    const outPlayer = await insertPlayer("Cannot Make It");
    const withdrawnPlayer = await insertPlayer("Withdrew");

    async function insertResponse(
      playerId: string,
      status: "in" | "out" | "waitlisted" | "pending" | "withdrawn",
      respondedAt: Date | null,
      waitlistPosition: number | null = null,
    ): Promise<void> {
      await db.insert(responses).values({
        id: crypto.randomUUID(),
        fixtureId,
        playerId,
        status,
        respondedAt,
        waitlistPosition,
        source: "token",
      });
    }

    await insertResponse(inPlayerLate, "in", new Date("2026-08-10T10:00:00Z"));
    await insertResponse(inPlayerEarly, "in", new Date("2026-08-09T10:00:00Z"));
    // Stored positions have a gap (3 was vacated by someone who left), so the
    // rendered rank must not be the stored position.
    await insertResponse(waitlisted2, "waitlisted", new Date("2026-08-11T10:00:00Z"), 5);
    await insertResponse(waitlisted1, "waitlisted", new Date("2026-08-10T09:00:00Z"), 2);
    await insertResponse(pendingPlayer, "pending", null);
    await insertResponse(outPlayer, "out", new Date("2026-08-09T09:00:00Z"));
    await insertResponse(withdrawnPlayer, "withdrawn", new Date("2026-08-09T09:00:00Z"));

    const result = await getFixtureWithSquad(db, fixtureId);
    expect(result).not.toBeNull();
    expect(result?.squad.map((m) => m.playerId)).toEqual([
      inPlayerEarly,
      inPlayerLate,
      waitlisted1,
      waitlisted2,
      pendingPlayer,
      outPlayer,
    ]);

    const w1 = result?.squad.find((m) => m.playerId === waitlisted1);
    const w2 = result?.squad.find((m) => m.playerId === waitlisted2);
    expect(w1?.waitlistRank).toBe(1);
    expect(w2?.waitlistRank).toBe(2);

    for (const member of result?.squad ?? []) {
      if (member.status !== "waitlisted") expect(member.waitlistRank).toBeNull();
    }

    expect(result?.squad.some((m) => m.playerId === withdrawnPlayer)).toBe(false);
  });

  it("computes waitlistRank from openFixture's pending rows once players respond", async () => {
    const gameId = await insertGame(db, { minPlayers: 1, maxPlayers: 2 });
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId,
      gameId,
      kicksOffAt: NOW,
      minPlayers: 1,
      maxPlayers: 2,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
    });

    const p1 = await insertPlayer("P1");
    const p2 = await insertPlayer("P2");
    await db.insert(responses).values([
      { id: crypto.randomUUID(), fixtureId, playerId: p1, status: "in", source: "token", respondedAt: NOW },
      {
        id: crypto.randomUUID(),
        fixtureId,
        playerId: p2,
        status: "waitlisted",
        waitlistPosition: 1,
        respondedAt: NOW,
        source: "token",
      },
    ]);

    const result = await getFixtureWithSquad(db, fixtureId);
    expect(result?.squad.find((m) => m.playerId === p2)?.waitlistRank).toBe(1);
  });
});

// Confidence that `openFixture` from M2.3 produces rows this read model can
// consume unchanged — the two features share the same responses table.
describe("getFixtureWithSquad against openFixture output", () => {
  it("lists every eligible player as pending", async () => {
    const gameId = await insertGame(db);
    const fixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: fixtureId,
      gameId,
      kicksOffAt: NOW,
      minPlayers: 10,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
    });

    const playerId = await insertPlayer("Eligible Player");
    await db.insert(memberships).values({
      id: crypto.randomUUID(),
      gameId,
      playerId,
    });

    await openFixture(db, fixtureId, NOW);

    const result = await getFixtureWithSquad(db, fixtureId);
    expect(result?.squad).toEqual([
      { playerId, name: "Eligible Player", status: "pending", waitlistRank: null },
    ]);
  });
});
