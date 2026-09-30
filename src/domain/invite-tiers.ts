import type { ResponseStatus } from "./response-status.js";
import { addWakingHours, isWaking, latestAskAtOrBefore } from "./waking-hours.js";

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
  /**
   * How many waking hours after the previous group this one is asked (M69),
   * or null for "only when the groups above cannot fill the game". Ignored for
   * the first group, which is asked when the fixture opens.
   */
  askAfterHours: number | null;
  members: TierMember[];
}

export interface ReleaseInput {
  /** In invite order: stored tiers by (position, created_at), then the implicit tier. */
  tiers: TierState[];
  /** Live `in` responses belonging to no membership — guests (BR-32). */
  guestInCount: number;
  maxPlayers: number;
  now: Date;
  /** The Game's IANA timezone, which waking hours are read in. */
  timeZone: string;
  /** When the fixture opened, which is when its first group was asked. */
  openedAt: Date;
  kicksOffAt: Date;
  /** The owner's manual release: one tier, whatever the clock and the count say. */
  force: boolean;
}

export interface ReleasePlan {
  /** Every tier released once this plan is applied, in order, counting those already released. */
  releasedTierIds: Array<string | null>;
  /** Players whose `invited_at` must be stamped, in tier then member order. */
  toInvite: string[];
}

/**
 * A timed group is asked no later than this long before kickoff, if the game
 * is not full (M69). The safety net for a schedule that no longer fits —
 * after a late open, or a kickoff moved earlier.
 */
export const ASK_CUTOFF_HOURS_BEFORE_KICKOFF = 3;

const HOUR_MS = 3_600_000;

/** The latest a timed group may be asked for this kickoff. */
export function askCutoff(kicksOffAt: Date, timeZone: string): Date {
  return latestAskAtOrBefore(
    new Date(kicksOffAt.getTime() - ASK_CUTOFF_HOURS_BEFORE_KICKOFF * HOUR_MS),
    timeZone,
  );
}

/**
 * When a timed group falls due: its head start of waking hours, counted from
 * when the group before it was asked, but never later than the cut-off.
 */
export function dueAt(
  previousAskedAt: Date,
  askAfterHours: number,
  kicksOffAt: Date,
  timeZone: string,
): Date {
  const byHeadStart = addWakingHours(previousAskedAt, askAfterHours, timeZone);
  const cutoff = askCutoff(kicksOffAt, timeZone);
  return byHeadStart < cutoff ? byHeadStart : cutoff;
}

/**
 * When a tier was asked by a release: its earliest stamp *that a release put
 * there*, or null if none did.
 *
 * `invitedIndividually` is excluded deliberately (M46): the owner inviting one
 * sub by hand invites exactly that person, and reading it as a release would
 * open their whole tier and every tier above it.
 */
export function releaseStamp(tier: {
  members: ReadonlyArray<Pick<TierMember, "invitedAt" | "invitedIndividually">>;
}): Date | null {
  return tier.members.reduce<Date | null>((earliest, member) => {
    if (member.invitedAt === null || member.invitedIndividually) return earliest;
    return earliest === null || member.invitedAt < earliest ? member.invitedAt : earliest;
  }, null);
}

/**
 * How many tiers are released, derived from the *last* one carrying a release
 * stamp rather than from the first gap — so a tier whose members all lost
 * their rows, and so was stamped for nobody, does not read as a break in the
 * sequence and stall every tier behind it.
 */
function releasedCountOf(tiers: TierState[]): number {
  let count = 0;
  tiers.forEach((tier, index) => {
    if (releaseStamp(tier) !== null) count = index + 1;
  });
  return count;
}

export type GroupDue = { kind: "asked" } | { kind: "at"; at: Date } | { kind: "when-needed" };

/**
 * When this player's group will be asked, at the latest (M69) — what a player
 * who said yes early, or has not been asked, is told.
 *
 * The head starts chained from the last group actually asked, clamped to the
 * cut-off, exactly as `planReleases` would reach them if nothing brought them
 * forward. Null when the player is in no group of this order.
 */
