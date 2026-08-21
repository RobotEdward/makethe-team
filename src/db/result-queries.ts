import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./client.js";
import { fixtureResultClaims, memberships, players, responses } from "./schema.js";
import type { ResultClaim, ResultOutcome } from "../domain/result.js";

/**
 * A claim as stored, with just enough about its author to render it.
 *
 * `erasedAt` travels with the row for the reason `SquadMember.erasedAt` does:
 * a played fixture keeps its erased participants, so `name` may be the
 * `[erased player]` placeholder, which must never reach a screen. Every read
 * of it goes through `displayName`.
 */
export interface StoredClaim extends ResultClaim {
  id: string;
  name: string;
  erasedAt: Date | null;
}

/**
 * Every claim on a fixture, ordered by `id`.
 *
 * The order is arbitrary but must be *some* fixed order: `deriveResult`'s
 * comparator is a total order over its input, but SQLite makes no promise
 * about row order absent an `ORDER BY`, and `fixture_results` exists so a
 * recomputation can never disagree with what was cached at lock time. `id`
 * is a UUID with nothing to do with the tally — which is exactly why it is
 * safe: it is stable and unique, so two reads of the same rows always come
 * back in the same order, without smuggling in an ordering (like `filedAt`)
 * that could make a later change to this function look like it was also
 * changing the tally.
 */
export async function listResultClaims(db: Db, fixtureId: string): Promise<StoredClaim[]> {
  return db
    .select({
      id: fixtureResultClaims.id,
      playerId: fixtureResultClaims.playerId,
      outcome: fixtureResultClaims.outcome,
      scoreA: fixtureResultClaims.scoreA,
      scoreB: fixtureResultClaims.scoreB,
      filedAt: fixtureResultClaims.filedAt,
      name: players.name,
      erasedAt: players.erasedAt,
    })
    .from(fixtureResultClaims)
    .innerJoin(players, eq(fixtureResultClaims.playerId, players.id))
    .where(eq(fixtureResultClaims.fixtureId, fixtureId))
    .orderBy(fixtureResultClaims.id);
}

/**
 * Who may file on this fixture, and which of them are organisers (BR-37 §6).
 *
 * Everyone who was `in`, plus every active owner whether or not they played —
 * the organiser is who chases a missing result, and their membership of
 * `organiserIds` is what `deriveResult`'s second tie-break reads.
 *
 * **Guests are excluded here even though `requirePlayer` already stops them.**
 * They hold `in` rows (`addGuest` writes one) and have no account, so leaving
 * them in would inflate `eligible_count` — the turnout denominator on every
 * cached result — with people who could never have voted.
 *
 * Two queries rather than a union: they are different joins over different
 * tables, and D1 has no interactive transactions to make one round trip
 * safer than two reads of frozen rows.
 */
export async function resultElectorate(
  db: Db,
  gameId: string,
  fixtureId: string,
): Promise<{ eligibleIds: Set<string>; organiserIds: Set<string> }> {
  const [playedRows, ownerRows] = await Promise.all([
    db
      .select({ playerId: responses.playerId })
      .from(responses)
      .innerJoin(players, eq(responses.playerId, players.id))
      .where(
        and(
          eq(responses.fixtureId, fixtureId),
          eq(responses.status, "in"),
          eq(players.isGuest, false),
        ),
      ),
    db
      .select({ playerId: memberships.playerId })
      .from(memberships)
      .where(
        and(
          eq(memberships.gameId, gameId),
          eq(memberships.role, "owner"),
          eq(memberships.active, true),
        ),
      ),
  ]);

  const organiserIds = new Set(ownerRows.map((row) => row.playerId));
  const eligibleIds = new Set(playedRows.map((row) => row.playerId));
  organiserIds.forEach((id) => eligibleIds.add(id));
  return { eligibleIds, organiserIds };
}

/** One claim, tagged with the fixture it belongs to — `listClaimsForFixtures`'s row shape. */
export interface FixtureClaim extends ResultClaim {
  fixtureId: string;
}

