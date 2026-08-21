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
        <div class="whatsapp-actions">
          <a class="button" href="${escapeHtml(whatsappShareUrl(message.text))}" target="_blank" rel="noopener">Open in WhatsApp</a>
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
