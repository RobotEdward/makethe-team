import { PUSH_UNSUBSCRIBE_PATH } from "../auth/paths.js";
import { escapeHtml } from "./layout.js";
import { PUSH_BUTTON_ID, PUSH_KEY_ATTRIBUTE, PUSH_PROBLEM_ID } from "./scripts.js";

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
   *
   * **`undefined` on every token-authenticated page, always.** This is the
   * whole of the security invariant `PUSH_UNSUBSCRIBE_PATH` depends on
   * (`src/auth/paths.ts`, `src/routes/push.ts`): a token holder must never
   * be shown an endpoint they do not already hold, because a token is also
   * accepted as proof on the unsubscribe route, and an endpoint disclosed
   * here would turn that acceptance into a way to silently switch off a
   * stranger's notifications. `/app/account` — session-gated — is the only
   * caller that may pass an array (even an empty one); the one-time offer on
   * `/r/:token` must pass `undefined` and nothing else, forever.
   */
  devices?: readonly PushDeviceRow[];
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

/**
 * Notification permission and the device list — spec §11's states 3-5, the
 * half of the five-state component M14 Task 12 adds. States 1-2 (install)
 * are `renderInstallSection` above; the two functions are meant to read as
 * one coherent panel on `/app/account` rather than two competing ones, which
 * is why `PUSH_STYLES_CSS` in `src/views/styles.ts` echoes `.install`'s own
 * spacing and border rather than inventing a second look.
 *
 * **The button ships `hidden`, exactly like `data-install-button` above.**
 * The server has no way to know a visitor's `Notification.permission` — that
 * lives only in the browser — so it cannot choose between state 3 (ask),
 * state 4 (already granted) or state 5 (denied) at render time. Feature
 * detection is entirely `PUSH_SUBSCRIBE_JS`'s job: it reveals the button
 * unless permission is already `"denied"`, in which case it leaves the
 * button hidden and fills `PUSH_PROBLEM_ID` instead. With scripting off the
 * button and the problem text both stay hidden and silent — never a control
 * that cannot work — and the device list below, being plain server-rendered
 * markup, is the one part of this component that is not asking a browser API
 * anything and so needs no script to be complete.
 */
export function renderPushSection({ heading, intro, vapidPublicKey, devices }: PushSectionOptions): string {
  const deviceList =
    devices === undefined
      ? ""
      : `
        <h3>Your devices</h3>
        ${
          devices.length === 0
            ? `<p class="read-only">No devices registered yet.</p>`
            : `<ul class="push-device-list">${devices.map(renderPushDevice).join("")}</ul>`
        }`;

  const button =
    vapidPublicKey === undefined
      ? ""
      : `
        <button
          class="button primary"
          type="button"
          id="${PUSH_BUTTON_ID}"
          ${PUSH_KEY_ATTRIBUTE}="${escapeHtml(vapidPublicKey)}"
          hidden
        >Turn on notifications</button>
        <p class="nudge" id="${PUSH_PROBLEM_ID}" hidden></p>`;

  return `
    <section class="push">
      <h2>${escapeHtml(heading)}</h2>
      <p>${escapeHtml(intro)}</p>
      ${button}
      ${deviceList}
    </section>
  `;
}
