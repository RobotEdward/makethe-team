import { LocalTimeError, type LocalDate } from "./local.js";

export interface LocalParts extends LocalDate {
  hour: number; // 0-23
  minute: number;
  second: number;
}

const DAY_MS = 86_400_000;
const SECOND_MS = 1_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
const dateOnlyFormatters = new Map<string, Intl.DateTimeFormat>();
const displayFormatters = new Map<string, Intl.DateTimeFormat>();
const shortDateFormatters = new Map<string, Intl.DateTimeFormat>();
const timeOnlyFormatters = new Map<string, Intl.DateTimeFormat>();

/** Read-only view of the formatter cache size, for tests only. */
export function formatterCacheSize(): number {
  return formatters.size;
}

/**
 * Build (or reuse) a cached `Intl.DateTimeFormat` for `timeZone`, sharing the
 * error handling and cache-canonicalisation every caller in this module needs
 * regardless of which display options it wants.
 */
function cachedFormatter(
  timeZone: string,
  cache: Map<string, Intl.DateTimeFormat>,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  // Fast path: the input is already the canonical spelling we cached last time
  // (the common case — callers pass a single consistent IANA spelling).
  const cached = cache.get(timeZone);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(locale, { timeZone, ...options });
  } catch {
    // Intl.DateTimeFormat throws a raw RangeError for an invalid or empty IANA
    // zone name. Nothing is cached on this path — the cache must only ever hold
    // formatters for zones that actually resolved.
    throw new LocalTimeError(`"${timeZone}" is not a valid IANA time zone`);
  }

  // ICU accepts IANA zone names case-insensitively, so a naive cache keyed on the
  // raw input string lets every distinct spelling of a zone (e.g. "europe/london",
  // "EUROPE/LONDON" — 2^13 spellings for "Europe/London" alone) mint its own entry,
  // growing the cache unboundedly once a zone string is attacker-influenced.
  // Canonicalise on the resolved zone name and key the cache by that alone, so every
  // spelling of a zone shares one entry regardless of how it was cased on input.
  const canonical = formatter.resolvedOptions().timeZone;
  const canonicalFormatter = cache.get(canonical) ?? formatter;
  cache.set(canonical, canonicalFormatter);

  return canonicalFormatter;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  return cachedFormatter(timeZone, formatters, "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function timeOnlyFormatterFor(timeZone: string): Intl.DateTimeFormat {
  // Its own cache, for the reason every formatter here has one: a single cache
  // keyed by zone alone cannot hold two option sets for the same zone.
  return cachedFormatter(timeZone, timeOnlyFormatters, "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateOnlyFormatterFor(timeZone: string): Intl.DateTimeFormat {
  // Its own cache, for the reason `displayFormatters` is separate from
  // `formatters`: one cache keyed by zone alone cannot hold two different
  // option sets for the same zone without handing a caller the wrong one.
  return cachedFormatter(timeZone, dateOnlyFormatters, "en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function shortDateFormatterFor(timeZone: string): Intl.DateTimeFormat {
  // A third cache for a third option set, for the reason above: one cache
  // keyed by zone alone would hand a caller whichever options got there first.
  return cachedFormatter(timeZone, shortDateFormatters, "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function displayFormatterFor(timeZone: string): Intl.DateTimeFormat {
  // en-GB, not en-US: this is what src/routes/respond.ts used before this
  // formatter moved here, and it's what produces "Thursday 13 August at
  // 19:00" rather than the US month-first ordering.
  return cachedFormatter(timeZone, displayFormatters, "en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/**
 * Format an instant for a human reading it in `timeZone`, e.g.
 * "Thursday 13 August at 19:00".
 *
 * All timezone conversion lives in this module and nowhere else — routes and
 * views must call this rather than constructing their own
 * `Intl.DateTimeFormat`. That keeps an invalid zone failing as the typed
 * `LocalTimeError` below rather than a raw `RangeError` surfacing wherever a
 * caller happened to build its own formatter, and keeps every caller sharing
 * one canonicalised cache instead of building a fresh formatter per call.
 */
export function formatLocalDateTime(instant: Date, timeZone: string): string {
  return displayFormatterFor(timeZone).format(instant);
}

/**
 * The same, without the clock time: "Thursday 13 August".
 *
 * For an instant whose time of day is an artefact rather than information —
 * an auto-decline expiry (M28) is four weeks from whenever the player happened
 * to tap the button, and "until Saturday 19 September at 14:32" invites a
 * reader to believe that 14:32 was chosen and matters.
 *
 * Here rather than in the view for the reason above: every timezone
 * conversion in the app goes through this module (TR-5), and a view building
 * its own `Intl.DateTimeFormat` is exactly what that rule forbids.
 */
/**
 * The clock time alone: "16:35".
 *
 * For a list already grouped under its day, where repeating the date on every
 * row is noise — the fixture timeline (M52), where every entry printed the
 * full date and several shared it, so the eye read three identical dates
 * before reaching any event.
 *
 * Here rather than in the view for the reason the others are: every timezone
 * conversion in the app goes through this module (TR-5), and a view building
 * its own Intl.DateTimeFormat is exactly what that rule forbids.
 */
export function formatLocalTime(instant: Date, timeZone: string): string {
  return timeOnlyFormatterFor(timeZone).format(instant);
}

export function formatLocalDate(instant: Date, timeZone: string): string {
  return dateOnlyFormatterFor(timeZone).format(instant);
}

/**
 * The day with its year, in the shortest form that stays unambiguous.
 *
 * Distinct from `formatLocalDate` above, which gives the weekday and omits
 * the year: that form suits a deadline days away, and misleads in a list
 * spanning months, where a two-year-old date reads as a recent one.
 */
export function formatLocalShortDate(instant: Date, timeZone: string): string {
  return shortDateFormatterFor(timeZone).format(instant);
}

export function toLocalParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new LocalTimeError(`Intl returned no ${type} for time zone "${timeZone}"`);
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
