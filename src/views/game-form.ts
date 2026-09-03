import { inviteOrderPath, gameArchivePath } from "../auth/paths.js";
import type { FieldError } from "../domain/game-form.js";
import {
  cellFieldName,
  cellMarkerName,
  GATED_FALLBACK_NEVER,
  NOTIFICATION_SWITCHES,
  supportedTimezones,
} from "../domain/game-form.js";
import { WEEKDAYS } from "../domain/recurrence/parse.js";
import type { NotificationType } from "../notify/dedupe-key.js";
import { cellsWithScope } from "../notify/notification-controls.js";
import type { EffectiveSettings } from "../notify/notification-settings.js";
import type { Channel } from "../notify/notifier.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { FORM_CSS, NOTIFY_MATRIX_CSS } from "./styles.js";

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

/**
 * The marker name for one form-level switch, taken from the parser's own
 * list rather than written out again here (M26, M34).
 *
 * `parseGameForm` reads these markers to tell "the owner turned this off" from
 * "this form has no such section" — the create form's case for gating — so a
 * name typed twice and spelled differently once would silently turn the
 * switch off on save, with the form still showing it on.
 */
function markerFor(field: string): string {
  const known = NOTIFICATION_SWITCHES.find((entry) => entry.field === field);
  if (known === undefined) throw new Error(`no notification switch named ${field}`);
  return known.submitted;
}

/**
 * What the fallback select offers, coarsest first, with "never" at the head.
 *
 * Ordered that way because a value the list does not carry leaves no option
 * selected and the browser falls back to the first one — and the safe landing
 * for an unrecognised fallback is BR-44's "never", not a release the owner
 * never asked for.
 */
const FALLBACK_OPTIONS: readonly (readonly [string, string])[] = [
  [GATED_FALLBACK_NEVER, "Never"],
  ["3", "3 hours before"],
  ["6", "6 hours before"],
  ["12", "12 hours before"],
  ["24", "24 hours before"],
  ["48", "48 hours before"],
];

/**
 * What the select shows when the caller said nothing, matching the default
 * `shortWarningOffsetHours` carries (spec, "games (two new columns)"). It is a
 * rendering default only: an owner who never opens this section saves a null
 * fallback, because the section is edit-only and submits nothing on create.
 */
const OFFERED_FALLBACK_HOURS = "12";

/**
 * Whether the gating switch renders ticked.
 *
 * Deliberately not `switchChecked`: gating defaults *off* (BR-39), so a fresh
 * render with nothing said must leave the box clear. Sharing that helper would
 * show every game as gated until the owner saved the form.
 */
function gatedChecked(values: Partial<Record<string, string>>): boolean {
  return values["gatedInvitesEnabled"] === "on";
}

export interface NotificationCellView {
  channel: Channel;
  ownerWants: boolean;
  adminAllows: boolean;
}

export interface NotificationRowView {
  type: NotificationType;
  label: string;
  hint: string;
  cells: NotificationCellView[];
  timings?: string;
}

/**
 * The owner-facing copy for each row of the notifications matrix (M37).
 *
 * Kept here, not in the route: the route passes only `EffectiveSettings`, and
 * a settings resolver has no opinion on wording. One table so the six rows
 * cannot describe the same notification two different ways on two pages.
 */
const OWNER_NOTIFICATION_COPY: Record<NotificationType, { label: string; hint: string }> = {
  n1: {
    label: "Remind players before kickoff",
    hint: "The message that asks players if they are in. Fixtures still open on this schedule when it is off.",
  },
  n4: {
    label: "Warn me when a fixture is short or uneven",
    hint: "Once per fixture. Only fixtures scheduled from now on take a changed warning time.",
  },
  n9: {
    label: "Tell players when I publish teams",
    hint: "Sent when you publish. Teams still appear on the fixture page.",
  },
  n11: {
    label: "Nudge me to post it to the group chat",
    hint: "A phone notification, sent with the reminder above.",
  },
  n12: {
    label: "Ask players how it went",
    hint: "Asks everyone who played for the score. Zero hours means as soon after full time as we can.",
  },
  n13: {
    label: "Tell a player when I hand them the team pick",
    hint: "Nothing is sent when you open the pick to the whole squad.",
  },
} as Record<NotificationType, { label: string; hint: string }>;

