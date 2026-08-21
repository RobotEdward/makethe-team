import type { DerivedResult, OutcomeCandidate, ResultOutcome } from "../domain/result.js";
import { MAX_SCORE } from "../domain/result.js";
import { escapeHtml } from "./layout.js";

/**
 * What this game calls each of the three things that can have happened.
 *
 * `draw` is not a side, so it takes a fixed word — the game names its two
 * teams, not the absence of a winner.
 */
export function outcomeNames(game: {
  teamAName: string;
  teamBName: string;
}): Record<ResultOutcome, string> {
  return { a: game.teamAName, b: game.teamBName, draw: "Draw" };
}

/**
 * The words for one stored outcome, or null when this build has none.
 *
 * `fixture_result_claims.outcome` is a bare `text NOT NULL` with no CHECK
 * constraint, so a row can carry a value the union says is impossible;
 * indexing the record would then yield `undefined`, and `escapeHtml(undefined)`
 * calls `.replace` on it and 500s the page. Callers branch on null and say
 * nothing rather than guessing — a result this build cannot name is one it
 * cannot announce.
 */
export function outcomeLabel(
  names: Record<ResultOutcome, string>,
  outcome: ResultOutcome,
): string | null {
  return names[outcome] ?? null;
}

function claimWords(
  names: Record<ResultOutcome, string>,
  outcome: ResultOutcome,
  scoreA: number | null,
  scoreB: number | null,
): string | null {
  const label = outcomeLabel(names, outcome);
  if (label === null) return null;
  if (scoreA === null || scoreB === null) return outcome === "draw" ? "Draw" : `${label} won`;
  // An en dash, matching how every other score-like pair reads in this app.
  const score = `${scoreA}–${scoreB}`;
  return outcome === "draw" ? `Draw ${score}` : `${label} won ${score}`;
}

export interface ResultPanelParams {
  names: Record<ResultOutcome, string>;
  /** From `tally()`, most-backed first. Empty while nobody has filed. */
  candidates: readonly OutcomeCandidate[];
  /** From `deriveResult()`. Non-null whenever anybody has filed. */
  derived: DerivedResult | null;
  locked: boolean;
  writable: boolean;
  /** Whether the viewer may file at all (BR-37 §6). */
  eligible: boolean;
  /** Whether the fixture had published teams for a roster join to reach. */
  rostered: boolean;
  yourPlayerId: string;
  /** Already through `formatLocalDateTime` (TR-5). */
  deadlineLocal: string;
  actionPath: string;
  clearPath: string;
}

function renderAgreeForm(
  params: ResultPanelParams,
  outcome: ResultOutcome,
  scoreA: number | null,
  scoreB: number | null,
): string {
  if (!params.writable || !params.eligible) return "";
  const score =
    scoreA === null || scoreB === null
      ? ""
      : `<input type="hidden" name="scoreA" value="${escapeHtml(String(scoreA))}">
         <input type="hidden" name="scoreB" value="${escapeHtml(String(scoreB))}">`;
  return `
    <form method="post" action="${escapeHtml(params.actionPath)}">
      <input type="hidden" name="outcome" value="${escapeHtml(outcome)}">
      ${score}
      <button type="submit" class="button">Agree</button>
    </form>
  `;
}

function renderRow(
  params: ResultPanelParams,
  outcome: ResultOutcome,
  scoreA: number | null,
  scoreB: number | null,
  backers: readonly string[],
): string {
  const words = claimWords(params.names, outcome, scoreA, scoreB);
  if (words === null) return "";
  const yours = backers.includes(params.yourPlayerId)
    ? `<span class="result-yours">your pick</span>`
    : "";
  return `
    <li class="result-candidate">
      <span class="result-claim">${escapeHtml(words)}</span>
      <span class="result-backers">${escapeHtml(String(backers.length))} ${backers.length === 1 ? "backer" : "backers"}</span>
      ${yours}
      ${renderAgreeForm(params, outcome, scoreA, scoreB)}
    </li>
  `;
}

