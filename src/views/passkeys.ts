import { DASHBOARD_PATH } from "../auth/paths.js";
import { escapeHtml, layout } from "./layout.js";
import { PASSKEY_REGISTER_JS } from "./scripts.js";
import { FIXTURE_STYLES_CSS, PASSKEY_STYLES_CSS } from "./styles.js";

export interface PasskeysPageOptions {
  /**
   * The passkeys already registered to the *signed-in* identity, newest last,
   * each already reduced to a label. Deliberately a list of strings and not
   * database rows: nothing about a credential — its id, its public key, its
   * counter — has any business reaching a template, and typing the boundary
   * this way means none of it can be printed by accident.
   */
  labels: readonly string[];
}

/**
 * Manage passkeys: see the ones you have, add another.
 *
 * **Everything on this page that matters is server-rendered.** The list comes
 * from the database, the explanation is static, and the only thing the
 * `PASSKEY_REGISTER_JS` block does is reveal the "add" button on a browser
 * that can actually complete the ceremony. With scripting off the page still
 * tells a player what passkeys are, which ones they already have, and that
 * their email link keeps working — it just cannot add one, because
 * `navigator.credentials` is the only way to add one and there is no
 * server-side substitute.
 *
 * There is no "remove" control yet, on purpose rather than by omission: the
 * magic link is always available, so a lost authenticator is an inconvenience
 * and not a lockout, and a delete button is a destructive action that wants
 * its own confirmation design. Noted for a later task.
 */
export function renderPasskeysPage({ labels }: PasskeysPageOptions): string {
  const list =
    labels.length === 0
      ? `<p>You haven't added a passkey yet.</p>`
      : `<ul class="passkey-list">${labels
          .map((label) => `<li>${escapeHtml(label)}</li>`)
          .join("")}</ul>`;

  return layout({
    title: "Passkeys — Make The Team",
    // `FIXTURE_STYLES_CSS` is here for `.back-link` alone (§2.5), the same way
    // `src/views/game-overview.ts` and `src/views/leave.ts` carry it: without
    // the block the class is inert and the link butts against the block above
    // it. Every other selector in that block is a class this page never
    // renders, so nothing already here changes appearance.
    pageStyles: [PASSKEY_STYLES_CSS, FIXTURE_STYLES_CSS],
    pageScripts: [PASSKEY_REGISTER_JS],
    body: `
      <h1>Passkeys</h1>
      <p>A passkey signs you in with your device's own fingerprint, face or screen lock, instead of waiting for an email. You can add one now and still use the email link whenever you'd rather.</p>
      ${list}
      <div class="passkey" id="passkey-add" hidden>
        <button class="button primary" type="button" id="passkey-add-button">Add a passkey</button>
        <p class="nudge" id="passkey-problem" hidden></p>
      </div>
      <p class="back-link"><a href="${escapeHtml(DASHBOARD_PATH)}">Back to your games</a></p>
    `,
  });
}
