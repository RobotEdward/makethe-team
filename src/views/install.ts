import { PASSKEYS_PATH, PUSH_TEST_PATH, PUSH_UNSUBSCRIBE_PATH } from "../auth/paths.js";
import { escapeHtml } from "./layout.js";
import {
  PUSH_BUTTON_ID,
  PUSH_DONE_ID,
  PUSH_KEY_ATTRIBUTE,
  PUSH_NAME_ID,
  PUSH_PROBLEM_ID,
  PUSH_REENABLE_ATTRIBUTE,
  PUSH_RELOAD_ATTRIBUTE,
  PUSH_TOKEN_ATTRIBUTE,
} from "./scripts.js";

/**
 * "Add to your home screen" (M13, spec §11).
 *
 * Three states, and the *server* renders the one that works everywhere:
 * manual instructions. Script then upgrades it — to a real button on a
 * browser that fired `beforeinstallprompt`, or to a confirmation on a device
 * where the app is already installed.
 *
 * Rendering the instructions as the baseline rather than the button is the
 * whole no-JS rule applied honestly. iOS has no install API of any kind: the
 * Share sheet is the only route Apple offers, so a player on an iPhone reads
 * these instructions whether or not anything runs. Chrome's menu carries the
 * same item, so the instructions are never wrong — only sometimes bettered.
 *
 * The button and the "already installed" confirmation both ship `hidden`
 * (see `INSTALL_JS` in `src/views/scripts.ts` for what reveals which one),
 * and `[hidden] { display: none !important; }` in `STYLES` is what keeps
 * them that way for anyone whose script never runs: nothing in
 * `INSTALL_STYLES_CSS` gives `.install` a `display:` rule that could
 * out-specificity the attribute and reveal a control the platform cannot
 * act on.
 */
function renderInstallBody(hasPasskey: boolean): string {
  // Server-rendered inside the `hidden` confirmation, so it appears only on
  // the device that is already the installed app — the one place the emailed
  // link is no use, because it opens in the browser and signs the browser in.
  const passkeyNudge = hasPasskey
    ? ""
    : ` <a href="${PASSKEYS_PATH}">Add a passkey</a> so you can sign in from here — an emailed link opens in your browser, not in the app.`;
  return `
      <p data-install-instructions>
        Keep Make The Team a tap away, and it opens like an app rather than a tab.
      </p>
      <ol data-install-steps>
        <li>Open the browser's <strong>Share</strong> or menu button.</li>
        <li>Choose <strong>Add to Home Screen</strong>.</li>
      </ol>
      <button class="button" type="button" data-install-button hidden>Add to home screen</button>
      <p data-install-done hidden>Make The Team is installed on this device.${passkeyNudge}</p>
  `;
}

/** One registered device, as `renderPushBody` shows, tests and removes it. */
export interface PushDeviceRow {
  /**
   * **Never rendered as text.** Carried only so the row's two forms — remove
   * and test — can put it in a hidden `endpoint` field, the one place this
   * value is allowed to appear at all, and only inside a `value=""`
   * attribute, never as text a reader could see. This is the account page's
   * half of the invariant on `PUSH_UNSUBSCRIBE_PATH` (`src/auth/paths.ts`):
   * the endpoint is high-entropy and this session-gated page is the only
   * place the product ever discloses one — see that route's own doc comment
   * before changing anything here. `PUSH_SUBSCRIBE_JS` also reads these
   * hidden fields to find which row is the device it is running on; that is
   * a read of what the page already carries, not a new disclosure.
   */
  endpoint: string;
  /**
   * The caption the player typed at subscribe time ("Ed's phone"), or null
   * for a device registered before the field existed — those fall back to
   * `userAgent` below. Untrusted text either way: escaped like any other
   * player-influenced string.
   */
  name: string | null;
  /**
   * `push_subscriptions.user_agent` — the pre-name caption (the browser's
   * own UA string, truncated), kept only as the fallback when `name` is
   * null. Untrusted text: escaped.
   */
  userAgent: string | null;
  /** `created_at`, already formatted by the route (TR-5). */
  enabledAtLocal: string;
}

