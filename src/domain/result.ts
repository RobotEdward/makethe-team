/**
 * The one definition of `fixture_result_claims.outcome` and
 * `fixture_results.outcome` (BR-37).
 *
 * This module imports nothing on purpose: the schema layer depends on it, so
 * anything it depended on would risk a cycle back through the domain layer —
 * exactly the constraint `src/domain/lifecycle.ts` documents.
 */
export const RESULT_OUTCOMES = ["a", "b", "draw"] as const;

export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];

/**
 * The largest score either side may be given.
 *
 * Arbitrary, and that is fine: it exists so that a pasted number cannot
 * produce a row nothing can render sensibly, not because 100-0 is
 * footballing nonsense.
 */
export const MAX_SCORE = 99;

/** One player's position on what happened, as the tally sees it. */
export interface ResultClaim {
  playerId: string;
  outcome: ResultOutcome;
  scoreA: number | null;
  scoreB: number | null;
  filedAt: Date;
}

export function outcomeFromScore(scoreA: number, scoreB: number): ResultOutcome {
  if (scoreA > scoreB) return "a";
  if (scoreB > scoreA) return "b";
  return "draw";
}

export type ParsedClaim =
  | { ok: true; outcome: ResultOutcome; scoreA: number | null; scoreB: number | null }
  | { ok: false; problem: string };

function parseScore(raw: string | undefined): number | null | "bad" {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return null;
  // `Number()` rather than `parseInt`: `parseInt("3abc")` is 3, which would
  // accept a field the person plainly did not mean.
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0 || value > MAX_SCORE) return "bad";
  return value;
}

/**
 * Turn one submitted form into a claim, or into the reason it is not one.
 *
 * **The submitted outcome is ignored whenever a score is given.** This is the
 * only thing standing between the two-level tally and a claim that counts
 * toward an outcome its own score contradicts — `fixture_result_claims.outcome`
 * has no CHECK constraint behind it, so nothing else would catch such a row.
 */
export function parseClaim(form: {
  outcome: string | undefined;
  scoreA: string | undefined;
  scoreB: string | undefined;
}): ParsedClaim {
  const a = parseScore(form.scoreA);
  const b = parseScore(form.scoreB);
  if (a === "bad" || b === "bad") {
    return { ok: false, problem: `Scores must be whole numbers between 0 and ${MAX_SCORE}.` };
  }
  if ((a === null) !== (b === null)) {
    return { ok: false, problem: "Give both scores, or leave both blank and just say who won." };
  }
  if (a !== null && b !== null) {
    return { ok: true, outcome: outcomeFromScore(a, b), scoreA: a, scoreB: b };
  }
  const outcome = RESULT_OUTCOMES.find((value) => value === form.outcome);
  if (outcome === undefined) {
    return { ok: false, problem: "Say who won, or give the score." };
  }
  return { ok: true, outcome, scoreA: null, scoreB: null };
}

export interface ScoreCandidate {
  scoreA: number;
  scoreB: number;
  backers: readonly string[];
  firstFiledAt: Date;
}

export interface OutcomeCandidate {
  outcome: ResultOutcome;
  backers: readonly string[];
  firstFiledAt: Date;
  scores: readonly ScoreCandidate[];
  /** Backers of this outcome who gave no score — the "score not given" row. */
  unscoredBackers: number;
}

/**
 * Compare two candidates by the four steps every level of the tally uses, in
 * this order: most backers, then an organiser's backing, then the earliest
 * claim, then the lowest backer id.
 *
 * Step 2 exists because step 3 alone rewards being quick over being right: a
 * wrong early claim that picks up one friend would beat a correct later one.
 *
 * Step 4 exists because step 3 is not actually total: `putResultClaim`
 * stamps every claim in one request with a single `params.now`, so two
 * players filing in the same request tie on `filedAt` exactly, and
 * `fixture_results` caches whichever winner `deriveResult` picked at lock
 * time. If the comparator could stop at step 3 and fall through to
 * `Array.prototype.sort`'s handling of equal elements, the answer would
 * depend on the order candidates were built in — Map insertion order, which
 * traces back to database row order, which SQLite does not guarantee
 * without an `ORDER BY` — and a later recomputation could disagree with the
 * cached row on the exact same claims. Backer ids are UUIDs and every
 * candidate's backer set is disjoint from every other's (a claim names one
 * outcome, and a scored claim one score, so a player contributes to exactly
 * one candidate at each level), so the lowest one is both stable across
 * evaluations and never a tie between two genuinely different candidates.
 */
