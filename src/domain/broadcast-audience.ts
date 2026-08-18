import type { ResponseStatus } from "./response-status.js";

/**
 * Who an organiser's broadcast goes to (BR-36, spec §2).
 *
 * `everyone` is game-scoped and resolved from `memberships`; the other four
 * are fixture-scoped and resolved from `responses.status`. One union rather
 * than two because a single form, view and route serve both scopes, and a
 * split type would put a widening cast at every one of those boundaries.
 */
export const BROADCAST_AUDIENCES = ["everyone", "playing", "waitlisted", "pending", "unavailable"] as const;

export type BroadcastAudience = (typeof BROADCAST_AUDIENCES)[number];

/** The four offered on a fixture's compose page, in the order they render. */
export const FIXTURE_AUDIENCES = ["playing", "waitlisted", "pending", "unavailable"] as const;

export const DEFAULT_FIXTURE_AUDIENCE: BroadcastAudience = "playing";

/** What the radios say. One place, so the form and any later summary agree. */
export const AUDIENCE_LABELS: Record<BroadcastAudience, string> = {
  everyone: "Everyone in this squad",
  playing: "Playing",
  waitlisted: "On the waitlist",
  pending: "Not answered yet",
  unavailable: "Can't play",
};

/**
 * The mapping in the spec's §2 table, and the single place it is written.
 *
 * `status` is `string`, not `ResponseStatus`, deliberately: `responses.status`
 * is `text NOT NULL` with no CHECK constraint, so the TypeScript union is a
 * claim about the schema rather than a guarantee about the rows. An
 * unrecognised value is selected by **no** audience — excluded rather than
 * defaulted into one — because a message reaching someone on the strength of
 * a corrupt row is worse than a message not sent.
 *
 * `waitlisted` is its own audience rather than being folded into `playing`: a
 * waitlisted player has no slot, and "you're on Reds"-shaped messages must
 * not reach them. `out` and `withdrawn` pair up because the difference
 * between them is how the slot was released (BR-3), which matters to capacity
 * and to nothing an organiser writes.
 */
export function audienceSelectsStatus(audience: BroadcastAudience, status: string): boolean {
  switch (audience) {
    // Resolved from memberships, never from response rows.
    case "everyone":
      return false;
    case "playing":
      return status === "in";
    case "waitlisted":
      return status === "waitlisted";
    case "pending":
      return status === "pending";
    case "unavailable":
      return status === "out" || status === "withdrawn";
  }
}

/** Everything the exclusion rule needs to know about one candidate recipient. */
export interface BroadcastCandidate {
  isGuest: boolean;
  /** `players.email`, nullable in the schema — guests have none. */
  email: string | null;
  /** Whether this player has at least one row in `push_subscriptions`. */
  hasDevice: boolean;
}

/**
 * Whether there is any channel this player could actually be reached on
 * (spec §2.1).
 *
 * A guest is excluded whatever their row holds (BR-32): a guest is somebody an
 * organiser typed in, not somebody who agreed to hear from the product.
 *
 * The `.trim()` matches `send-teams.ts` and `send-welcome.ts` exactly, and is
 * load-bearing for the same reason: an email of `" "` is truthy, and letting
 * it through mints a `queued` row and a `no-recipient` result that
 * `applySendResult` records as `failed` forever.
 */
export function isAddressable(candidate: BroadcastCandidate): boolean {
  if (candidate.isGuest) return false;
  return (candidate.email ?? "").trim() !== "" || candidate.hasDevice;
}

/** Narrow unknown form input to an audience. */
export function isBroadcastAudience(value: unknown): value is BroadcastAudience {
  return typeof value === "string" && (BROADCAST_AUDIENCES as readonly string[]).includes(value);
}

/**
 * Present so a future `ResponseStatus` addition is a typecheck error here
 * rather than a status silently reaching no audience. Referenced by the
 * exhaustiveness case in this module's test.
 */
export type KnownStatus = ResponseStatus;
