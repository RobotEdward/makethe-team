import type { ResponseSource, ResponseStatus } from "../domain/response-status.js";

/** What a player can ask for. Waitlisting is an outcome, never an intent (BR-5). */
export type ResponseIntent = "in" | "out";

export interface SetResponseInput {
  playerId: string;
  intent: ResponseIntent;
  /** Null when the player set it themselves; the owner's id for an override. */
  actorPlayerId: string | null;
  source: ResponseSource;
  /** Passed in rather than read from the clock — domain code stays testable. */
  now: number;
}

export type SetResponseOutcome =
  | { kind: "recorded"; status: ResponseStatus; inCount: number; spotsLeft: number }
  /**
   * `waitlistPosition` is the **stored** position — permanent, never reused,
   * and therefore gappy once people leave the waitlist. Use it for logs and
   * assertions. Never show it to a player: the page renders `waitlistRank`
   * from `getFixtureWithSquad` instead. See spec amendment 5.
   */
  | { kind: "waitlisted"; waitlistPosition: number; inCount: number }
  | { kind: "rejected"; reason: "fixture-not-open" | "not-eligible" | "fixture-not-found" };
