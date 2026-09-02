import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, players, responses } from "../../src/db/schema.js";
import { getFixtureWithSquad, listTeamAssignments, findMembershipInGame, countActiveOwners, listOpenFixtureIds, countCommitments, listPastFixturesForGame } from "../../src/db/queries.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { insertGame, resetDatabase, testDb, insertPlayer as insertPlayerFactory, insertMembership, insertFixture, insertResponse } from "../support/factories.js";

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
      {
        playerId,
        name: "Eligible Player",
        erasedAt: null,
        status: "pending",
        team: null,
        waitlistRank: null,
        setBy: null,
        source: "system",
        isGuest: false,
        // M46: carried so the organiser's page can offer "invite now" on the
        // rows the invite order has not reached. Null here, and forever on an
        // ungated Game, where nothing stamps it.
        invitedAt: null,
      },
    ]);
  });
});

describe("getFixtureWithSquad — attribution and guests", () => {
  let fixtureId: string;

  beforeEach(async () => {
    const gameId = await insertGame(db);
    fixtureId = await insertFixture(db, gameId, { minPlayers: 1, maxPlayers: 14 });
    await db.insert(players).values({ id: "o-1", name: "Olivia Nightingale", email: "o1@example.com" });
    await db.insert(players).values({ id: "p-1", name: "Priya Raman", email: "p1@example.com" });
    await db.insert(players).values({ id: "p-2", name: "Sam Okafor", email: "p2@example.com" });
    await insertMembership(db, gameId, "o-1", { role: "owner" });
    await insertMembership(db, gameId, "p-1");
    await insertMembership(db, gameId, "p-2");
    await openFixture(db, fixtureId, NOW);

    // Owner `o-1` marks `p-1` in — written through the Durable Object so the
    // row is stamped the way production writes it.
    await env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
      playerId: "p-1",
      intent: "in",
      actorPlayerId: "o-1",
      source: "owner",
      whenFull: "waitlist",
      now: NOW.getTime(),
    });
    // `p-2` answers for themselves.
    await env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
      playerId: "p-2",
      intent: "in",
      actorPlayerId: null,
      source: "token",
      whenFull: "waitlist",
      now: NOW.getTime(),
    });
    await env.FIXTURE_CAPACITY.getByName(fixtureId).addGuest({
      name: "Sam Whitlock",
      actorPlayerId: "o-1",
      whenFull: "refuse",
      now: NOW.getTime(),
    });
  });

  it("reports who set a response when an owner set it", async () => {
    const result = await getFixtureWithSquad(db, fixtureId);
    const member = result!.squad.find((m) => m.playerId === "p-1")!;

    expect(member.setBy).toEqual({ playerId: "o-1", name: "Olivia Nightingale", erasedAt: null });
    expect(member.source).toBe("owner");
    expect(member.isGuest).toBe(false);
  });

  /**
   * §4: "Renderers must branch on `erased_at`". They cannot branch on a column
   * the query does not return, and until the final review this one did not
   * return it — for the member or for BR-27's setter — so `[erased player]`
   * reached the screen in both positions.
   */
  it("carries erased_at for the member and for whoever set their response", async () => {
    const erasedAt = new Date("2026-08-20T09:00:00Z");
    await db.update(players).set({ erasedAt }).where(eq(players.id, "o-1"));
    await db.update(players).set({ erasedAt }).where(eq(players.id, "p-2"));

    const result = await getFixtureWithSquad(db, fixtureId);

    const setByErased = result!.squad.find((m) => m.playerId === "p-1")!;
    expect(setByErased.erasedAt).toBeNull();
    expect(setByErased.setBy?.erasedAt?.getTime()).toBe(erasedAt.getTime());

    const erasedMember = result!.squad.find((m) => m.playerId === "p-2")!;
    expect(erasedMember.erasedAt?.getTime()).toBe(erasedAt.getTime());
  });

  it("reports no setter for a player who answered for themselves", async () => {
    const result = await getFixtureWithSquad(db, fixtureId);
    const member = result!.squad.find((m) => m.playerId === "p-2")!;

    expect(member.setBy).toBeNull();
    expect(member.source).toBe("token");
  });

  it("marks a guest as one", async () => {
    const result = await getFixtureWithSquad(db, fixtureId);
    const guest = result!.squad.find((m) => m.name === "Sam Whitlock")!;

    expect(guest.isGuest).toBe(true);
  });
});

