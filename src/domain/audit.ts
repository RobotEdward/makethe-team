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
 * `action` is namespaced by the entity it is recorded against (`fixture.
 * cancelled`, `game.updated`) so that as more entity types gain actions, two
 * unrelated actions never collide on the same bare verb. The `*_email_deferred`
 * deferral actions key on whichever entity the undelivered message was
 * about — a fixture for the sweep-driven ones (N-1, N-2, N-3, N-4, N-9), the
 * game for a broadcast (N-10), whose `entity_id` is that entity's id, not
 * always a fixture's.
 *
 * Extended by M6a, which is the first milestone to audit something that is not
 * a fixture. `entity_type` is a TypeScript-only narrowing — Drizzle's
 * `text({ enum })` emits no SQL CHECK on SQLite — so this needs no migration.
 */
export const AUDIT_ENTITY_TYPES = ["fixture", "game", "membership", "player"] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

/**
 * The `*_email_deferred` actions record a message the daily send
 * ceiling (TR-31) refused — the durable half of TR-31's owner-visible
 * warning, and the answer to a gap this milestone's reviews raised three
 * separate times.
 *
 * A ceiling refusal *deletes* its `notification_log` row (see
 * `applySendResult` in `src/notify/delivery.ts`) so that a retry remains
 * possible. That asymmetry is right, and is deliberately not being changed —
 * but its side effect is that the deletion also erases the only trace that
 * the message was ever owed to anyone. Without a row here, "was this player
 * ever told?" becomes unanswerable, and for three of the five cases nothing
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
 * - `fixture.attention_email_deferred` (N-4) — the mildest of the five,
 *   because the sweep re-evaluates every run and *will* retry it once the
 *   ceiling lifts. Recorded anyway, because it is the case that proves the
 *   ceiling is biting on the very channel TR-31's warning was supposed to
 *   travel down.
 * - `fixture.teams_email_deferred` (N-9, M9) — N-2-shaped, not N-4-shaped,
 *   and it was nearly filed as the latter: publishing *is* retryable in
 *   principle (a second publish mints a fresh dedupe key from a fresh
 *   instant), but nothing retries it — not the sweep, not any later message
 *   — and the organiser has been redirected to a page that now reads
 *   "Publish again", positively asserting the squad was told. A player who
 *   never learns which side they are on, on a fixture whose organiser has
 *   been shown success, is exactly the silence this row exists to break.
 *
 * N-1 and N-4 fire from the sweep, not from a one-shot route call, so a
 * sustained ceiling would otherwise write one row per sweep tick, forever,
 * into a table nothing prunes; `recordCeilingDeferral`'s `collapseWindowMs`
 * bounds that (see `src/notify/ceiling-audit.ts`). N-2, N-3 and N-9 fire from
 * routes and are naturally bounded by user action, so they do not pass it.
 *
 * They are five actions rather than one with a type field because their
 * severities differ that much: an operator wants to alert on the N-3 one
 * immediately and merely count the N-1 and N-4 ones.
 */
export const AUDIT_ACTIONS = [
  "fixture.cancelled",
  "fixture.reminder_email_deferred",
  "fixture.promotion_email_deferred",
  "fixture.cancellation_email_deferred",
  "fixture.attention_email_deferred",
  "fixture.teams_email_deferred",
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
  // J6b. A one-off guest, added to and removed from a single fixture. Both
  // carry a real actor: only an owner can do either.
  "fixture.guest_added",
  "fixture.guest_removed",
  // M7b (BR-34). The subject and the actor are always the same player: these
  // four are the only actions in this list nobody can perform on anyone else,
  // because both routes act on the session's own player id and take no
  // parameter naming a player.
  //
  // `player.erasure_requested` and `player.erasure_cancelled` are written by
  // the routes; `player.erased` by the sweep when the window elapses. The
  // erased row survives (anonymised), so `actor_player_id`'s foreign key still
  // resolves afterwards.
  //
  // `player.erasure_blocked` is the exception to "the actor did it": nobody
  // acted, the sweep found the invariant of §6 standing in the way. It is
  // still attributed to the player, because the actor of the *request* it
  // belongs to is the player and a null actor here would read as a cron doing
  // something to them. `after_json` carries `{ gameIds }` — the games holding
  // it up, which is the only fact an operator or a support answer needs.
  //
  // Written **once per transition into the blocked state**, not once per
  // hourly retry: `players.erasure_blocked_at` is what bounds it, exactly as
  // `recordCeilingDeferral`'s collapse window bounds the sweep-driven
  // `*_email_deferred` actions above, and for the same reason — a sweep-driven
  // condition can persist for weeks, and one row an hour forever into a table
  // nothing prunes is not a record, it is a leak.
  "player.erasure_requested",
  "player.erasure_cancelled",
  "player.erasure_blocked",
  "player.erased",
  // M11. A player renaming themselves on `/app/account`. Subject and actor are
  // always the same player, like the erasure actions above and for the same
  // reason — the route acts on the session's own player id and takes no
  // parameter naming a player. `before`/`after` carry `{ name }`, because what
  // the row is *for* is what the name used to be.
  "player.renamed",
  // M9 (BR-35). Who put someone on which side is exactly the question an audit
  // trail exists to answer, and both actions are organiser actions on a
  // fixture (BR-27). Saving and publishing are separate because only one of
  // them emails anybody.
  "fixture.teams_saved",
  "fixture.teams_published",
  // M15 (BR-36). One row per broadcast an organiser sends, and the counter the
  // per-game daily cap is enforced from (`src/domain/broadcast-limit.ts`) —
  // there is no message table, so these rows are the only record that a send
  // happened. `after_json` carries the audience, the channels, the recipient
  // count, the fixture id, and the **subject only**: copying 500 characters of
  // somebody's prose into a second, longer-lived place is not what an audit
  // trail is for.
  "game.broadcast_sent",
  // The durable half of TR-31's warning for N-10, matching the
  // `*_email_deferred` family above. A ceiling refusal deletes its
  // `notification_log` row, so without this there is no evidence anyone was
  // ever owed the message.
  "game.broadcast_email_deferred",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
