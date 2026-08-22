import { formatRecurrenceRule, WEEKDAYS, type Weekday } from "./recurrence/parse.js";
import { formatLocalDate, LocalTimeError, parseLocalTime } from "./time/local.js";
import { toLocalParts } from "./time/zone.js";

/**
 * Parse and validate the game form (spec §3.2). Pure: no database, no clock,
 * no HTTP. Shared by create and edit so the two cannot disagree about what a
 * valid game is.
 *
 * Returns *every* bad field rather than the first, because the form redisplays
 * them together — failing fast here would make a submission with three
 * mistakes take three round trips.
 *
 * Three of the rules below exist to close rows in `docs/known-issues.md`, and
 * each closes it by making the bad state unreachable from a form rather than
 * by changing the module that would have mishandled it:
 *
 * - Kickoff and reminder times go through `parseLocalTime`, so a `LocalParts`
 *   with `hour: 25` cannot be built from user input.
 * - Timezones are checked against `Intl.supportedValuesOf('timeZone')`, a
 *   membership test, so a rejected zone never reaches `Intl.DateTimeFormat`
 *   and cannot drive its uncached re-construction.
 * - An odd `max_players` with `prefers_even_numbers` is a **warning, not an
 *   error** (spec Part 3 item 6). BR-29 makes parity advisory; rejecting the
 *   configuration would be stricter than the rule it protects.
 */

const MAX_NAME_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 500;
const MAX_URL_LENGTH = 500;
const MAX_DURATION_MINUTES = 1440;
const MAX_PLAYERS_CEILING = 200;
const MAX_WARNING_OFFSET_HOURS = 168;
const MAX_REMINDER_DAYS_BEFORE = 7;
const MAX_TEAM_NAME_LENGTH = 40;
const MAX_RESULT_PROMPT_OFFSET_HOURS = 48;

export const DEFAULT_TIMEZONE = "Europe/London";
export const DEFAULT_TEAM_A_NAME = "Team A";
export const DEFAULT_TEAM_B_NAME = "Team B";
export const DEFAULT_REMINDER_DAYS_BEFORE = 1;
export const DEFAULT_REMINDER_LOCAL_TIME = "09:00";
export const DEFAULT_SHORT_WARNING_OFFSET_HOURS = 12;
export const DEFAULT_RESULT_PROMPT_OFFSET_HOURS = 0;

/**
 * The notification switches (M26), and the hidden marker that rides with each.
 *
 * An unticked checkbox is absent from the POST body, so "the owner turned this
 * off" and "this form never showed the section" arrive as the same
 * `undefined`. The notification section is edit-only, and every switch
 * defaults on, so without a marker the create form's submission would read as
 * an owner who had turned all five off.
 *
 * The marker is therefore parsed, not merely rendered — unlike
 * `prefersEvenNumbersSubmitted`, whose section appears on both forms and whose
 * marker exists only for the 422 redisplay. Both halves live here so the view
 * cannot name a field the parser does not read.
 */
export const NOTIFICATION_SWITCHES = [
  { field: "reminderEnabled", submitted: "reminderEnabledSubmitted" },
  { field: "shortWarningEnabled", submitted: "shortWarningEnabledSubmitted" },
  { field: "groupNudgeEnabled", submitted: "groupNudgeEnabledSubmitted" },
  { field: "resultPromptEnabled", submitted: "resultPromptEnabledSubmitted" },
  { field: "teamsPublishedEmailEnabled", submitted: "teamsPublishedEmailEnabledSubmitted" },
] as const;

export interface GameFormValues {
  name: string;
  venueName: string;
  venueAddress: string | null;
  venueUrl: string | null;
  timezone: string;
  recurrenceRule: string;
  kickoffTime: string;
  durationMinutes: number;
  minPlayers: number;
  maxPlayers: number;
  prefersEvenNumbers: boolean;
  squadVisibleToPlayers: boolean;
  teamAName: string;
  teamBName: string;
  reminderDaysBefore: number;
  reminderLocalTime: string;
  shortWarningOffsetHours: number;
  reminderEnabled: boolean;
  shortWarningEnabled: boolean;
  groupNudgeEnabled: boolean;
  resultPromptEnabled: boolean;
  teamsPublishedEmailEnabled: boolean;
  resultPromptOffsetHours: number;
}

