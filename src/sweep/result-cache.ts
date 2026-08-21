import { eq, inArray } from "drizzle-orm";
import { recordAudit } from "../db/audit.js";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import type { Db } from "../db/client.js";
import { listTeamAssignments } from "../db/queries.js";
import { listResultClaims, resultElectorate } from "../db/result-queries.js";
import { fixtureResults, fixtures } from "../db/schema.js";
import { deriveResult } from "../domain/result.js";
import { isResultLocked, resultLockedAt } from "../domain/result-lock.js";
import { announcementOutstanding } from "../domain/teams.js";
import type { SweepFailure } from "./open-and-remind.js";

export interface MaterialiseResultsOutcome {
  /** Played fixtures with no cached row yet, examined on this run. */
  considered: number;
  /** How many of those had a locked result and got a row written. */
  written: number;
  failures: SweepFailure[];
}

/**
 * Materialise the derived result of every fixture whose window has closed
 * (BR-37, M25).
 *
 * **Nothing reads what this writes to decide anything.** Every page and every
 * refusal derives the result from the claims; `fixture_results` is a cache,
 * and a run that fails or never happens costs a row the next run writes — not
 * a fixture stuck in a wrong state with nothing to notice it. That is the
 * whole reason the lock is a predicate rather than a stored state.
 *
 * It exists because a purely derived result is a function evaluated at read
 * time: change the tie-break rule in eighteen months, or fix a bug in it, and
 * last season's results silently change underneath anything fitted on them,
 * with no row edited and no test failing. This row is the derivation pinned to
 * the instant it froze.
 *
 * Selection: every `played` fixture, minus every fixture that already has a
 * `fixture_results` row — read as two separate selects (candidate ids, then
 * existing ids) and filtered in JS against a `Set`, rather than a `LEFT JOIN
 * ... IS NULL`, because this table is small enough that the extra round trip
 * costs nothing and the two-select shape matches `retirePastFixtures`'s
 * candidate-then-filter pattern next to it in this directory. This is also
 * what makes a second run idempotent without a single `INSERT` needing
 * `onConflictDoNothing`: an already-materialised fixture is simply never
 * selected again.
 *
 * Every fixture is processed in its own `try`, exactly as `sendOwnerAttention`
 * does and for the same reason: one fixture whose claims or roster data can't
 * be read must not stop the rest of the run's fixtures being cached, nor the
 * erasure step that follows this one in the sweep.
 */
export async function materialiseResults(db: Db, now: Date): Promise<MaterialiseResultsOutcome> {
  const outcome: MaterialiseResultsOutcome = { considered: 0, written: 0, failures: [] };

  const played = await db
    .select({ id: fixtures.id, gameId: fixtures.gameId, kicksOffAt: fixtures.kicksOffAt })
    .from(fixtures)
    .where(eq(fixtures.lifecycle, "played"));
  if (played.length === 0) return outcome;

  const alreadyCached = await db
    .select({ fixtureId: fixtureResults.fixtureId })
    .from(fixtureResults)
    .where(
      inArray(
        fixtureResults.fixtureId,
        played.map((row) => row.id),
      ),
    );
  const cachedIds = new Set(alreadyCached.map((row) => row.fixtureId));
  const candidates = played.filter((row) => !cachedIds.has(row.id));

  outcome.considered = candidates.length;

  const rows: (typeof fixtureResults.$inferInsert)[] = [];
  for (const candidate of candidates) {
    try {
      const written = await materialiseOne(db, candidate, now);
      if (written) rows.push(written);
    } catch (error) {
      outcome.failures.push({
        fixtureId: candidate.id,
        gameId: candidate.gameId,
        stage: "prepare",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const batch of chunk(rows, INSERT_CHUNK_SIZE)) {
    await db.insert(fixtureResults).values(batch);
  }
  for (const row of rows) {
    // A separate insert per fixture, not batched with the row above: the two
    // tables' column counts differ, so chunking them together would not keep
    // either under D1's bound-parameter ceiling (TR-38), and an audit row
    // failing to write must still leave the cache row it describes intact —
    // the cache is what every page reads, the audit trail is history about it.
    await recordAudit(db, {
      actorPlayerId: null,
      entityType: "fixture",
      entityId: row.fixtureId,
      action: "fixture.result_locked",
      after: { outcome: row.outcome, scoreA: row.scoreA, scoreB: row.scoreB },
      now,
    });
  }

  outcome.written = rows.length;
  return outcome;
}

/**
 * Read one fixture's claims and roster, and build the row to insert if its
 * result has locked — or `null` if it hasn't (not a failure: most fixtures on
 * most runs simply haven't reached their deadline yet, or nobody has filed).
 */
async function materialiseOne(
  db: Db,
  candidate: { id: string; gameId: string; kicksOffAt: Date },
  now: Date,
): Promise<(typeof fixtureResults.$inferInsert) | null> {
  const claims = await listResultClaims(db, candidate.id);
  if (!isResultLocked(candidate.kicksOffAt, claims.length, now)) return null;

  const { eligibleIds, organiserIds } = await resultElectorate(db, candidate.gameId, candidate.id);
  const derived = deriveResult(claims, organiserIds);
  // `isResultLocked` requires `claimCount > 0`, so a locked fixture always has
  // at least one claim and `deriveResult` never returns null here — this is
  // just what makes that guarantee visible to the type checker.
  if (derived === null) return null;

  const [fixtureRow] = await db
    .select({ teamsPublishedAt: fixtures.teamsPublishedAt, teamsSavedAt: fixtures.teamsSavedAt })
    .from(fixtures)
    .where(eq(fixtures.id, candidate.id));
  // The fixture disappeared between the candidate select and now, which
  // cannot happen in production (fixtures are never deleted) but would
  // otherwise read `undefined.teamsPublishedAt` below.
  if (!fixtureRow) return null;

  // Unfiltered rows, not `getFixtureWithSquad`'s — see `src/domain/teams.ts`'s
  // module comment: a `withdrawn` row that still carries a `team` is exactly
  // condition 2 of staleness, and a query that filtered `withdrawn` out would
  // never surface it.
  const assignments = await listTeamAssignments(db, candidate.id);

  const lockedAt = resultLockedAt(candidate.kicksOffAt, claims);
  // Same guarantee as `derived` above: claims is non-empty here, so
  // `resultLockedAt` cannot return null.
  if (lockedAt === null) return null;

  return {
    fixtureId: candidate.id,
    outcome: derived.outcome,
    scoreA: derived.scoreA,
    scoreB: derived.scoreB,
    outcomeBackers: derived.outcomeBackers,
    marginBackers: derived.marginBackers,
    voterCount: derived.voterCount,
    eligibleCount: eligibleIds.size,
    distinctOutcomes: derived.distinctOutcomes,
    distinctScores: derived.distinctScores,
    rostered: fixtureRow.teamsPublishedAt !== null,
    teamsAccurate: !announcementOutstanding(fixtureRow, assignments),
    lockedAt,
    materialisedAt: now,
  };
}
