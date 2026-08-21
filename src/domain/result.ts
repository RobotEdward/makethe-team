/**
 * The one definition of `fixture_result_claims.outcome` and
 * `fixture_results.outcome` (BR-37).
 *
 * This module imports nothing on purpose: the schema layer depends on it, so
 * anything it depended on would risk a cycle back through the domain layer —
 * exactly the constraint `src/domain/lifecycle.ts` documents.
 */
export const RESULT_OUTCOMES = ["a", "b", "draw"] as const;

export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];
