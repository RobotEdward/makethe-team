export const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface WeeklyRule {
  freq: "WEEKLY";
  interval: number;
  byday: Weekday;
}

export class RecurrenceError extends Error {}

const SUPPORTED_KEYS = new Set(["FREQ", "INTERVAL", "BYDAY"]);
const MAX_INTERVAL = 8;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function isWeekday(value: string): value is Weekday {
  return (WEEKDAYS as readonly string[]).includes(value);
}

/**
 * Parse the supported subset of RFC 5545 RRULE: FREQ=WEEKLY with an optional
 * INTERVAL and exactly one BYDAY. Anything else throws — silently ignoring an
 * unsupported part would schedule a game on the wrong days.
 */
export function parseRecurrenceRule(input: string): WeeklyRule {
  if (typeof input !== "string") {
    throw new RecurrenceError(`Recurrence rule must be a string, got ${typeof input}`);
  }
  if (input.length === 0) throw new RecurrenceError("Recurrence rule must not be empty");
  if (input.trim() !== input) throw new RecurrenceError("Recurrence rule must not have surrounding whitespace");

  const parts = new Map<string, string>();
  for (const segment of input.split(";")) {
    const separator = segment.indexOf("=");
    if (separator <= 0 || separator === segment.length - 1) {
      throw new RecurrenceError(`Malformed segment "${segment}" — expected KEY=VALUE`);
    }
    const key = segment.slice(0, separator);
    if (parts.has(key)) throw new RecurrenceError(`Duplicate key ${key}`);
    parts.set(key, segment.slice(separator + 1));
  }

  for (const key of parts.keys()) {
    if (!SUPPORTED_KEYS.has(key)) {
      throw new RecurrenceError(
        `Unsupported key ${key} — only FREQ, INTERVAL and BYDAY are supported`,
      );
    }
  }

  const freq = parts.get("FREQ");
  if (freq !== "WEEKLY") {
    throw new RecurrenceError(`Unsupported FREQ ${freq ?? "(missing)"} — only WEEKLY is supported`);
  }

  const byday = parts.get("BYDAY");
  if (byday === undefined) throw new RecurrenceError("BYDAY is required");
  if (!isWeekday(byday)) {
    throw new RecurrenceError(
      `Unsupported BYDAY "${byday}" — exactly one of ${WEEKDAYS.join(", ")}`,
    );
  }

  const rawInterval = parts.get("INTERVAL") ?? "1";
  if (!POSITIVE_INTEGER.test(rawInterval)) {
    throw new RecurrenceError(`INTERVAL must be a positive whole number, got "${rawInterval}"`);
  }
  const interval = Number(rawInterval);
  if (interval > MAX_INTERVAL) {
    throw new RecurrenceError(`INTERVAL above ${MAX_INTERVAL} weeks is not supported`);
  }

  return { freq: "WEEKLY", interval, byday };
}

export function formatRecurrenceRule(rule: WeeklyRule): string {
  return `FREQ=WEEKLY;INTERVAL=${rule.interval};BYDAY=${rule.byday}`;
}
