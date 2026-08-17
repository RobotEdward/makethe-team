import {
  DASHBOARD_PATH,
  DELETE_ACCOUNT_CANCEL_PATH,
  DELETE_ACCOUNT_PATH,
  gamePath,
} from "../auth/paths.js";
import { escapeHtml, layout } from "./layout.js";
import { FIXTURE_STYLES_CSS, FORM_CSS } from "./styles.js";

/**
 * The page behind `/app/delete` (BR-34, M7b).
 *
 * Modelled on `src/views/leave.ts`: one render function, a `state`
 * discriminator, one body function per state, and the destructive action
 * behind a real `<form method="post">` rather than a link, so nothing a
 * browser or a prefetcher issues as a `GET` can start it. Unlike that page
 * this one is its own signed-in page rather than a token-reached one, so
 * `FORM_CSS` belongs here — the dashboard, which never carries it, is a
 * different page with a different style budget.
 */
export interface DeleteAccountPageParams {
  playerName: string;
  /**
   * - `offer` — nothing pending; renders the request button.
   * - `sole-organiser` — renders **no button**, and names the games.
   * - `pending` — an erasure is scheduled and its date is still ahead;
   *   renders the cancel button.
   * - `held-up` — the date has arrived and the erasure has not happened.
   *   Names whatever is blocking it, and renders the cancel button only while
   *   cancelling is still an honest offer (see `started`).
   */
  state: "offer" | "sole-organiser" | "pending" | "held-up";
  /**
   * For `sole-organiser` and `held-up`. Each links to its own game page to
   * hand over. Empty on `held-up` means nothing is blocking it and the run is
   * simply still to come — the sweep is hourly, so a date can be minutes past
   * with nothing wrong at all.
   */
  blockingGames?: readonly { gameId: string; gameName: string }[];
  /** For `pending` and `held-up`, already formatted by the caller. */
  erasesAtLocal?: string;
  /**
   * `held-up` only: execution has begun and stopped part-way
   * (`players.erasure_started_at`). Squads have already been left and other
   * people promoted into the places given up, so the copy must not claim
   * nothing has changed and there must be no cancel button — cancelling would
   * strand the account out of its squads with nothing left to finish the job.
   */
  started?: boolean;
  /**
   * Why a `POST` was refused, rendered above the body at 422. The refusal
   * shows this same page with the reason on it rather than a bare error, the
   * way `renderDashboard` handles its own sole-organiser refusal.
   */
  problem?: string;
}

/**
 * The offer itself.
 *
 * **It states both halves, and the delay.** What goes is everything that ties
 * the account to a person — name, address, every way of signing in, every
 * squad. What stays is the response rows that keep a past fixture honest: a
 * ten-a-side game still reads as ten-a-side, with this player unnamed. Saying
 * only the first half would promise a deletion this product does not perform
 * (see `erasePlayer` for why those rows survive), and saying only the second
 * would read as a refusal.
 *
 * The two days are named in the same breath, because the window is the only
 * thing standing between a mis-tap and an irreversible act — a person who does
 * not know it exists cannot use it.
 */
function offerBody(): string {
  return `
    <p>This erases your name, your email address and every way of signing in, and takes you out of every squad you're in. It can't be undone.</p>
    <p>Fixtures you've already played still count you, as a former player with no name attached — that's what keeps a past game's numbers honest for everyone else who was there.</p>
    <p>It happens <strong>two days from now</strong>, not straight away. Nothing changes in the meantime: you stay in your squads, your answers stand, and you can stop it from this page at any point before then.</p>
    <form method="post" action="${escapeHtml(DELETE_ACCOUNT_PATH)}">
      <button class="button danger" type="submit">Delete my data</button>
    </form>
  `;
}

/**
 * The one refusal this page can produce, worded as `views/leave.ts`'s
 * sole-organiser state is (M7a) — the same invariant, `isLastActiveOwner`,
 * refusing for the same reason, so a player who hits it in both places is
 * told the same thing twice rather than two different things.
 *
 * **No button at all**, rather than a disabled one: there is nothing to press
 * until the handover has happened, and a control that exists but refuses
 * invites the press. Each game links to its own page, because that is where
 * the handover is actually done.
 */
function soleOrganiserBody(blockingGames: readonly { gameId: string; gameName: string }[]): string {
  const items = blockingGames
    .map(
      (game) =>
        `<li><a href="${escapeHtml(gamePath(game.gameId))}">${escapeHtml(game.gameName)}</a></li>`,
    )
    .join("");

  return `
    <p>Not yet — each of these games needs an organiser, and you're the only one it has:</p>
    <ul>${items}</ul>
    <p>Make someone else an organiser first, then come back here.</p>
  `;
}

/**
 * The pending state — the page the confirmation email sends someone back to.
 *
 * It names the exact instant rather than "in two days": the person reading it
 * may be reading it a day later, having been told about a request they did not
 * make, and "two days" from the wrong starting point is not an answer.
 *
 * **Only ever rendered while that instant is still ahead.** Both sentences —
 * the date, and "until then nothing has changed" — are false the moment it is
 * not, and one of them is false in the direction that matters: an erasure that
 * has begun has already taken the player out of squads. `held-up` is the state
 * for everything past the deadline; the route selects between them.
 */