/**
 * The permission control — name field, button, problem paragraph — shared by
 * `renderPushBody` and `renderPushOffer` below (M14 Task 12 review,
 * Finding 5). Not exported: the two callers differ in exactly what a
 * `devices` field would let a caller do wrong, which is the reason this was
 * split into two functions rather than one with an optional `devices?`
 * parameter in the first place, and a third, more general entry point would
 * reopen that hole.
 *
 * **Everything here ships `hidden`, exactly like `data-install-button`
 * above.** The server has no way to know a visitor's
 * `Notification.permission` — that lives only in the browser — so it cannot
 * choose between state 3 (ask), state 4 (already granted) or state 5
 * (denied) at render time. Feature detection is entirely
 * `PUSH_SUBSCRIBE_JS`'s job: it reveals the name field and button together
 * unless permission is already `"denied"`, in which case it leaves both
 * hidden and fills `PUSH_PROBLEM_ID` instead. With scripting off the whole
 * control stays hidden and silent — never a control that cannot work.
 *
 * `token`, when given, rides along as `${PUSH_TOKEN_ATTRIBUTE}` — see that
 * constant's own doc comment in `src/views/scripts.ts` for why the offer's
 * button is otherwise unusable for its entire, signed-out audience (Finding
 * 2). The account page never passes one: its caller is signed in, and
 * `resolvePlayerId` in `src/routes/push.ts` already reads the session.
 *
 * `reloadTo`, when given, is where `PUSH_SUBSCRIBE_JS` navigates after a
 * successful subscribe (`${PUSH_RELOAD_ATTRIBUTE}`) — the account page
 * passes its own URL with a confirmation flag so the freshly registered
 * device appears in the table it renders. The offer page passes none and
 * gets the inline `PUSH_DONE_ID` acknowledgement instead.
 */
interface PermissionControl {
  vapidPublicKey: string | undefined;
  token?: string;
  buttonLabel: string;
  /** Pre-filled into the name field; the player can overtype it. */
  defaultDeviceName: string;
  reloadTo?: string;
  /** Swapped in by script when this browser is already in the table. */
  reenableLabel?: string;
}

function renderPermissionControl(control: PermissionControl): string {
  const { vapidPublicKey, token, buttonLabel, defaultDeviceName, reloadTo, reenableLabel } = control;
  if (vapidPublicKey === undefined) return "";
  const tokenAttribute = token === undefined ? "" : ` ${PUSH_TOKEN_ATTRIBUTE}="${escapeHtml(token)}"`;
  const reloadAttribute = reloadTo === undefined ? "" : ` ${PUSH_RELOAD_ATTRIBUTE}="${escapeHtml(reloadTo)}"`;
  const reenableAttribute =
    reenableLabel === undefined ? "" : ` ${PUSH_REENABLE_ATTRIBUTE}="${escapeHtml(reenableLabel)}"`;
  return `
    <label class="device-name" for="${PUSH_NAME_ID}" hidden>Name this device
      <input class="device-name-input" id="${PUSH_NAME_ID}" type="text" maxlength="60" value="${escapeHtml(defaultDeviceName)}">
    </label>
    <button
      class="button primary"
      type="button"
      id="${PUSH_BUTTON_ID}"
      ${PUSH_KEY_ATTRIBUTE}="${escapeHtml(vapidPublicKey)}"${tokenAttribute}${reloadAttribute}${reenableAttribute}
      hidden
    >${escapeHtml(buttonLabel)}</button>
    <p class="nudge" id="${PUSH_PROBLEM_ID}" hidden></p>
    <p id="${PUSH_DONE_ID}" hidden>Notifications are on for this device.</p>`;
}

/**
 * One row of the device table: caption, date, and two plain `<form>`s — Test
 * and Remove.
 *
 * Real `<form method="post">`s, not script-driven, because §11's closing
 * paragraph requires the whole list to work with no JavaScript at all —
 * `POST /app/push/unsubscribe` and `POST /app/push/test` both read exactly
 * this shape (`application/x-www-form-urlencoded`) for that reason.
 *
 * The "This device" badge ships `hidden`: only the browser knows which row
 * it is (`pushManager.getSubscription()`), so `PUSH_SUBSCRIBE_JS` reveals it
 * on the row whose hidden endpoint matches. With scripting off it simply
 * never appears — absence of an enhancement, not a broken control.
 */