/**
 * Every claim on a batch of fixtures, no player join — for callers that need
 * only what `deriveResult`/`isResultLocked` take (the dashboard's "results
 * needed" list and the account history's locked rows, M25 Task 13), across
 * however many fixtures in one round trip rather than one query per fixture.
 * `listResultClaims` above stays the single-fixture, name-carrying read the
 * write routes and the fixture pages use.
 */
export async function listClaimsForFixtures(db: Db, fixtureIds: readonly string[]): Promise<FixtureClaim[]> {
  if (fixtureIds.length === 0) return [];
  return db
    .select({
      fixtureId: fixtureResultClaims.fixtureId,
      playerId: fixtureResultClaims.playerId,
      outcome: fixtureResultClaims.outcome,
      scoreA: fixtureResultClaims.scoreA,
      scoreB: fixtureResultClaims.scoreB,
      filedAt: fixtureResultClaims.filedAt,
    })
    .from(fixtureResultClaims)
    .where(inArray(fixtureResultClaims.fixtureId, fixtureIds));
}

/**
 * Every active owner of a batch of games, grouped by game id — the organiser
 * half of `resultElectorate`, batched across games rather than one game at a
 * time, for the account history's per-row `deriveResult` tie-break (M25 Task
 * 13). A history can span many games in one page load; this is one query
 * for all of them rather than one per row.
 */
export async function activeOwnersByGame(
  db: Db,
  gameIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (gameIds.length === 0) return result;
  const rows = await db
    .select({ gameId: memberships.gameId, playerId: memberships.playerId })
    .from(memberships)
    .where(
      and(
        inArray(memberships.gameId, gameIds),
        eq(memberships.role, "owner"),
        eq(memberships.active, true),
      ),
    );
  for (const row of rows) {
    const set = result.get(row.gameId) ?? new Set<string>();
    set.add(row.playerId);
    result.set(row.gameId, set);
  }
  return result;
}

export async function findResultClaim(
  db: Db,
  fixtureId: string,
  playerId: string,
): Promise<StoredClaim | null> {
  const rows = await listResultClaims(db, fixtureId);
  return rows.find((row) => row.playerId === playerId) ?? null;
}

/**
 * File or move one player's claim.
 *
 * An upsert on the unique index, so a replayed form cannot produce a second
 * row for the same person — the constraint, not this function, is the
 * guarantee. `filedAt` is written on both paths: see the column's comment for
 * why a change moves it.
 *
 * `scoreA`/`scoreB` are written unconditionally, including as nulls, so that
 * a player moving from "3-2" to a bare "Bibs won" does not keep a score they
 * have withdrawn.
 */
export async function putResultClaim(
  db: Db,
  params: {
    fixtureId: string;
    playerId: string;
    outcome: ResultOutcome;
    scoreA: number | null;
    scoreB: number | null;
    now: Date;
  },
): Promise<void> {
  await db
    .insert(fixtureResultClaims)
    .values({
      id: crypto.randomUUID(),
      fixtureId: params.fixtureId,
      playerId: params.playerId,
      outcome: params.outcome,
      scoreA: params.scoreA,
      scoreB: params.scoreB,
      filedAt: params.now,
    })
    .onConflictDoUpdate({
      target: [fixtureResultClaims.fixtureId, fixtureResultClaims.playerId],
      set: {
        outcome: params.outcome,
        scoreA: params.scoreA,
        scoreB: params.scoreB,
        filedAt: params.now,
      },
    });
}

/** Withdraw your own claim. Returns whether there was one to withdraw. */
export async function deleteResultClaim(
  db: Db,
  fixtureId: string,
  playerId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(fixtureResultClaims)
    .where(
      and(
        eq(fixtureResultClaims.fixtureId, fixtureId),
        eq(fixtureResultClaims.playerId, playerId),
      ),
    )
    .returning({ id: fixtureResultClaims.id });
  return deleted.length > 0;
}
