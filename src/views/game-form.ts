import type { FieldError } from "../domain/game-form.js";
import { supportedTimezones } from "../domain/game-form.js";
import { WEEKDAYS } from "../domain/recurrence/parse.js";
import { escapeHtml, layout } from "./layout.js";
import { FORM_CSS } from "./styles.js";

const WEEKDAY_LABELS: Record<string, string> = {
  MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday",
  FR: "Friday", SA: "Saturday", SU: "Sunday",
};

/**
 * The hidden companion to the "Prefer even numbers" checkbox.
 *
 * An unchecked checkbox is simply absent from the POST body, so "the owner
 * unchecked it" and "this form was never submitted" arrive as the same
 * `undefined`. The create form wants a checked default; a 422 redisplay must
 * show back what was actually submitted. Without a marker, an owner who
 * unchecks the box, mistypes the kickoff and corrects it silently saves
 * `prefers_even_numbers = true` against their intent — the redisplay re-checks
 * the box and they have no reason to look at it again.
 *
 * A hidden input is always submitted, so its presence distinguishes the two
 * cases. `parseGameForm` never reads this field: it is a rendering concern
 * only, and the checkbox itself remains the only thing that decides the value.
 */
const PREFERS_EVEN_SUBMITTED = "prefersEvenNumbersSubmitted";

function prefersEvenChecked(values: Partial<Record<string, string>>): boolean {
  if (values[PREFERS_EVEN_SUBMITTED] !== undefined) {
    // This came back from a real submission: absent means unchecked, full stop.
    return values["prefersEvenNumbers"] === "on";
  }
  // A fresh render. Absent means "the caller said nothing", and the default for
  // a new game is on; the edit route says `""` explicitly for a saved false.
  return values["prefersEvenNumbers"] === undefined || values["prefersEvenNumbers"] === "on";
}

export interface GameFormPageParams {
  /** Where the form posts. Always a same-origin relative path (`form-action 'self'`). */
  action: string;
  heading: string;
  submitLabel: string;
  /** Whatever was submitted, so a rejected form redisplays what was typed. */
  values: Partial<Record<string, string>>;
  errors: readonly FieldError[];
  warnings: readonly string[];
  /** The Advanced block appears on edit only — see spec §3.1. */
  showAdvanced: boolean;
  /** "This will update 4 scheduled fixtures…", on edit. */
  affectedNotice?: string;
}

/**
 * The create and edit form. One renderer for both, so the two cannot drift —
 * the same reason `parseGameForm` is shared on the other side.
 *
 * Every rejected submission comes back through here with `values` still
 * populated, so nothing a person typed is ever thrown away. That is why the
 * route answers 422 with this page rather than a bare 400.
 */
export function renderGameFormPage(params: GameFormPageParams): string {
  const { action, heading, submitLabel, values, errors, warnings, showAdvanced, affectedNotice } = params;

  const errorFor = (field: string): string | undefined =>
    errors.find((error) => error.field === field)?.message;

  const value = (field: string, fallback = ""): string => escapeHtml(values[field] ?? fallback);

  const field = (name: string, label: string, input: string): string => {
    const message = errorFor(name);
    return `
      <div class="field${message ? " field-invalid" : ""}">
        <label for="${name}">${escapeHtml(label)}</label>
        ${input}
        ${message ? `<span class="error" id="${name}-error">${escapeHtml(message)}</span>` : ""}
      </div>`;
  };

  const textInput = (name: string, type = "text", extra = ""): string =>
    `<input id="${name}" name="${name}" type="${type}" value="${value(name)}"${
      errorFor(name) ? ` aria-describedby="${name}-error"` : ""
    }${extra}>`;

  const weekdayOptions = WEEKDAYS.map((code) =>
    `<option value="${code}"${values["weekday"] === code ? " selected" : ""}>${WEEKDAY_LABELS[code]}</option>`,
  ).join("");

  const intervalOptions = [
    ["1", "Every week"],
    ["2", "Every 2 weeks"],
  ].map(([code, label]) =>
    `<option value="${code}"${values["interval"] === code ? " selected" : ""}>${label}</option>`,
  ).join("");

  const timezoneOptions = supportedTimezones().map((zone) =>
    `<option value="${escapeHtml(zone)}"${
      (values["timezone"] ?? "Europe/London") === zone ? " selected" : ""
    }>${escapeHtml(zone)}</option>`,
  ).join("");

  const advanced = showAdvanced
    ? `
      <details>
        <summary>Advanced</summary>
        ${field("timezone", "Time zone", `<select id="timezone" name="timezone">${timezoneOptions}</select>`)}
        ${field("venueUrl", "Venue link", textInput("venueUrl", "url"))}
        ${field("reminderDaysBefore", "Send the reminder this many days before", textInput("reminderDaysBefore", "number"))}
        ${field("reminderLocalTime", "Send the reminder at", textInput("reminderLocalTime", "time"))}
        ${field("shortWarningOffsetHours", "Warn owners this many hours before kickoff", textInput("shortWarningOffsetHours", "number"))}
      </details>`
    : "";

  const body = `
    <h1>${escapeHtml(heading)}</h1>
    ${errors.length > 0 ? `<p class="nudge">Some details need another look.</p>` : ""}
    ${warnings.map((warning) => `<p class="nudge">${escapeHtml(warning)}</p>`).join("")}
    ${affectedNotice ? `<p class="nudge">${escapeHtml(affectedNotice)}</p>` : ""}
    <form method="post" action="${escapeHtml(action)}">
      ${field("name", "Game name", textInput("name"))}
      ${field("venueName", "Where you play", textInput("venueName"))}
      ${field("venueAddress", "Address (optional)", textInput("venueAddress"))}
      <div class="row">
        ${field("weekday", "Day", `<select id="weekday" name="weekday">${weekdayOptions}</select>`)}
        ${field("interval", "How often", `<select id="interval" name="interval">${intervalOptions}</select>`)}
      </div>
      <div class="row">
        ${field("kickoffTime", "Kickoff", textInput("kickoffTime", "time"))}
        ${field("durationMinutes", "Minutes", textInput("durationMinutes", "number"))}
      </div>
      <div class="row">
        ${field("minPlayers", "Minimum players", textInput("minPlayers", "number"))}
        ${field("maxPlayers", "Maximum players", textInput("maxPlayers", "number"))}
      </div>
      <div class="field">
        <input type="hidden" name="${PREFERS_EVEN_SUBMITTED}" value="1">
        <label for="prefersEvenNumbers">
          <input id="prefersEvenNumbers" name="prefersEvenNumbers" type="checkbox"${
            prefersEvenChecked(values) ? " checked" : ""
          }>
          Prefer even numbers
        </label>
      </div>
      ${advanced}
      <div class="actions">
        <button class="button primary" type="submit">${escapeHtml(submitLabel)}</button>
      </div>
    </form>
  `;

  return layout({ title: `${heading} — Make The Team`, body, pageStyles: [FORM_CSS] });
}
