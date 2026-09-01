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
  /**
   * What to do when the fixture is already at `max_players` and this response
   * would take a slot.
   *
   * `waitlist` is BR-5: a player answering for themselves joins the waitlist.
   * `refuse` writes nothing and returns `would-exceed-capacity` — an owner's
   * mark-in, so that BR-8's override is a second, explicit act rather than a
   * silent consequence of the first. `exceed` **is** that second act: the
   * player goes `in` regardless of `max_players`.
   *
   * Required rather than defaulted on purpose. A default is exactly what lets
   * a future caller inherit a capacity policy it never chose; requiring it
   * makes the compiler name every call site.
   *
   * It governs only *taking* a slot. An `out` intent frees one and is never
   * refused.
   */
  whenFull: "waitlist" | "refuse" | "exceed";
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
  | {
      kind: "rejected";
      reason: "fixture-not-open" | "not-eligible" | "fixture-not-found" | "would-exceed-capacity";
    };

/** What an owner's removal of a squad member does to one fixture (BR-3, J6a §3.2). */
export interface WithdrawMemberInput {
  playerId: string;
  /** The owner performing the removal. Recorded on the withdrawn row (BR-27). */
  actorPlayerId: string;
  /** Passed in rather than read from the clock — domain code stays testable. */
  now: number;
}

export type WithdrawMemberOutcome =
  | {
      // "removed", not "withdrawn": `withdrawn` is only one of the four things
      // this does to the row (a `pending`, `out` or `waitlisted` row is
      // deleted), so naming the whole outcome after it would make the deleted
      // cases read as a different result than they are.
      kind: "removed";
      /** The status the row held before this call. */
      previousStatus: "pending" | "in" | "out" | "waitlisted";
      inCount: number;
      /**
       * Present only when freeing this slot promoted a waitlisted player
       * (BR-7). Carried out of the lock for the caller to act on — the object
       * sends nothing, for the reason `WaitlistPromotion` documents.
       */
      promoted?: WaitlistPromotion;
    }
  /** Nothing to do. Not an error: a removal walks every open fixture, and most hold no row for the player. */
  | { kind: "no-op"; reason: "no-response-row" | "fixture-not-open" | "fixture-not-found" };

/** An Owner adding a one-off guest to a single fixture (J6b §5). */
export interface AddGuestInput {
  /** Already parsed and trimmed by `parseGuestName`. */
  name: string;
  /** The owner doing it. Recorded on the response row (BR-27). */
  actorPlayerId: string;
  /**
   * A guest never waitlists — they have no email address, so a guest who
   * landed on a waitlist would be a person nobody could ever tell they got
   * in. So `refuse`, and then `exceed` once the owner has confirmed.
   */
  whenFull: "refuse" | "exceed";
  now: number;
}

export type AddGuestOutcome =
  | { kind: "added"; playerId: string; inCount: number; spotsLeft: number }
  /** No `promoted` variant: adding a guest only ever takes a slot, never frees one. */
  | { kind: "rejected"; reason: "would-exceed-capacity" | "fixture-not-open" | "fixture-not-found" };

/** An owner's manual release sets `force`; every other caller leaves it off. */
export interface ClaimInviteReleasesInput {
  /** Passed in rather than read from the clock — domain code stays testable. */
  now: number;
  /** Release one tier regardless of BR-43's veto. The owner's button, only. */
  force?: boolean;
}

/**
 * Which players this call newly invited (BR-41).
 *
 * **The object stamps and returns; it never sends.** `claimInviteReleases` runs
 * wholly inside `ctx.blockConcurrencyWhile`, so an HTTP call to a mail provider
 * from in there would serialise every other tap on the fixture behind it — the
 * same reasoning `WaitlistPromotion` gives at length for N-2. The caller sends
 * the N-1 after the object has returned and the lock has been released.
 *
 * An empty `playerIds` is the steady state, not a failure: every sweep tick
 * calls this for every open gated fixture, and almost every one finds nothing
 * to release.
 */
export type ClaimInviteReleasesOutcome =
  | {
      kind: "claimed";
      /**
       * Newly stamped players who are owed the N-1 invitation — **excluding
       * anyone in `promoted`**, who is owed the N-2 instead. The two lists are
       * disjoint so that a caller cannot send one player both.
       */
      playerIds: string[];
      /**
       * Players this call moved off the waitlist into a free slot, because the
       * tier holding them back opened (BR-40a). Each is owed the N-2, exactly
       * as a BR-7 promotion is, and for the same reason the object does not
       * send it — see `WaitlistPromotion`.
       *
       * Empty on almost every call, like `playerIds`.
       */
      promoted: WaitlistPromotion[];
    }
  | {
      kind: "skipped";
      reason: "not-gated" | "fixture-not-open" | "fixture-not-found" | "already-invited";
    };
