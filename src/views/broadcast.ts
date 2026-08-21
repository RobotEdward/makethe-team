import { ownerFixturePath, gamePath, gameMessagePath, fixtureMessagePath } from "../auth/paths.js";
import {
  AUDIENCE_LABELS,
  FIXTURE_AUDIENCES,
  type BroadcastAudience,
} from "../domain/broadcast-audience.js";
import { MAX_MESSAGE_LENGTH, MAX_SUBJECT_LENGTH, type BroadcastFormValues } from "../domain/broadcast-form.js";
import type { FieldError } from "../domain/game-form.js";
import { whatsappShareUrl } from "../domain/whatsapp-message.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { BROADCAST_WHATSAPP_JS } from "./scripts.js";
import { FIXTURE_STYLES_CSS, FORM_CSS, WHATSAPP_CSS } from "./styles.js";
import { WHATSAPP_CARD_ID } from "./whatsapp.js";

/**
 * The compose page behind `gameMessagePath`/`fixtureMessagePath` (M15
 * spec §2, task 7). One renderer for both scopes, the way `game-form.ts`
 * shares one renderer for create and edit — the audience control is the only
 * thing that differs, and `fixture` being present or absent is what decides
 * it, matching `parseBroadcastForm`'s own `scope` split.
 */
export interface BroadcastPageParams {
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
  gameId: string;
  gameName: string;
  /** Fixture-scoped only. Absent renders the game-scoped page. */
  fixture?: { id: string; whenLocal: string };
  /** Per-audience recipient counts, for the radio labels. */
  counts: Record<BroadcastAudience, number>;
  /**
   * How many people this send, as configured, could actually reach: the
   * selected audience narrowed by the ticked channels. The route computes it
   * the same way for its refusal and for the audit row it writes.
   *
   * A rendered figure can still go stale before submission — this page runs
   * no script, so unticking a channel does not update the button until the
   * server answers. It is a display, like the channel-agnostic counts beside
   * the radios, which it is not derivable from.
   */
  reachableCount: number;
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
 * What the submit button says.
 *
 * At zero it names the situation instead of offering "Send to 0 players",
 * which proposes a no-op. The button stays enabled either way: the server's
 * 422 refusal is the control, and a disabled button would hide the reason
 * rather than give it.
 */
function sendLabel(reachableCount: number): string {
  return reachableCount === 0 ? "Nobody to send to" : `Send to ${count(reachableCount)}`;
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

/**
 * "Post to WhatsApp too" (M22): a `wa.me` link `BROADCAST_WHATSAPP_JS` keeps
 * filled with the subject and message as typed. Ships `hidden` and the
 * script reveals it — there is no server-side text to put in it, since a
 * broadcast's body is never stored (M15 spec §8), so without the script
 * there is nothing honest to show. Outside the form on purpose: an anchor
 * inside it would read as one of its controls, and tapping it must not
 * submit anything.
 */
function renderWhatsAppCompose(): string {
  return `
    <div class="whatsapp" id="${WHATSAPP_CARD_ID}" hidden>
      <h2>Post to WhatsApp too</h2>
      <p>Opens WhatsApp with what you've written here — before or after you send it.</p>
      <div class="whatsapp-actions">
        <a class="button" id="whatsapp-link" href="${escapeHtml(whatsappShareUrl(""))}" target="_blank" rel="noopener">Open in WhatsApp</a>
      </div>
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

  const heading = scoped
    ? `Message the squad for ${gameName} on ${escapeHtml(fixture.whenLocal)}`
    : `Message everyone in ${gameName}`;

  const subjectMessage = errorFor("subject");
  const messageMessage = errorFor("message");

  // With no channel ticked, `reachableCount` is zero by arithmetic rather
  // than because the audience is empty, and "Nobody to send to" beside "Pick
  // at least one way to send this" reads as a second, wrong problem. The
  // channel-agnostic count is what the button will mean as soon as a channel
  // is ticked back on.
  const buttonCount =
    errorFor("channels") === undefined
      ? params.reachableCount
      : scoped
        ? counts[values.audience]
        : counts.everyone;

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
        <button class="button primary" type="submit">${sendLabel(buttonCount)}</button>
      </div>
    </form>
    ${renderWhatsAppCompose()}
    <p class="back-link"><a href="${escapeHtml(backHref)}">Back</a></p>
  `;

  return layout({
    nav: params.nav,
    title: `Message the squad — ${params.gameName} — Make The Team`,
    body,
    pageStyles: [FORM_CSS, FIXTURE_STYLES_CSS, WHATSAPP_CSS],
    pageScripts: [BROADCAST_WHATSAPP_JS],
  });
}
