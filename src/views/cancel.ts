import { ownerFixturePath } from "../auth/paths.js";
import { cancelledMessage } from "../domain/whatsapp-message.js";
import { escapeHtml, layout } from "./layout.js";
import { COPY_BUTTON_JS } from "./scripts.js";
import { CANCEL_STYLES_CSS, WHATSAPP_CSS } from "./styles.js";
import { renderWhatsAppCard } from "./whatsapp.js";

/**
 * The pages behind `/cancel/:token` (BR-14, J5).
 *
 * Every one of them is built from `layout()` and the token-based styles
 * already defined there — no second visual language, no page-local
 * stylesheet. The only new element type this flow needs is a textarea, styled
 * by the small inline block below, which exists because `layout()`'s
 * stylesheet is shared with the player-facing pages and gaining a rule that
 * only ever applies here would be dead weight on the critical path.
 *
 * The destructive submit is no longer styled here at all. It used to be
 * repainted to the `--warn` palette by this page's own block; M10 gave the
 * product a real `--danger` token and a shared `.button.danger` in `STYLES`,
 * so this page now gets its red from the same rule the three other
 * irreversible actions do.
 *
 * Nothing here decides anything: the route has already verified the token,
 * proved entitlement, and read the counts. These functions render.
 */

/**
 * The longest reason the route will accept.
 *
 * Lives here because the page states the limit and the textarea enforces it
 * client-side-with-no-JavaScript (`maxlength`), and a limit the page
 * advertises differently from the one the server applies is worse than no
 * limit at all. `maxlength` is a convenience only — the server check is the
 * real one, and it is not in this module.
 */
export const MAX_REASON_LENGTH = 2000;

/** What an owner is about to do, in the numbers that make it real. */
export interface CancelPreview {
  gameName: string;
  venueName: string;
  /** Already formatted in the Game's timezone by the caller (src/domain/time/zone.ts). */
  kicksOffAtLocal: string;
  /** Players currently `in`. */
  inCount: number;
  /** Everyone BR-20 says must be told — `in` or `waitlisted`, never a guest. */
  recipientCount: number;
  /** Of those, how many have no usable address and so cannot actually be reached. */
  unreachableCount: number;
}

export interface CancelConfirmPageOptions extends CancelPreview {
  /** Echoed into the form action so the POST carries the same token. */
  token: string;
  /** Preserved across a rejected submission so the owner does not retype it. */
  reason?: string;
  /** Shown above the form when a submission was refused (today: only an over-long reason). */
  error?: string;
  /**
   * The fixture's own game and id, for the "Keep the game on" back-out link
   * (M10 §3.7; restored by the whole-branch review's Important 3, having been
   * dropped by 23e271d for want of a real destination — the route has both,
   * see `src/routes/cancel.ts`).
   *
   * Links to `ownerFixturePath(gameId, fixtureId)`, which sits behind
   * `requirePlayer` and entitlement — this page itself is reached by a signed
   * token that authorises cancelling and nothing else, so a visitor with no
   * session lands on sign-in rather than the fixture page. That is still an
   * honest destination: it is where they would go to manage the fixture, and
   * a sign-in prompt is a better back-out than no exit at all, which is what
   * this page had until now.
   */
  gameId: string;
  fixtureId: string;
}

/**
 * The reason box, and the destructive submit's *layout* — its width and the
 * space above it. Its colour comes from `.button.danger` in `STYLES`.
 *
 * Until M10 this block repainted that button to the `--warn` palette, on the
 * reasoning that every other primary button in the product confirms something
 * good is happening ("I'm in") and this one ends a game, so it must not look
 * like them. That reasoning was right and the product has since acted on it
 * properly: `--danger` exists, nothing else in the app uses it, and three
 * other irreversible actions wear it too. Amber here would now mean
 * "unsettled", which is what the waitlist uses it for.
 *
 * Exported as bare CSS, without the `<style>` tags, so `src/security/csp.ts`
 * can hash exactly what ends up between them (see `STYLES` in
 * `src/views/layout.ts` for the same reasoning) — the wrapping tags are
 * added once, at the single call site below.
 */

/** `CANCEL_STYLES_CSS`, wrapped exactly as it is inlined into the page body. */
const CANCEL_STYLES_TAG = `\n<style>${CANCEL_STYLES_CSS}</style>\n`;

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * The submit's label (M10 whole-branch review, Minor 8). "Call it off and
 * email 0 people" reads as a bug — zero of anything in a sentence like this
 * usually means something failed to load — so the count only appears once
 * there is somebody to name.
 */
function callItOffLabel(reachable: number): string {
  return reachable === 0
    ? "Call it off"
    : `Call it off and email ${reachable} ${plural(reachable, "person", "people")}`;
}

/**
 * The confirmation page — deliberately a page, not a button.
 *
 * It states the fixture, how many players are in, and exactly how many people
 * an email will go to, *before* anything happens. A one-tap link from an
 * email that immediately cancelled a game would be one mis-tap, one
 * over-eager mail client prefetch, or one shared inbox away from ending a
 * game nobody meant to end — hence a `GET` that only ever renders and a
 * separate, explicit `POST`.
 */
