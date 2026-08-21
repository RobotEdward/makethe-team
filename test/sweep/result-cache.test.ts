import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import type { Db } from "../../src/db/client.js";
import { INSERT_CHUNK_SIZE } from "../../src/db/chunk.js";
import { auditLog, fixtureResults } from "../../src/db/schema.js";
import { deriveResult } from "../../src/domain/result.js";
import { listResultClaims, resultElectorate } from "../../src/db/result-queries.js";
import { materialiseResults } from "../../src/sweep/result-cache.js";
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

const db = testDb();

const KICKOFF = new Date("2026-08-13T19:00:00Z");
// `resultDeadline` is kickoff + 48h; kept as its own constant here rather than
// imported from `src/domain/result-lock.ts`, so this suite still catches a
// change to that window instead of silently tracking it.
const DEADLINE = new Date(KICKOFF.getTime() + 48 * 60 * 60 * 1000);
const BEFORE_DEADLINE = new Date(DEADLINE.getTime() - 1);
const AFTER_DEADLINE = new Date(DEADLINE.getTime() + 1);

async function cachedRow(fixtureId: string) {
  const [row] = await db.select().from(fixtureResults).where(eq(fixtureResults.fixtureId, fixtureId));
  return row;
}

/**
 * A `db` that throws when reading `fixture_result_claims` for one specific
 * fixture, standing in for a genuine D1 outage on that one query — the
 * shape of `RejectingNotifier` in `test/sweep/attention.test.ts`, adapted to
 * this module's only dependency being the database itself rather than a
 * `Notifier`.
 *
 * Scoped two ways so it cannot leak into queries this test does not intend to
 * break: `sql.includes("fixture_result_claims")` keeps it off the candidate
 * select and the `fixture_results` (no `_claims`) already-cached lookup, and
 * `args.includes(brokenFixtureId)` keeps it off every other fixture's own
 * claims read.
 */
function dbThatFailsReadingClaimsFor(brokenFixtureId: string): Db {
  const proxied = new Proxy(env.DB, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      const prepare = value as (sql: string) => D1PreparedStatement;
      return (sql: string) => {
        const stmt = prepare.call(target, sql);
        if (!sql.includes("fixture_result_claims")) return stmt;
        return new Proxy(stmt, {
          get(stmtTarget, stmtProp) {
            const stmtValue = Reflect.get(stmtTarget, stmtProp, stmtTarget);
            if (stmtProp !== "bind") {
              return typeof stmtValue === "function" ? stmtValue.bind(stmtTarget) : stmtValue;
            }
            const bind = stmtValue as (...args: unknown[]) => unknown;
            return (...args: unknown[]) => {
              if (args.includes(brokenFixtureId)) {
                throw new Error(`simulated D1 failure reading claims for fixture ${brokenFixtureId}`);
              }
              return bind.apply(stmtTarget, args);
            };
          },
        });
      };
    },
  }) as D1Database;
  return getDb(proxied);
}

/**
 * A `db` that throws when *writing* `fixture_results` for one specific
 * fixture — the write-phase counterpart to `dbThatFailsReadingClaimsFor`
 * above, standing in for a genuine D1 outage on the batch that commits the
 * cache row and its audit row together.
 *
 * Scoped to an `insert into "fixture_results"` statement specifically (not
 * merely any statement mentioning the table) so the read-only `alreadyCached`
 * lookup in `materialiseResults` — which also names `fixture_results`, in a
 * `select` — is untouched.
 */
function dbThatFailsWritingResultFor(brokenFixtureId: string): Db {
  const proxied = new Proxy(env.DB, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "prepare") return typeof value === "function" ? value.bind(target) : value;
      const prepare = value as (sql: string) => D1PreparedStatement;
      return (sql: string) => {
        const stmt = prepare.call(target, sql);
        if (!sql.toLowerCase().startsWith('insert into "fixture_results"')) return stmt;
        return new Proxy(stmt, {
          get(stmtTarget, stmtProp) {
            const stmtValue = Reflect.get(stmtTarget, stmtProp, stmtTarget);
            if (stmtProp !== "bind") {
              return typeof stmtValue === "function" ? stmtValue.bind(stmtTarget) : stmtValue;
            }
            const bind = stmtValue as (...args: unknown[]) => unknown;
            return (...args: unknown[]) => {
              if (args.includes(brokenFixtureId)) {
                throw new Error(`simulated D1 failure writing fixture_results for fixture ${brokenFixtureId}`);
              }
              return bind.apply(stmtTarget, args);
            };
          },
        });
      };
    },
  }) as D1Database;
  return getDb(proxied);
}

