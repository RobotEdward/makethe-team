import { ownerFixturePath, gamePath, gameMessagePath, fixtureMessagePath } from "../auth/paths.js";
import {
  AUDIENCE_LABELS,
  FIXTURE_AUDIENCES,
  type BroadcastAudience,
} from "../domain/broadcast-audience.js";
import { MAX_MESSAGE_LENGTH, MAX_SUBJECT_LENGTH, type BroadcastFormValues } from "../domain/broadcast-form.js";
import type { FieldError } from "../domain/game-form.js";
import { escapeHtml, layout } from "./layout.js";
import { FIXTURE_STYLES_CSS, FORM_CSS } from "./styles.js";

/**
 * The compose page behind `gameMessagePath`/`fixtureMessagePath` (M15
 * spec §2, task 7). One renderer for both scopes, the way `game-form.ts`
 * shares one renderer for create and edit — the audience control is the only
 * thing that differs, and `fixture` being present or absent is what decides
 * it, matching `parseBroadcastForm`'s own `scope` split.
 */
export interface BroadcastPageParams {
  gameId: string;
  gameName: string;
  /** Fixture-scoped only. Absent renders the game-scoped page. */
  fixture?: { id: string; whenLocal: string };
  /** Per-audience recipient counts, for the radio labels and the button. */
  counts: Record<BroadcastAudience, number>;
  /** What was typed, for re-rendering a refusal. Empty strings on a fresh GET. */
  values: BroadcastFormValues;
  /** Field errors from `parseBroadcastForm`, plus any route-level refusal. */
  errors?: readonly FieldError[];
  /** A whole-page refusal, e.g. the daily cap. Rendered above the form. */
  problem?: string;
}

function count(n: number): string {
  return `${n} ${n === 1 ? "player" : "players"}`;
}

/**
 * The four fixture audiences as radios, `playing` (or whatever was actually
 * submitted) checked by default.
 *
 * Never rendered for the game scope: `parseBroadcastForm` substitutes
 * `"everyone"` there regardless of what a forged field carried, so offering
 * radios that field cannot express would just be a control with no effect.
 */
function audienceFields(
  selected: BroadcastAudience,
  counts: Record<BroadcastAudience, number>,
  errorMessage: string | undefined,
): string {
  const radios = FIXTURE_AUDIENCES.map((audience) => {
    const id = `audience-${audience}`;
    return `
      <label for="${id}">
        <input id="${id}" type="radio" name="audience" value="${audience}"${
          audience === selected ? " checked" : ""
        }>
        ${escapeHtml(AUDIENCE_LABELS[audience])} (${counts[audience]})
      </label>`;
  }).join("");

  // Worded so an unrecognised submission does not read as "you picked
  // Playing": `parseBroadcastForm` substitutes the default audience for a
  // forged value rather than echoing it back (there is no radio for a value
  // that isn't one of the four), so this message must never imply the
  // checked radio is what was actually submitted.
  return `
    <fieldset class="field audience-group${errorMessage ? " field-invalid" : ""}">
      <legend>Who gets this message?</legend>
      ${radios}
      ${errorMessage ? `<span class="error" id="audience-error">${escapeHtml(errorMessage)}</span>` : ""}
    </fieldset>`;
}

function channelFields(values: BroadcastFormValues, errorMessage: string | undefined): string {
  return `
    <div class="field${errorMessage ? " field-invalid" : ""}">
      <div class="switch-row">
        <label for="email">Email</label>
        <input id="email" name="email" type="checkbox"${values.email ? " checked" : ""}>
        <span class="hint">Send by email.</span>
      </div>
      <div class="switch-row">
        <label for="push">Push notification</label>
        <input id="push" name="push" type="checkbox"${values.push ? " checked" : ""}>
        <span class="hint">Send as a push notification, to anyone with a device registered.</span>
      </div>
      ${errorMessage ? `<span class="error" id="channels-error">${escapeHtml(errorMessage)}</span>` : ""}
    </div>`;
}

export function renderBroadcastPage(params: BroadcastPageParams): string {
  const { gameId, fixture, counts, values } = params;
  const errors = params.errors ?? [];
  const errorFor = (field: string): string | undefined =>
    errors.find((error) => error.field === field)?.message;

  const gameName = escapeHtml(params.gameName);
  const scoped = fixture !== undefined;
  const action = scoped ? fixtureMessagePath(gameId, fixture.id) : gameMessagePath(gameId);
  const backHref = scoped ? ownerFixturePath(gameId, fixture.id) : gamePath(gameId);
  const recipientCount = scoped ? counts[values.audience] : counts.everyone;

  const heading = scoped
    ? `Message the squad for ${gameName} on ${escapeHtml(fixture.whenLocal)}`
    : `Message everyone in ${gameName}`;

  const subjectMessage = errorFor("subject");
  const messageMessage = errorFor("message");

  const body = `
    <h1>${heading}</h1>
    ${params.problem ? `<p class="problem">${escapeHtml(params.problem)}</p>` : ""}
    <form method="post" action="${escapeHtml(action)}">
      ${scoped ? audienceFields(values.audience, counts, errorFor("audience")) : `<p>This goes to everyone in the squad.</p>`}
      <div class="field${subjectMessage ? " field-invalid" : ""}">
        <label for="subject">Subject</label>
        <input id="subject" name="subject" type="text" maxlength="${MAX_SUBJECT_LENGTH}" value="${escapeHtml(values.subject)}"${
          subjectMessage ? ` aria-describedby="subject-error"` : ""
        }>
        ${subjectMessage ? `<span class="error" id="subject-error">${escapeHtml(subjectMessage)}</span>` : ""}
      </div>
      <div class="field${messageMessage ? " field-invalid" : ""}">
        <label for="message">Message</label>
        <textarea id="message" name="message" maxlength="${MAX_MESSAGE_LENGTH}"${
          messageMessage ? ` aria-describedby="message-error"` : ""
        }>${escapeHtml(values.message)}</textarea>
        ${messageMessage ? `<span class="error" id="message-error">${escapeHtml(messageMessage)}</span>` : ""}
      </div>
      ${channelFields(values, errorFor("channels"))}
      <div class="actions">
        <button class="button primary" type="submit">Send to ${count(recipientCount)}</button>
      </div>
    </form>
    <p class="back-link"><a href="${escapeHtml(backHref)}">Back</a></p>
  `;

  return layout({
    title: `Message the squad — ${params.gameName} — Make The Team`,
    body,
    pageStyles: [FORM_CSS, FIXTURE_STYLES_CSS],
  });
}
