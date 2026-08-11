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

/**
 * A waitlisted player moved to `in` because the response being recorded freed
 * the slot they were waiting for (BR-7).
 *
 * This is **carried out of the lock, not acted on inside it**. `setResponse`
 * runs wholly inside `ctx.blockConcurrencyWhile`, so an HTTP call to a mail
 * provider from in there would serialise every other tap on the fixture behind
 * it — one slow Resend request would freeze the fixture for the whole squad.
 * The promotion itself is atomic with the dropout (same `db.batch()`); the N-2
 * email that tells the promoted player about it is the caller's job, after the
 * object has returned and the lock has been released.
 */
export interface WaitlistPromotion {
  /** The promoted player. Their response row is now `in`. */
  playerId: string;
  /**
   * The `waitlist_position` they held immediately before promotion — the
   * lowest live position on the fixture, which is the earliest arrival (BR-6).
   * Their stored position is now null; this is the only remaining record of
   * it, and it is here for logs and assertions, never for display.
   */
  previousWaitlistPosition: number;
  /**
   * When the promotion happened, as epoch milliseconds — the same `now` the
   * caller passed in, echoed back so the N-2 dedupe key
   * (`promotionKey(fixtureId, playerId, promotedAt)`) names this promotion and
   * not merely this player.
   */
  promotedAt: number;
}

export type SetResponseOutcome =
  | {
      kind: "recorded";
      status: ResponseStatus;
      inCount: number;
      spotsLeft: number;
      /**
       * Present only when this response freed a slot that a waitlisted player
       * immediately took. The caller must send N-2; the object deliberately
       * does not. See `WaitlistPromotion`.
       */
      promoted?: WaitlistPromotion;
    }
  /**
   * `waitlistPosition` is the **stored** position: the highest position among
   * the fixture's currently waitlisted players, plus one. Positions are
   * therefore *reused* — when someone leaves the waitlist, the number they
   * held becomes available to the next joiner — so this value orders the
   * waitlist but does not identify a player over time, and two players on the
   * same fixture at different moments can legitimately have held the same
   * one. Use it for logs and assertions. Never show it to a player: the page
   * renders `waitlistRank` from `getFixtureWithSquad` instead. See spec
   * amendment 5.
   */
  | { kind: "waitlisted"; waitlistPosition: number; inCount: number }
  | { kind: "rejected"; reason: "fixture-not-open" | "not-eligible" | "fixture-not-found" };