export interface FieldError {
  field: string;
  message: string;
}

/**
 * Warnings ride on *both* variants. A submission can be advisory-odd and
 * invalid at the same time (an odd max plus a mistyped kickoff), and the 422
 * redisplay is precisely where the nudge is most actionable — the owner is
 * still in the form. Dropping it on the failure path would mean the nudge
 * appeared only for submissions that happened to be otherwise perfect.
 */
export type GameFormResult =
  | { ok: true; values: GameFormValues; warnings: string[] }
  | { ok: false; errors: FieldError[]; warnings: string[] };

/**
 * The zones the picker offers and the validator accepts — one list, so the
 * form can never reject an option it presented. Verified available in workerd
 * (spec §3.2).
 */
let cachedZones: readonly string[] | undefined;
export function supportedTimezones(): readonly string[] {
  cachedZones ??= Intl.supportedValuesOf("timeZone");
  return cachedZones;
}

/** The local calendar date in `timezone`, as the YYYY-MM-DD anchor column wants. */
export function localDateToday(now: Date, timezone: string): string {
  return formatLocalDate(toLocalParts(now, timezone));
}

/**
 * A body value that is not a string is absent — `parseBody` can yield a File.
 * Shared with `broadcast-form.ts`, so both forms agree on what "absent" means.
 */
export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown): string | null {
  const trimmed = text(value);
  return trimmed === "" ? null : trimmed;
}

/**
 * The one wording for the odd-`max_players` nudge (BR-29, spec Part 3 item 6).
 *
 * Exported because two surfaces say it: `parseGameForm` below, so a rejected
 * submission carries it back with the form the owner is still editing, and
 * `src/views/game-overview.ts`, which re-derives the condition from the *saved*
 * game row so it keeps showing for as long as the configuration is actually
 * odd. An advisory condition that is still true deserves to still be on screen,
 * and both create and edit 303 to `/g/:id`, so the owner meets it immediately
 * after saving either way. One function so the two cannot word it differently.
 */
export function oddMaxWarning(maxPlayers: number): string {
  return `A squad of ${maxPlayers} can never split evenly, so every full fixture will show as uneven. That's only a nudge — nothing is blocked.`;
}

const WHOLE_NUMBER = /^-?[0-9]+$/;

