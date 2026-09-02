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
import { playerRecordByGame } from "../../src/db/record-queries.js";
import { kickoffIn } from "../support/clock.js";
import type { Db } from "../../src/db/client.js";

// `fixtures` is unique on (game_id, kicks_off_at), so every fixture a case
// builds needs its own kickoff. Reset per test by `resetDatabase`'s sibling
// below rather than shared across the file, so a case reads the same however
// many ran before it.
let kickoffsUsed = 0;

/**
 * One played fixture this player was in, with an optional side and an
 * optional settled result — the four-way shape every case below varies.
 */
async function playedFixture(
  db: Db,
  gameId: string,
  playerId: string,
  options: {
    team?: "a" | "b";
    outcome?: "a" | "b" | "draw";
    status?: "in" | "out" | "waitlisted" | "pending";
    lifecycle?: "played" | "open" | "cancelled";
  } = {},
): Promise<string> {
  kickoffsUsed += 1;
  const fixtureId = await insertFixture(db, gameId, {
    lifecycle: options.lifecycle ?? "played",
    kicksOffAt: kickoffIn(-24 * kickoffsUsed),
  });
  await insertResponse(db, fixtureId, playerId, {
    status: options.status ?? "in",
    team: options.team ?? null,
  });
  if (options.outcome !== undefined) {
    await insertFixtureResult(db, fixtureId, { outcome: options.outcome });
  }
  return fixtureId;
}

describe("playerRecordByGame", () => {
  beforeEach(async () => {
    await resetDatabase();
    kickoffsUsed = 0;
  });

  it("counts a fixture whose result matches the player's side as a win", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db, { name: "Thursday Footy" });
    await insertMembership(db, gameId, playerId);
    await playedFixture(db, gameId, playerId, { team: "a", outcome: "a" });

    expect(await playerRecordByGame(db, playerId)).toEqual([
      { gameId, gameName: "Thursday Footy", played: 1, won: 1, lost: 0, drawn: 0 },
    ]);
  });

  it("counts a fixture whose result names the other side as a loss", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, playerId);
    await playedFixture(db, gameId, playerId, { team: "a", outcome: "b" });

    const [record] = await playerRecordByGame(db, playerId);
    expect(record).toMatchObject({ played: 1, won: 0, lost: 1, drawn: 0 });
  });

  it("counts a drawn fixture as drawn for whichever side the player was on", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, playerId);
    await playedFixture(db, gameId, playerId, { team: "b", outcome: "draw" });

    const [record] = await playerRecordByGame(db, playerId);
    expect(record).toMatchObject({ played: 1, won: 0, lost: 0, drawn: 1 });
  });

  it("counts a fixture with no settled result as played and nothing else", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, playerId);
    await playedFixture(db, gameId, playerId, { team: "a" });

    const [record] = await playerRecordByGame(db, playerId);
    expect(record).toMatchObject({ played: 1, won: 0, lost: 0, drawn: 0 });
  });

  it("counts a settled fixture the player has no side in as played and nothing else", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, playerId);
    // Teams were never picked, so a draw is no more attributable than a win.
    await playedFixture(db, gameId, playerId, { outcome: "draw" });

    const [record] = await playerRecordByGame(db, playerId);
    expect(record).toMatchObject({ played: 1, won: 0, lost: 0, drawn: 0 });
  });

  it("ignores a fixture the player was not in", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, playerId);
    await playedFixture(db, gameId, playerId, { status: "out", outcome: "a", team: "a" });
    await playedFixture(db, gameId, playerId, { status: "waitlisted" });
    await playedFixture(db, gameId, playerId, { status: "pending" });

    expect(await playerRecordByGame(db, playerId)).toEqual([]);
  });

  it("ignores a fixture that has not been played yet", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, playerId);
    await playedFixture(db, gameId, playerId, { lifecycle: "open", team: "a" });
    await playedFixture(db, gameId, playerId, { lifecycle: "cancelled", team: "a" });

    expect(await playerRecordByGame(db, playerId)).toEqual([]);
  });

  it("keeps the record of a game the player has since left", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const gameId = await insertGame(db, { name: "Old Sunday League" });
    await insertMembership(db, gameId, playerId, { active: false });
    await playedFixture(db, gameId, playerId, { team: "a", outcome: "a" });

    expect(await playerRecordByGame(db, playerId)).toEqual([
      { gameId, gameName: "Old Sunday League", played: 1, won: 1, lost: 0, drawn: 0 },
    ]);
  });

  it("never counts another player's fixtures", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const other = await insertPlayer(db, { email: "b@example.com" });
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, playerId);
    await insertMembership(db, gameId, other);
    const fixtureId = await playedFixture(db, gameId, playerId, { team: "a", outcome: "a" });
    // The same fixture, the losing side, somebody else.
    await insertResponse(db, fixtureId, other, { status: "in", team: "b" });

    expect(await playerRecordByGame(db, playerId)).toEqual([
      { gameId, gameName: "Thursday 7-a-side", played: 1, won: 1, lost: 0, drawn: 0 },
    ]);
  });

  it("returns one row per game, most played first", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const quiet = await insertGame(db, { name: "Quiet Game" });
    const busy = await insertGame(db, { name: "Busy Game" });
    await insertMembership(db, quiet, playerId);
    await insertMembership(db, busy, playerId);
    await playedFixture(db, quiet, playerId, { team: "a", outcome: "b" });
    await playedFixture(db, busy, playerId, { team: "a", outcome: "a" });
    await playedFixture(db, busy, playerId, { team: "b", outcome: "b" });

    expect(await playerRecordByGame(db, playerId)).toEqual([
      { gameId: busy, gameName: "Busy Game", played: 2, won: 2, lost: 0, drawn: 0 },
      { gameId: quiet, gameName: "Quiet Game", played: 1, won: 0, lost: 1, drawn: 0 },
    ]);
  });

  it("has nothing to say about a player who has played nothing", async () => {
    const db = testDb();
    const playerId = await insertPlayer(db, { email: "a@example.com" });

    expect(await playerRecordByGame(db, playerId)).toEqual([]);
  });
});