function pendingBody(erasesAtLocal: string): string {
  return `
    <p>Your data is due to be erased on <strong>${escapeHtml(erasesAtLocal)}</strong>.</p>
    <p>Until then nothing has changed — you're still in your squads and your answers still stand. If you didn't ask for this, or you've changed your mind, stop it here.</p>
    <form method="post" action="${escapeHtml(DELETE_ACCOUNT_CANCEL_PATH)}">
      <button class="button primary" type="submit">Keep my account</button>
    </form>
  `;
}

/**
 * The state the page had no words for until the final review: the date has
 * arrived and the erasure has not run (§6).
 *
 * The `pending` body asserts a future date and "until then nothing has
 * changed". Both go stale the moment the deadline passes, and a blocked
 * erasure can sit unfulfilled for weeks — so that page told the player,
 * forever, that their data was due to be erased on a Wednesday that was three
 * weeks ago, with nothing naming the game that was actually holding it up.
 *
 * Selected on the date rather than on the blocked marker, deliberately: the
 * date passing is what makes the old copy false, whatever the reason, so this
 * state also covers "the sweep has not come round yet" and "an erasure that
 * threw last hour". The games list is what distinguishes them, and it is read
 * live rather than out of the audit payload, so a handover done ten seconds
 * ago is reflected here.
 *
 * `started` removes the cancel button rather than disabling it, for
 * `soleOrganiserBody`'s reason: there is nothing to press, and a control that
 * exists but refuses invites the press.
 */
function heldUpBody(
  erasesAtLocal: string,
  blockingGames: readonly { gameId: string; gameName: string }[],
  started: boolean,
): string {
  const items = blockingGames
    .map(
      (game) =>
        `<li><a href="${escapeHtml(gamePath(game.gameId))}">${escapeHtml(game.gameName)}</a></li>`,
    )
    .join("");

  const why =
    blockingGames.length > 0
      ? `
    <p>Each of these games needs an organiser, and you're the only one it has:</p>
    <ul>${items}</ul>
    <p>Make someone else an organiser and it will go ahead by itself, within the hour. Nothing else will start it.</p>`
      : `<p>It runs on the hour, so it should happen shortly on its own. You don't need to do anything.</p>`;

  const ending = started
    ? `<p>It has already begun. You've been taken out of some or all of your squads, and the places you'd given up have gone to whoever was waiting for them — that part can't be undone, so this can't be stopped now. It will finish once the way is clear.</p>`
    : `
    <form method="post" action="${escapeHtml(DELETE_ACCOUNT_CANCEL_PATH)}">
      <button class="button primary" type="submit">Keep my account</button>
    </form>`;

  return `
    <p>Your data was due to be erased on <strong>${escapeHtml(erasesAtLocal)}</strong>, and it hasn't happened yet.</p>
    ${why}
    ${ending}
  `;
}

/**
 * On every state, without exception.
 *
 * An organiser who wants to help a player out of the app will go looking for
 * a control to do it with, and not finding one reads as an oversight unless
 * the page says otherwise. It is not an oversight: both routes act on
 * `c.get("player")!.id` and take no player id from a path, a query string or a
 * form body, so there is no way to name somebody else. Saying so here is what
 * stops the missing control from being reported as a bug — and stops anyone
 * from asking support to do it for them, which is equally impossible.
 */
const ON_NOBODY_ELSE_S_BEHALF = `
  <p class="nudge">Only you can start or stop this. An organiser can't do it for you, and neither can we — there's no control anywhere that names somebody else.</p>
`;

/**
 * The page, in whichever of its four states the route decided on.
 *
 * The player's own name is on every state, not as a greeting: this page acts
 * on the session's player and on nothing else, so knowing *which* account is
 * about to be erased is the only check a person can make before pressing the
 * button. A shared device, or a second address for the same person, makes that
 * a real question rather than a rhetorical one.
 */
export function renderDeleteAccountPage(params: DeleteAccountPageParams): string {
  const { state } = params;

  const body = `
    <h1>Delete my data</h1>
    <p>You're signed in as ${escapeHtml(params.playerName)}.</p>
    ${params.problem === undefined ? "" : `<p class="nudge">${escapeHtml(params.problem)}</p>`}
    ${
      state === "offer"
        ? offerBody()
        : state === "sole-organiser"
          ? soleOrganiserBody(params.blockingGames ?? [])
          : state === "held-up"
            ? heldUpBody(
                params.erasesAtLocal ?? "",
                params.blockingGames ?? [],
                params.started ?? false,
              )
            : pendingBody(params.erasesAtLocal ?? "")
    }
    ${ON_NOBODY_ELSE_S_BEHALF}
    <p class="back-link"><a href="${escapeHtml(DASHBOARD_PATH)}">Back to your games</a></p>
  `;

  return layout({
    title: `Delete my data — Make The Team`,
    body,
    // `FIXTURE_STYLES_CSS` is here for `.back-link` alone (§2.5), the same way
    // `src/views/game-overview.ts` and `src/views/leave.ts` carry it: without
    // the block the class is inert and the link butts against the paragraph
    // above it. Every other selector in that block is a class this page never
    // renders, so nothing already here changes appearance.
    pageStyles: [FORM_CSS, FIXTURE_STYLES_CSS],
  });
}
