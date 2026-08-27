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
export const NOTIFICATION_TYPES = ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11", "n12", "n13", "n14"] as const;

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

/**
 * N-9 teams published: once per player per publish (BR-35, M9).
 *
 * `publishedAt` is load-bearing, as in N-2 and N-8. Re-publishing after a late
 * drop-out has to genuinely re-send — that is the entire point of the organiser
 * being asked to publish again — and a key without the timestamp would be
 * swallowed by the unique index on `notification_log.dedupe_key`, leaving the
 * squad holding an email describing teams that have since changed.
 */
export function teamsKey(fixtureId: string, playerId: string, publishedAt: string): string {
  return `n9:${fixtureId}:${playerId}:${publishedAt}`;
}

/**
 * N-10 organiser broadcast: once per recipient per send (BR-36, M15).
 *
 * `broadcastId` is a UUID minted once per request and shared by every
 * recipient of that send. Not a timestamp, as N-2 and N-9 use: two broadcasts
 * a second apart are both genuinely new information, and `Date.now()` is
 * frozen between I/O inside one Worker invocation — so two sends within one
 * request would mint the same key and the unique index on `dedupe_key` would
 * silently drop the second, which for the one notification a person wrote by
 * hand is the worst available failure.
 */
export function broadcastKey(broadcastId: string, playerId: string): string {
  return `n10:${broadcastId}:${playerId}`;
}

/**
 * N-11 organiser group nudge: once per owner per fixture, ever (M22).
 *
 * Push-only — the one type with no email leg — so the row written for it
 * carries `pushKey(groupNudgeKey(...))`, the same `push:` namespace every
 * other push row lives in. No timestamp, like N-4: the nudge fires the first
 * sweep tick after the fixture's reminder instant and is not repeated, since
 * the N-4 attention push already covers "numbers are short, go and chase".
 */
export function groupNudgeKey(fixtureId: string, playerId: string): string {
  return `n11:${fixtureId}:${playerId}`;
}

/**
 * N-12 "how did it go?": once per player per fixture, ever.
 *
 * No timestamp, like N-4 and unlike N-2: there is one full-time per fixture,
 * and a second prompt to record a result somebody has already chosen not to
 * record is nagging.
 */
export function resultNudgeKey(fixtureId: string, playerId: string): string {
  return `n12:${fixtureId}:${playerId}`;
}

/**
 * The push channel's dedupe key for a notification whose email key is
 * `emailKey` (M14, spec §9.3).
 *
 * A prefix on the existing key, deliberately, rather than a channel segment
 * inside every key builder. `notification_log.dedupe_key` is UNIQUE across
 * the whole table, so both channels needed separating — but rewriting the
 * *existing* keys would mean the first sweep after deploy looks up a key
 * that has never been written, finds nothing, and re-sends an N-1 reminder
 * to every player who has already had one.
 *
 * Every email key in this module therefore stays exactly as it was, and push
 * takes a namespace of its own. Nothing already in the table can collide
 * with anything new.
 */
/**
 * N-13 picker hand-over (M29): once per hand-over.
 *
 * `setAt` is in the key for the reason `promotionKey`'s `promotedAt` is: an
 * organiser who hands Thursday to Ali, changes their mind, and hands it back
 * to Ali has told Ali something new both times, and a key of
 * `n13:<fixture>:<player>` alone would silently drop the second message —
 * leaving the delegate never knowing the job was theirs again.
 *
 * The route only re-stamps `team_picker_set_at` when the holder actually
 * changes, so re-submitting the hand-over form unchanged reuses this exact
 * key and the UNIQUE constraint drops the duplicate, which is the wanted
 * behaviour rather than an accident of it.
 */
export function pickerHandoverKey(fixtureId: string, playerId: string, setAt: string): string {
  return `n13:${fixtureId}:${playerId}:${setAt}`;
}

/**
 * N-14 join confirmation (M39): **no `notification_log` row and no key
 * builder.** `notification_log.player_id` is NOT NULL and there is no
 * player yet — that is the whole point of the message. Once-per-day is
 * kept by `join_confirmations` (`src/notify/send-join-confirmation.ts`),
 * and the provider key is a fresh UUID exactly as N-5's is.
 */

export function pushKey(emailKey: string): string {
  return `push:${emailKey}`;
}
