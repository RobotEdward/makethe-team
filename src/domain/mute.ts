/**
 * Auto-decline, the player's own "don't ask me for a while" switch (M28).
 *
 * A mute lives on `memberships` — it is a fact about one player in one Game,
 * never a preference on `players`. "Apply to all my games" writes the same
 * pair of columns onto every membership the player holds *at that moment*; a
 * Game they join next month starts unmuted, because joining is itself the act
 * of saying "ask me about this one".
 *
 * Nothing sweeps an expired mute away. `isMuted` is asked with a clock, so a
 * mute that has run out simply stops applying and the row goes on recording
 * when the player stepped back and until when. A sweep would buy nothing and
 * would be one more scheduled write that can fail.
 */

/** The two columns `memberships` stores, and everything the predicate reads. */
export interface MuteState {
  mutedAt: Date | null;
  mutedUntil: Date | null;
}

/**
 * Whether this membership is auto-declining right now.
 *
 * `mutedAt` is the switch and `mutedUntil` is only its expiry, so a row
 * carrying an expiry with no `mutedAt` beside it — a half-written row, or one
 * a future unmute path clears in the wrong order — reads as *not* muted. The
 * failure that matters here is silence a player did not ask for, so the
 * ambiguous row fails towards being asked.
 *
 * The comparison is strict: at the exact instant of expiry the mute is over.
 */
export function isMuted(state: MuteState, now: Date): boolean {
  if (state.mutedAt === null) return false;
  return state.mutedUntil === null || state.mutedUntil.getTime() > now.getTime();
}

/** What the radio list offers, in the order it renders. */
export const MUTE_DURATIONS = [
  { value: "1w", weeks: 1, label: "1 week" },
  { value: "2w", weeks: 2, label: "2 weeks" },
  { value: "4w", weeks: 4, label: "4 weeks" },
  { value: "8w", weeks: 8, label: "8 weeks" },
  { value: "forever", weeks: null, label: "Indefinitely" },
] as const;

export type MuteDuration = (typeof MUTE_DURATIONS)[number]["value"];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The instant a mute of this length runs out, or `null` for the indefinite
 * choice.
 *
 * Plain millisecond arithmetic, not calendar arithmetic, and deliberately so:
 * nothing here is shown to a player in a Game's timezone until
 * `formatLocalDateTime` renders it (TR-5), and "four weeks" that lands an hour
 * early across a DST boundary is not a defect anyone can perceive in a switch
 * whose whole job is to stop asking.
 */
export function muteExpiryFor(duration: MuteDuration, now: Date): Date | null {
  const chosen = MUTE_DURATIONS.find((d) => d.value === duration);
  if (!chosen || chosen.weeks === null) return null;
  return new Date(now.getTime() + chosen.weeks * WEEK_MS);
}

/**
 * The submitted duration, or `null` if it is not one of the listed ones.
 *
 * A form value is attacker-controlled, and an unrecognised one must not fall
 * through to a default: silently muting for a length nobody chose is worse
 * than refusing the submission.
 */
export function parseMuteDuration(value: unknown): MuteDuration | null {
  return MUTE_DURATIONS.some((d) => d.value === value) ? (value as MuteDuration) : null;
}

/**
 * What a refused `duration` field is told, built from the list rather than
 * typed out beside it.
 *
 * Both routes that parse a duration used to carry the four values as a string
 * literal, so M57's fifth choice would have left two error messages naming a
 * set the parser no longer had.
 */
export function muteDurationsSentence(): string {
  return MUTE_DURATIONS.map((d) => d.value).join(", ");
}
