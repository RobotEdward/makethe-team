/**
 * The one definition of `audit_log`'s `entity_type` and `action` values (BR-27, §2.8).
 *
 * The Drizzle column enums (`src/db/schema.ts`) and `recordAudit`'s parameter
 * type (`src/db/audit.ts`) derive from these arrays, so adding or renaming a
 * value is a single edit here and any drift elsewhere is a typecheck error.
 *
 * Deliberately narrow: this lists only what M4 actually writes — fixture
 * cancellation. Later milestones extend these arrays as they add owner
 * actions and lifecycle changes; they do not need a migration to do so; see
 * `src/domain/lifecycle.ts` for the equivalent for `fixtures.lifecycle`.
 *
 * `action` is namespaced (`fixture.cancelled`) so that as more entity types
 * gain actions, two unrelated actions never collide on the same bare verb.
 */
export const AUDIT_ENTITY_TYPES = ["fixture"] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const AUDIT_ACTIONS = ["fixture.cancelled"] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
