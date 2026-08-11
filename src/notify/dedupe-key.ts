/**
 * The one definition of the notification catalogue and its dedupe keys (§2.8).
 *
 * `notification_log.dedupe_key` is the entire idempotency guarantee behind the
 * reminder sweep: the sweep runs hourly, forever, and can be retried or overlap
 * with itself, and the UNIQUE constraint on this column is what stops a retry
 * from emailing everyone twice. Every builder here must produce exactly the
 * string documented in §2.8's dedupe-key table — a typo is a duplicate email
 * to a real person.
 *
 * The Drizzle column enum (`src/db/schema.ts`) derives `notification_type`
 * from `NOTIFICATION_TYPES` below, so adding or renaming a type is a
 * typecheck error rather than silent drift.
 */
export const NOTIFICATION_TYPES = ["n1", "n2", "n3", "n4", "n5", "n6"] as const;

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

/** N-6 welcome: once per membership; rejoining (a new membership row) sends again. */
export function welcomeKey(membershipId: string): string {
  return `n6:${membershipId}`;
}