beforeEach(resetDatabase);

describe("materialiseResults", () => {
  it("writes nothing before the deadline", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: KICKOFF });
    await insertResponse(db, fixtureId, playerId, { status: "in" });
    await insertResultClaim(db, fixtureId, playerId, { outcome: "a", filedAt: KICKOFF });

    const outcome = await materialiseResults(db, BEFORE_DEADLINE);

    expect(outcome.considered).toBe(1);
    expect(outcome.written).toBe(0);
    expect(outcome.failures).toHaveLength(0);
    expect(await cachedRow(fixtureId)).toBeUndefined();
  });

  it("writes the derived result once the deadline has passed", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: KICKOFF });
    await insertResponse(db, fixtureId, playerId, { status: "in" });
    await insertResultClaim(db, fixtureId, playerId, { outcome: "a", filedAt: KICKOFF });

    const outcome = await materialiseResults(db, AFTER_DEADLINE);

    expect(outcome.written).toBe(1);
    const row = await cachedRow(fixtureId);
    expect(row?.outcome).toBe("a");
  });

  it("writes nothing for a fixture nobody filed on", async () => {
    const gameId = await insertGame(db);
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: KICKOFF });

    // Long past the deadline, and still nobody has filed: `claims.length ===
    // 0` keeps `isResultLocked` false forever, exactly as the fixture-page
    // refusal reads it.
    const outcome = await materialiseResults(db, new Date(DEADLINE.getTime() + 30 * 24 * 60 * 60 * 1000));

    expect(outcome.written).toBe(0);
    expect(await cachedRow(fixtureId)).toBeUndefined();
  });

  it("writes for a fixture whose only claim was filed late, immediately", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: KICKOFF });
    await insertResponse(db, fixtureId, playerId, { status: "in" });
    // Filed three days after kickoff — a day after the ordinary deadline.
    const lateFiling = new Date(KICKOFF.getTime() + 72 * 60 * 60 * 1000);
    await insertResultClaim(db, fixtureId, playerId, { outcome: "b", filedAt: lateFiling });

    // Run at the very instant of the late filing: no separate 48-hour wait
    // after a claim that already arrived after the window (`resultLockedAt`'s
    // "later of the deadline and the earliest claim").
    const outcome = await materialiseResults(db, lateFiling);

    expect(outcome.written).toBe(1);
    const row = await cachedRow(fixtureId);
    expect(row?.outcome).toBe("b");
    expect(row?.lockedAt.getTime()).toBe(lateFiling.getTime());
  });

  it("does not rewrite a row it has already written", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: KICKOFF });
    await insertResponse(db, fixtureId, playerId, { status: "in" });
    await insertResultClaim(db, fixtureId, playerId, { outcome: "a", filedAt: KICKOFF });

    const first = await materialiseResults(db, AFTER_DEADLINE);
    expect(first.written).toBe(1);
    const firstRow = await cachedRow(fixtureId);

    // A later run, at a distinctly later `now`, must leave the cached row
    // untouched — the whole point of selecting only fixtures with no
    // existing row (see the module's doc comment).
    const second = await materialiseResults(db, new Date(AFTER_DEADLINE.getTime() + 24 * 60 * 60 * 1000));
    expect(second.considered).toBe(0);
    expect(second.written).toBe(0);
    const secondRow = await cachedRow(fixtureId);
    expect(secondRow?.materialisedAt.getTime()).toBe(firstRow?.materialisedAt.getTime());
  });

  it("records the turnout denominator as the electorate, not the voters", async () => {
    const gameId = await insertGame(db);
    const owner = await insertPlayer(db, { email: "owner@example.com" });
    const voter = await insertPlayer(db, { email: "voter@example.com" });
    const nonVoterOne = await insertPlayer(db, { email: "nv1@example.com" });
    const nonVoterTwo = await insertPlayer(db, { email: "nv2@example.com" });
    await insertMembership(db, gameId, owner, { role: "owner" });
    for (const id of [voter, nonVoterOne, nonVoterTwo]) await insertMembership(db, gameId, id);

    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: KICKOFF });
    await insertResponse(db, fixtureId, voter, { status: "in" });
    await insertResponse(db, fixtureId, nonVoterOne, { status: "in" });
    await insertResponse(db, fixtureId, nonVoterTwo, { status: "in" });
    // Only the owner and one player file a claim — two voters out of an
    // electorate of four (owner + three `in` players).
    await insertResultClaim(db, fixtureId, owner, { outcome: "a", filedAt: KICKOFF });
    await insertResultClaim(db, fixtureId, voter, { outcome: "a", filedAt: KICKOFF });

    await materialiseResults(db, AFTER_DEADLINE);

    const row = await cachedRow(fixtureId);
    expect(row?.voterCount).toBe(2);
    expect(row?.eligibleCount).toBe(4);
  });

  it("records rostered:false when the teams were never published", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: KICKOFF,
      teamsPublishedAt: null,
    });
    await insertResponse(db, fixtureId, playerId, { status: "in" });
    await insertResultClaim(db, fixtureId, playerId, { outcome: "a", filedAt: KICKOFF });

    await materialiseResults(db, AFTER_DEADLINE);

    const row = await cachedRow(fixtureId);
    expect(row?.rostered).toBe(false);
  });

  it("records teamsAccurate:false when a player who has a side is no longer in", async () => {
    const gameId = await insertGame(db);
    const stillIn = await insertPlayer(db, { email: "still-in@example.com" });
    const droppedOut = await insertPlayer(db, { email: "dropped@example.com" });
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: KICKOFF,
      teamsPublishedAt: KICKOFF,
    });
    await insertResponse(db, fixtureId, stillIn, { status: "in", team: "a" });
    // Kept their side after leaving — condition 2 of `teams.ts`'s staleness,
    // which only the *unfiltered* row set (`listTeamAssignments`) can see.
    await insertResponse(db, fixtureId, droppedOut, { status: "withdrawn", team: "b" });
    await insertResultClaim(db, fixtureId, stillIn, { outcome: "a", filedAt: KICKOFF });

    await materialiseResults(db, AFTER_DEADLINE);

    const row = await cachedRow(fixtureId);
    expect(row?.teamsAccurate).toBe(false);
    expect(row?.rostered).toBe(true);
  });

  it("records teamsAccurate:true for a clean published pick", async () => {
    const gameId = await insertGame(db);
    const playerA = await insertPlayer(db, { email: "a@example.com" });
    const playerB = await insertPlayer(db, { email: "b@example.com" });
    const fixtureId = await insertFixture(db, gameId, {
      lifecycle: "played",
      kicksOffAt: KICKOFF,
      teamsPublishedAt: KICKOFF,
      teamsSavedAt: new Date(KICKOFF.getTime() - 60_000),
    });
    await insertResponse(db, fixtureId, playerA, { status: "in", team: "a" });
    await insertResponse(db, fixtureId, playerB, { status: "in", team: "b" });
    await insertResultClaim(db, fixtureId, playerA, { outcome: "draw", filedAt: KICKOFF });

    await materialiseResults(db, AFTER_DEADLINE);

    const row = await cachedRow(fixtureId);
    expect(row?.teamsAccurate).toBe(true);
    expect(row?.rostered).toBe(true);
  });

  it("stores exactly what deriveResult says", async () => {
    const gameId = await insertGame(db);
    const owner = await insertPlayer(db, { email: "owner@example.com" });
    const players = await Promise.all(
      ["p1@example.com", "p2@example.com", "p3@example.com", "p4@example.com"].map((email) =>
        insertPlayer(db, { email }),
      ),
    );
    await insertMembership(db, gameId, owner, { role: "owner" });
    for (const id of players) await insertMembership(db, gameId, id);

    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: KICKOFF });
    for (const id of [owner, ...players]) await insertResponse(db, fixtureId, id, { status: "in" });

    // Five claims across two outcomes and three distinct scores, so the tally
    // has real work to do at both levels.
    await insertResultClaim(db, fixtureId, owner, { outcome: "a", scoreA: 3, scoreB: 1, filedAt: KICKOFF });
    await insertResultClaim(db, fixtureId, players[0]!, {
      outcome: "a",
      scoreA: 3,
      scoreB: 1,
      filedAt: KICKOFF,
    });
    await insertResultClaim(db, fixtureId, players[1]!, {
      outcome: "a",
      scoreA: 2,
      scoreB: 1,
      filedAt: KICKOFF,
    });
    await insertResultClaim(db, fixtureId, players[2]!, { outcome: "b", scoreA: 1, scoreB: 3, filedAt: KICKOFF });
    await insertResultClaim(db, fixtureId, players[3]!, { outcome: "b", scoreA: 0, scoreB: 2, filedAt: KICKOFF });

    await materialiseResults(db, AFTER_DEADLINE);

    const [stored] = await db.select().from(fixtureResults).where(eq(fixtureResults.fixtureId, fixtureId));
    const claims = await listResultClaims(db, fixtureId);
    const { organiserIds } = await resultElectorate(db, gameId, fixtureId);
    const derived = deriveResult(claims, organiserIds)!;

    expect(stored).toMatchObject({
      outcome: derived.outcome,
      scoreA: derived.scoreA,
      scoreB: derived.scoreB,
      outcomeBackers: derived.outcomeBackers,
      marginBackers: derived.marginBackers,
      voterCount: derived.voterCount,
      distinctOutcomes: derived.distinctOutcomes,
      distinctScores: derived.distinctScores,
    });
  });

  it("isolates a read-phase failure to one fixture and still processes the rest", async () => {
    const brokenGameId = await insertGame(db);
    const healthyGameId = await insertGame(db);
    const brokenPlayer = await insertPlayer(db, { email: "broken@example.com" });
    const healthyPlayer = await insertPlayer(db, { email: "healthy@example.com" });
    // Two different games, both kicking off at the exact same instant: the
    // `fixtures_game_kickoff_unique` index is scoped per game, and a genuine
    // difference in kickoff time would shift the two fixtures' own 48-hour
    // deadlines apart, which would make `AFTER_DEADLINE` past one and not
    // the other for a reason that has nothing to do with isolation.
    const broken = await insertFixture(db, brokenGameId, { lifecycle: "played", kicksOffAt: KICKOFF });
    const healthy = await insertFixture(db, healthyGameId, { lifecycle: "played", kicksOffAt: KICKOFF });
    await insertResponse(db, broken, brokenPlayer, { status: "in" });
    await insertResponse(db, healthy, healthyPlayer, { status: "in" });
    await insertResultClaim(db, broken, brokenPlayer, { outcome: "a", filedAt: KICKOFF });
    await insertResultClaim(db, healthy, healthyPlayer, { outcome: "b", filedAt: KICKOFF });

    const brokenDb = dbThatFailsReadingClaimsFor(broken);
    const outcome = await materialiseResults(brokenDb, AFTER_DEADLINE);

    expect(outcome.considered).toBe(2);
    expect(outcome.written).toBe(1);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.fixtureId).toBe(broken);
    expect(outcome.failures[0]?.stage).toBe("prepare");
    expect(await cachedRow(broken)).toBeUndefined();
    const healthyRow = await cachedRow(healthy);
    expect(healthyRow?.outcome).toBe("b");
  });

  it("isolates a write-phase failure to one fixture, and the failed fixture's write is all-or-nothing", async () => {
    // Distinct from the read-phase test above: that one breaks
    // `listResultClaims`, before any row is even built. This one breaks the
    // `db.batch()` call itself — the cache row and its audit row committing
    // together or not at all — which is the failure mode the Important
    // review finding named: a cache row landing while its audit row is lost
    // would be unrecoverable, because a written fixture is never selected
    // again.
    const brokenGameId = await insertGame(db);
    const healthyGameId = await insertGame(db);
    const brokenPlayer = await insertPlayer(db, { email: "broken-write@example.com" });
    const healthyPlayer = await insertPlayer(db, { email: "healthy-write@example.com" });
    const broken = await insertFixture(db, brokenGameId, { lifecycle: "played", kicksOffAt: KICKOFF });
    const healthy = await insertFixture(db, healthyGameId, { lifecycle: "played", kicksOffAt: KICKOFF });
    await insertResponse(db, broken, brokenPlayer, { status: "in" });
    await insertResponse(db, healthy, healthyPlayer, { status: "in" });
    await insertResultClaim(db, broken, brokenPlayer, { outcome: "a", filedAt: KICKOFF });
    await insertResultClaim(db, healthy, healthyPlayer, { outcome: "b", filedAt: KICKOFF });

    const brokenDb = dbThatFailsWritingResultFor(broken);
    const outcome = await materialiseResults(brokenDb, AFTER_DEADLINE);

    expect(outcome.considered).toBe(2);
    // The healthy fixture's write still counts; the broken one does not —
    // proving the counts reflect what actually committed, not what was
    // merely attempted.
    expect(outcome.written).toBe(1);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.fixtureId).toBe(broken);
    expect(outcome.failures[0]?.stage).toBe("prepare");

    // Nothing landed for the broken fixture: neither the cache row nor its
    // audit row. If the batch were not atomic, or if the write happened
    // outside the per-fixture `try`, this would be the one place a
    // half-written state could show up undetected.
    expect(await cachedRow(broken)).toBeUndefined();
    const brokenAuditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, broken));
    expect(brokenAuditRows.filter((row) => row.action === "fixture.result_locked")).toHaveLength(0);

    // The other fixture in the same run is untouched by the failure.
    const healthyRow = await cachedRow(healthy);
    expect(healthyRow?.outcome).toBe("b");
    const healthyAuditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, healthy));
    expect(healthyAuditRows.filter((row) => row.action === "fixture.result_locked")).toHaveLength(1);
  });

  it("chunks past D1's 100-bound-parameter ceiling instead of throwing (C1, TR-38)", async () => {
    // More played fixtures than `INSERT_CHUNK_SIZE * 13` — past `chunk.ts`'s
    // own worked example of the ceiling, and the whole class this regression
    // guards was invisible to every other test in this file because none of
    // them crosses 100 played fixtures. Before the fix, the unchunked
    // `inArray` over every played fixture id threw here, outside the
    // per-fixture `try`, and the step never cached another result again.
    const TOTAL = INSERT_CHUNK_SIZE * 13 + 3;
    const fixtureIds: string[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const gameId = await insertGame(db);
      const playerId = await insertPlayer(db, { email: `p${i}@example.com` });
      const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: KICKOFF });
      await insertResponse(db, fixtureId, playerId, { status: "in" });
      await insertResultClaim(db, fixtureId, playerId, { outcome: "a", filedAt: KICKOFF });
      fixtureIds.push(fixtureId);
    }

    const outcome = await materialiseResults(db, AFTER_DEADLINE);

    expect(outcome.considered).toBe(TOTAL);
    expect(outcome.written).toBe(TOTAL);
    expect(outcome.failures).toHaveLength(0);
    for (const fixtureId of fixtureIds) {
      expect(await cachedRow(fixtureId)).toBeDefined();
    }

    // A second run must still complete without throwing, exercising the
    // chunked "already cached" lookup at the same scale.
    const second = await materialiseResults(db, AFTER_DEADLINE);
    expect(second.considered).toBe(0);
    expect(second.failures).toHaveLength(0);
  });

  it("writes a fixture.result_locked audit row with a null actor", async () => {
    const gameId = await insertGame(db);
    const playerId = await insertPlayer(db, { email: "a@example.com" });
    const fixtureId = await insertFixture(db, gameId, { lifecycle: "played", kicksOffAt: KICKOFF });
    await insertResponse(db, fixtureId, playerId, { status: "in" });
    await insertResultClaim(db, fixtureId, playerId, { outcome: "a", filedAt: KICKOFF });

    await materialiseResults(db, AFTER_DEADLINE);

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, fixtureId));
    const lockedRows = rows.filter((row) => row.action === "fixture.result_locked");
    expect(lockedRows).toHaveLength(1);
    expect(lockedRows[0]?.actorPlayerId).toBeNull();
    expect(lockedRows[0]?.entityType).toBe("fixture");
  });
});

