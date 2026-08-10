/**
 * The one definition of a fixture's stored lifecycle.
 *
 * The Drizzle column enum (`src/db/schema.ts`), the domain union type
 * (`src/domain/fixture-view.ts`) and the value materialisation writes
 * (`src/domain/materialise.ts`) all derive from this array, so adding or
 * renaming a value is a single edit and any drift is a typecheck error.
 *
 * This module imports nothing on purpose: the schema layer depends on it, so
 * anything it depended on would risk a cycle back through the domain layer.
 */
export const LIFECYCLES = ["scheduled", "open", "cancelled", "played"] as const;

export type Lifecycle = (typeof LIFECYCLES)[number];

/** The lifecycle every fixture is born in (§2.3, BR-10). */
export const INITIAL_LIFECYCLE: Lifecycle = "scheduled";

/** Lifecycles after which nobody can join, so remaining capacity is moot. */
export const TERMINAL_LIFECYCLES: readonly Lifecycle[] = ["cancelled", "played"];

export function isTerminalLifecycle(lifecycle: Lifecycle): boolean {
  return TERMINAL_LIFECYCLES.includes(lifecycle);
}
