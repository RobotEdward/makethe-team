import type { LocalDate } from "./local.js";

export interface LocalParts extends LocalDate {
  hour: number; // 0-23
  minute: number;
  second: number;
}

const DAY_MS = 86_400_000;
const SECOND_MS = 1_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function toLocalParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl returned no ${type} for time zone "${timeZone}"`);
    return Number(part.value);
  };

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * Milliseconds to add to a UTC instant to get the local wall-clock reading.
 * Truncated to whole seconds because Intl has no sub-second resolution.
 */
function offsetAt(instantMs: number, timeZone: string): number {
  const parts = toLocalParts(new Date(instantMs), timeZone);
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asIfUtc - Math.floor(instantMs / SECOND_MS) * SECOND_MS;
}

/**
 * Convert a local wall-clock reading in `timeZone` to the UTC instant it names.
 *
 * Probing the offset a day either side is what makes the DST edges correct: on a
 * transition day two different offsets are in play, and only one of them (or, in a
 * spring-forward gap, neither) actually produces the requested local time.
 *
 * - Ambiguous (autumn overlap): both candidates are valid; return the earlier.
 * - Non-existent (spring gap): no candidate is valid; return the later attempt,
 *   which shifts the result forward by the length of the gap.
 */
export function toUtc(local: LocalParts, timeZone: string): Date {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);

  const offsets = new Set<number>([
    offsetAt(naive - DAY_MS, timeZone),
    offsetAt(naive, timeZone),
    offsetAt(naive + DAY_MS, timeZone),
  ]);

  const attempted: number[] = [];
  const valid: number[] = [];

  for (const offset of offsets) {
    const candidate = naive - offset;
    attempted.push(candidate);
    if (offsetAt(candidate, timeZone) === offset) valid.push(candidate);
  }

  if (valid.length > 0) return new Date(Math.min(...valid));
  return new Date(Math.max(...attempted));
}

/** 0 = Sunday … 6 = Saturday, in the target zone. */
export function localWeekday(instant: Date, timeZone: string): number {
  const parts = toLocalParts(instant, timeZone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}
