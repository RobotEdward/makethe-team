/**
 * The one definition of `audit_log`'s `entity_type` and `action` values (BR-27, §2.8).
 *
 * The Drizzle column enums (`src/db/schema.ts`) and `recordAudit`'s parameter
 * type (`src/db/audit.ts`) derive from these arrays, so adding or renaming a
 * value is a single edit here and any drift elsewhere is a typecheck error.
 *
 * Deliberately narrow: this lists only what M4 actually writes — fixture
 * cancellation, and the three notifications a daily-ceiling refusal can
 * silently swallow. Later milestones extend these arrays as they add owner
 * actions and lifecycle changes; they do not need a migration to do so
 * (Drizzle's `text({ enum })` emits no SQL CHECK constraint on SQLite, so the
 * enum is a TypeScript-only narrowing); see `src/domain/lifecycle.ts` for the
 * equivalent for `fixtures.lifecycle`.
 *
 * `action` is namespaced (`fixture.cancelled`) so that as more entity types
 * gain actions, two unrelated actions never collide on the same bare verb.
 * Every action below is `fixture.`-namespaced because every one of them is
 * recorded against a fixture — including the notification deferrals, whose
 * `entity_id` is the fixture the undelivered message was about.
 */
export const AUDIT_ENTITY_TYPES = ["fixture"] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * The three `*_email_deferred` actions record a message the daily send
 * ceiling (TR-31) refused — the durable half of TR-31's owner-visible
 * warning, and the answer to a gap this milestone's reviews raised three
 * separate times.
 *
 * A ceiling refusal *deletes* its `notification_log` row (see
 * `applySendResult` in `src/notify/delivery.ts`) so that a retry remains
 * possible. That asymmetry is right, and is deliberately not being changed —
 * but its side effect is that the deletion also erases the only trace that
 * the message was ever owed to anyone. Without a row here, "was this player
 * ever told?" becomes unanswerable, and for two of the three cases nothing
 * retries:
 *
 * - `fixture.promotion_email_deferred` (N-2) — a player was promoted off the
 *   waitlist and never told. No later message corrects it, and a retry is
 *   impossible in any case because `promotedAt` — which the dedupe key needs
 *   — is persisted nowhere.
 * - `fixture.cancellation_email_deferred` (N-3) — materially worse: the
 *   fixture is terminal, so no reminder or any other message follows, and the
 *   players turn up to a game that is off.
 * - `fixture.attention_email_deferred` (N-4) — the mildest of the three,
 *   because the sweep re-evaluates every run and *will* retry it once the
 *   ceiling lifts. Recorded anyway, because it is the case that proves the
 *   ceiling is biting on the very channel TR-31's warning was supposed to
 *   travel down.
 *
 * They are three actions rather than one with a type field because their
 * severities differ that much: an operator wants to alert on the N-3 one
 * immediately and merely count the N-4 one.
 */
export const AUDIT_ACTIONS = [
  "fixture.cancelled",
  "fixture.promotion_email_deferred",
  "fixture.cancellation_email_deferred",
  "fixture.attention_email_deferred",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
