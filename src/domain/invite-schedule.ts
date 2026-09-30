import { askCutoff } from "./invite-tiers.js";
import { reminderInstant, type ReminderTimingInputs } from "./reminder-time.js";
import { parseLocalTime, type LocalDate } from "./time/local.js";
import { toUtc } from "./time/zone.js";
import { addWakingHours } from "./waking-hours.js";

const HOUR_MS = 3_600_000;

/** A week of waking hours; anything longer cannot fit before a weekly kickoff. */
export const MAX_ASK_AFTER_HOURS = 7 * 17;

/** One group as the schedule sees it. */
export interface ScheduleTier {
  name: string;
  /** Ignored for the first group. Null: asked only when the groups above cannot fill the game. */
  askAfterHours: number | null;
  memberCount: number;
}

export type ScheduledAsk =
  | { kind: "opens"; name: string; askAt: Date }
  | { kind: "timed"; name: string; askAt: Date; pausedOvernight: boolean; late: boolean }
  | { kind: "when-needed"; name: string }
  | { kind: "empty"; name: string };

export interface ScheduleProblem {
  name: string;
  askAt: Date;
  /** The longest head start that still fits, or null if none does. */
  longestThatFits: number | null;
}

export interface Schedule {
  asks: ScheduledAsk[];
  /** Nothing timed is asked after this. */
  cutoff: Date;
  problem: ScheduleProblem | null;
}

/**
 * The slowest schedule this order can run to (M69): the first group at open,
 * each timed group when its head start runs out, and nothing brought forward
 * by auto-advance.
 *
 * What the owner is shown and what a save is checked against, so a schedule
 * that asks a group after the latest useful moment cannot be saved. The live
 * rule in `planReleases` also enforces the cut-off, as a safety net for
 * schedules that stop fitting later — a late open, or a kickoff moved earlier.
 *
 * A group with nobody in it is skipped exactly as `planReleases` skips it, so
 * the preview agrees with what will happen.
 */
export function planSchedule(input: {
  tiers: ScheduleTier[];
  openAt: Date;
  kicksOffAt: Date;
  timeZone: string;
}): Schedule {
  const { openAt, kicksOffAt, timeZone } = input;
  const cutoff = askCutoff(kicksOffAt, timeZone);
  const asks: ScheduledAsk[] = [];
  let problem: ScheduleProblem | null = null;
  let previous: Date | null = null;

  for (const tier of input.tiers) {
    if (tier.memberCount === 0) {
      asks.push({ kind: "empty", name: tier.name });
      continue;
    }
    if (previous === null) {
      asks.push({ kind: "opens", name: tier.name, askAt: openAt });
      previous = openAt;
      continue;
    }
    if (tier.askAfterHours === null) {
      asks.push({ kind: "when-needed", name: tier.name });
      continue;
    }

    const askAt = addWakingHours(previous, tier.askAfterHours, timeZone);
    const late = askAt > cutoff;
    asks.push({
      kind: "timed",
      name: tier.name,
      askAt,
      pausedOvernight: askAt.getTime() - previous.getTime() > tier.askAfterHours * HOUR_MS,
      late,
    });

    if (late && problem === null) {
      const from = previous;
      let longestThatFits: number | null = null;
      for (let hours = tier.askAfterHours - 1; hours >= 0; hours--) {
        if (addWakingHours(from, hours, timeZone) <= cutoff) {
          longestThatFits = hours;
          break;
        }
      }
      problem = { name: tier.name, askAt, longestThatFits };
    }
    previous = askAt;
  }

  return { asks, cutoff, problem };
}

/**
 * When a fixture on `kickoffDate` would open and kick off under these
 * settings.
 *
 * Built from the settings rather than read from a stored fixture, so the game
 * form can check a schedule against a kickoff time or reminder the owner is
 * only now proposing.
 */
export function representativeTimes(
  settings: ReminderTimingInputs & { kickoffTime: string },
  kickoffDate: LocalDate,
): { openAt: Date; kicksOffAt: Date } {
  const time = parseLocalTime(settings.kickoffTime);
  const kicksOffAt = toUtc(
    { ...kickoffDate, hour: time.hour, minute: time.minute, second: 0 },
    settings.timezone,
  );
  return { openAt: reminderInstant(settings, kicksOffAt), kicksOffAt };
}
