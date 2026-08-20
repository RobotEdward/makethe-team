import {
  ACCOUNT_PATH,
  DELETE_ACCOUNT_PATH,
  PASSKEYS_PATH,
  PRIVACY_PATH,
  gamePath,
} from "../auth/paths.js";
import { renderDeviceSections, type PushDeviceRow } from "./install.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
import { INSTALL_JS, PUSH_SUBSCRIBE_JS } from "./scripts.js";
import { signOutForm } from "./sign-out-form.js";
import {
  DASHBOARD_STYLES_CSS,
  FIXTURE_STYLES_CSS,
  FORM_CSS,
  INSTALL_STYLES_CSS,
  PUSH_STYLES_CSS,
} from "./styles.js";

/**
 * One fixture as the account page shows it — already formatted, already
 * labelled, by the route.
 *
 * **No other player appears here, by name or otherwise**, for the reason
 * `DashboardRow` gives: this page is a cross-game view of the viewer's *own*
 * record, and the squad belongs to the fixture page. The type has nowhere to
 * put a roster, which is what stops one creeping in.
 */
export interface AccountFixtureRow {
  gameId: string;
  gameName: string;
  venueName: string;
  /** Already formatted in the game's timezone by the caller (TR-5). */
  kicksOffAtLocal: string;
  /** The fixture's own state, in words: "Played", "Called off", "Confirmed"… */
  statusLabel: string;
  /** What the viewer answered: "You were in", "You couldn't make it"… */
  myStatusLabel: string;
}

export interface AccountPageOptions {
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
  playerName: string;
  /** Null for a guest, who has no contact details (§2.8, BR-32). */
  email: string | null;
  fixtures: readonly AccountFixtureRow[];
  /** A refusal to explain on this page — an empty or over-long name. */
  problem?: string;
  /** Set when this player has an erasure pending — already formatted (M7b). */
  erasesAtLocal?: string;
  /** This player's own registered devices (M14 Task 12, spec §11). */
  pushDevices: readonly PushDeviceRow[];
  /**
   * base64url VAPID public key, or `undefined` while none is configured —
   * see `PushSectionOptions.vapidPublicKey` in `src/views/install.ts` for
   * why that renders no button at all rather than a broken one.
   */
  vapidPublicKey: string | undefined;
  /**
   * A push outcome to acknowledge — subscribe landed, test sent, test
   * failed. One of the route's own fixed strings (it reads the query flag
   * as an enum), never caller text.
   */
  pushNotice?: string | undefined;
}

/**
 * One history row. Deliberately *not* `renderRow` from `src/views/dashboard.ts`:
 * that card carries the two response buttons, and this page must offer no way
 * to answer a fixture. The card class is shared so the two pages look alike.
 */
function renderFixture(row: AccountFixtureRow): string {
  return `
    <li class="fixture-card">
      <h3><a href="${escapeHtml(gamePath(row.gameId))}">${escapeHtml(row.gameName)}</a></h3>
      <p class="kickoff">${escapeHtml(row.kicksOffAtLocal)}</p>
      <p class="venue">${escapeHtml(row.venueName)}</p>
      <p class="status-line">${escapeHtml(row.statusLabel)}</p>
      ${row.myStatusLabel ? `<p class="viewer-headline">${escapeHtml(row.myStatusLabel)}</p>` : ""}
    </li>`;
}

/**
 * A player's own account: who we have them down as, how they sign in, and what
 * they have played.
 *
 * The email is rendered as text and not as an input, and the page says why.
 * `players.email` is Better Auth's sign-in identity as well as a column here,
 * so an editable field would mean either a typo that ends the account — sign-in
 * stops working *and* the magic link that would fix it goes to a stranger's
 * inbox — or a verified-change flow, which is its own milestone. Saying the
 * address is fixed is honest; a field that silently half-works is not.
 *
 * Server-rendered, no `<script>`, no `type="password"` (TR-4, TR-15, TR-16).
 *
 * **The erasure banner and the rename form both render when an erasure is
 * pending.** §5.1 says the page must not offer a rename "as though nothing
 * were happening" — read here as a requirement that the banner be visible,
 * not as a requirement that the form be hidden. An erasure is cancellable
 * within its window (`POST /app/delete/cancel`), so renaming yourself while
 * one is pending is not absurd: the account may still be here in two days,
 * and there is no reason to make somebody cancel first just to fix a typo in
 * their own name. This was a decision, not an oversight left over from
 * before the banner existed.
 */