describe("listTeamAssignments", () => {
  // Pins the one property that gives this query a reason to exist: unlike
  // `getFixtureWithSquad`, it must NOT filter out `withdrawn` rows. Leaving a
  // game (M7a), being removed by an organiser (J6a) and being erased (M7b)
  // all write `withdrawn` while leaving `team` untouched, and
  // `teamsNeedAnotherLook` (src/domain/teams.ts) depends on seeing that row
  // to detect the most common way published teams go stale. If someone later
  // "tidied up" this query to match the `ne(responses.status, "withdrawn")`
  // filter that sits a few dozen lines above it in this same file, the whole
  // suite would still pass and staleness detection would silently break —
  // this test is what would catch that.
  it("includes a withdrawn player's team, unlike getFixtureWithSquad", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId);
    const playerId = await insertPlayerFactory(db);
    await insertMembership(db, gameId, playerId);
    await insertResponse(db, fixtureId, playerId, { status: "withdrawn", team: "a" });

    const assignments = await listTeamAssignments(db, fixtureId);
    expect(assignments).toEqual([{ playerId, status: "withdrawn", team: "a" }]);

    const squad = await getFixtureWithSquad(db, fixtureId);
    expect(squad?.squad.find((m) => m.playerId === playerId)).toBeUndefined();
  });
});

describe("findMembershipInGame", () => {
  beforeEach(resetDatabase);

  it("finds an active member of that game", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayerFactory(db, { name: "Sam Okafor" });
    const membershipId = await insertMembership(db, gameId, playerId, { role: "owner" });

    const found = await findMembershipInGame(db, gameId, playerId);
    expect(found).toMatchObject({ membershipId, playerId, name: "Sam Okafor", role: "owner", active: true });
  });

  it("returns null for a membership in a different game", async () => {
    const db = testDb();
    const [mine, theirs] = [await insertGame(db), await insertGame(db)];
    const playerId = await insertPlayerFactory(db);
    await insertMembership(db, theirs, playerId);

    // The scoping that stops `:playerId` reading as a global identifier.
    expect(await findMembershipInGame(db, mine, playerId)).toBeNull();
  });

  it("returns an inactive membership rather than hiding it", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayerFactory(db);
    await insertMembership(db, gameId, playerId, { active: false });

    // Callers decide what an inactive membership means; this query reports it.
    expect(await findMembershipInGame(db, gameId, playerId)).toMatchObject({ active: false });
  });
});

describe("countActiveOwners", () => {
  beforeEach(resetDatabase);

  it("counts only active owners of that game", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const other = await insertGame(db);
    await insertMembership(db, gameId, await insertPlayerFactory(db), { role: "owner" });
    await insertMembership(db, gameId, await insertPlayerFactory(db), { role: "owner", active: false });
    await insertMembership(db, gameId, await insertPlayerFactory(db), { role: "player" });
    await insertMembership(db, other, await insertPlayerFactory(db), { role: "owner" });

    expect(await countActiveOwners(db, gameId)).toBe(1);
  });
});

describe("listOpenFixtureIds", () => {
  beforeEach(resetDatabase);

  it("returns only this game's open fixtures", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const other = await insertGame(db);
    const open = await insertFixture(db, gameId, { lifecycle: "open" });
    await insertFixture(db, gameId, { lifecycle: "scheduled", kicksOffAt: new Date("2026-08-21T18:00:00Z") });
    await insertFixture(db, gameId, { lifecycle: "cancelled", kicksOffAt: new Date("2026-08-22T18:00:00Z") });
    await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: new Date("2026-08-23T18:00:00Z") });
    await insertFixture(db, other, { lifecycle: "open" });

    expect(await listOpenFixtureIds(db, gameId)).toEqual([open]);
  });
});

