import {
  ACCOUNT_PATH,
  DASHBOARD_PATH,
  DELETE_ACCOUNT_CANCEL_PATH,
  DELETE_ACCOUNT_PATH,
  NEW_GAME_PATH,
  ONBOARDING_DISMISS_PATH,
  PRIVACY_PATH,
  PASSKEYS_PATH,
  gamePath,
} from "../auth/paths.js";
import type { FixtureView } from "../domain/fixture-view.js";
import type { ResponseStatus } from "../domain/response-status.js";
import {
  answerStateOf,
  renderFullWarning,
  renderResponseButtons,
  renderStatusLine,
  viewerHeadlineOpen,
} from "./fixture.js";
import { escapeHtml, layout, type PageNav } from "./layout.js";
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
  /**
   * The game this fixture belongs to. Here for one reason: the card's heading
   * links to that game's page, which is the only route a member who owns
   * nothing has into it — see `renderRow`.
   */
  gameId: string;
  gameName: string;
  venueName: string;
  /** Already formatted in the game's timezone by the caller (TR-5). */
  kicksOffAtLocal: string;
  view: FixtureView;
  myStatus: ResponseStatus;
  /**
   * How many are on the waitlist right now — `fixtures.waitlistCount`, read by
   * `listDashboardFixtures`/`findActionableFixture` alongside every other
   * column those queries already select. Needed for the identical reason
   * `FixturePageOptions.waitlistCount` is (M10 §3.4): a card that shows "0
   * spots left" above a live "I'm in" button owes the viewer the same warning
   * about what tapping it will do (M10 whole-branch review, Important 2).
   */
  waitlistCount: number;
}

/** One game the viewer is a member of, as the "Your squads" list needs it (M20 B3). */
export interface SquadListEntry {
  id: string;
  name: string;
  owned: boolean;
}

export interface DashboardPageOptions {
  /** The signed-in header (M16); see PageNav in layout.ts. */
  nav: PageNav;
  playerName: string;
  rows: readonly DashboardRow[];
  /** Every game this player is an active member of — `listMemberGames` (M20 B3). */
  squads: readonly SquadListEntry[];
  /** The one refusal `POST /app/games/:gameId/leave` can produce (M7a Task 4). */
  problem?: string;
  /** Set when this player has an erasure pending — already formatted (M7b). */
  erasesAtLocal?: string;
  /**
   * Set instead of a plain pending banner when the date has arrived and the
   * erasure has not run (§6). `erasesAtLocal` is still the promised instant;
   * this says it is in the past and why.
   */
  erasureHeldUp?: {
    /** The games holding it up, live. Empty means "the sweep is simply due". */
    blockingGames: readonly { gameId: string; gameName: string }[];
    /** Execution has begun and stopped part-way — no cancel button. */
    started: boolean;
  };
  /**
   * Present only while the "Get set up" card should show at all (M19): within
   * the new-player window, not yet dismissed. The route decides that; this
   * type only says which hints remain. The install hint has no flag because
   * the server cannot know — CSS hides it inside the installed app.
   */
  onboarding?: OnboardingHints;
}

/** Which onboarding hints the viewer has not completed yet. */
export interface OnboardingHints {
  /** No passkey registered to this identity yet. */
  passkey: boolean;
  /** No push subscription on any device yet. */
  notifications: boolean;
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
  return renderResponseButtons(
    DASHBOARD_PATH,
    row.myStatus,
    `<input type="hidden" name="fixtureId" value="${escapeHtml(row.fixtureId)}">`,
  );
}

/**
 * One fixture card. Its heading is a link to the game's own page.
 *
 * That link is not the only route in any more — "Your squads" below lists
 * every game the viewer is a member of — but it costs no extra query, because
 * the dashboard already loads every game the viewer has a fixture in. The same
 * "built but nobody can get to it" failure that `renderYourSquadsSection`
 * exists to prevent for `/g/new` had happened again for the member's own game
 * page; this is the fix for it.
 */
