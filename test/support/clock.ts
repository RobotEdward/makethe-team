/**
 * Shared time-independent fixture clock for tests that mint real signed
 * tokens (response/cancel/leave) and then exercise a route that verifies
 * them against the real wall clock — `SELF.fetch`, `app.fetch`, or a route
 * handler reached through either.
 *
 * A response token expires 24 hours after its fixture's kickoff (BR-24,
 * `src/domain/token.ts`), and the route under test checks that expiry
 * against `new Date(Date.now())`, not against whatever fictional `now` the
 * test used to seed the database. A fixed kickoff (`new Date("2026-08-13...")`)
 * is therefore a ticking bomb: it is in the future only until that date
 * passes, at which point every token minted against it reads as expired and
 * the route renders the generic "this link isn't working" page instead of
 * whatever the test actually meant to exercise. This bug detonated twice in
 * two days (`test/security/csp.test.ts`, then five more files) before this
 * helper existed.
 *
 * `NOW` and `kickoffIn` are relative to the instant the module loads, so a
 * fixture built from them is exactly as fresh next week as it is today.
 *
 * Not `new Date()` — ESLint's `no-restricted-syntax` bans the bare form.
 */
export const NOW = new Date(Date.now());

/**
 * A kickoff `hours` away from `NOW` — in the future for a positive offset,
 * in the past for a negative one. Use a negative offset for fixtures that
 * are deliberately past or terminal (played/cancelled) rather than a fixed
 * historical date, so they stay in the past relative to whenever the suite
 * actually runs.
 */
export function kickoffIn(hours: number): Date {
  return new Date(NOW.getTime() + hours * 60 * 60 * 1000);
}