export function whenGroupIsAsked(
  input: Pick<ReleaseInput, "tiers" | "timeZone" | "openedAt" | "kicksOffAt">,
  playerId: string,
): GroupDue | null {
  const tiers = input.tiers.filter((tier) => tier.members.length > 0);
  const index = tiers.findIndex((tier) => tier.members.some((member) => member.playerId === playerId));
  if (index === -1) return null;

  const released = releasedCountOf(tiers);
  if (index < released) return { kind: "asked" };

  let at = released <= 1 ? input.openedAt : (releaseStamp(tiers[released - 1]!) ?? input.openedAt);
  for (const tier of tiers.slice(Math.max(released, 1), index + 1)) {
    if (tier.askAfterHours === null) return { kind: "when-needed" };
    at = dueAt(at, tier.askAfterHours, input.kicksOffAt, input.timeZone);
  }
  return { kind: "at", at };
}

/**
 * Which tiers of this Game's invite order should be released, and who that
 * newly invites (M69, replacing BR-43/BR-44's decline counting).
 *
 * The first group is asked when the fixture opens. Each later group is asked
 * at the first of:
 *
 * - **auto-advance** — everyone asked so far who is in, has not answered, or
 *   is waiting for a place in a full game, plus guests, cannot reach the
 *   maximum;
 * - **its head start running out** — `askAfterHours` waking hours after the
 *   group before it was asked, if the game is not full;
 * - **the cut-off**, three hours before kickoff, on the same condition.
 *
 * A group with `askAfterHours` null takes part only in auto-advance. Nothing
 * but the owner's manual release asks a group outside waking hours.
 *
 * **Level-based: the answer is a function of current state and the clock,
 * with no event log.** A second call on unchanged state returns the same plan,
 * so a retry, an overlapping sweep tick and a concurrent decline cannot
 * compound — and a release the full game held back simply happens on the
 * first call after a place frees.
 */
export function planReleases(input: ReleaseInput): ReleasePlan {
  const { maxPlayers, guestInCount, now, timeZone, openedAt, kicksOffAt, force } = input;

  // A group with nobody in it invites nobody, so it is dropped before the
  // order is walked. Kept, it would spend a head start asking no one while
  // the real subs behind it waited.
  const tiers = input.tiers.filter((tier) => tier.members.length > 0);

  let releasedCount = releasedCountOf(tiers);

  // When the most recently released tier was asked — what the next tier's
  // head start counts from. The first tier was asked when the fixture opened
  // whatever its stamps say; a tier released by this call was asked now.
  let lastAskedAt: Date =
    releasedCount <= 1 ? openedAt : (releaseStamp(tiers[releasedCount - 1]!) ?? openedAt);

  // Taken slots, wherever the player sits: an `in` from an unreleased tier is
  // an owner's override or a hand invite, and really does hold a place.
  const inCount =
    guestInCount +
    tiers.reduce((sum, tier) => sum + tier.members.filter((member) => member.status === "in").length, 0);

  /**
   * Everyone who could still fill a place: every `in`, plus — on a released
   * tier only — everyone not yet answered and everyone waiting for a place.
   * An unreleased `waitlisted` is an early yes held by the order (BR-40a);
   * counting it would let that player's keenness keep their own group
   * waiting.
   */
  const potential = (count: number): number => {
    let total = inCount;
    tiers.slice(0, count).forEach((tier) => {
      for (const member of tier.members) {
        if (member.status === "pending" || member.status === "waitlisted") total += 1;
      }
    });
    return total;
  };

  // Bounded by the tier count: every iteration that continues releases one.
  for (let step = 0; step <= tiers.length && releasedCount < tiers.length; step++) {
    const release = (): void => {
      releasedCount += 1;
      lastAskedAt = now;
    };

    if (releasedCount === 0 || (force && step === 0)) {
      release();
      continue;
    }
    if (!isWaking(now, timeZone)) break;

    if (potential(releasedCount) < maxPlayers) {
      release();
      continue;
    }

    const next = tiers[releasedCount]!;
    if (
      next.askAfterHours !== null &&
      inCount < maxPlayers &&
      now >= dueAt(lastAskedAt, next.askAfterHours, kicksOffAt, timeZone)
    ) {
      release();
      continue;
    }
    break;
  }

  const released = tiers.slice(0, releasedCount);
  const toInvite: string[] = [];
  for (const tier of released) {
    for (const member of tier.members) {
      if (member.invitedAt !== null) continue;
      // No live row means there is nothing to stamp. `withdrawn` means an
      // owner took this player out of the fixture (BR-3), and inviting them
      // would undo that.
      if (member.status === null || member.status === "withdrawn") continue;
      toInvite.push(member.playerId);
    }
  }

  return { releasedTierIds: released.map((tier) => tier.tierId), toInvite };
}
