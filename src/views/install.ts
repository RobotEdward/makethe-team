import { PUSH_UNSUBSCRIBE_PATH } from "../auth/paths.js";
import { escapeHtml } from "./layout.js";
import { PUSH_BUTTON_ID, PUSH_KEY_ATTRIBUTE, PUSH_PROBLEM_ID, PUSH_TOKEN_ATTRIBUTE } from "./scripts.js";

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
export function renderInstallSection(): string {
  return `
    <section class="install">
      <h2>Add to your home screen</h2>
      <p data-install-instructions>
        Keep Make The Team a tap away, and it opens like an app rather than a tab.
      </p>
      <ol data-install-steps>
        <li>Open the browser's <strong>Share</strong> or menu button.</li>
        <li>Choose <strong>Add to Home Screen</strong>.</li>
      </ol>
      <button class="button" type="button" data-install-button hidden>Add to home screen</button>
      <p data-install-done hidden>Make The Team is installed on this device.</p>
    </section>
  `;
}

/** One registered device, as `renderPushSection` shows and removes it. */
export interface PushDeviceRow {
  /**
   * **Never rendered.** Carried only so `renderPushDevice` can put it in the
   * removal form's hidden `endpoint` field — the one place this value is
   * allowed to appear at all, and only inside a `value=""` attribute, never
   * as text a reader could see. This is the account page's half of the
   * invariant on `PUSH_UNSUBSCRIBE_PATH` (`src/auth/paths.ts`): the endpoint
   * is high-entropy and this session-gated page is the only place the
   * product ever discloses one — see that route's own doc comment before
   * changing anything here.
   */
  endpoint: string;
  /**
   * `push_subscriptions.user_agent` — a caption a player wrote for
   * themselves at subscribe time (their browser's own UA string, truncated),
   * not an identifier, and untrusted text either way: `renderPushDevice`
   * escapes it like any other player-influenced string. `null` when the
   * device subscribed before a `User-Agent` header was sent, or with one
   * empty.
   */
  userAgent: string | null;
}

/**
 * The permission button and its problem paragraph — the one piece shared by
 * `renderPushSection` and `renderPushOffer` below (M14 Task 12 review,
 * Finding 5). Not exported: the two callers differ in exactly what a
 * `devices` field would let a caller do wrong, which is the reason this was
 * split into two functions rather than one with an optional `devices?`
 * parameter in the first place, and a third, more general entry point would
 * reopen that hole.
 *
 * **The button ships `hidden`, exactly like `data-install-button` above.**
 * The server has no way to know a visitor's `Notification.permission` — that
 * lives only in the browser — so it cannot choose between state 3 (ask),
 * state 4 (already granted) or state 5 (denied) at render time. Feature
 * detection is entirely `PUSH_SUBSCRIBE_JS`'s job: it reveals the button
 * unless permission is already `"denied"`, in which case it leaves the
 * button hidden and fills `PUSH_PROBLEM_ID` instead. With scripting off the
 * button and the problem text both stay hidden and silent — never a control
 * that cannot work.
 *
 * `token`, when given, rides along as `${PUSH_TOKEN_ATTRIBUTE}` — see that
 * constant's own doc comment in `src/views/scripts.ts` for why the offer's
 * button is otherwise unusable for its entire, signed-out audience (Finding
 * 2). The account page never passes one: its caller is signed in, and
 * `resolvePlayerId` in `src/routes/push.ts` already reads the session.
 */
function renderPermissionButton(vapidPublicKey: string | undefined, token: string | undefined): string {
  if (vapidPublicKey === undefined) return "";
  const tokenAttribute = token === undefined ? "" : ` ${PUSH_TOKEN_ATTRIBUTE}="${escapeHtml(token)}"`;
  return `
    <button
      class="button primary"
      type="button"
      id="${PUSH_BUTTON_ID}"
      ${PUSH_KEY_ATTRIBUTE}="${escapeHtml(vapidPublicKey)}"${tokenAttribute}
      hidden
    >Turn on notifications</button>
    <p class="nudge" id="${PUSH_PROBLEM_ID}" hidden></p>`;
}

/**
 * One row of the device list: a caption and a plain `<form>` that removes it.
 *
 * A real `<form method="post">`, not a script-driven delete, because §11's
 * closing paragraph requires the whole list to work with no JavaScript at
 * all — `POST /app/push/unsubscribe` reads exactly this shape
 * (`application/x-www-form-urlencoded`) for that reason.
 */
function renderPushDevice(device: PushDeviceRow): string {
  const label = device.userAgent && device.userAgent.trim().length > 0 ? device.userAgent : "An unnamed device";
  return `
    <li class="push-device">
      <span>${escapeHtml(label)}</span>
      <form method="post" action="${escapeHtml(PUSH_UNSUBSCRIBE_PATH)}">
        <input type="hidden" name="endpoint" value="${escapeHtml(device.endpoint)}">
        <button class="button" type="submit">Remove</button>
      </form>
    </li>`;
}

export interface PushSectionOptions {
  heading: string;
  intro: string;
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
}

/**
 * Notification permission and the device list — spec §11's states 3-5, on
 * the one page that may ever show both: `/app/account`, session-gated. The
 * one-time offer on `/r/:token` is `renderPushOffer` below, not this
 * function — that page must never be able to express a devices list, which
 * is why the two are separate exports rather than one function with an
 * optional parameter (M14 Task 12 review, Finding 5).
 *
 * States 1-2 (install) are `renderInstallSection` above. The two sections
 * currently render as two separate boxes on `/app/account` rather than one
 * merged panel — `PUSH_STYLES_CSS` in `src/views/styles.ts` intentionally
 * echoes `.install`'s own spacing and border so the two at least *look*
 * related, but they remain two `<section>` elements, and a future task may
 * choose to fold them into one.
 */
export function renderPushSection({ heading, intro, vapidPublicKey, devices }: PushSectionOptions): string {
  const deviceHeading = "<h3>Your devices</h3>";
  const deviceList =
    devices.length === 0
      ? `<p class="read-only">No devices registered yet.</p>`
      : `<ul class="push-device-list">${devices.map(renderPushDevice).join("")}</ul>`;

  return `
    <section class="push">
      <h2>${escapeHtml(heading)}</h2>
      <p>${escapeHtml(intro)}</p>
      ${renderPermissionButton(vapidPublicKey, undefined)}
      ${deviceHeading}
      ${deviceList}
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
}

/**
 * The one-time push offer on the response-confirmation page (spec §11).
 *
 * **No `devices` parameter exists on this type, at all.** This is a
 * token-authenticated page — anyone holding the response link in `/r/:token`
 * reaches it, not only the player it names — and `PUSH_UNSUBSCRIBE_PATH`'s
 * whole safety argument (`src/auth/paths.ts`) depends on an endpoint value
 * never being disclosed to a token-authenticated caller. `renderPushSection`
 * above is the only function in this module that can render a devices list,
 * and it is called from nowhere but `/app/account`. Do not add a `devices`
 * field to `PushOfferOptions` — see `src/views/fixture.ts`'s
 * `FixturePageOptions.pushOffer` doc comment before changing anything here.
 */
export function renderPushOffer({ heading, intro, vapidPublicKey, token }: PushOfferOptions): string {
  return `
    <section class="push">
      <h2>${escapeHtml(heading)}</h2>
      <p>${escapeHtml(intro)}</p>
      ${renderPermissionButton(vapidPublicKey, token)}
    </section>
  `;
}
