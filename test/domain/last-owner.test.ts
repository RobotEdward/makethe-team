import { beforeEach, describe, expect, it } from "vitest";
import { isLastActiveOwner } from "../../src/domain/last-owner.js";
import { insertGame, insertMembership, insertPlayer, resetDatabase, testDb } from "../support/factories.js";

describe("isLastActiveOwner", () => {
  beforeEach(resetDatabase);

  it("is true for the only owner", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });
    await insertMembership(db, gameId, await insertPlayer(db), { role: "player" });

    expect(await isLastActiveOwner(db, gameId, { role: "owner", active: true })).toBe(true);
  });

  it("is false when a co-owner remains", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });

    expect(await isLastActiveOwner(db, gameId, { role: "owner", active: true })).toBe(false);
  });

  it("is false for an ordinary player, however few owners there are", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });

    expect(await isLastActiveOwner(db, gameId, { role: "player", active: true })).toBe(false);
  });

  it("is false for an already-inactive owner, who is not counted", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    await insertMembership(db, gameId, await insertPlayer(db), { role: "owner" });

    expect(await isLastActiveOwner(db, gameId, { role: "owner", active: false })).toBe(false);
  });
});
