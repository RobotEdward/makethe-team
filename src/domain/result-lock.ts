import type { Lifecycle } from "./lifecycle.js";
import type { ResultClaim } from "./result.js";

/**
 * Everything a lock question needs about the fixture itself.
 *
 * `durationMinutes` is the fixture's own copy, not the Game's: it is what the
 * fixture was scheduled for, frozen at materialisation, so a Game whose length
 * changed this season cannot move the deadline of a match already played.
 */
export interface LockableFixture {
  kicksOffAt: Date;
  durationMinutes: number;
}

/**
 * The default `games.result_lock_hours_after`.
 *
 * The column's own default is the authority for rows already in the database;
 * this is what the create form stores when its Advanced section was never
 * rendered, and the one place the two are kept in step.
 */
export const DEFAULT_RESULT_LOCK_HOURS_AFTER = 24;

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * How long a result stays open to argument (BR-37).
 *
 * Measured from **full time**, and by the owner's own setting since M57. Until
 * then it was a fixed 48 hours from kickoff, on the reasoning that kickoff
 * needs no duration arithmetic and is the instant everybody already knows —
 * but `kicksOffAt + durationMinutes` is how four other modules in this
 * codebase already say "full time" (`src/notify/send-result-nudge.ts`,
 * `src/sweep/retire.ts`, `src/sweep/attention.ts`,
 * `src/sweep/open-and-remind.ts`), and a squad that plays for two hours had
 * two fewer to argue in than one that plays for one.
 *
 * The offset is passed in rather than read here: this module has no database,
 * and every caller already holds the Game row it comes from.
 */
export function resultDeadline(fixture: LockableFixture, lockHoursAfter: number): Date {
  return new Date(
    fixture.kicksOffAt.getTime() + fixture.durationMinutes * MINUTE_MS + lockHoursAfter * HOUR_MS,
  );
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
export function isResultLocked(
  fixture: LockableFixture,
  lockHoursAfter: number,
  claimCount: number,
  now: Date,
): boolean {
  return claimCount > 0 && now.getTime() >= resultDeadline(fixture, lockHoursAfter).getTime();
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
  fixture: LockableFixture,
  lockHoursAfter: number,
  claimCount: number,
  now: Date,
): boolean {
  if (lifecycle !== "played") return false;
  return !isResultLocked(fixture, lockHoursAfter, claimCount, now);
}

/**
 * The instant this fixture's result became final, or null if it has not.
 *
 * The later of the deadline and the earliest claim: a fixture nobody filed on
 * until Tuesday locked on Tuesday, not retrospectively on Saturday evening.
 * Cached on `fixture_results.locked_at`; never used to decide anything, only
 * to record what happened.
 */
export function resultLockedAt(
  fixture: LockableFixture,
  lockHoursAfter: number,
  claims: readonly ResultClaim[],
): Date | null {
  if (claims.length === 0) return null;
  const first = claims.reduce(
    (soonest, claim) => (claim.filedAt < soonest ? claim.filedAt : soonest),
    claims[0]!.filedAt,
  );
  const deadline = resultDeadline(fixture, lockHoursAfter);
  return first > deadline ? first : deadline;
}

/**
 * Whether an organiser may still change who is in this fixture and which
 * side they are on (M64).
 *
 * Open, and the ordinary rules apply. `played`, and the roster follows the
 * result: a last-minute drop-out replaced by a guest at the venue, and sides
 * re-balanced on the pitch, are part of the same record as the score, and the
 * game already has one owner-configurable window in which that record can be
 * argued with. One lock for the whole evening — the alternative is a roster
 * that can move under a result's cached teams-accuracy figure after the
 * result itself has frozen (`src/sweep/result-cache.ts`).
 *
 * The consequence to know about: a played fixture nobody ever filed a result
 * on stays correctable indefinitely, exactly as `resultWritable` leaves it
 * open to a first claim. The first claim after the deadline locks both.
 *
 * The caller decides who may act on this; it says nothing about players.
 * Their own answers lock at `played` under BR-15 regardless.
 */
export function rosterEditable(
  lifecycle: Lifecycle,
  fixture: LockableFixture,
  lockHoursAfter: number,
  claimCount: number,
  now: Date,
): boolean {
  if (lifecycle === "open") return true;
  return resultWritable(lifecycle, fixture, lockHoursAfter, claimCount, now);
}