function integer(value: unknown): number | null {
  const raw = text(value);
  if (!WHOLE_NUMBER.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isWeekday(value: string): value is Weekday {
  return (WEEKDAYS as readonly string[]).includes(value);
}

export function parseGameForm(body: Record<string, unknown>): GameFormResult {
  const errors: FieldError[] = [];
  const warnings: string[] = [];
  const fail = (field: string, message: string): void => void errors.push({ field, message });

  const name = text(body["name"]);
  if (name === "") fail("name", "Give the game a name.");
  else if (name.length > MAX_NAME_LENGTH) fail("name", `Keep the name under ${MAX_NAME_LENGTH} characters.`);

  const venueName = text(body["venueName"]);
  if (venueName === "") fail("venueName", "Say where you play.");
  else if (venueName.length > MAX_NAME_LENGTH) fail("venueName", `Keep the venue under ${MAX_NAME_LENGTH} characters.`);

  const venueAddress = optionalText(body["venueAddress"]);
  if (venueAddress !== null && venueAddress.length > MAX_ADDRESS_LENGTH) {
    fail("venueAddress", `Keep the address under ${MAX_ADDRESS_LENGTH} characters.`);
  }

  const venueUrl = optionalText(body["venueUrl"]);
  if (venueUrl !== null) {
    if (venueUrl.length > MAX_URL_LENGTH) {
      fail("venueUrl", `Keep the link under ${MAX_URL_LENGTH} characters.`);
    } else {
      // Scheme-checked, not merely parsed: `javascript:` parses perfectly well
      // and would render as a clickable link on the public invite page.
      let parsed: URL | null;
      try {
        parsed = new URL(venueUrl);
      } catch {
        parsed = null;
      }
      if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        fail("venueUrl", "The venue link must start with http:// or https://");
      }
    }
  }

  // `timezone` is absent on the create form, which is what the default is for.
  // An explicitly empty string is a bad submission, not an absent field, so it
  // must fall through to the membership check below rather than default away.
  const timezone = body["timezone"] === undefined ? DEFAULT_TIMEZONE : text(body["timezone"]);
  if (!supportedTimezones().includes(timezone)) {
    fail("timezone", "Pick a time zone from the list.");
  }

  const weekday = text(body["weekday"]);
  if (!isWeekday(weekday)) fail("weekday", "Pick the day you play.");

  const interval = integer(body["interval"]);
  if (interval !== 1 && interval !== 2) {
    fail("interval", "Choose every week or every 2 weeks.");
  }

  const kickoffTime = text(body["kickoffTime"]);
  if (!isValidLocalTime(kickoffTime)) fail("kickoffTime", "Give a kickoff time as HH:MM, like 19:00.");

  const durationMinutes = integer(body["durationMinutes"]);
  if (durationMinutes === null || durationMinutes <= 0 || durationMinutes > MAX_DURATION_MINUTES) {
    fail("durationMinutes", "How long is the game, in minutes?");
  }

  const minPlayers = integer(body["minPlayers"]);
  if (minPlayers === null || minPlayers < 1 || minPlayers > MAX_PLAYERS_CEILING) {
    fail("minPlayers", "The minimum must be at least 1.");
  }

  const maxPlayers = integer(body["maxPlayers"]);
  if (maxPlayers === null || maxPlayers < 1 || maxPlayers > MAX_PLAYERS_CEILING) {
    fail("maxPlayers", "The maximum must be at least 1.");
  }

  if (minPlayers !== null && maxPlayers !== null && minPlayers > maxPlayers) {
    fail("minPlayers", "The minimum can't be higher than the maximum.");
  }

  const prefersEvenNumbers = typeof body["prefersEvenNumbers"] === "string";
  const squadVisibleToPlayers = typeof body["squadVisibleToPlayers"] === "string";

  // Blank or absent falls back to the default rather than being rejected,
  // unlike `timezone`: there is no meaningful "explicitly blank" team name to
  // preserve, so an empty submission is just the owner not naming their sides.
  const teamAName = optionalText(body["teamAName"]) ?? DEFAULT_TEAM_A_NAME;
  if (teamAName.length > MAX_TEAM_NAME_LENGTH) {
    fail("teamAName", `Keep the team name under ${MAX_TEAM_NAME_LENGTH} characters.`);
  }

  const teamBName = optionalText(body["teamBName"]) ?? DEFAULT_TEAM_B_NAME;
  if (teamBName.length > MAX_TEAM_NAME_LENGTH) {
    fail("teamBName", `Keep the team name under ${MAX_TEAM_NAME_LENGTH} characters.`);
  }

  // Advisory, per BR-29 and spec Part 3 item 6: a full fixture at an odd max
  // can never satisfy parity, so it carries the `uneven` flag permanently.
  // Worth saying out loud; not worth refusing.
  if (prefersEvenNumbers && maxPlayers !== null && maxPlayers % 2 === 1) {
    warnings.push(oddMaxWarning(maxPlayers));
  }

  const reminderDaysBefore = body["reminderDaysBefore"] === undefined
    ? DEFAULT_REMINDER_DAYS_BEFORE
    : integer(body["reminderDaysBefore"]);
  if (
    reminderDaysBefore === null ||
    reminderDaysBefore < 0 ||
    reminderDaysBefore > MAX_REMINDER_DAYS_BEFORE
  ) {
    fail("reminderDaysBefore", `Remind between 0 and ${MAX_REMINDER_DAYS_BEFORE} days before.`);
  }

  // Absent-defaults, not blank-defaults, matching `timezone`: an
  // <input type="time"> can be cleared and submitted blank, and a blank
  // submission must be rejected rather than silently coerced to the default.
  const reminderLocalTime = body["reminderLocalTime"] === undefined
    ? DEFAULT_REMINDER_LOCAL_TIME
    : text(body["reminderLocalTime"]);
  if (!isValidLocalTime(reminderLocalTime)) {
    fail("reminderLocalTime", "Give the reminder time as HH:MM, like 09:00.");
  }

  const shortWarningOffsetHours = body["shortWarningOffsetHours"] === undefined
    ? DEFAULT_SHORT_WARNING_OFFSET_HOURS
    : integer(body["shortWarningOffsetHours"]);
  if (
    shortWarningOffsetHours === null ||
    shortWarningOffsetHours < 1 ||
    shortWarningOffsetHours > MAX_WARNING_OFFSET_HOURS
  ) {
    fail("shortWarningOffsetHours", `Warn between 1 and ${MAX_WARNING_OFFSET_HOURS} hours before.`);
  }

  // A switch the form never showed stays on; see NOTIFICATION_SWITCHES.
  const switchValue = (field: string, submitted: string): boolean =>
    body[submitted] === undefined ? true : typeof body[field] === "string";

  const reminderEnabled = switchValue("reminderEnabled", "reminderEnabledSubmitted");
  const shortWarningEnabled = switchValue("shortWarningEnabled", "shortWarningEnabledSubmitted");
  const groupNudgeEnabled = switchValue("groupNudgeEnabled", "groupNudgeEnabledSubmitted");
  const resultPromptEnabled = switchValue("resultPromptEnabled", "resultPromptEnabledSubmitted");
  const teamsPublishedEmailEnabled = switchValue(
    "teamsPublishedEmailEnabled",
    "teamsPublishedEmailEnabledSubmitted",
  );

  const resultPromptOffsetHours = body["resultPromptOffsetHours"] === undefined
    ? DEFAULT_RESULT_PROMPT_OFFSET_HOURS
    : integer(body["resultPromptOffsetHours"]);
  if (
    resultPromptOffsetHours === null ||
    resultPromptOffsetHours < 0 ||
    resultPromptOffsetHours > MAX_RESULT_PROMPT_OFFSET_HOURS
  ) {
    fail(
      "resultPromptOffsetHours",
      `Ask between 0 and ${MAX_RESULT_PROMPT_OFFSET_HOURS} hours after full time.`,
    );
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  return {
    ok: true,
    warnings,
    values: {
      name,
      venueName,
      venueAddress,
      venueUrl,
      timezone,
      recurrenceRule: formatRecurrenceRule({
        freq: "WEEKLY",
        interval: interval!,
        byday: weekday as Weekday,
      }),
      kickoffTime,
      durationMinutes: durationMinutes!,
      minPlayers: minPlayers!,
      maxPlayers: maxPlayers!,
      prefersEvenNumbers,
      squadVisibleToPlayers,
      teamAName,
      teamBName,
      reminderDaysBefore: reminderDaysBefore!,
      reminderLocalTime,
      shortWarningOffsetHours: shortWarningOffsetHours!,
      reminderEnabled,
      shortWarningEnabled,
      groupNudgeEnabled,
      resultPromptEnabled,
      teamsPublishedEmailEnabled,
      resultPromptOffsetHours: resultPromptOffsetHours!,
    },
  };
}

/**
 * Delegates to `parseLocalTime` rather than testing a regex here, so the form
 * and the materialisation path agree on what a time is by construction.
 */
function isValidLocalTime(value: string): boolean {
  try {
    parseLocalTime(value);
    return true;
  } catch (error) {
    if (error instanceof LocalTimeError) return false;
    throw error;
  }
}