/**
 * The owner's matrix rows (M37), one per owner-scoped catalogue type,
 * grouped from `cellsWithScope("owner")` rather than hand-listed, so a type
 * the catalogue adds shows up here as a row with no copy — a loud failure —
 * rather than silently missing from the page.
 */
export function ownerNotificationRows(gameId: string, settings: EffectiveSettings): NotificationRowView[] {
  const byType = new Map<NotificationType, NotificationCellView[]>();
  for (const { type, channel } of cellsWithScope("owner")) {
    const cells = byType.get(type) ?? [];
    cells.push({
      channel,
      ownerWants: settings.ownerWants(gameId, type, channel),
      adminAllows: settings.adminAllows(type, channel),
    });
    byType.set(type, cells);
  }

  return [...byType.entries()].map(([type, cells]) => {
    const copy = OWNER_NOTIFICATION_COPY[type];
    if (copy === undefined) throw new Error(`ownerNotificationRows: no copy for ${type}`);
    return { type, label: copy.label, hint: copy.hint, cells };
  });
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
  /** Absent on create: the invite order belongs to a game that exists (M34). */
  gameId?: string;
  /** "This will update 4 scheduled fixtures…", on edit. */
  affectedNotice?: string;
  /** The owner's matrix (M37). Absent on create — a game that does not exist has no rows to show. */
  notifications?: NotificationRowView[];
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
  const { action, heading, submitLabel, values, errors, warnings, showAdvanced, affectedNotice, gameId } = params;

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

  /**
   * One timing control inside a notification row: its own label, the input,
   * and the field error if there is one.
   *
   * Separate from `field()` because these sit inside a `.switch-row` grid,
   * where `.field`'s block layout would put each control on a line of its own
   * and push the row past three times the height of its neighbours.
   */
  const timing = (name: string, label: string, type: string, extra: string): string => {
    const message = errorFor(name);
    return `
        <span class="notify-timing-field">
          <label for="${name}">${escapeHtml(label)}</label>
          ${textInput(name, type, extra)}
          ${message ? `<span class="error" id="${name}-error">${escapeHtml(message)}</span>` : ""}
        </span>`;
  };

  const CHANNEL_LABEL: Record<Channel, string> = { email: "Email", push: "Push" };

  /**
   * Timing controls per row, keyed by type rather than carried on
   * `NotificationRowView`: `ownerNotificationRows` only sees `EffectiveSettings`,
   * with no `values`/`errorFor` to build a `timing()` input from, so the three
   * rows that fire on a schedule get their strip attached here instead.
   */
  const notificationTimings: Partial<Record<NotificationType, string>> = {
    n1: `
        <div class="notify-timing">
          ${timing("reminderDaysBefore", "Days before", "number", ` min="0" max="7"`)}
          ${timing("reminderLocalTime", "At", "time", "")}
        </div>`,
    n4: `
        <div class="notify-timing">
          ${timing("shortWarningOffsetHours", "Hours before kickoff", "number", ` min="1" max="168"`)}
        </div>`,
    n12: `
        <div class="notify-timing">
          ${timing("resultPromptOffsetHours", "Hours after full time", "number", ` min="0" max="48"`)}
        </div>`,
  };

  const cell = (row: NotificationRowView, channel: Channel): string => {
    const found = row.cells.find((c) => c.channel === channel);
    if (!found) return `<td class="notify-cell notify-none">—</td>`;
    const name = cellFieldName(row.type, channel);
    if (!found.adminAllows) {
      return `<td class="notify-cell"><input id="${escapeHtml(name)}" name="${escapeHtml(name)}" type="checkbox" disabled aria-label="${escapeHtml(`${row.label} — ${CHANNEL_LABEL[channel]}`)}" aria-describedby="${escapeHtml(name)}-note"></td>`;
    }
    return `<td class="notify-cell">
        <input type="hidden" name="${escapeHtml(cellMarkerName(row.type, channel))}" value="1">
        <input id="${escapeHtml(name)}" name="${escapeHtml(name)}" type="checkbox"${found.ownerWants ? " checked" : ""} aria-label="${escapeHtml(`${row.label} — ${CHANNEL_LABEL[channel]}`)}">
      </td>`;
  };

  const adminNotes = (row: NotificationRowView): string =>
    row.cells
      .filter((c) => !c.adminAllows)
      .map((c) => `<p class="notify-admin-off" id="${escapeHtml(cellFieldName(row.type, c.channel))}-note">${escapeHtml(`${CHANNEL_LABEL[c.channel]} is switched off for everyone by the site administrator. Your own setting is kept and comes back if they turn it on again.`)}</p>`)
      .join("");

  const matrixRow = (row: NotificationRowView): string => `
      <tr class="notify-row" data-notification="${escapeHtml(row.type)}">
        <td class="notify-what">
          <span class="notify-label">${escapeHtml(row.label)}</span>
          <span class="hint">${escapeHtml(row.hint)}</span>
          ${adminNotes(row)}
          ${row.timings ?? notificationTimings[row.type] ?? ""}
        </td>
        ${cell(row, "email")}
        ${cell(row, "push")}
      </tr>`;

  const notifications = showAdvanced && params.notifications
    ? `
      <fieldset class="notify-group">
        <legend>Notifications</legend>
        <table class="notify-matrix">
          <thead><tr><th class="notify-what">Notification</th><th>Email</th><th>Push</th></tr></thead>
          <tbody>${params.notifications.map(matrixRow).join("")}</tbody>
        </table>
      </fieldset>`
    : "";

  const fallbackOptions = FALLBACK_OPTIONS.map(([code, label]) =>
    `<option value="${escapeHtml(code)}"${
      (values["gatedFallbackHoursBefore"] ?? OFFERED_FALLBACK_HOURS) === code ? " selected" : ""
    }>${escapeHtml(label)}</option>`,
  ).join("");

  const invites = showAdvanced
    ? `
      <fieldset class="notify-group">
        <legend>Invites</legend>
        ${switchRow({
          name: "gatedInvitesEnabled",
          submitted: markerFor("gatedInvitesEnabled"),
          label: "Ask in priority order",
          hint: "Off — everyone is asked at once. On, only the core group is asked first, and the rest as spots come free.",
          checked: gatedChecked(values),
        })}
        <!-- Grouped so their state can follow the switch above (M52). With
             priority order off these two are inert — the order is not
             consulted at all — but they rendered at full contrast, which reads
             as a live setting. Dimmed by CSS keyed off the checkbox, and still
             fully operable: locking them out would stop an owner turning the
             switch on and choosing its fallback in the same save, which is the
             only save most owners will make. See the styles for why this needs
             no script. -->
        <div class="gated-dependants">
          <p class="gated-note">These apply only while priority order is on.</p>
          ${field(
            "gatedFallbackHoursBefore",
            "If we're still short of the minimum, ask the next group",
            `<select id="gatedFallbackHoursBefore" name="gatedFallbackHoursBefore">${fallbackOptions}</select>`,
          )}
          ${gameId === undefined ? "" : `<p><a href="${escapeHtml(inviteOrderPath(gameId))}">Edit the invite order &rarr;</a></p>`}
        </div>
      </fieldset>`
    : "";

  const advanced = showAdvanced
    ? `
      <details>
        <summary>Advanced</summary>
        ${field("timezone", "Time zone", `<select id="timezone" name="timezone">${timezoneOptions}</select>`)}
        ${field("venueUrl", "Venue link", textInput("venueUrl", "url"))}
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
      ${notifications}
      ${invites}
      ${advanced}
      <div class="actions">
        <button class="button primary" type="submit">${escapeHtml(submitLabel)}</button>
      </div>
    </form>
    ${gameId === undefined ? "" : `<p class="archive-link"><a class="danger-link" href="${escapeHtml(gameArchivePath(gameId))}">Archive this game</a></p>`}
  `;

  return layout({ nav: params.nav, title: `${heading} — Make The Team`, body, pageStyles: [FORM_CSS, NOTIFY_MATRIX_CSS] });
}
