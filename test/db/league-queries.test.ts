import { beforeEach, describe, expect, it } from "vitest";
import {
  insertFixture,
  insertFixtureResult,
  insertGame,
  insertMembership,
  insertPlayer,
  insertResponse,
  resetDatabase,
  testDb,
} from "../support/factories.js";
import { squadLeagueTally } from "../../src/db/record-queries.js";
import { kickoffIn } from "../support/clock.js";
import type { Db } from "../../src/db/client.js";

// `fixtures` is unique on (game_id, kicks_off_at): every fixture needs its own.
let kickoffsUsed = 0;

/** One played fixture in `gameId`, with a result if `outcome` is given. */
async function playedFixture(
  db: Db,
  gameId: string,
  options: {
    outcome?: "a" | "b" | "draw";
    scoreA?: number;
    scoreB?: number;
    lifecycle?: "played" | "open";
  } = {},
): Promise<string> {
  kickoffsUsed += 1;
  const fixtureId = await insertFixture(db, gameId, {
    lifecycle: options.lifecycle ?? "played",
    kicksOffAt: kickoffIn(-24 * kickoffsUsed),
  });
  if (options.outcome !== undefined) {
    await insertFixtureResult(db, fixtureId, {
      outcome: options.outcome,
      scoreA: options.scoreA ?? null,
      scoreB: options.scoreB ?? null,
    });
  }
  return fixtureId;
}

describe("squadLeagueTally", () => {
  beforeEach(async () => {
    await resetDatabase();
    kickoffsUsed = 0;
  });

  it("counts a member's wins, losses and draws in this game", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "a@example.com", name: "Ada Okafor" });
    await insertMembership(db, gameId, playerId);

    const won = await playedFixture(db, gameId, { outcome: "a" });
    const lost = await playedFixture(db, gameId, { outcome: "b" });
    const drew = await playedFixture(db, gameId, { outcome: "draw" });
    for (const fixtureId of [won, lost, drew]) {
      await insertResponse(db, fixtureId, playerId, { status: "in", team: "a" });
    }

    expect(await squadLeagueTally(db, gameId)).toEqual([
      {
        playerId,
        name: "Ada Okafor",
        erasedAt: null,
        played: 3,
        won: 1,
        lost: 1,
        drawn: 1,
        goalsFor: 0,
        goalsAgainst: 0,
      },
    ]);
  });

  it("sums goals from the player's own side of the scoreline", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    await insertMembership(db, gameId, playerId);

    // On A for a 3-1 win, then on B for a 2-5 defeat: 5 for, 6 against.
    const first = await playedFixture(db, gameId, { outcome: "a", scoreA: 3, scoreB: 1 });
    await insertResponse(db, first, playerId, { status: "in", team: "a" });
    const second = await playedFixture(db, gameId, { outcome: "a", scoreA: 5, scoreB: 2 });
    await insertResponse(db, second, playerId, { status: "in", team: "b" });

    const [row] = await squadLeagueTally(db, gameId);
    expect(row).toMatchObject({ played: 2, won: 1, lost: 1, goalsFor: 5, goalsAgainst: 6 });
  });

  it("counts an outcome agreed without a score, but takes no goals from it", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    await insertMembership(db, gameId, playerId);

    const fixtureId = await playedFixture(db, gameId, { outcome: "a" });
    await insertResponse(db, fixtureId, playerId, { status: "in", team: "a" });

    const [row] = await squadLeagueTally(db, gameId);
    expect(row).toMatchObject({ played: 1, won: 1, goalsFor: 0, goalsAgainst: 0 });
  });

  it("counts a fixture with no side as played and nothing else", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    await insertMembership(db, gameId, playerId);

    const fixtureId = await playedFixture(db, gameId, { outcome: "draw", scoreA: 2, scoreB: 2 });
    await insertResponse(db, fixtureId, playerId, { status: "in", team: null });

    const [row] = await squadLeagueTally(db, gameId);
    expect(row).toMatchObject({ played: 1, won: 0, lost: 0, drawn: 0, goalsFor: 0 });
  });

  it("gives no row to a guest", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const guest = await insertPlayer(db, { email: null, name: "Dave's mate", isGuest: true });
    await insertMembership(db, gameId, guest);
    const fixtureId = await playedFixture(db, gameId, { outcome: "a" });
    await insertResponse(db, fixtureId, guest, { status: "in", team: "a" });

    expect(await squadLeagueTally(db, gameId)).toEqual([]);
  });

  it("gives no row to someone who has left the squad", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const gone = await insertPlayer(db, { email: "gone@example.com" });
    await insertMembership(db, gameId, gone, { active: false });
    const fixtureId = await playedFixture(db, gameId, { outcome: "a" });
    await insertResponse(db, fixtureId, gone, { status: "in", team: "a" });

    expect(await squadLeagueTally(db, gameId)).toEqual([]);
  });

  it("gives no row to a member who has not played", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    await insertMembership(db, gameId, playerId);
    const fixtureId = await playedFixture(db, gameId, { outcome: "a" });
    // Asked, said no.
    await insertResponse(db, fixtureId, playerId, { status: "out" });

    expect(await squadLeagueTally(db, gameId)).toEqual([]);
  });

  it("ignores a fixture that has not been played yet", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    await insertMembership(db, gameId, playerId);
    const fixtureId = await playedFixture(db, gameId, { lifecycle: "open" });
    await insertResponse(db, fixtureId, playerId, { status: "in", team: "a" });

    expect(await squadLeagueTally(db, gameId)).toEqual([]);
  });

  it("never counts a player's fixtures in another game", async () => {
    const db = testDb();
    const gameId = await insertGame(db, { name: "This Game" });
    const elsewhere = await insertGame(db, { name: "Another Game" });
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    await insertMembership(db, gameId, playerId);
    await insertMembership(db, elsewhere, playerId);

    const here = await playedFixture(db, gameId, { outcome: "a", scoreA: 1, scoreB: 0 });
    await insertResponse(db, here, playerId, { status: "in", team: "a" });
    const there = await playedFixture(db, elsewhere, { outcome: "a", scoreA: 9, scoreB: 0 });
    await insertResponse(db, there, playerId, { status: "in", team: "a" });

    const [row] = await squadLeagueTally(db, gameId);
    expect(row).toMatchObject({ played: 1, won: 1, goalsFor: 1, goalsAgainst: 0 });
  });

  it("carries an erased member's erasure date rather than deciding what to call them", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const erasedAt = new Date("2026-01-01T00:00:00Z");
    const playerId = await insertPlayer(db, {
      email: null,
      name: "[erased player]",
      erasedAt,
    });
    await insertMembership(db, gameId, playerId);
    const fixtureId = await playedFixture(db, gameId, { outcome: "a" });
    await insertResponse(db, fixtureId, playerId, { status: "in", team: "a" });

    const [row] = await squadLeagueTally(db, gameId);
    expect(row).toMatchObject({ name: "[erased player]", erasedAt });
  });

  it("has nothing to say about a game nobody has played", async () => {
    const db = testDb();
    const gameId = await insertGame(db);

    expect(await squadLeagueTally(db, gameId)).toEqual([]);
  });
});