describe("countCommitments", () => {
  beforeEach(resetDatabase);

  it("counts a player's in and waitlisted rows on this game's open fixtures", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayerFactory(db);
    const a = await insertFixture(db, gameId, { lifecycle: "open" });
    const b = await insertFixture(db, gameId, { lifecycle: "open", kicksOffAt: new Date("2026-08-21T18:00:00Z") });
    const c = await insertFixture(db, gameId, { lifecycle: "open", kicksOffAt: new Date("2026-08-22T18:00:00Z") });
    await insertResponse(db, a, playerId, { status: "in" });
    await insertResponse(db, b, playerId, { status: "waitlisted", waitlistPosition: 1 });
    await insertResponse(db, c, playerId, { status: "pending" });

    expect(await countCommitments(db, gameId, playerId)).toEqual({ in: 1, waitlisted: 1 });
  });
});

/**
 * `listPastFixturesForGame` (M27) — the organiser's half of the past-fixtures
 * page. Its sibling `listUpcomingFixtures` is bounded the other way and
 * filters no lifecycle either; this one is the mirror image, and both are
 * separate functions rather than one with a direction flag because the name
 * is what tells the next reader which way a row sorts.
 */
describe("listPastFixturesForGame", () => {
  const PAST = new Date("2026-08-01T18:00:00Z");
  const OLDER = new Date("2026-07-01T18:00:00Z");
  const FUTURE = new Date("2026-09-01T18:00:00Z");

  it("returns fixtures before now, most recent first", async () => {
    const gameId = await insertGame(db);
    const older = await insertFixture(db, gameId, { kicksOffAt: OLDER, lifecycle: "played" });
    const newer = await insertFixture(db, gameId, { kicksOffAt: PAST, lifecycle: "played" });

    const rows = await listPastFixturesForGame(db, gameId, NOW, 50);

    expect(rows.map((row) => row.id)).toEqual([newer, older]);
  });

  it("excludes a fixture that has not kicked off yet", async () => {
    const gameId = await insertGame(db);
    await insertFixture(db, gameId, { kicksOffAt: FUTURE });
    const past = await insertFixture(db, gameId, { kicksOffAt: PAST, lifecycle: "played" });

    const rows = await listPastFixturesForGame(db, gameId, NOW, 50);

    expect(rows.map((row) => row.id)).toEqual([past]);
  });

  it("includes a cancelled one — an organiser asking what happened is better served by seeing it", async () => {
    const gameId = await insertGame(db);
    const cancelled = await insertFixture(db, gameId, { kicksOffAt: PAST, lifecycle: "cancelled" });

    const rows = await listPastFixturesForGame(db, gameId, NOW, 50);

    expect(rows.map((row) => row.id)).toEqual([cancelled]);
    expect(rows[0]!.lifecycle).toBe("cancelled");
  });

  it("excludes another game's fixtures", async () => {
    const gameId = await insertGame(db);
    const otherGameId = await insertGame(db, { name: "Someone Else's Game" });
    await insertFixture(db, otherGameId, { kicksOffAt: PAST, lifecycle: "played" });
    const mine = await insertFixture(db, gameId, { kicksOffAt: PAST, lifecycle: "played" });

    const rows = await listPastFixturesForGame(db, gameId, NOW, 50);

    expect(rows.map((row) => row.id)).toEqual([mine]);
  });

  it("stops at the limit, keeping the most recent (TR-38)", async () => {
    const gameId = await insertGame(db);
    for (let i = 1; i <= 4; i++) {
      await insertFixture(db, gameId, {
        kicksOffAt: new Date(PAST.getTime() - i * 86_400_000),
        lifecycle: "played",
      });
    }

    const rows = await listPastFixturesForGame(db, gameId, NOW, 2);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.kicksOffAt.getTime()).toBeGreaterThan(rows[1]!.kicksOffAt.getTime());
  });
});