function renderPushDevice(device: PushDeviceRow): string {
  const caption =
    device.name && device.name.trim().length > 0
      ? device.name
      : device.userAgent && device.userAgent.trim().length > 0
        ? device.userAgent
        : "An unnamed device";
  return `
    <tr>
      <td>${escapeHtml(caption)}<span class="this-device" hidden>This device</span></td>
      <td class="device-when">${escapeHtml(device.enabledAtLocal)}</td>
      <td class="push-actions">
        <form method="post" action="${escapeHtml(PUSH_TEST_PATH)}">
          <input type="hidden" name="endpoint" value="${escapeHtml(device.endpoint)}">
          <button class="button row-action" type="submit">Test</button>
        </form>
        <form method="post" action="${escapeHtml(PUSH_UNSUBSCRIBE_PATH)}">
          <input type="hidden" name="endpoint" value="${escapeHtml(device.endpoint)}">
          <button class="button row-action" type="submit">Remove</button>
        </form>
      </td>
    </tr>`;
}

export interface PushSectionOptions {
  /**
   * base64url VAPID public key for this deployment, or `undefined` when none
   * is configured. M14 ships dark — production has no `VAPID_PUBLIC_KEY` at
   * all until the owner generates the real pair — so `undefined` renders no
   * button and no `data-push-key` attribute at all: `PUSH_SUBSCRIBE_JS`
   * already returns early with no key to read, and a button that can only
   * fail must not exist rather than exist and do nothing (spec §11 state 5's
   * reasoning, applied one state earlier).
   */
  vapidPublicKey: string | undefined;
  /**
   * The player's own registered devices, listed with a way to remove each.
   * **Required, deliberately** — not `readonly PushDeviceRow[] | undefined`
   * (M14 Task 12 review, Finding 5). An optional field's default is
   * "nothing was passed", which is indistinguishable at the call site from a
   * caller that deliberately chose to show no devices, and Finding 2 showed
   * exactly how an unexercised optional silently goes wrong here. Only this
   * function — called from the session-gated `/app/account` alone — can
   * express a devices list at all; `renderPushOffer` below has no parameter
   * that could ever hold one. See the security invariant on
   * `PUSH_UNSUBSCRIBE_PATH` in `src/auth/paths.ts` for why that split
   * matters: an endpoint must never reach a token-authenticated caller, and
   * a type that cannot express "devices" on that caller's page is a
   * property, not just a habit.
   */
  devices: readonly PushDeviceRow[];
  /** Pre-fills the name field ("Ed's phone"); the player can overtype it. */
  defaultDeviceName: string;
  /**
   * A one-line outcome to show at the top of the section — "Notifications
   * are on for this device.", "Test sent." — chosen by the route from its
   * own fixed strings, never from caller text.
   */
  notice?: string | undefined;
  /** Where a successful subscribe navigates; see `PermissionControl`. */
  reloadTo?: string;
}

/**
 * The device list and its permission control — spec §11's states 3-5, on the
 * one page that may ever show both: `/app/account`, session-gated. Just the
 * inside of the panel — no `<section>`, heading or intro — so
 * `renderThisDeviceSection` below can wrap it alongside the install steps
 * without a caller ever being able to reach a devices list from anywhere
 * else. The one-time offer on `/r/:token` is `renderPushOffer` below, not
 * this function — that page must never be able to express a devices list,
 * which is why the two remain separate rather than one function with an
 * optional parameter (M14 Task 12 review, Finding 5).
 */
function renderPushBody({ vapidPublicKey, devices, defaultDeviceName, notice, reloadTo }: PushSectionOptions): string {
  const deviceHeading = "<h3>Your devices</h3>";
  const deviceList =
    devices.length === 0
      ? `<p class="read-only">No devices registered yet.</p>`
      : `<table class="push-devices">
          <thead><tr><th>Device</th><th>Enabled</th><th></th></tr></thead>
          <tbody>${devices.map(renderPushDevice).join("")}</tbody>
        </table>`;
  // "Turn on notifications" is the honest label for someone with nothing
  // registered; once a table exists the same button under it means "add the
  // one I am holding", so the words change with the position — and script
  // upgrades them again to "Re-enable on this device" when the badge check
  // finds this browser already in the table.
  const control = renderPermissionControl({
    vapidPublicKey,
    buttonLabel: devices.length === 0 ? "Turn on notifications" : "Enable on this device",
    defaultDeviceName,
    reloadTo,
    reenableLabel: "Re-enable on this device",
  });
  const noticeHtml = notice === undefined ? "" : `<p class="nudge">${escapeHtml(notice)}</p>`;

  return `
      ${noticeHtml}
      ${devices.length === 0 ? `${control}${deviceHeading}${deviceList}` : `${deviceHeading}${deviceList}${control}`}
  `;
}

