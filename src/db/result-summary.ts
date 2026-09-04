import { inArray } from "drizzle-orm";
import type { Db } from "./client.js";
import { games } from "./schema.js";
import { activeOwnersByGame, listClaimsForFixtures } from "./result-queries.js";
import { deriveResult } from "../domain/result.js";
import { isResultLocked } from "../domain/result-lock.js";
import type { Lifecycle } from "../domain/lifecycle.js";
import { derivedResultWords, outcomeNames } from "../views/result.js";

/**
 * The least a row needs for `resultWordsForLockedRows` to answer about it.
 *
 * Deliberately narrower than `DashboardFixture`, which is the shape the first
 * caller happened to have: this module is also read by a game-scoped list
 * (M27's past-fixtures page) whose rows are not per-player at all and have no
 * `myStatus` to offer.
 */
export interface ResultSummaryRow {
  fixtureId: string;
  gameId: string;
  kicksOffAt: Date;
  /** With `kicksOffAt`, full time — where the lock is measured from (M57). */
  durationMinutes: number;
  /** This Game's `result_lock_hours_after`, carried on the row for the same
   * reason every other column here is: one read for the whole list. */
  resultLockHoursAfter: number;
  lifecycle: Lifecycle;
}

/**
 * The result summary for every *locked* played fixture in a list, keyed by
 * fixture id (M25 Task 13, BR-37).
 *
 * Shared by every page that shows a settled result beside a list of fixtures
 * — the account history it was written for, the dashboard's recently-played
 * card and the past-fixtures page (both M27). One derivation, so no two of
 * them can name the same result differently.
 *
 * **Derived from the claims, not read from `fixture_results`.** That table
 * is a cache the sweep (`src/sweep/result-cache.ts`) may not have written yet
 * — its own module comment says "a run that fails or never happens costs a
 * row the next run writes", not a fixture stuck showing no result until it
 * does. Every page derives its own answer from the claims, and this is no
 * exception.
 *
 * Two batched reads regardless of how many fixtures are locked: every claim
 * on every played fixture in the page (`listClaimsForFixtures`), and every
 * active owner of every game the page touches (`activeOwnersByGame`) — the
 * organiser set `deriveResult`'s tie-break needs. A per-row query for either
 * would multiply by the length of the list.
 */
export async function resultWordsForLockedRows(
  db: Db,
  history: readonly ResultSummaryRow[],
  now: Date,
): Promise<Map<string, string>> {
  const played = history.filter((fixture) => fixture.lifecycle === "played");
  if (played.length === 0) return new Map();

  const claims = await listClaimsForFixtures(
    db,
    played.map((fixture) => fixture.fixtureId),
  );
  const claimsByFixture = new Map<string, typeof claims>();
  for (const claim of claims) {
    const bucket = claimsByFixture.get(claim.fixtureId) ?? [];
    bucket.push(claim);
    claimsByFixture.set(claim.fixtureId, bucket);
  }

  const locked = played.filter((fixture) =>
    isResultLocked(
      fixture,
      fixture.resultLockHoursAfter,
      claimsByFixture.get(fixture.fixtureId)?.length ?? 0,
      now,
    ),
  );
  if (locked.length === 0) return new Map();

  const [ownersByGame, teamNameRows] = await Promise.all([
    activeOwnersByGame(
      db,
      locked.map((fixture) => fixture.gameId),
    ),
    db
      .select({ id: games.id, teamAName: games.teamAName, teamBName: games.teamBName })
      .from(games)
      .where(
        inArray(
          games.id,
          locked.map((fixture) => fixture.gameId),
        ),
      ),
  ]);
  const teamNamesByGame = new Map(teamNameRows.map((row) => [row.id, row]));

  const words = new Map<string, string>();
  for (const fixture of locked) {
    const teamNames = teamNamesByGame.get(fixture.gameId);
    // The game disappeared between the history read and here, which cannot
    // happen in production (games are never deleted) but would otherwise
    // read `outcomeNames(undefined)` below.
    if (teamNames === undefined) continue;
    const fixtureClaims = claimsByFixture.get(fixture.fixtureId) ?? [];
    const organiserIds = ownersByGame.get(fixture.gameId) ?? new Set<string>();
    const derived = deriveResult(fixtureClaims, organiserIds);
    // `locked` is filtered by `isResultLocked`, which requires `claimCount >
    // 0`, so `fixtureClaims` is non-empty here and `deriveResult` cannot
    // return null — this is just what makes that guarantee visible to the
    // type checker, matching `src/sweep/result-cache.ts`'s own comment on
    // the identical guarantee.
    if (derived === null) continue;
    const summary = derivedResultWords(outcomeNames(teamNames), derived);
    if (summary !== null) words.set(fixture.fixtureId, summary);
  }
  return words;
}

