/**
 * The one definition of the notification catalogue and its dedupe keys (§2.8).
 *
 * `notification_log.dedupe_key` is the entire idempotency guarantee behind the
 * reminder sweep: the sweep runs on a fixed cadence, forever, and can be retried or overlap
 * with itself, and the UNIQUE constraint on this column is what stops a retry
 * from emailing everyone twice. Every builder here must produce exactly the
 * string documented in §2.8's dedupe-key table — a typo is a duplicate email
 * to a real person.
 *
 * The Drizzle column enum (`src/db/schema.ts`) derives `notification_type`
 * from `NOTIFICATION_TYPES` below, so adding or renaming a type is a
 * typecheck error rather than silent drift.
 */
export const NOTIFICATION_TYPES = ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** `notification_log.status` (§2.8). */
export const NOTIFICATION_STATUSES = ["queued", "sent", "failed"] as const;

export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** N-1 reminder: once per player per fixture (BR-18). */
export function reminderKey(fixtureId: string, playerId: string): string {
  return `n1:${fixtureId}:${playerId}`;
}

/**
 * N-2 promotion: once per promotion.
 *
 * Includes `promotedAt` deliberately — unlike N-4, a player promoted twice
 * (e.g. promoted, drops out, promoted again) is told twice, because each
 * promotion is genuinely new information.
 *
 * **Warning for whoever writes the next promotion pass** (cancellation and
 * BR-3 both need one): `promotedAt` is caller-supplied, and `Date.now()` is
 * frozen between I/O within a single Worker invocation, so a pass that
 * promotes several players in one request must not reuse a single `now` for
 * all of them. `FixtureCapacity#setResponse` gets away with echoing back
 * `input.now` unmodified only because it promotes at most one player per
 * call. A multi-slot pass reading one `now` per player it promotes — not one
 * `now` for the whole pass — keeps this key unique; reusing one `now` across
 * the pass would give the same player promoted twice in it a colliding key,
 * and the UNIQUE constraint on `dedupe_key` would silently drop the second
 * N-2 rather than error.
 */
export function promotionKey(fixtureId: string, playerId: string, promotedAt: string): string {
  return `n2:${fixtureId}:${playerId}:${promotedAt}`;
}

/** N-3 cancellation: once per player per fixture. */
export function cancellationKey(fixtureId: string, playerId: string): string {
  return `n3:${fixtureId}:${playerId}`;
}

/**
 * N-4 attention: once per owner per fixture, ever (BR-31).
 *
 * Deliberately excludes any timestamp, unlike N-2 — the owner is warned at
 * most once per fixture no matter how many times the short-numbers condition
 * re-triggers within the warning window.
 */
export function attentionKey(fixtureId: string, playerId: string): string {
  return `n4:${fixtureId}:${playerId}`;
}

/**
 * N-6 welcome: once per membership, and again on each rejoin.
 *
 * §2.8's table gives this key as `n6:<membership_id>` and its prose says
 * "rejoining sends again". Those contradict each other, because
 * `UNIQUE (game_id, player_id)` on `memberships` forces a rejoin to reactivate
 * the existing row rather than insert a second one — so the membership id
 * alone is the same string both times and the unique index on `dedupe_key`
 * would silently drop the second welcome.
 *
 * `joinedAt` (reset on every reactivation, see `src/domain/join-squad.ts`)
 * is what distinguishes them. Passed as an ISO string by every caller.
 */
export function welcomeKey(membershipId: string, joinedAt: string): string {
  return `n6:${membershipId}:${joinedAt}`;
}

/**
 * N-7, the removal email: once per removal.
 *
 * `leftAt`, not the membership id alone, for exactly the reason `welcomeKey`
 * takes `joinedAt`. `UNIQUE (game_id, player_id)` on `memberships` forces a
 * rejoin to reactivate the existing row, so across a join → remove → rejoin →
 * remove cycle the membership id is the same string both times, and the unique
 * index on `dedupe_key` would silently drop the second email. Passed as an ISO
 * string by every caller.
 */
export function removalKey(membershipId: string, leftAt: string): string {
  return `n7:${membershipId}:${leftAt}`;
}

/**
 * N-8 erasure scheduled: once per request (M7b, BR-34).
 *
 * Includes `erasesAt` deliberately, like N-2 and unlike N-4: someone who
 * requests erasure, cancels, and requests again has genuinely new information
 * both times, and each request has its own deadline. Keyed on the player
 * alone, the unique index on `dedupe_key` would silently drop the second
 * email and leave them with no record of the second, still-live request.
 */
export function erasureScheduledKey(playerId: string, erasesAt: string): string {
  return `n8:${playerId}:${erasesAt}`;
}
