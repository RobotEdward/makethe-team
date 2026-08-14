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
 *
 * Extended by M6a, which is the first milestone to audit something that is not
 * a fixture. `entity_type` is a TypeScript-only narrowing — Drizzle's
 * `text({ enum })` emits no SQL CHECK on SQLite — so this needs no migration.
 */
export const AUDIT_ENTITY_TYPES = ["fixture", "game", "membership"] as const;

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
 * ever told?" becomes unanswerable, and for two of the four cases nothing
 * retries:
 *
 * - `fixture.reminder_email_deferred` (N-1) — the highest-volume
 *   notification in the system, and the exact case TR-31 was filed about: a
 *   `MAX_EMAILS_PER_DAY` typo failing closed to zero silently stops every
 *   reminder. Mild on its own (the sweep retries every run), but it is the
 *   case most likely to hit the ceiling first, so it is the case the durable
 *   half must not miss.
 * - `fixture.promotion_email_deferred` (N-2) — a player was promoted off the
 *   waitlist and never told. No later message corrects it, and a retry is
 *   impossible in any case because `promotedAt` — which the dedupe key needs
 *   — is persisted nowhere.
 * - `fixture.cancellation_email_deferred` (N-3) — materially worse: the
 *   fixture is terminal, so no reminder or any other message follows, and the
 *   players turn up to a game that is off.
 * - `fixture.attention_email_deferred` (N-4) — the mildest of the four,
 *   because the sweep re-evaluates every run and *will* retry it once the
 *   ceiling lifts. Recorded anyway, because it is the case that proves the
 *   ceiling is biting on the very channel TR-31's warning was supposed to
 *   travel down.
 *
 * N-1 and N-4 fire from the sweep, not from a one-shot route call, so a
 * sustained ceiling would otherwise write one row per sweep tick, forever,
 * into a table nothing prunes; `recordCeilingDeferral`'s `collapseWindowMs`
 * bounds that (see `src/notify/ceiling-audit.ts`). N-2 and N-3 fire from
 * routes and are naturally bounded by user action, so they do not pass it.
 *
 * They are four actions rather than one with a type field because their
 * severities differ that much: an operator wants to alert on the N-3 one
 * immediately and merely count the N-1 and N-4 ones.
 */
export const AUDIT_ACTIONS = [
  "fixture.cancelled",
  "fixture.reminder_email_deferred",
  "fixture.promotion_email_deferred",
  "fixture.cancellation_email_deferred",
  "fixture.attention_email_deferred",
  // M6a. `game.updated` carries before/after of the changed columns only,
  // not the whole row — an owner reading this wants to see what moved.
  "game.created",
  "game.updated",
  "game.invite_rotated",
  // A join through the public invite link. `actor_player_id` is **null**: the
  // actor is whoever was holding the link, and they are unidentified. It was
  // originally the joining player, on the reasoning that "nobody else acted" —
  // which is false for the case that matters. `joinSquad` reuses any existing
  // `players` row matching the submitted address, so someone holding a leaked
  // link can attach a real person's account to a squad they never asked to
  // join, and an actor of the joining player made the trail assert that the
  // victim added themselves. `via: "invite_link"` in `after_json`
  // distinguishes a null actor here from a cron or system action.
  "membership.joined",
  "membership.rejoined",
  // J6a. Owner actions on someone else's membership, so both carry a real
  // actor. `membership.removed` carries `active`/`left_at` before and after;
  // `membership.role_changed` carries `role`.
  "membership.removed",
  "membership.role_changed",
  // J6b. An owner answering on a player's behalf (BR-27). `before` carries the
  // status the row held, which is what BR-27's "previous value" means here;
  // `after.overCapacity` records whether this was BR-8's deliberate override
  // rather than an ordinary mark-in, because the two are indistinguishable
  // from the resulting row alone.
  "fixture.response_overridden",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