export function renderAccountPage({
  nav,
  playerName,
  email,
  fixtures,
  problem,
  erasesAtLocal,
  pushDevices,
  vapidPublicKey,
  pushNotice,
}: AccountPageOptions): string {
  const problemNotice = problem === undefined ? "" : `<p class="problem">${escapeHtml(problem)}</p>`;

  // Shown here as well as on the dashboard, for the reason `renderErasureBanner`
  // gives: a pending erasure is invisible to whoever did not request it unless
  // every page they visit routinely says so.
  const erasureNotice =
    erasesAtLocal === undefined
      ? ""
      : `<div class="nudge">
           <p>Your data is due to be erased on <strong>${escapeHtml(erasesAtLocal)}</strong>.</p>
           <p><a href="${DELETE_ACCOUNT_PATH}">More about this</a></p>
         </div>`;

  // Two different things, so two different treatments. An address we hold is a
  // value being read out: a caption above plain text, because the dashed box
  // this used to use says "nothing here to act on", which of a value reads as
  // a field that has been disabled on you. Having no address at all *is*
  // nothing to act on — the same state as the empty fixture list below — so
  // that branch keeps the box, and needs no caption because the sentence
  // already names what is missing.
  const emailLine =
    email === null
      ? `<p class="read-only">We don't have an email address for you.</p>`
      : `<p class="readout-label">Email address</p>
         <p>${escapeHtml(email)}</p>`;

  const body = `
    <h1>Your account</h1>
    ${problemNotice}
    ${erasureNotice}

    <h2>Your name</h2>
    <p>This is what your squads see, on every fixture and in every email.</p>
    <form method="post" action="${ACCOUNT_PATH}">
      <div class="field">
        <label for="name">Name</label>
        <input id="name" name="name" type="text" value="${escapeHtml(playerName)}" maxlength="200" required>
      </div>
      <button class="button primary" type="submit">Save</button>
    </form>

    <h2>Signing in</h2>
    ${emailLine}
    <p>This is how you sign in and where your reminders go, so it can't be changed here yet.</p>
    <p><a href="${PASSKEYS_PATH}">Manage your passkeys</a></p>

    <h2>Your fixtures</h2>
    ${
      fixtures.length === 0
        ? `<p class="read-only">Nothing yet. Once you've answered a fixture, it'll show up here.</p>`
        : `<ul class="fixture-list">${fixtures.map(renderFixture).join("")}</ul>`
    }

    ${renderDeviceSections({
      vapidPublicKey,
      devices: pushDevices,
      defaultDeviceName: `${playerName}'s phone`,
      notice: pushNotice,
      // Back to this page with the flag that renders the acknowledgement,
      // so the new device is in the table the moment the player can look
      // for it.
      reloadTo: `${ACCOUNT_PATH}?push=enabled`,
    })}

    <p><a href="${escapeHtml(DELETE_ACCOUNT_PATH)}">Delete my account and data</a> · <a href="${escapeHtml(PRIVACY_PATH)}">Privacy</a></p>
    ${signOutForm("Sign out")}
  `;

  return layout({
    nav,
    title: "Your account — Make The Team",
    body,
    pageStyles: [FIXTURE_STYLES_CSS, DASHBOARD_STYLES_CSS, FORM_CSS, INSTALL_STYLES_CSS, PUSH_STYLES_CSS],
    // `PUSH_SUBSCRIBE_JS` is opted in unconditionally, even while
    // `vapidPublicKey` is `undefined` and no button exists for it to find —
    // matching `INSTALL_JS`'s own doc comment: the guard is inside the
    // script (`if (!button) return;`), and `SCRIPT_BLOCKS` membership is a
    // static, per-block fact rather than something that could vary by
    // request. See the module comment on `src/views/scripts.ts` for why a
    // conditional page-script array is not how this project decides what a
    // page may carry.
    pageScripts: [INSTALL_JS, PUSH_SUBSCRIBE_JS],
  });
}