export function renderCancelConfirmPage(options: CancelConfirmPageOptions): string {
  const { token, reason, error, gameId, fixtureId } = options;
  const reachable = options.recipientCount - options.unreachableCount;

  const body = `
    ${CANCEL_STYLES_TAG}
    <h1 class="cancel-heading">${escapeHtml(options.kicksOffAtLocal)} won't be played</h1>
    <p class="venue">${escapeHtml(options.gameName)}, ${escapeHtml(options.venueName)}</p>
    <p>Every other week carries on as normal.</p>
    <p class="spots">${options.inCount} ${plural(options.inCount, "player is", "players are")} in.</p>
    <p class="spots">${reachable} ${plural(reachable, "person", "people")} will be emailed to say it's off.</p>
    ${
      options.unreachableCount > 0
        ? `<p class="nudge">${options.unreachableCount} ${plural(options.unreachableCount, "player has", "players have")} no email address on file and won't be told — you'll need to reach them another way.</p>`
        : ""
    }
    ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ""}
    <form class="cancel-form" method="post" action="/cancel/${escapeHtml(token)}">
      <label for="reason">Why is it off? (optional — this goes in the email)</label>
      <textarea id="reason" name="reason" rows="4" maxlength="${MAX_REASON_LENGTH}" placeholder="Pitch flooded">${escapeHtml(reason ?? "")}</textarea>
      <p class="hint">Up to ${MAX_REASON_LENGTH} characters. Leave it blank if you'd rather not say.</p>
      <button class="button danger" type="submit">${callItOffLabel(reachable)}</button>
    </form>
    <a class="button keep-link" href="${escapeHtml(ownerFixturePath(gameId, fixtureId))}">Keep the game on</a>
    <p class="read-only">This can't be undone. Once it's cancelled, everyone who was in or on the waitlist gets an email, and nobody can respond to this fixture again.</p>
  `;

  return layout({ title: `Call off ${options.gameName} on ${options.kicksOffAtLocal} — Make The Team`, body });
}

export interface CancelledPageOptions {
  gameName: string;
  /** Already formatted in the game's timezone by the caller (TR-5). */
  kicksOffAtLocal: string;
  /** The reason the owner just gave, for the WhatsApp message; blank means none. */
  reason: string | null;
  /** How many players were actually emailed. */
  emailed: number;
  /** Recipients with no usable address, plus any the send could not deliver to. */
  notEmailed: number;
}

/**
 * The page an owner gets after a cancellation they just made succeeded.
 *
 * Carries the "Post to WhatsApp" card (M22): the squad has been emailed, and
 * this is the moment the organiser tells the group chat too — "let them
 * know another way" is exactly what the card is for.
 */
export function renderCancelledPage(options: CancelledPageOptions): string {
  const body = `
    <h1>${escapeHtml(options.gameName)} is cancelled</h1>
    <p>The game is off. Nobody can respond to this fixture any more.</p>
    <p class="spots">${options.emailed} ${plural(options.emailed, "player has", "players have")} been emailed to tell them.</p>
    ${
      options.notEmailed > 0
        ? `<p class="nudge">${options.notEmailed} ${plural(options.notEmailed, "player", "players")} couldn't be emailed — they have no address on file, or the message didn't go through. Let them know another way.</p>`
        : ""
    }
    ${renderWhatsAppCard({
      messages: [
        {
          id: "whatsapp-cancelled",
          label: "Cancelled",
          text: cancelledMessage({
            gameName: options.gameName,
            kicksOffAtLocal: options.kicksOffAtLocal,
            reason: options.reason,
          }),
        },
      ],
    })}
  `;
  return layout({
    title: `${options.gameName} cancelled — Make The Team`,
    body,
    centred: true,
    pageStyles: [WHATSAPP_CSS],
    pageScripts: [COPY_BUTTON_JS],
  });
}

/**
 * A fixture that is already cancelled, on either verb.
 *
 * Reached by a second `POST` (the idempotency requirement) and by a `GET`
 * after the fact — the same page for both, because they are the same
 * situation and an owner re-reading their own link should not have to work
 * out which one they are looking at. Notably it does **not** say "you already
 * did this" or name a time: this is also what a *second* owner sees, and
 * whether someone else got there first is not something this page needs to
 * adjudicate.
 */
export function renderAlreadyCancelledPage(gameName: string): string {
  const body = `
    <h1>${escapeHtml(gameName)} is already cancelled</h1>
    <p>Nothing more has happened — everyone who needed telling was emailed when it was cancelled, and nobody has been emailed again.</p>
  `;
  return layout({ title: `${gameName} already cancelled — Make The Team`, body, centred: true });
}

/** A fixture that has been played: there is nothing left to cancel. */
export function renderAlreadyPlayedPage(gameName: string): string {
  const body = `
    <h1>${escapeHtml(gameName)} can't be cancelled</h1>
    <p>This game has already been played, so there's nothing to cancel and nobody to tell.</p>
  `;
  return layout({ title: `${gameName} — Make The Team`, body, centred: true });
}
