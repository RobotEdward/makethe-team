import { beforeEach, describe, expect, it } from "vitest";
import { fixtureResultClaims } from "../../src/db/schema.js";
import {
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  insertResultClaim,
  resetDatabase,
  testDb,
} from "../support/factories.js";
import {
  deleteResultClaim,
  listResultClaims,
  putResultClaim,
  resultElectorate,
} from "../../src/db/result-queries.js";

describe("fixture_result_claims", () => {
  beforeEach(resetDatabase);

  it("allows one claim per player per fixture and refuses a second", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played" });

    await insertResultClaim(db, fixtureId, playerId, { outcome: "a", scoreA: 3, scoreB: 2 });

    await expect(
      insertResultClaim(db, fixtureId, playerId, { outcome: "draw" }),
    ).rejects.toThrow();
  });

  it("allows the same player a claim on a different fixture", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db);
    const one = await insertFixture(db, gameId, { lifecycle: "played" });
    const two = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: new Date("2026-08-20T18:00:00Z"),
    });

    await insertResultClaim(db, one, playerId, { outcome: "a" });
    await insertResultClaim(db, two, playerId, { outcome: "b" });

    const rows = await db.select().from(fixtureResultClaims);
    expect(rows).toHaveLength(2);
  });
});

describe("resultElectorate", () => {
  beforeEach(resetDatabase);

  it("is everyone who was in, plus every active owner, and no guest", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const inPlayer = await insertPlayer(db, { email: "in@example.com" });
    const outPlayer = await insertPlayer(db, { email: "out@example.com" });
    const owner = await insertPlayer(db, { email: "owner@example.com" });
    const formerOwner = await insertPlayer(db, { email: "former@example.com" });
    const guest = await insertPlayer(db, { name: "Guest", isGuest: true });
    for (const id of [inPlayer, outPlayer, guest]) await insertMembership(db, gameId, id);
    await insertMembership(db, gameId, owner, { role: "owner" });
    await insertMembership(db, gameId, formerOwner, { role: "owner", active: false });

    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played" });
    await insertResponse(db, fixtureId, inPlayer, { status: "in" });
    await insertResponse(db, fixtureId, outPlayer, { status: "out" });
    await insertResponse(db, fixtureId, guest, { status: "in" });

    const { eligibleIds, organiserIds } = await resultElectorate(db, gameId, fixtureId);

    expect(eligibleIds.has(inPlayer)).toBe(true);
    expect(eligibleIds.has(owner)).toBe(true);
    // A guest has an `in` row and no account. They are on the roster and can
    // never file; `requirePlayer` is what actually stops them, and this set
    // must agree with it or the turnout denominator lies.
    expect(eligibleIds.has(guest)).toBe(false);
    expect(eligibleIds.has(outPlayer)).toBe(false);
    expect(eligibleIds.has(formerOwner)).toBe(false);
    expect(organiserIds).toEqual(new Set([owner]));
  });
});

describe("putResultClaim", () => {
  beforeEach(resetDatabase);

  it("files once and then updates in place, moving filedAt", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played" });
    const first = new Date("2026-08-14T09:00:00Z");
    const second = new Date("2026-08-14T10:00:00Z");

    await putResultClaim(db, { fixtureId, playerId, outcome: "a", scoreA: 3, scoreB: 2, now: first });
    await putResultClaim(db, { fixtureId, playerId, outcome: "b", scoreA: 2, scoreB: 3, now: second });

    const claims = await listResultClaims(db, fixtureId);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.outcome).toBe("b");
    // `filed_at` answers "how long has this position been held?", which is the
    // last tie-break. A player who switched an hour ago has not been backing
    // the new position since this morning.
    expect(claims[0]?.filedAt.getTime()).toBe(second.getTime());
  });

  it("clears a score when the player moves to an outcome-only claim", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played" });
    const now = new Date("2026-08-14T09:00:00Z");

    await putResultClaim(db, { fixtureId, playerId, outcome: "a", scoreA: 3, scoreB: 2, now });
    await putResultClaim(db, { fixtureId, playerId, outcome: "a", scoreA: null, scoreB: null, now });

    const [claim] = await listResultClaims(db, fixtureId);
    expect(claim?.scoreA).toBeNull();
    expect(claim?.scoreB).toBeNull();
  });
});

describe("deleteResultClaim", () => {
  beforeEach(resetDatabase);

  it("removes only the caller's own row and reports whether there was one", async () => {
    const db = testDb();
    const mine = await insertPlayer(db, { email: "a@example.com" });
    const theirs = await insertPlayer(db, { email: "b@example.com" });
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played" });
    await insertResultClaim(db, fixtureId, mine, { outcome: "a" });
    await insertResultClaim(db, fixtureId, theirs, { outcome: "b" });

    expect(await deleteResultClaim(db, fixtureId, mine)).toBe(true);
    expect(await deleteResultClaim(db, fixtureId, mine)).toBe(false);
    expect(await listResultClaims(db, fixtureId)).toHaveLength(1);
  });
});

describe("listResultClaims", () => {
  beforeEach(resetDatabase);

  it("carries the erasure marker so a renderer never prints the placeholder", async () => {
    const db = testDb();
    const erasedAt = new Date("2026-08-01T00:00:00Z");
    const playerId = await insertPlayer(db, { name: "[erased player]", erasedAt });
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played" });
    await insertResultClaim(db, fixtureId, playerId, { outcome: "a" });

    expect((await listResultClaims(db, fixtureId))[0]?.erasedAt?.getTime()).toBe(erasedAt.getTime());
  });
});
