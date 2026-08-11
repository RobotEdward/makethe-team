import { addDays } from "./time/local.js";
import { parseLocalTime } from "./time/local.js";
import { toLocalParts, toUtc } from "./time/zone.js";

/** Everything `reminderInstant` needs from a Game. */
export interface ReminderTimingInputs {
  /** IANA identifier, e.g. Europe/London (TR-5). */
  timezone: string;
  reminderDaysBefore: number;
  /** Local HH:MM. */
  reminderLocalTime: string;
}

/**
 * Resolve the wall-clock instant a Fixture's reminder (N-1) should send at
 * (BR-17).
 *
 * Pure: takes the kickoff instant and the Game's reminder configuration,
 * reads no clock, and touches `Intl` only indirectly through
 * `src/domain/time/zone.ts`.
 *
 * The critical property is *how* the day-before is computed. Kickoff is
 * converted to its **local calendar date** first, `reminder_days_before` is
 * subtracted with calendar arithmetic (`addDays`, no timezone involved), and
 * the result is recombined with `reminder_local_time` and converted back to
 * UTC with `toUtc`. That keeps the reminder pinned to the same wall-clock
 * time (e.g. "09:00") on every fixture regardless of which side of a DST
 * transition it falls on.
 *
 * The alternative — subtracting `reminder_days_before * 86_400_000`
 * milliseconds straight from the kickoff instant — looks equivalent but
 * isn't: a day that crosses a BST/GMT boundary is not exactly 24 hours long,
 * so that arithmetic drifts the reminder an hour off "09:00 local" right on
 * the boundary this function exists to get correct (BR-17).
 */
export function reminderInstant(game: ReminderTimingInputs, kicksOffAt: Date): Date {
  const kickoffLocalDate = toLocalParts(kicksOffAt, game.timezone);
  const reminderLocalDate = addDays(kickoffLocalDate, -game.reminderDaysBefore);
  const reminderLocalTime = parseLocalTime(game.reminderLocalTime);

  return toUtc(
    {
      ...reminderLocalDate,
      hour: reminderLocalTime.hour,
      minute: reminderLocalTime.minute,
      second: 0,
    },
    game.timezone,
  );
}
