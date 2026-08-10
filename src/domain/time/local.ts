export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export interface LocalTime {
  hour: number; // 0-23
  minute: number; // 0-59
}

export class LocalTimeError extends Error {}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

export function parseLocalDate(input: string): LocalDate {
  const match = DATE_PATTERN.exec(input);
  if (!match) throw new LocalTimeError(`Expected a YYYY-MM-DD date, got "${input}"`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Round-tripping through Date.UTC rejects impossible dates such as 2026-02-30,
  // which the regex alone accepts.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new LocalTimeError(`"${input}" is not a real date`);
  }

  return { year, month, day };
}

export function parseLocalTime(input: string): LocalTime {
  const match = TIME_PATTERN.exec(input);
  if (!match) throw new LocalTimeError(`Expected an HH:MM time, got "${input}"`);

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23) throw new LocalTimeError(`Hour must be 00-23, got "${input}"`);
  if (minute > 59) throw new LocalTimeError(`Minute must be 00-59, got "${input}"`);

  return { hour, minute };
}

export function formatLocalDate(date: LocalDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

export function formatLocalTime(time: LocalTime): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

const DAY_MS = 86_400_000;

/** Calendar arithmetic only — no timezone involved. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}
