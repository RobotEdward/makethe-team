import { DASHBOARD_PATH, NEW_GAME_PATH, PASSKEYS_PATH, gamePath } from "../auth/paths.js";
import type { FixtureView } from "../domain/fixture-view.js";
import type { ResponseStatus } from "../domain/response-status.js";
import { renderStatusLine, viewerHeadlineOpen } from "./fixture.js";
import { escapeHtml, layout } from "./layout.js";
import { signOutForm } from "./sign-out-form.js";
import { DASHBOARD_STYLES_CSS, FIXTURE_STYLES_CSS } from "./styles.js";

/**
 * One fixture as the dashboard shows it: the game, when and where, the derived
 * status, and the viewer's own response.
 *
 * **No other player appears here, by name or otherwise.** BR-25 authorises a
 * cross-fixture view of the viewer's *own* commitments; the squad list belongs
 * to the fixture page. A dashboard is exactly the page where a "while we're
 * here, show the roster" addition would creep in, so the type itself has
 * nowhere to put one — see `DashboardFixture` in `src/db/dashboard-queries.ts`,
 * which never selects another player's row in the first place.
 */
export interface DashboardRow {
  fixtureId: string;
  gameName: string;
  venueName: string;
  /** Already formatted in the game's timezone by the caller (TR-5). */
  kicksOffAtLocal: string;
  view: FixtureView;
  myStatus: ResponseStatus;
}

/** One game the viewer owns, as the "your games" list needs it — nothing else. */
export interface OwnedGame {
  id: string;
  name: string;
}

export interface DashboardPageOptions {
  playerName: string;
  rows: readonly DashboardRow[];
  /** Games this player is an active Owner of — `listOwnedGames` (J1/M6a). */
  ownedGames: readonly OwnedGame[];
}

/**
 * The two response buttons, posting to the dashboard itself.
 *
 * An ordinary form submit with a hidden fixture id — no JavaScript, no
 * per-fixture URL, and nothing in the form the server trusts: the handler
 * re-derives the viewer's entitlement to that fixture from the database before
 * it touches the capacity object.
 */
function renderActions(row: DashboardRow): string {
  return `
      <form method="post" action="${DASHBOARD_PATH}" class="responses">
        <input type="hidden" name="fixtureId" value="${escapeHtml(row.fixtureId)}">
        <button type="submit" class="button" name="intent" value="in">I'm in</button>
        <button type="submit" class="button" name="intent" value="out">Can't make it</button>
      </form>`;
}

function renderRow(row: DashboardRow): string {
  // Same sentences the fixture page uses for the same statuses — imported, not
  // restated, so a waitlisted player can never read as confirmed on one page
  // and not the other (BR-5).
  const headline = viewerHeadlineOpen({ status: row.myStatus, waitlistRank: null });
  const headlineClass = `viewer-headline${row.myStatus === "waitlisted" ? " warn" : ""}`;

  return `
    <li class="fixture-card">
      <h2>${escapeHtml(row.gameName)}</h2>
      <p class="kickoff">${escapeHtml(row.kicksOffAtLocal)}</p>
      <p class="venue">${escapeHtml(row.venueName)}</p>
      ${renderStatusLine(row.view)}
      <p class="${headlineClass}">${escapeHtml(headline)}</p>
      ${renderActions(row)}
    </li>`;
}

/**
 * "Set up a game" plus any games the viewer owns, with links to `/g/:id`.
 *
 * Without this the whole of J1 is unreachable except by typing `/g/new`
 * directly — there is no other link into it anywhere in the app. Deliberately
 * no "Games you own" header at all when the list is empty: a heading over
 * nothing reads as a broken page, not an honest empty state, and the "Set up
 * a game" link already says everything a first-time owner needs.
 */
function renderOwnedGamesSection(games: readonly OwnedGame[]): string {
  const link = `<p><a href="${NEW_GAME_PATH}">Set up a game</a></p>`;
  if (games.length === 0) return link;

  const items = games
    // `escapeHtml` on the href as well as the name. The id is a UUID, so this
    // is not exploitable — it is here so the pattern that gets copied out of
    // this file is the safe one, and so it matches `src/views/game-overview.ts`
    // which escapes the identical construction.
    .map((game) => `<li><a href="${escapeHtml(gamePath(game.id))}">${escapeHtml(game.name)}</a></li>`)
    .join("");
  return `
    ${link}
    <h2>Games you own</h2>
    <ul class="owned-games">${items}</ul>`;
}

/**
 * The player dashboard (J7, BR-25): every upcoming fixture across every game
 * the viewer is an active member of, with the response they can change.
 *
 * Server-rendered, no `<script>`, no `type="password"` (TR-4, TR-15, TR-16).
 * This is the *only* renderer for this page: `POST` redirects back to `GET`
 * rather than rendering a second time, so there is no second copy of this
 * markup to keep in step (see `src/routes/dashboard.ts` for why the dashboard
 * redirects where `POST /r/:token` deliberately does not).
 *
 * The passkey link is a plain `<a>` to a page that *does* carry script. That
 * is the whole reason `/app/passkeys` is a separate page rather than a panel
 * here: this page — the one a player actually uses every week — stays
 * scriptless, and the enhancement is quarantined on the page that cannot
 * exist without it.
 */
export function renderDashboardPage({ playerName, rows, ownedGames }: DashboardPageOptions): string {
  const body = `
    <h1>Your games</h1>
    <p>Signed in as ${escapeHtml(playerName)}.</p>
    ${
      rows.length === 0
        ? `<p class="read-only">You've nothing coming up. When your next game opens for responses, it'll show up here.</p>`
        : `<ul class="fixture-list">${rows.map(renderRow).join("")}</ul>`
    }
    ${renderOwnedGamesSection(ownedGames)}
    <p><a href="${PASSKEYS_PATH}">Sign in faster next time with a passkey</a></p>
    ${signOutForm("Sign out")}
  `;

  return layout({
    title: "Your games — Make The Team",
    body,
    pageStyles: [FIXTURE_STYLES_CSS, DASHBOARD_STYLES_CSS],
  });
}
