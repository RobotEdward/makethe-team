import { DASHBOARD_PATH } from "../auth/paths.js";
import type { FixtureView } from "../domain/fixture-view.js";
import type { ResponseStatus } from "../domain/response-status.js";
import { renderStatusLine, viewerHeadlineOpen } from "./fixture.js";
import { escapeHtml, layout } from "./layout.js";
import { signOutForm } from "./sign-out-form.js";

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

export interface DashboardPageOptions {
  playerName: string;
  rows: readonly DashboardRow[];
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
    <li class="game-card">
      <h2>${escapeHtml(row.gameName)}</h2>
      <p class="kickoff">${escapeHtml(row.kicksOffAtLocal)}</p>
      <p class="venue">${escapeHtml(row.venueName)}</p>
      ${renderStatusLine(row.view)}
      <p class="${headlineClass}">${escapeHtml(headline)}</p>
      ${renderActions(row)}
    </li>`;
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
 */
export function renderDashboardPage({ playerName, rows }: DashboardPageOptions): string {
  const body = `
    <h1>Your games</h1>
    <p>Signed in as ${escapeHtml(playerName)}.</p>
    ${
      rows.length === 0
        ? `<p class="read-only">You've nothing coming up. When your next game opens for responses, it'll show up here.</p>`
        : `<ul class="game-list">${rows.map(renderRow).join("")}</ul>`
    }
    ${signOutForm("Sign out")}
  `;

  return layout({ title: "Your games — Make The Team", body });
}