function renderCandidates(params: ResultPanelParams): string {
  const rows = params.candidates
    .flatMap((candidate) => [
      ...candidate.scores.map((score) =>
        renderRow(params, candidate.outcome, score.scoreA, score.scoreB, score.backers),
      ),
      candidate.unscoredBackers > 0
        ? renderRow(
            params,
            candidate.outcome,
            null,
            null,
            candidate.backers.filter(
              (backer) => !candidate.scores.some((score) => score.backers.includes(backer)),
            ),
          )
        : "",
    ])
    .join("");
  return rows === "" ? "" : `<ul class="result-candidates">${rows}</ul>`;
}

function renderFileForm(params: ResultPanelParams): string {
  if (!params.writable || !params.eligible) return "";
  const options = (["a", "b", "draw"] as const)
    .map((outcome) => {
      const label = outcomeLabel(params.names, outcome);
      if (label === null) return "";
      const words = outcome === "draw" ? "Draw" : `${label} won`;
      return `<label><input type="radio" name="outcome" value="${escapeHtml(outcome)}"> ${escapeHtml(words)}</label>`;
    })
    .join("");

  return `
    <form method="post" action="${escapeHtml(params.actionPath)}">
      <h3>What happened?</h3>
      <div class="result-score">
        <label>${escapeHtml(params.names.a)}
          <input type="number" name="scoreA" min="0" max="${escapeHtml(String(MAX_SCORE))}" inputmode="numeric">
        </label>
        <label>${escapeHtml(params.names.b)}
          <input type="number" name="scoreB" min="0" max="${escapeHtml(String(MAX_SCORE))}" inputmode="numeric">
        </label>
      </div>
      <p class="result-note">Or, if nobody remembers the score, just say who won:</p>
      ${options}
      <p><button type="submit" class="button">Record it</button></p>
    </form>
  `;
}

function renderClearForm(params: ResultPanelParams): string {
  const youFiled = params.candidates.some((candidate) =>
    candidate.backers.includes(params.yourPlayerId),
  );
  if (!params.writable || !params.eligible || !youFiled) return "";
  return `
    <form method="post" action="${escapeHtml(params.clearPath)}">
      <button type="submit" class="danger-link">Withdraw my answer</button>
    </form>
  `;
}

function renderLocked(params: ResultPanelParams): string {
  const derived = params.derived;
  if (derived === null) return "";
  const words = claimWords(params.names, derived.outcome, derived.scoreA, derived.scoreB);
  if (words === null) return `<p class="result-note">This fixture's result can't be shown.</p>`;

  const margin =
    derived.scoreA === null
      ? `<p class="result-confidence">Score not agreed.</p>`
      : `<p class="result-confidence">Score ${escapeHtml(String(derived.marginBackers))} of ${escapeHtml(String(derived.voterCount))}</p>`;

  const unrostered = params.rostered
    ? ""
    : `<p class="result-note">Teams weren't picked in the app for this fixture, so we don't know who played on which side.</p>`;

  return `
    <p class="result-final">${escapeHtml(words)}</p>
    <p class="result-confidence">Result ${escapeHtml(String(derived.outcomeBackers))} of ${escapeHtml(String(derived.voterCount))}</p>
    ${margin}
    ${unrostered}
  `;
}

/**
 * The result of one played fixture (BR-37), for both the player fixture page
 * and the organiser's.
 *
 * Three states, and the third is not an error: a fixture whose window has
 * passed with nothing filed is still writable, because there was nothing to
 * lock (`isResultLocked`). It says so and keeps the form.
 *
 * The deadline line renders whenever the panel is writable, whether or not a
 * candidate exists yet — someone who has just been nudged to file is opening
 * an empty panel and is exactly who needs to see how long the window stays
 * open.
 */
export function renderResultPanel(params: ResultPanelParams): string {
  if (params.locked) {
    return `<section><h2>Result</h2>${renderLocked(params)}</section>`;
  }

  const nothingYet =
    params.candidates.length === 0 ? `<p class="result-note">No result recorded yet.</p>` : "";
  const deadline = params.writable
    ? `<p class="result-note">Locks ${escapeHtml(params.deadlineLocal)}.</p>`
    : "";

  return `
    <section>
      <h2>Result</h2>
      ${nothingYet}
      ${deadline}
      ${renderCandidates(params)}
      ${renderFileForm(params)}
      ${renderClearForm(params)}
    </section>
  `;
}
