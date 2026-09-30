import { addDays } from "./time/local.js";
import { toLocalParts, toUtc } from "./time/zone.js";

/**
 * The hours of the day, in the Game's timezone, in which a group may be asked
 * and in which a head start counts down (M69). Fixed rather than a setting:
 * nobody wants a 02:00 invitation, and a head start spent asleep is no head
 * start at all.
 */
export const WAKING_START_HOUR = 6;
export const WAKING_END_HOUR = 23;

const HOUR_MS = 3_600_000;

function localAt(instant: Date, timeZone: string, dayOffset: number, hour: number): Date {
  const date = addDays(toLocalParts(instant, timeZone), dayOffset);
  return toUtc({ ...date, hour, minute: 0, second: 0 }, timeZone);
}

export function isWaking(instant: Date, timeZone: string): boolean {
  const { hour } = toLocalParts(instant, timeZone);
  return hour >= WAKING_START_HOUR && hour < WAKING_END_HOUR;
}

/** The instant itself if waking, otherwise the next 06:00. */
function nextWakingStart(instant: Date, timeZone: string): Date {
  const { hour } = toLocalParts(instant, timeZone);
  if (hour < WAKING_START_HOUR) return localAt(instant, timeZone, 0, WAKING_START_HOUR);
  if (hour >= WAKING_END_HOUR) return localAt(instant, timeZone, 1, WAKING_START_HOUR);
  return instant;
}

/** Floor to the local hour. Local rather than UTC, for zones with half-hour offsets. */
function floorToHour(instant: Date, timeZone: string): Date {
  const parts = toLocalParts(instant, timeZone);
  return toUtc({ ...parts, minute: 0, second: 0 }, timeZone);
}

/**
 * `hours` of waking time after `start`, counted from the start of `start`'s
 * hour.
 *
 * Floored because the sweep asks on the hour: a release stamped a few seconds
 * into the 09:00 run, counted exactly, would put a 12-hour head start at
 * 21:00:04 and so miss the 21:00 run by four seconds and wait for 22:00. The
 * cost is that a group asked mid-hour — by a decline — gets up to an hour less.
 */
export function addWakingHours(start: Date, hours: number, timeZone: string): Date {
  let cursor = nextWakingStart(floorToHour(start, timeZone), timeZone);
  let remaining = hours * HOUR_MS;

  // Bounded: every pass either returns or consumes a whole waking day.
  for (;;) {
    const endOfDay = localAt(cursor, timeZone, 0, WAKING_END_HOUR);
    const available = endOfDay.getTime() - cursor.getTime();
    // Strictly less: landing exactly on 23:00 is already night.
    if (remaining < available) return new Date(cursor.getTime() + remaining);
    remaining -= available;
    cursor = localAt(cursor, timeZone, 1, WAKING_START_HOUR);
  }
}

/**
 * The last sweep hour at or before `instant` at which a group may be asked.
 *
 * 22:00 rather than 23:00 for a night-time instant, because the sweep runs on
 * the hour and the 23:00 run is already night: a deadline of 22:30 would
 * otherwise be met by nothing until 06:00.
 */
export function latestAskAtOrBefore(instant: Date, timeZone: string): Date {
  const { hour } = toLocalParts(instant, timeZone);
  if (hour >= WAKING_END_HOUR) return localAt(instant, timeZone, 0, WAKING_END_HOUR - 1);
  if (hour < WAKING_START_HOUR) return localAt(instant, timeZone, -1, WAKING_END_HOUR - 1);
  return floorToHour(instant, timeZone);
}
