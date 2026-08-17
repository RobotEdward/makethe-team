import { isTerminalLifecycle, type Lifecycle } from "./lifecycle.js";

export type { Lifecycle };

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
  /**
   * The three counts carried through unchanged, so a renderer showing the
   * headcount as a proportion — "9 of 14", and the bar drawn from it — has
   * them from the view alone. Without these, every page that draws the bar
   * would need the `FixtureFacts` beside the view it was already given, and
   * four call sites each doing their own arithmetic is four chances to
   * disagree about what "full" means.
   */
  inCount: number;
  minPlayers: number;
  maxPlayers: number;
}

const HOUR_MS = 3_600_000;

/**
 * Whether this fixture is still taking changes — the one predicate the owner
 * page's per-row controls, its add-a-guest form, the team picker and both
 * team routes gate on, so none of them can disagree about when an organiser
 * can still act. A cancelled or played fixture is history, and a merely
 * scheduled one is not yet asking anybody anything; in all three cases there
 * is no capacity write for a control to make, and the Durable Object would
 * refuse it.
 *
 * Here beside `FixtureView` rather than in the view module that first needed
 * it: it is a pure question about the type declared above, with no markup and
 * no escaping in it, and the routes that must ask the same question — the
 * team picker's save and publish, which write straight to D1 and so have no
 * Durable Object to refuse them — would otherwise be importing a predicate
 * from a view.
 */
export function takingChanges(view: FixtureView): boolean {
  return view.status !== "cancelled" && view.status !== "played" && view.status !== "scheduled";
}

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
    // A `scheduled` fixture is empty but joinable-to-be, so it has its full
    // capacity left — reporting 0 would have a renderer announce "0 spots left"
    // on a fixture nobody has been asked about yet. After `cancelled` or
    // `played` nobody can join, so there is genuinely nothing left.
    const spotsLeft = isTerminalLifecycle(facts.lifecycle)
      ? 0
      : Math.max(0, facts.maxPlayers - facts.inCount);

    // The counts go out by this return as well as the main one below: a
    // `scheduled` or `cancelled` fixture still gets rendered, and omitting
    // them here would have those pages draw a bar from `undefined` — "NaN of
    // undefined", which prints rather than throws.
    return {
      status: facts.lifecycle,
      flags: [],
      spotsLeft,
      needsOwnerAttention: false,
      inCount: facts.inCount,
      minPlayers: facts.minPlayers,
      maxPlayers: facts.maxPlayers,
    };
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
    inCount: facts.inCount,
    minPlayers: facts.minPlayers,
    maxPlayers: facts.maxPlayers,
  };
}
