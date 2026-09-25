import { escapeHtml } from "./layout.js";

export interface PotmPanelParams {
  open: boolean;
  /** Whether the viewer may vote now: open, and in the electorate. */
  canVote: boolean;
  /** The ballot, the viewer already left out — nobody votes for themselves. */
  candidates: readonly { playerId: string; name: string }[];
  yourVote: string | null;
  /** Already through `formatLocalDateTime` (TR-5). */
  closesLocal: string;
  actionPath: string;
  /** Closed only, and only when enough votes counted to name anybody. */
  winners: { names: readonly string[]; votes: number } | null;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.slice(-1).join("")}`;
}

function renderBallot(params: PotmPanelParams): string {
  const choices = params.candidates
    .map(
      (candidate) =>
        `<label><input type="radio" name="candidateId" value="${escapeHtml(candidate.playerId)}"${candidate.playerId === params.yourVote ? " checked" : ""} required> ${escapeHtml(candidate.name)}</label>`,
    )
    .join("");
  return `
    <form method="post" action="${escapeHtml(params.actionPath)}">
      <fieldset class="potm-choices" aria-label="Player of the match">${choices}</fieldset>
      <button type="submit" class="button">Vote</button>
    </form>`;
}

/**
 * Player of the match (M68), beneath the result on both fixture pages.
 *
 * Secondary to the score by design: its own quiet section after the result
 * card, and once you have voted the ballot folds away behind a disclosure.
 * **No counts are shown while it is open** — only your own choice — so the
 * vote cannot become a bandwagon on whoever is ahead.
 */
export function renderPotmPanel(params: PotmPanelParams): string {
  if (!params.open) {
    if (params.winners === null) return "";
    const noun = params.winners.names.length === 1 ? "Player of the match" : "Players of the match";
    const votes = `${params.winners.votes} ${params.winners.votes === 1 ? "vote" : "votes"}${params.winners.names.length > 1 ? " each" : ""}`;
    return `
    <section class="potm">
      <h2>${noun}</h2>
      <p class="potm-winner">${escapeHtml(joinNames(params.winners.names))}</p>
      <p class="potm-note">${escapeHtml(votes)}</p>
    </section>`;
  }

  if (!params.canVote || params.candidates.length === 0) return "";
  const closes = `<p class="potm-note">Votes are secret until voting closes on ${escapeHtml(params.closesLocal)}.</p>`;
  const chosen = params.candidates.find((candidate) => candidate.playerId === params.yourVote);

  if (chosen === undefined) {
    return `
    <section class="potm">
      <h2>Player of the match</h2>
      <p>Who played best?</p>
      ${renderBallot(params)}
      ${closes}
    </section>`;
  }

  return `
    <section class="potm">
      <h2>Player of the match</h2>
      <p>You voted for <strong>${escapeHtml(chosen.name)}</strong>.</p>
      <details class="potm-change"><summary>Change my vote</summary>${renderBallot(params)}</details>
      ${closes}
    </section>`;
}
