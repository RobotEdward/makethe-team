import type { Lifecycle } from "./lifecycle.js";
import type { ResultClaim } from "./result.js";

/**
 * How long a result stays open to argument (BR-37).
 *
 * Measured from **kickoff**, not from full time: it is the rule as stated, it
 * needs no duration arithmetic, and kickoff is the instant everybody involved
 * already knows.
 */
export const RESULT_LOCK_WINDOW_MS = 48 * 60 * 60 * 1000;

export function resultDeadline(kicksOffAt: Date): Date {
  return new Date(kicksOffAt.getTime() + RESULT_LOCK_WINDOW_MS);
}

/**
 * Whether the claims on this fixture are final.
 *
 * **Both halves of the agreed behaviour fall out of this one expression, with
 * no second state and no special case.** Before the deadline claims exist and
 * can be argued with. At the deadline an existing claim set freezes. After the
 * deadline with *nothing* filed, `claimCount > 0` is false — so the fixture
 * stays writable, reads "no result recorded", and the first late claim makes
 * this true on the very same evaluation, standing alone with no voting round.
 *
 * A squad that forgot for two days does not lose the fixture from its history;
 * a squad that recorded something does not get it rewritten a week later.
 */
export function isResultLocked(kicksOffAt: Date, claimCount: number, now: Date): boolean {
  return claimCount > 0 && now.getTime() >= resultDeadline(kicksOffAt).getTime();
}

/**
 * Whether this fixture will accept a claim right now.
 *
 * `cancelled` is excluded for BR-16's reason — it is terminal and is never
 * resurrected into another lifecycle — and `open`/`scheduled` because there is
 * nothing yet to have a result about.
 */
export function resultWritable(
  lifecycle: Lifecycle,
  kicksOffAt: Date,
  claimCount: number,
  now: Date,
): boolean {
  if (lifecycle !== "played") return false;
  return !isResultLocked(kicksOffAt, claimCount, now);
}

/**
 * The instant this fixture's result became final, or null if it has not.
 *
 * The later of the deadline and the earliest claim: a fixture nobody filed on
 * until Tuesday locked on Tuesday, not retrospectively on Saturday evening.
 * Cached on `fixture_results.locked_at`; never used to decide anything, only
 * to record what happened.
 */
export function resultLockedAt(kicksOffAt: Date, claims: readonly ResultClaim[]): Date | null {
  if (claims.length === 0) return null;
  const first = claims.reduce(
    (soonest, claim) => (claim.filedAt < soonest ? claim.filedAt : soonest),
    claims[0]!.filedAt,
  );
  const deadline = resultDeadline(kicksOffAt);
  return first > deadline ? first : deadline;
}
