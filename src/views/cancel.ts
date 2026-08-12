import { escapeHtml, layout } from "./layout.js";

/**
 * The pages behind `/cancel/:token` (BR-14, J5).
 *
 * Every one of them is built from `layout()` and the token-based styles
 * already defined there — no second visual language, no page-local
 * stylesheet. The only new element type this flow needs is a textarea and a
 * destructive-looking submit, both styled from the existing `--warn` tokens
 * via the small inline block below, which exists because `layout()`'s
 * stylesheet is shared with the player-facing pages and gaining a rule that
 * only ever applies here would be dead weight on the critical path.
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
}

/**
 * Two rules, one for the reason box and one for the destructive submit.
 *
 * The button is `--warn`, not `--accent`: every other primary button in this
 * product confirms something good is happening ("I'm in"), and this one ends
 * a game. It must not look like them.
 *
 * Exported as bare CSS, without the `<style>` tags, so `src/security/csp.ts`
 * can hash exactly what ends up between them (see `STYLES` in
 * `src/views/layout.ts` for the same reasoning) — the wrapping tags are
 * added once, at the single call site below.
 */
export const CANCEL_STYLES_CSS = `
  .cancel-form { margin-top: 1.5rem; text-align: left; }
  .cancel-form label { display: block; margin-bottom: 0.4rem; color: var(--fg); font-weight: 600; }
  .cancel-form textarea {
    width: 100%; min-height: 6rem; padding: 0.7rem 0.85rem;
    border-radius: 0.6rem; border: 1px solid var(--line);
    background: var(--bg); color: var(--fg); font: inherit; font-size: 1rem;
  }
  .cancel-form textarea:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .cancel-form .hint { margin-top: 0.4rem; font-size: 0.85rem; }
  .cancel-form .button.danger {
    margin-top: 1.25rem; width: 100%;
    background: var(--warn-bg); border-color: var(--warn); color: var(--warn);
  }
  .form-error {
    margin-top: 1rem; padding: 0.7rem 1rem; border-radius: 0.6rem;
    background: var(--warn-bg); color: var(--warn); font-size: 0.95rem; text-align: left;
  }
  .cancel-heading { text-align: center; margin-top: 0; color: var(--warn); }
`;

/** `CANCEL_STYLES_CSS`, wrapped exactly as it is inlined into the page body. */
const CANCEL_STYLES_TAG = `\n<style>${CANCEL_STYLES_CSS}</style>\n`;

function fixtureHeading(preview: CancelPreview): string {
  return `
    <h1>${escapeHtml(preview.gameName)}</h1>
    <p class="venue">${escapeHtml(preview.venueName)}</p>
    <p class="kickoff">${escapeHtml(preview.kicksOffAtLocal)}</p>
  `;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
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
  const { token, reason, error } = options;
  const reachable = options.recipientCount - options.unreachableCount;

  const body = `
    ${CANCEL_STYLES_TAG}
    <h2 class="cancel-heading">Cancel this game?</h2>
    ${fixtureHeading(options)}
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
      <button class="button danger" type="submit">Cancel this game and tell everyone</button>
    </form>
    <p class="read-only">This can't be undone here. Once it's cancelled, everyone who was in or on the waitlist gets an email, and nobody can respond to this fixture again.</p>
  `;

  return layout({ title: `Cancel ${options.gameName} — Make The Team`, body });
}

export interface CancelledPageOptions {
  gameName: string;
  /** How many players were actually emailed. */
  emailed: number;
  /** Recipients with no usable address, plus any the send could not deliver to. */
  notEmailed: number;
}

/** The page an owner gets after a cancellation they just made succeeded. */
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
  `;
  return layout({ title: `${options.gameName} cancelled — Make The Team`, body });
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
  return layout({ title: `${gameName} already cancelled — Make The Team`, body });
}

/** A fixture that has been played: there is nothing left to cancel. */
export function renderAlreadyPlayedPage(gameName: string): string {
  const body = `
    <h1>${escapeHtml(gameName)} can't be cancelled</h1>
    <p>This game has already been played, so there's nothing to cancel and nobody to tell.</p>
  `;
  return layout({ title: `${gameName} — Make The Team`, body });
}
