import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { responses } from "../../src/db/schema.js";
import { backfillOpenFixtureResponses } from "../../src/domain/backfill-open-responses.js";
import {
  insertFixture,
  insertGame,
  insertPlayer,
  insertResponse,
  resetDatabase,
  testDb,
} from "../support/factories.js";
import { kickoffIn } from "../support/clock.js";

describe("backfillOpenFixtureResponses", () => {
  beforeEach(resetDatabase);

  it("writes a pending row for each open fixture of the game (BR-2′)", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const openA = await insertFixture(db, gameId, { lifecycle: "open", kicksOffAt: kickoffIn(24) });
    const openB = await insertFixture(db, gameId, { lifecycle: "open", kicksOffAt: kickoffIn(48) });
    const playerId = await insertPlayer(db);

    const backfilled = await backfillOpenFixtureResponses(db, gameId, playerId);

    expect(backfilled.sort()).toEqual([openA, openB].sort());
    const rows = await db.select().from(responses).where(eq(responses.playerId, playerId));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("pending");
      expect(row.source).toBe("system");
    }
  });

  it("touches nothing outside this game's open fixtures", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    await insertFixture(db, gameId, { lifecycle: "scheduled", kicksOffAt: kickoffIn(24) });
    await insertFixture(db, gameId, { lifecycle: "cancelled", kicksOffAt: kickoffIn(48) });
    await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: kickoffIn(72) });
    const otherGameId = await insertGame(db);
    await insertFixture(db, otherGameId, { lifecycle: "open" });
    const playerId = await insertPlayer(db);

    const backfilled = await backfillOpenFixtureResponses(db, gameId, playerId);

    expect(backfilled).toEqual([]);
    expect(await db.select().from(responses).where(eq(responses.playerId, playerId))).toHaveLength(0);
  });

  it("leaves a withdrawn row untouched and does not report that fixture", async () => {
    // BR-3's marker survives a rejoin: an anonymous invite link must not undo
    // an organiser's removal from a fixture already underway.
    const db = testDb();
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open" });
    const playerId = await insertPlayer(db);
    await insertResponse(db, fixtureId, playerId, { status: "withdrawn" });

    const backfilled = await backfillOpenFixtureResponses(db, gameId, playerId);

    expect(backfilled).toEqual([]);
    const rows = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, playerId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("withdrawn");
  });

  it("is idempotent: a second call inserts nothing and reports nothing", async () => {
    const db = testDb();
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "open" });
    const playerId = await insertPlayer(db);

    expect(await backfillOpenFixtureResponses(db, gameId, playerId)).toEqual([fixtureId]);
    expect(await backfillOpenFixtureResponses(db, gameId, playerId)).toEqual([]);
    expect(await db.select().from(responses).where(eq(responses.playerId, playerId))).toHaveLength(1);
  });
});