/**
 * The account page's install and notifications cards (M21, reversing M20
 * B5's merge): two boxes, each headed from *outside* the card so the
 * headings sit at the same level as "Your fixtures" — a card that carries
 * its own h2 reads as a different, heavier kind of section than the plain
 * ones around it. The token-page offer (`renderPushOffer`) is deliberately
 * NOT built from this: the type split that stops a devices list existing on
 * a token page is the product's endpoint-disclosure invariant, and a shared
 * entry point is how it would erode.
 *
 * The permission control and device list still render inside their own
 * `.push` wrapper rather than directly in `.install` — `PUSH_STYLES_CSS`'s
 * selectors (`.push h3`, `.push .button`, `.push label.device-name`, …) are
 * shared with `renderPushOffer`'s own `<section class="push">`, and nesting
 * here rather than editing those selectors keeps this change from touching
 * `renderPushOffer` at all.
 */
export function renderDeviceSections(push: PushSectionOptions, hasPasskey: boolean): string {
  return `
    <h2>Install the app</h2>
    <section class="install">
      ${renderInstallBody(hasPasskey)}
    </section>

    <h2>Manage notifications</h2>
    <section class="install">
      <div class="push">${renderPushBody(push)}</div>
    </section>
  `;
}

export interface PushOfferOptions {
  heading: string;
  intro: string;
  /** See `PushSectionOptions.vapidPublicKey` — the same M14-ships-dark rule. */
  vapidPublicKey: string | undefined;
  /**
   * The same response token that authenticated this page (`/r/:token`).
   * `renderPermissionButton` puts it on the button as `${PUSH_TOKEN_ATTRIBUTE}`
   * so `PUSH_SUBSCRIBE_JS` can send it back on the subscribe POST —
   * `resolvePlayerId` in `src/routes/push.ts` accepts a session **or** a
   * token, and this page's entire audience is signed out, so without the
   * token there is no proof at all and the route 404s (M14 Task 12 review,
   * Finding 2). Required rather than optional: every real caller of this
   * page has one — it is the token in the URL — and a hole here is exactly
   * the failure mode that got missed the first time.
   */
  token: string;
  /**
   * Pre-fills the name field. This page cannot always name its viewer (the
   * squad list is hidden under BR-33 for some fixtures), so callers pass a
   * generic caption rather than a personalised one.
   */
  defaultDeviceName: string;
}

/**
 * The one-time push offer on the response-confirmation page (spec §11).
 *
 * **No `devices` parameter exists on this type, at all.** This is a
 * token-authenticated page — anyone holding the response link in `/r/:token`
 * reaches it, not only the player it names — and `PUSH_UNSUBSCRIBE_PATH`'s
 * whole safety argument (`src/auth/paths.ts`) depends on an endpoint value
 * never being disclosed to a token-authenticated caller. `renderPushBody`
 * above is the only function in this module that can render a devices list,
 * and it is called from nowhere but `renderThisDeviceSection`, itself called
 * from nowhere but `/app/account`. Do not add a `devices`
 * field to `PushOfferOptions` — see `src/views/fixture.ts`'s
 * `FixturePageOptions.pushOffer` doc comment before changing anything here.
 */
export function renderPushOffer({ heading, intro, vapidPublicKey, token, defaultDeviceName }: PushOfferOptions): string {
  return `
    <section class="push">
      <h2>${escapeHtml(heading)}</h2>
      <p>${escapeHtml(intro)}</p>
      ${renderPermissionControl({ vapidPublicKey, token, buttonLabel: "Turn on notifications", defaultDeviceName })}
    </section>
  `;
}
