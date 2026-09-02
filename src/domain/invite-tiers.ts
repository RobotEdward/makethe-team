import type { ResponseStatus } from "./response-status.js";

/** One member of a tier, with their current response on the fixture being planned. */
export interface TierMember {
  playerId: string;
  /**
   * Null when the member holds no live response row at all. An owner removal
   * *deletes* the row of a `pending`, `out` or `waitlisted` player rather than
   * marking it (see `WithdrawMemberOutcome`), so absence is a real state here
   * and not a loading failure.
   */
  status: ResponseStatus | null;
  /** Null until this player has been invited (BR-41). */
  invitedAt: Date | null;
  /**
   * True when that stamp came from the owner inviting this one player by hand
   * (M46) rather than from their tier being released.
   *
   * The distinction exists because the release count is *derived* from the
   * stamps: a tier reads as released once one of its members carries one.
   * Without this flag, inviting a single sub out of order would read their
   * whole tier — and every tier above it — as released, and the next decline
   * would invite the tier below. The player is invited either way; what this
   * says is that nobody else in their tier was.
   */
  invitedIndividually: boolean;
}

/** One rung of the invite order. `tierId` is null for the implicit final tier (BR-38). */
export interface TierState {
  tierId: string | null;
  members: TierMember[];
}

export interface ReleaseInput {
  /** In invite order: stored tiers by (position, created_at), then the implicit tier. */
  tiers: TierState[];
  /** Live `in` responses belonging to no membership — guests (BR-32). */
  guestInCount: number;
  maxPlayers: number;
  minPlayers: number;
  /**
   * True once `now >= kicksOffAt - gatedFallbackHoursBefore`. Always false when
   * the owner has switched the fallback off (BR-44).
   */
  fallbackDue: boolean;
  /** The owner's manual release: one tier, ignoring BR-43's veto. */
  force: boolean;
}

export interface ReleasePlan {
  /** How many tiers should be released in total, counting those already released. */
  releasedCount: number;
  /** Players whose `invited_at` must be stamped, in tier then member order. */
  toInvite: string[];
}

/**
 * Whether this player occupies one of the fixture's slots outright.
 *
 * Only `in`. A released `waitlisted` player is counted too, but by the caller
 * and only once their tier is open — see `measure` for why the two cases
 * cannot share a predicate.
 */
function occupiesASlot(status: ResponseStatus | null): boolean {
  return status === "in";
}

/**
 * How many tiers of this Game's invite order should be released, and who that
 * newly invites (BR-41 to BR-44).
 *
 * **Level-based: the answer is a function of current state, with no event log.**
 * Two consequences the callers depend on. A second call on unchanged state
 * returns the same plan, so a retry, an overlapping sweep tick and a concurrent
 * decline cannot compound. And a release the veto held back is never lost — it
 * simply happens on the first call after `potential` drops.
 *
 * `shortfall` is counted from the **membership** side rather than by counting
 * `out` rows, because an owner removal deletes the row of a player who had not
 * yet answered. A rule that counted declines would silently fail to release a
 * tier for exactly the player the organiser had just taken out.
 */
export function planReleases(input: ReleaseInput): ReleasePlan {
  const { tiers, maxPlayers, minPlayers, guestInCount, fallbackDue, force } = input;

  // A tier is released once any of its members carries a stamp *that a release
  // put there*. Derived from the *last* such tier rather than from the first
  // gap, so an empty tier — one whose members have all left the squad — does
  // not read as a break in the sequence and stall every tier behind it.
  //
  // `invitedIndividually` is excluded deliberately (M46): the owner inviting
  // one sub by hand invites exactly that person, and reading it as a release
  // would open their whole tier and every tier above it.
  let releasedCount = 0;
  tiers.forEach((tier, index) => {
    const released = tier.members.some(
      (member) => member.invitedAt !== null && !member.invitedIndividually,
    );
    if (released) releasedCount = index + 1;
  });

  const measure = (count: number): { potential: number; shortfall: number } => {
    let potential = guestInCount;
    let shortfall = 0;
    tiers.forEach((tier, index) => {
      const released = index < count;
      for (const member of tier.members) {
        // An `in` counts wherever it sits. Under BR-40a a player answering for
        // themselves from an unreleased tier is waitlisted rather than let in,
        // so an unreleased `in` is an owner's override or a row predating this
        // rule — either way they really are occupying a slot.
        if (occupiesASlot(member.status)) potential += 1;
        // A released `waitlisted` is BR-43's original reading: BR-7 hands them
        // the next free slot, so counting them as missing would release a
        // whole tier on their behalf.
        else if (released && member.status === "waitlisted") potential += 1;
        else if (released && member.status === "pending") potential += 1;
        // Everything else on a *released* tier is a member who went missing.
        // The `released` guard is also what keeps the gate-held volunteer of
        // BR-40a out of both totals: they reach neither the `waitlisted`
        // branch above (which requires release) nor this one, which is the
        // intent. Counting them in `potential` would make their own answer
        // veto the release they are waiting for, and the fixture would kick
        // off short with a willing player on the bench; counting them here
        // would release a tier on their behalf, the same error inverted.
        else if (released) shortfall += 1;
      }
    });
    return { potential, shortfall };
  };

  /**
   * Release the next tier, stepping over any that is empty.
   *
   * A tier whose members have all left the squad invites nobody, so letting it
   * consume the release would spend a decline's release on nobody and leave
   * the real subs behind it unasked — silently, since every count still looks
   * consistent afterwards.
   */
  const releaseNext = (): void => {
    releasedCount += 1;
    while (releasedCount < tiers.length && tiers[releasedCount - 1]!.members.length === 0) {
      releasedCount += 1;
    }
  };

  // Bounded by the tier count: every iteration that continues releases at
  // least one tier, so this cannot spin even if a future edit gets a guard
  // wrong.
  for (let step = 0; step <= tiers.length; step++) {
    if (releasedCount >= tiers.length) break;

    const { potential, shortfall } = measure(releasedCount);
    const owed = 1 + shortfall;
    const target = Math.max(releasedCount, Math.min(owed, tiers.length));

    // The owner's manual release, and only ever the first extra tier of a call.
    if (force && step === 0) {
      releaseNext();
      continue;
    }
    if (releasedCount < target && potential < maxPlayers) {
      releaseNext();
      continue;
    }
    if (fallbackDue && potential < minPlayers) {
      releaseNext();
      continue;
    }
    break;
  }

  const toInvite: string[] = [];
  for (const tier of tiers.slice(0, releasedCount)) {
    for (const member of tier.members) {
      if (member.invitedAt !== null) continue;
      // No live row means there is nothing to stamp. `withdrawn` means an
      // owner took this player out of the fixture (BR-3), and inviting them
      // would undo that.
      if (member.status === null || member.status === "withdrawn") continue;
      toInvite.push(member.playerId);
    }
  }

  return { releasedCount, toInvite };
}