function renderRow(row: DashboardRow): string {
  // Same sentences the fixture page uses for the same statuses — imported, not
  // restated, so a waitlisted player can never read as confirmed on one page
  // and not the other (BR-5).
  const headline = viewerHeadlineOpen({ status: row.myStatus, waitlistRank: null });
  const headlineClass = `viewer-headline${row.myStatus === "waitlisted" ? " warn" : ""}`;
  // The card ends in the same answer block the response page opens with
  // (M20 B7), through the same exported state expression rather than a second
  // copy of it — the reason the headline itself is imported. `false` for
  // read-only because this row carries no read-only reason at all: the card's
  // controls are live whatever `row.view.status` says, exactly as they were
  // before this block existed.

  return `
    <li class="fixture-card">
      <h2><a href="${escapeHtml(gamePath(row.gameId))}">${escapeHtml(row.gameName)}</a></h2>
      <p class="kickoff">${escapeHtml(row.kicksOffAtLocal)}</p>
      <p class="venue">${escapeHtml(row.venueName)}</p>
      ${renderStatusLine(row.view, row.waitlistCount)}
      <section class="answer answer-${answerStateOf(row.myStatus, false)}">
        ${headline ? `<p class="${headlineClass}">${escapeHtml(headline)}</p>` : ""}
        ${renderActions(row)}
        ${renderFullWarning(row.view, { status: row.myStatus }, row.waitlistCount)}
      </section>
    </li>`;
}

/**
 * "Your squads" — every game the viewer is an active member of, owned or not,
 * each linking to `/g/:id` — plus "Set up a game", which links to `/g/new`.
 *
 * Without the link, the whole of J1 is unreachable except by typing `/g/new`
 * directly — there is no other link into it anywhere in the app. Deliberately
 * no "Your squads" header at all when the list is empty: a heading over
 * nothing reads as a broken page, not an honest empty state, and the "Set up
 * a game" link already says everything a first-time owner needs.
 */
function renderYourSquadsSection(squads: readonly SquadListEntry[]): string {
  const link = `<p><a href="${NEW_GAME_PATH}">Set up a game</a></p>`;
  if (squads.length === 0) return link;
  const items = squads
    .map(
      (g) =>
        `<li><a href="${escapeHtml(gamePath(g.id))}">${escapeHtml(g.name)}</a>${
          g.owned ? `<span class="detail"> · you own this</span>` : ""
        }</li>`,
    )
    .join("");
  return `
    <h2>Your squads</h2>
    <ul class="owned-games">${items}</ul>
    ${link}`;
}

/**
 * The pending-erasure banner (BR-34, M7b).
 *
 * **Shown here, not only on `/app/delete`.** The request can be made by
 * anyone who signs in as this player, on any device — a shared computer, a
 * second browser, a session that outlives the one that started it — and the
 * only page that visits routinely enough to be noticed is this one. A pending
 * erasure visible solely on the page where it was requested is invisible to
 * whoever did *not* request it, which is exactly the person a two-day window
 * exists to warn.
 *
 * The cancel form posts straight from here rather than linking through
 * `/app/delete` first: stopping an erasure someone did not start is the
 * one-click case this banner exists for, and a detour through another page
 * buys nothing but a chance to give up partway.
 */
function renderErasureBanner(erasesAtLocal: string): string {
  return `
    <div class="nudge">
      <p>Your data is due to be erased on <strong>${escapeHtml(erasesAtLocal)}</strong>.</p>
      <form method="post" action="${DELETE_ACCOUNT_CANCEL_PATH}">
        <button type="submit" class="button">Keep my account</button>
      </form>
    </div>`;
}

/**
 * The banner's other half: the date has passed and the erasure has not run
 * (§6, added by the final review).
 *
 * The sole-organiser invariant is checked again at execution, and a player who
 * has become the last organiser of a game since requesting erasure stays
 * pending — possibly for weeks, because nothing but a handover clears it. The
 * banner above went on saying "due to be erased on <a date in the past>" for
 * the whole of that time, named nothing, and offered a cancel button as the
 * only thing to press. This one says what is actually true, names each game,
 * and links it: the handover is the way out, and the game page is where it is
 * done.
 *
 * `started` is the harder case — execution began and stopped part-way, so the
 * player is already out of some squads. The cancel button goes: cancelling
 * would leave them out of those squads with no erasure left to finish, and the
 * promotions their departure caused have already been emailed.
 */
