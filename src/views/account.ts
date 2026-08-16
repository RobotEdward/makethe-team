import { ACCOUNT_PATH, DELETE_ACCOUNT_PATH, PASSKEYS_PATH, PRIVACY_PATH, gamePath } from "../auth/paths.js";
import { escapeHtml, layout } from "./layout.js";
import { signOutForm } from "./sign-out-form.js";
import { DASHBOARD_STYLES_CSS, FIXTURE_STYLES_CSS, FORM_CSS } from "./styles.js";

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
  playerName: string;
  /** Null for a guest, who has no contact details (§2.8, BR-32). */
  email: string | null;
  fixtures: readonly AccountFixtureRow[];
  /** A refusal to explain on this page — an empty or over-long name. */
  problem?: string;
  /** Set when this player has an erasure pending — already formatted (M7b). */
  erasesAtLocal?: string;
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
      <p class="viewer-headline">${escapeHtml(row.myStatusLabel)}</p>
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
 */
export function renderAccountPage({
  playerName,
  email,
  fixtures,
  problem,
  erasesAtLocal,
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

  const emailLine =
    email === null
      ? `<p class="read-only">We don't have an email address for you.</p>`
      : `<p class="read-only">${escapeHtml(email)}</p>`;

  const body = `
    <h1>Your account</h1>
    ${problemNotice}
    ${erasureNotice}

    <h2>Your name</h2>
    <p>This is what your squads see, on every fixture and in every email.</p>
    <form method="post" action="${ACCOUNT_PATH}">
      <label for="name">Name</label>
      <input id="name" name="name" type="text" value="${escapeHtml(playerName)}" maxlength="200" required>
      <button class="button primary" type="submit">Save</button>
    </form>

    <h2>Your email address</h2>
    ${emailLine}
    <p>This is how you sign in and where your reminders go, so it can't be changed here yet.</p>

    <h2>How you sign in</h2>
    <p><a href="${PASSKEYS_PATH}">Manage your passkeys</a></p>

    <h2>Your fixtures</h2>
    ${
      fixtures.length === 0
        ? `<p class="read-only">Nothing yet. Once you've answered a fixture, it'll show up here.</p>`
        : `<ul class="fixture-list">${fixtures.map(renderFixture).join("")}</ul>`
    }

    <p><a href="${DELETE_ACCOUNT_PATH}">Delete my account and data</a> · <a href="${PRIVACY_PATH}">Privacy</a></p>
    ${signOutForm("Sign out")}
  `;

  return layout({
    title: "Your account — Make The Team",
    body,
    pageStyles: [FIXTURE_STYLES_CSS, DASHBOARD_STYLES_CSS, FORM_CSS],
  });
}
