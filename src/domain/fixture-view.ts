export type Lifecycle = "scheduled" | "open" | "cancelled" | "played";

/** Lifecycle values plus the two judgements derived from counts and time. */
export type FixtureStatus = Lifecycle | "short" | "confirmed";

export type FixtureFlag = "uneven" | "full" | "over_capacity";

export interface FixtureFacts {
  lifecycle: Lifecycle;
  kicksOffAt: Date;
  inCount: number;
  minPlayers: number;
  maxPlayers: number;
  prefersEvenNumbers: boolean;
  shortWarningOffsetHours: number;
}

export interface FixtureView {
  status: FixtureStatus;
  flags: FixtureFlag[];
  spotsLeft: number;
  needsOwnerAttention: boolean;
}

const HOUR_MS = 3_600_000;

/**
 * Derive everything a reader needs to know about a fixture right now (§2.11).
 *
 * Pure and clock-free by design: `short` and `uneven` change purely with the
 * passage of time, so persisting them would mean a fixture whose stored status
 * quietly stops being true. Every renderer and the owner-attention sweep call
 * this, which is what keeps BR-12, BR-29 and BR-30 from drifting apart.
 */
export function fixtureView(facts: FixtureFacts, now: Date): FixtureView {
  if (facts.lifecycle !== "open") {
    return { status: facts.lifecycle, flags: [], spotsLeft: 0, needsOwnerAttention: false };
  }

  const windowOpensAt = facts.kicksOffAt.getTime() - facts.shortWarningOffsetHours * HOUR_MS;
  const inWindow = now.getTime() >= windowOpensAt;

  const flags: FixtureFlag[] = [];
  let status: FixtureStatus;

  if (facts.inCount < facts.minPlayers) {
    // Parity is meaningless below the minimum (BR-30) — being short dominates.
    status = inWindow ? "short" : "open";
  } else {
    status = "confirmed";
    if (facts.prefersEvenNumbers && facts.inCount % 2 !== 0) flags.push("uneven");
  }

  if (facts.inCount > facts.maxPlayers) flags.push("over_capacity");
  else if (facts.inCount === facts.maxPlayers) flags.push("full");

  return {
    status,
    flags,
    spotsLeft: Math.max(0, facts.maxPlayers - facts.inCount),
    needsOwnerAttention: inWindow && (status === "short" || flags.includes("uneven")),
  };
}
