import { beforeEach, describe, expect, it } from "vitest";
import { fixtureResultClaims } from "../../src/db/schema.js";
import { insertFixture, insertGame, insertPlayer, insertResultClaim, resetDatabase, testDb } from "../support/factories.js";

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
