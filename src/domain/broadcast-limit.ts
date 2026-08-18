/**
 * How many broadcasts one game may send in a UTC day (BR-36, spec §7).
 *
 * This is the first path in the product that lets a *person* spend the global
 * daily email ceiling (`MAX_EMAILS_PER_DAY`, TR-31) on demand. Without a
 * per-game limit, one organiser with a 200-player squad starves every other
 * game's reminders for the rest of the day.
 *
 * Three is a starting number, not a law. It is here, alone, with its reasoning
 * attached, so raising it is one edit.
 */
export const MAX_BROADCASTS_PER_GAME_PER_DAY = 3;

/**
 * The UTC midnight the day containing `now` began at.
 *
 * UTC, matching `QuotaNotifier`'s own `dayKey` rather than the game's local
 * timezone: the resource being protected is the global daily email ceiling,
 * which resets on the UTC day, and a per-game local day would let a game in
 * UTC+13 spend against two of them.
 */
export function utcDayStart(now: Date): Date {
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
}
