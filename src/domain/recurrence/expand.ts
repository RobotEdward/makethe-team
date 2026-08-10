import type { LocalDate, LocalTime } from "../time/local.js";
import { toUtc } from "../time/zone.js";
import { WEEKDAYS, type WeeklyRule } from "./parse.js";

const DAY_MS = 86_400_000;
const MAX_ITERATIONS = 1_000;

function utcMidnightMs(date: LocalDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

function dateFromUtcMs(ms: number): LocalDate {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Expand a weekly rule into UTC instants within [from, to], inclusive.
 *
 * Occurrences are anchored to the first `byday` on or after `startDate`, then
 * every `interval` weeks. Each occurrence is computed as a calendar date plus a
 * local kickoff time, converted independently — never by adding a week of
 * milliseconds to the previous instant, which would drift across DST.
 */
export function expandWeekly(
  rule: WeeklyRule,
  startDate: LocalDate,
  kickoff: LocalTime,
  timeZone: string,
  from: Date,
  to: Date,
): Date[] {
  if (to.getTime() < from.getTime()) return [];

  const startMs = utcMidnightMs(startDate);
  const startWeekday = new Date(startMs).getUTCDay();
  const targetWeekday = WEEKDAYS.indexOf(rule.byday);
  const anchorMs = startMs + ((targetWeekday - startWeekday + 7) % 7) * DAY_MS;

  const strideMs = rule.interval * 7 * DAY_MS;

  // Skip whole strides that end before the window opens. A day of slack absorbs
  // any timezone offset between the calendar date and the instant it produces.
  const windowOpensMs = utcMidnightMs(dateFromUtcMs(from.getTime())) - DAY_MS;
  const firstIndex = windowOpensMs > anchorMs ? Math.floor((windowOpensMs - anchorMs) / strideMs) : 0;

  const occurrences: Date[] = [];
  for (let i = firstIndex; i < firstIndex + MAX_ITERATIONS; i++) {
    const date = dateFromUtcMs(anchorMs + i * strideMs);
    const instant = toUtc(
      { ...date, hour: kickoff.hour, minute: kickoff.minute, second: 0 },
      timeZone,
    );

    if (instant.getTime() > to.getTime()) return occurrences;
    if (instant.getTime() >= from.getTime()) occurrences.push(instant);
  }

  throw new Error(
    `expandWeekly exceeded ${MAX_ITERATIONS} iterations — window is too wide for interval ${rule.interval}`,
  );
}
