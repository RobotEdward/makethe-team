import { MUTE_DURATIONS } from "../domain/mute.js";
import { escapeHtml } from "./layout.js";

/**
 * Whether the switch is on, and until when. `untilLocal` is already formatted
 * in the game's timezone by the caller (TR-5) and is `null` for a mute with no
 * end date — never for a mute that is off, which is the other variant.
 */
export type MuteState = { muted: false } | { muted: true; untilLocal: string | null };

export interface MuteControlsOptions {
  /** Where "turn it on" posts. */
  muteAction: string;
  /** Where "turn it off" posts. */
  unmuteAction: string;
  state: MuteState;
  /**
   * The squad the switch acts on, named in the copy. Omitted where the page is
   * already about one game and "this squad" can only mean that one; supplied
   * by the dashboard, which is about all of them and where an unqualified
   * "this squad" would name nothing.
   */
  squadName?: string;
  /**
   * Where the routes behind the form send the reader afterwards. A closed set,
   * never a URL: the field reaches the route from a form body, and a body that
   * could carry a destination is an open redirect.
   */
  returnTo?: "dashboard";
  /**
   * How many *other* active squads this player is in. Zero hides the
   * "all my games" checkbox entirely: an option that can only ever mean the
   * one squad already being acted on is a control with no effect, and the
   * count is what makes the phrase concrete enough to tick safely.
   */
  otherGamesCount: number;
}

/**
 * The player's auto-decline panel (M28), shared by the token fixture page, the
 * signed-in fixture page and the game page.
 *
 * One partial rather than three, for the reason `renderResponseButtons` is
 * shared: these pages are the same promise seen from three routes, and a
 * setting whose wording or whose duration list differed between them would
 * read as three different features.
 *
 * It renders **only** the switch. Neither the confirmation of a response nor
 * the "you're in for this one, still auto-declining later games" line belongs
 * here — those are about a fixture, and this panel is about a squad.
 */
export function renderMuteControls(options: MuteControlsOptions): string {
  return options.state.muted
    ? renderOn(options, options.state.untilLocal)
    : renderOff(options);
}

/**
 * The squad as the copy names it — its name where the caller gave one, the
 * bare "this squad" where the page itself has already established which.
 */
function squadPhrase(options: MuteControlsOptions): string {
  return options.squadName === undefined ? "this squad" : escapeHtml(options.squadName);
}

/**
 * The hidden field naming where the route redirects, or nothing. See
 * `returnTo`: the value is an enum the route matches, not a path it follows.
 */
function renderReturnTo(options: MuteControlsOptions): string {
  return options.returnTo === undefined
    ? ""
    : `<input type="hidden" name="from" value="${escapeHtml(options.returnTo)}">`;
}

function renderOff(options: MuteControlsOptions): string {
  const radios = MUTE_DURATIONS.map((duration) => {
    const id = `mute-${duration.value}`;
    return `
        <label for="${id}">
          <input id="${id}" type="radio" name="duration" value="${duration.value}"${
            duration.value === "4w" ? " checked" : ""
          }>
          ${escapeHtml(duration.label)}
        </label>`;
  }).join("");

  return `
    <details class="mute">
      <summary>Can't play for a while?</summary>
      <div class="mute-panel">
        <p>We'll mark you as out automatically and stop sending you anything about ${squadPhrase(options)}. You can still say yes to any game whenever you want — accepting one doesn't switch this back off.</p>
        <form method="post" action="${escapeHtml(options.muteAction)}">
          ${renderReturnTo(options)}
          <fieldset class="mute-durations">
            <legend class="mute-legend">Auto-decline for</legend>
            ${radios}
          </fieldset>
          ${renderAllGamesCheckbox(options.otherGamesCount, "Do this for my other squads too")}
          <button type="submit" class="button">Turn on auto-decline</button>
        </form>
      </div>
    </details>`;
}

function renderOn(options: MuteControlsOptions, untilLocal: string | null): string {
  const until =
    untilLocal === null
      ? `You're auto-declining ${squadPhrase(options)} until you turn it back on.`
      : `You're auto-declining ${squadPhrase(options)} until ${escapeHtml(untilLocal)}.`;

  return `
    <div class="mute-on">
      <p>${until} You can still say yes to any game.</p>
      <form method="post" action="${escapeHtml(options.unmuteAction)}">
        ${renderReturnTo(options)}
        ${renderAllGamesCheckbox(options.otherGamesCount, "Turn it off for my other squads too")}
        <button type="submit" class="button">Turn auto-decline off</button>
      </form>
    </div>`;
}

function renderAllGamesCheckbox(otherGamesCount: number, label: string): string {
  if (otherGamesCount === 0) return "";
  const squads = otherGamesCount === 1 ? "1 other squad" : `${otherGamesCount} other squads`;
  return `
          <div class="switch-row">
            <label for="all-games">${escapeHtml(label)}</label>
            <input id="all-games" name="all-games" type="checkbox" value="on">
            <span class="hint">You're in ${escapeHtml(squads)}.</span>
          </div>`;
}
