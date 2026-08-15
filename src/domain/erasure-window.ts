/**
 * How long a requested erasure waits before the sweep performs it (§2).
 *
 * The window exists so a person who did not ask for this can stop it, and it
 * is *inert*: nothing about their memberships, responses or fixtures changes
 * until it elapses. That is not a simplification — erasure ends memberships
 * through `removeMember`, which frees each open fixture's slot and promotes
 * the longest-waiting replacement, and those promotions send email and cannot
 * be taken back. If requesting erasure removed the player immediately,
 * "cancel" would not be a cancel; it would be a rebuild of squads whose freed
 * places another player has already been told they hold.
 *
 * Fixed hours rather than calendar days: the confirmation page names a precise
 * instant, and a clock change between the request and the deadline must not
 * move it.
 */
export const ERASURE_WINDOW_MS = 48 * 60 * 60 * 1000;

/** When an erasure requested at `now` becomes due. */
export function erasureDeadline(now: Date): Date {
  return new Date(now.getTime() + ERASURE_WINDOW_MS);
}
