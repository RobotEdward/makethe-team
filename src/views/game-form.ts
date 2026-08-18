import type { FieldError } from "../domain/game-form.js";
import { supportedTimezones } from "../domain/game-form.js";
import { WEEKDAYS } from "../domain/recurrence/parse.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
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

/**
 * The hidden companion to the "Let players see who else is playing" checkbox.
 * Mirrors `PREFERS_EVEN_SUBMITTED` above exactly — see its comment for why.
 */
const SQUAD_VISIBLE_SUBMITTED = "squadVisibleToPlayersSubmitted";

function squadVisibleChecked(values: Partial<Record<string, string>>): boolean {
  if (values[SQUAD_VISIBLE_SUBMITTED] !== undefined) {
    // A real submission: absent means unchecked, full stop.
    return values["squadVisibleToPlayers"] === "on";
  }
  // A fresh render. Absent means the caller said nothing, and a new game
  // shows the squad; the edit route says `""` explicitly for a saved false.
  return values["squadVisibleToPlayers"] === undefined || values["squadVisibleToPlayers"] === "on";
}

/**
 * One settings row: the label, the real checkbox, then the hint — in that
 * order, and through one function so the two rows cannot disagree.
 *
 * `.switch-row` places the checkbox explicitly but leaves the label and the
 * hint to grid auto-placement, which fills rows in document order. A hint
 * emitted ahead of its label quietly takes the top row and the label drops
 * underneath it: nothing throws, nothing fails, the row is just upside down.
 *
 * The hint is not decoration. Squad visibility changes nothing the owner can
 * see from this page, so the sentence is the only place its meaning exists;
 * both are worded for what the setting does, because a fixed string cannot
 * describe a value that toggles.
 *
 * The checkbox stays a real `<input type="checkbox">` — a CSS-only control
 * would be invisible to a screen reader and dead with scripting off.
 */
function switchRow(row: {
  name: string;
  /** The hidden companion; see `PREFERS_EVEN_SUBMITTED`. */
  submitted: string;
  label: string;
  hint: string;
  checked: boolean;
}): string {
  return `
      <div class="switch-row">
        <input type="hidden" name="${row.submitted}" value="1">
        <label for="${row.name}">${escapeHtml(row.label)}</label>
        <input id="${row.name}" name="${row.name}" type="checkbox"${row.checked ? " checked" : ""}>
        <span class="hint">${escapeHtml(row.hint)}</span>
      </div>`;
}

export interface GameFormPageParams {
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
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
      ${switchRow({
        name: "prefersEvenNumbers",
        submitted: PREFERS_EVEN_SUBMITTED,
        label: "Prefer even numbers",
        hint: "Warns you when the maximum is an odd number.",
        checked: prefersEvenChecked(values),
      })}
      ${switchRow({
        name: "squadVisibleToPlayers",
        submitted: SQUAD_VISIBLE_SUBMITTED,
        label: "Let players see who else is playing",
        hint: "When off, players see only how many are in; you always see the names.",
        checked: squadVisibleChecked(values),
      })}
      <div class="row">
        ${field("teamAName", "First team's name", textInput("teamAName"))}
        ${field("teamBName", "Second team's name", textInput("teamBName"))}
      </div>
      ${advanced}
      <div class="actions">
        <button class="button primary" type="submit">${escapeHtml(submitLabel)}</button>
      </div>
    </form>
  `;

  return layout({ nav: params.nav, title: `${heading} — Make The Team`, body, pageStyles: [FORM_CSS] });
}
