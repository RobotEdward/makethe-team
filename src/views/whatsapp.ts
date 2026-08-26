import type { OpenMessageOption } from "../domain/whatsapp-message.js";
import { whatsappShareUrl } from "../domain/whatsapp-message.js";
import { escapeHtml } from "./layout.js";

/**
 * The element id the organiser's nudge (N-11) deep-links to with a `#`
 * fragment, so the push lands them on the card rather than the top of a
 * long fixture page.
 */
export const WHATSAPP_CARD_ID = "whatsapp";

export interface WhatsAppMessage {
  /** The textarea's id — also what the Copy button's `data-copy` names. */
  id: string;
  /** Shown as a heading only when the card carries more than one message. */
  label: string;
  /** The plain text to post, as `src/domain/whatsapp-message.ts` built it. */
  text: string;
  /**
   * The trailing lines of `text` the organiser may switch off (M38), or
   * absent for a message with nothing optional in it.
   *
   * `text` already contains every one of them: the checkboxes ship ticked and
   * `WHATSAPP_LINKS_JS` only ever *subtracts*. That is what keeps a browser
   * with no scripting correct rather than crippled — it gets the whole
   * message and no switches, which is the message an organiser wants by
   * default anyway.
   */
  options?: readonly OpenMessageOption[];
}

/**
 * "Post to WhatsApp" (M22): each prepared message in a read-only textarea
 * with a `wa.me` link that opens WhatsApp with it prefilled, and a Copy
 * button the copy script reveals.
 *
 * Deliberately a plain anchor, not a script: `wa.me/?text=` is a URL, so the
 * whole feature works with scripting off and the CSP unchanged. The textarea
 * is the scriptless fallback for the Copy button too — press and hold.
 *
 * The product never posts into the group itself (no phone numbers are
 * stored, and WhatsApp has no API for someone else's group), so this hands
 * the words over and the organiser taps send.
 */
export function renderWhatsAppCard(params: { messages: readonly WhatsAppMessage[] }): string {
  const { messages } = params;
  const several = messages.length > 1;
  const blocks = messages
    .map(
      (message) => `
      <div class="whatsapp-message">
        ${several ? `<h3>${escapeHtml(message.label)}</h3>` : ""}
        <textarea id="${escapeHtml(message.id)}" readonly rows="${rowsFor(message.text)}">${escapeHtml(message.text)}</textarea>
        ${renderOptions(message)}
        <div class="whatsapp-actions">
          <a class="button" id="${escapeHtml(linkIdFor(message.id))}" href="${escapeHtml(whatsappShareUrl(message.text))}" target="_blank" rel="noopener">Open in WhatsApp</a>
          <button class="button" type="button" data-copy="${escapeHtml(message.id)}" hidden>Copy</button>
        </div>
      </div>`,
    )
    .join("");

  return `
    <div class="whatsapp" id="${WHATSAPP_CARD_ID}">
      <h2>Post to WhatsApp</h2>
      <p>Opens WhatsApp with this ready to send — pick the group chat and add your own words.</p>
      ${blocks}
    </div>`;
}

/** The `wa.me` anchor belonging to a message, so the script can find it. */
export function linkIdFor(messageId: string): string {
  return `${messageId}-link`;
}

/**
 * The switches, shipped `hidden` (M38).
 *
 * Same contract as the Copy button beside them: the page is complete without
 * the script, and revealing these is all the script does for a reader who has
 * one. A `<fieldset>` rather than loose labels so the group is announced as a
 * group, and no `<form>` — nothing here is submitted, and wrapping controls
 * that only a script reads in a form that posts nowhere would be a lie about
 * what pressing enter does.
 *
 * `data-line` carries each line's exact text rather than an index into
 * anything: the script rebuilds the message by subtracting these strings, so
 * they have to be the strings, and `test/views/whatsapp.test.ts` runs the
 * block against a fake DOM to hold it to the same answer the server gives.
 */
function renderOptions(message: WhatsAppMessage): string {
  if (message.options === undefined || message.options.length === 0) return "";
  const boxes = message.options
    .map(
      (option) => `
        <label class="whatsapp-option">
          <input type="checkbox" checked data-line="${escapeHtml(option.line)}">
          ${escapeHtml(option.label)}
        </label>`,
    )
    .join("");
  return `
      <fieldset class="whatsapp-options" data-target="${escapeHtml(message.id)}" hidden>
        <legend>Include</legend>
        ${boxes}
      </fieldset>`;
}

/**
 * Enough rows that the whole message shows without a scrollbar at a phone
 * width: one per line, plus one per ~38 characters a line wraps onto — the
 * figure a 390px viewport's textarea actually fits at the body size (read
 * off the capture, not computed). Taller than needed on a desktop, which is
 * the cheap side to be wrong on; a message the organiser cannot see the end
 * of is the expensive one.
 */
function rowsFor(text: string): number {
  const lines = text.split("\n");
  const wrapped = lines.reduce((total, line) => total + Math.floor(line.length / 38), 0);
  return Math.min(12, Math.max(3, lines.length + wrapped));
}