function renderHeldUpErasureBanner(
  erasesAtLocal: string,
  blockingGames: readonly { gameId: string; gameName: string }[],
  started: boolean,
): string {
  const games = blockingGames
    .map(
      (game) =>
        `<li><a href="${escapeHtml(gamePath(game.gameId))}">${escapeHtml(game.gameName)}</a></li>`,
    )
    .join("");

  const why =
    blockingGames.length > 0
      ? `<p>Each of these games needs an organiser, and you're the only one it has — make somebody else an organiser and it will go ahead by itself:</p>
         <ul>${games}</ul>`
      : `<p>It runs on the hour, so it should happen shortly. You don't need to do anything.</p>`;

  const ending = started
    ? `<p>It has already begun, so it can't be stopped now — you've been taken out of some of your squads and those places have gone to whoever was waiting.</p>`
    : `<form method="post" action="${DELETE_ACCOUNT_CANCEL_PATH}">
         <button type="submit" class="button">Keep my account</button>
       </form>`;

  return `
    <div class="nudge">
      <p>Your data was due to be erased on <strong>${escapeHtml(erasesAtLocal)}</strong>, and it hasn't happened yet.</p>
      ${why}
      ${ending}
      <p><a href="${DELETE_ACCOUNT_PATH}">More about this</a></p>
    </div>`;
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
/**
 * The "Get set up" card (M19). Every hint is a plain link to a flow that
 * already exists elsewhere — nothing here is the only way to reach anything,
 * which is what makes a Dismiss button safe. The install hint always renders
 * when the card does: whether this device already runs the installed app is a
 * fact only the client has, and \`.onboarding li.hint-install\` is hidden by a
 * display-mode media query rather than by script.
 */
function renderOnboardingCard(hints: OnboardingHints): string {
  return `
    <section class="onboarding">
      <h2>Get set up</h2>
      <ul>
        ${hints.passkey ? `<li><a href="${PASSKEYS_PATH}">Add a passkey to sign in faster</a></li>` : ""}
        <li class="hint-install"><a href="${ACCOUNT_PATH}">Install the app on this device</a></li>
        ${hints.notifications ? `<li><a href="${ACCOUNT_PATH}">Turn on notifications</a></li>` : ""}
      </ul>
      <form method="post" action="${ONBOARDING_DISMISS_PATH}">
        <button class="button" type="submit">Dismiss</button>
      </form>
    </section>
  `;
}

export function renderDashboardPage({
  nav,
  playerName,
  rows,
  squads,
  problem,
  erasesAtLocal,
  erasureHeldUp,
  onboarding,
}: DashboardPageOptions): string {
  const problemNotice = problem === undefined ? "" : `<p class="nudge">${escapeHtml(problem)}</p>`;
  const erasureBanner =
    erasesAtLocal === undefined
      ? ""
      : erasureHeldUp === undefined
        ? renderErasureBanner(erasesAtLocal)
        : renderHeldUpErasureBanner(
            erasesAtLocal,
            erasureHeldUp.blockingGames,
            erasureHeldUp.started,
          );
  const body = `
    <h1>Your games</h1>
    <p>Signed in as ${escapeHtml(playerName)}.</p>
    ${problemNotice}
    ${erasureBanner}
    ${onboarding === undefined ? "" : renderOnboardingCard(onboarding)}
    ${
      rows.length === 0
        ? `<p class="read-only">You've nothing coming up. When your next game opens for responses, it'll show up here.</p>`
        : `<ul class="fixture-list">${rows.map(renderRow).join("")}</ul>`
    }
    ${renderYourSquadsSection(squads)}
    <p><a href="${DELETE_ACCOUNT_PATH}">Delete my account and data</a> · <a href="${PRIVACY_PATH}">Privacy</a></p>
  `;

  return layout({
    nav,
    title: "Your games — Make The Team",
    body,
    pageStyles: [FIXTURE_STYLES_CSS, DASHBOARD_STYLES_CSS],
  });
}
