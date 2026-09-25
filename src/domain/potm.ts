import type { Lifecycle } from "./lifecycle.js";
import { resultDeadline, type LockableFixture } from "./result-lock.js";

/**
 * Fewer counted votes than this and nobody is announced: a single voter would
 * otherwise crown whoever they liked, and the winner is emailed about it.
 */
export const POTM_MIN_VOTES = 2;

export interface PotmVote {
  voterId: string;
  candidateId: string;
}

export interface PotmOutcome {
  /** Every candidate on the top count — a tie is a joint award, not a coin toss. */
  winnerIds: string[];
  /** The winners' count. */
  votes: number;
  /** Counted votes only, after the filters `potmWinners` applies. */
  totalVotes: number;
}

/**
 * Whether player-of-the-match votes are being taken.
 *
 * Closes at `resultDeadline` unconditionally, unlike `resultWritable`: a
 * result nobody filed stays open so the fixture is not lost from the record,
 * but a vote nobody cast has nothing to preserve, and the winner's
 * notification needs a fixed instant to fire at.
 */
export function potmOpen(
  lifecycle: Lifecycle,
  fixture: LockableFixture,
  lockHoursAfter: number,
  now: Date,
): boolean {
  if (lifecycle !== "played") return false;
  return now.getTime() < resultDeadline(fixture, lockHoursAfter).getTime();
}

/**
 * The winners, or null when too few votes count to name anybody.
 *
 * Derived at read time from the current candidates and voters, so a vote for
 * a player later taken out of the fixture — or by one — counts for nothing
 * rather than naming somebody who did not play. A self-vote is refused at the
 * route; it is dropped here too so a row that got past it cannot win.
 */
export function potmWinners(
  votes: readonly PotmVote[],
  candidateIds: ReadonlySet<string>,
  voterIds: ReadonlySet<string>,
): PotmOutcome | null {
  const counts = new Map<string, number>();
  let totalVotes = 0;
  for (const { voterId, candidateId } of votes) {
    if (voterId === candidateId || !candidateIds.has(candidateId) || !voterIds.has(voterId)) continue;
    counts.set(candidateId, (counts.get(candidateId) ?? 0) + 1);
    totalVotes++;
  }
  if (totalVotes < POTM_MIN_VOTES) return null;
  const top = Math.max(...counts.values());
  const winnerIds = [...counts.entries()].filter(([, n]) => n === top).map(([id]) => id);
  return { winnerIds, votes: top, totalVotes };
}