function compareCandidates(
  left: { backers: readonly string[]; firstFiledAt: Date },
  right: { backers: readonly string[]; firstFiledAt: Date },
  organiserIds: ReadonlySet<string>,
): number {
  if (left.backers.length !== right.backers.length) return right.backers.length - left.backers.length;
  const leftOrganiser = left.backers.some((id) => organiserIds.has(id));
  const rightOrganiser = right.backers.some((id) => organiserIds.has(id));
  if (leftOrganiser !== rightOrganiser) return leftOrganiser ? -1 : 1;
  const byTime = left.firstFiledAt.getTime() - right.firstFiledAt.getTime();
  if (byTime !== 0) return byTime;
  const leftMinId = [...left.backers].sort()[0]!;
  const rightMinId = [...right.backers].sort()[0]!;
  return leftMinId < rightMinId ? -1 : leftMinId > rightMinId ? 1 : 0;
}

function earliest(claims: readonly ResultClaim[]): Date {
  return claims.reduce(
    (soonest, claim) => (claim.filedAt < soonest ? claim.filedAt : soonest),
    claims[0]!.filedAt,
  );
}

/**
 * Group the claims into candidates, most-backed first.
 *
 * Ordered by backer count alone — not by `compareCandidates`, which needs the
 * organiser set the renderer has no business knowing. The page shows a list;
 * `deriveResult` decides a winner.
 */
export function tally(claims: readonly ResultClaim[]): readonly OutcomeCandidate[] {
  const byOutcome = new Map<ResultOutcome, ResultClaim[]>();
  for (const claim of claims) {
    const bucket = byOutcome.get(claim.outcome) ?? [];
    bucket.push(claim);
    byOutcome.set(claim.outcome, bucket);
  }

  const candidates: OutcomeCandidate[] = [];
  for (const [outcome, group] of byOutcome) {
    const byScore = new Map<string, ResultClaim[]>();
    for (const claim of group) {
      if (claim.scoreA === null || claim.scoreB === null) continue;
      const key = `${claim.scoreA}-${claim.scoreB}`;
      const bucket = byScore.get(key) ?? [];
      bucket.push(claim);
      byScore.set(key, bucket);
    }
    const scores: ScoreCandidate[] = [...byScore.values()]
      .map((group) => ({
        scoreA: group[0]!.scoreA!,
        scoreB: group[0]!.scoreB!,
        backers: group.map((claim) => claim.playerId),
        firstFiledAt: earliest(group),
      }))
      .sort((left, right) => right.backers.length - left.backers.length);

    candidates.push({
      outcome,
      backers: group.map((claim) => claim.playerId),
      firstFiledAt: earliest(group),
      scores,
      unscoredBackers: group.filter((claim) => claim.scoreA === null).length,
    });
  }

  return candidates.sort((left, right) => right.backers.length - left.backers.length);
}

export interface DerivedResult {
  outcome: ResultOutcome;
  outcomeBackers: number;
  /** Null is "outcome agreed, score not" — legitimate, and recordable. */
  scoreA: number | null;
  scoreB: number | null;
  marginBackers: number;
  voterCount: number;
  distinctOutcomes: number;
  distinctScores: number;
}

/**
 * The result these claims say, or null when nobody has filed.
 *
 * Two levels, because outcome-agreement and margin-agreement are different
 * facts and one number cannot carry both. The outcome is decided across
 * *every* claim — a 3-2 claim counts toward "Bibs won" exactly as an
 * outcome-only one does — and the margin only among the scored claims
 * consistent with the winning outcome, so a losing side's score can never
 * become the winner's.
 *
 * Pure: no clock and no database. The 48-hour window is
 * `src/domain/result-lock.ts`'s business, and this function is the same
 * answer before and after it.
 */
export function deriveResult(
  claims: readonly ResultClaim[],
  organiserIds: ReadonlySet<string>,
): DerivedResult | null {
  if (claims.length === 0) return null;
  const candidates = [...tally(claims)].sort((left, right) =>
    compareCandidates(left, right, organiserIds),
  );
  const winner = candidates[0]!;
  const margin = [...winner.scores].sort((left, right) =>
    compareCandidates(left, right, organiserIds),
  )[0];

  return {
    outcome: winner.outcome,
    outcomeBackers: winner.backers.length,
    scoreA: margin?.scoreA ?? null,
    scoreB: margin?.scoreB ?? null,
    marginBackers: margin?.backers.length ?? 0,
    voterCount: claims.length,
    distinctOutcomes: candidates.length,
    distinctScores: candidates.reduce((total, candidate) => total + candidate.scores.length, 0),
  };
}
