import { ownerTeamsPath, ownerTeamsPublishPath } from "../auth/paths.js";
import { displayName } from "../domain/display-name.js";
import { TEAM_IDS, type TeamId } from "../domain/teams.js";
import { escapeHtml } from "./layout.js";

/**
 * The team picker (BR-35 §4), as a fragment the owner's fixture page embeds
 * rather than a page of its own.
 *
 * A fragment because picking sides is something an organiser does *while*
 * looking at the squad — who is in, who arrived late, who is waitlisted —
 * and a separate page would put a navigation step between the list and the
 * decision the list informs.
 *
 * **No `<script>` and no inline event handlers anywhere in here.** Every row
 * is a radio group inside one form, so the picker works with JavaScript
 * disabled, and the drag-and-drop enhancement added later can assume the
 * radios are the source of truth rather than a fallback it has to keep in
 * step with some other state. `test/routes/signin.test.ts` enforces the rule
 * across every page the app serves; this comment records why it matters
 * *here* specifically.
 *
 * Only `in` players are offered a side. A waitlisted player has no place in
 * the fixture yet, and putting them on a team would promise one.
 */
export interface TeamPickerParams {
  gameId: string;
  fixtureId: string;
  /** From `teamNames(game)` — the labels for the two columns. */
  names: Record<TeamId, string>;
  /** Only `in` players, in the order the squad list shows them. */
  members: readonly { playerId: string; name: string; erasedAt: Date | null; isGuest: boolean; team: TeamId | null }[];
  counts: { a: number; b: number };
  /** True when the game prefers even numbers and the sides are uneven. */
  uneven: boolean;
  /** Set when a publish was refused: the names with no side yet. */
  unassignedProblem?: readonly string[];
  /** Whether a publish is on record for this fixture (`teams_published_at` is set). */
  published: boolean;
  /** From `teamsNeedAnotherLook` — the squad has moved since the pick was made. */
  needsAnotherLook: boolean;
}

/**
 * How a member's name reads on a picker or teams row.
 *
 * `displayName`, never `member.name` — a played fixture keeps its erased
 * participants, so "a former player" on a squad list is a live case, not a
 * theoretical one (BR-34 §4). The guest suffix matches the squad list above
 * it, so the same person reads the same way twice on one page.
 */
function rowName(member: { name: string; erasedAt: Date | null; isGuest: boolean }): string {
  return `${displayName(member.name, member.erasedAt)}${member.isGuest ? " (guest)" : ""}`;
}

/** Both sides' names with their current head count, above the rows. */
function renderCounts(names: Record<TeamId, string>, counts: { a: number; b: number }): string {
  const sides = TEAM_IDS.map(
    (id) => `<span>${escapeHtml(names[id])} <span class="count">${counts[id]}</span></span>`,
  ).join("");
  return `<p class="team-counts">${sides}</p>`;
}

/**
 * One member's row: their name, and a radio group named exactly their player
 * id.
 *
 * Three choices, not two. The empty-valued "Not picked yet" radio is what
 * makes a partial pick expressible without JavaScript — an organiser who has
 * placed six of fourteen players must be able to save and come back, and
 * with only two radios there would be no way to *undo* a placement once made
 * (a radio group cannot be unset by clicking it again). The route reads `""`
 * as "clear this player's side".
 */
function renderRow(member: TeamPickerParams["members"][number], names: Record<TeamId, string>): string {
  const group = escapeHtml(member.playerId);
  const choice = (value: string, label: string) =>
    `<label><input type="radio" name="${group}" value="${escapeHtml(value)}"${
      (member.team ?? "") === value ? " checked" : ""
    }>${escapeHtml(label)}</label>`;

  return `<li>
            <fieldset>
              <legend>${escapeHtml(rowName(member))}</legend>
              <span class="sides">
                ${TEAM_IDS.map((id) => choice(id, names[id])).join("")}
                ${choice("", "Not picked yet")}
              </span>
            </fieldset>
          </li>`;
}

/**
 * Publishing: its own form, below the picker's, and never a second button
 * inside it.
 *
 * Two forms because they are two acts. Publishing emails the whole squad and
 * cannot be taken back, and a submit button sharing the picker's form would
 * announce whatever half-finished state the radios happened to be in — which
 * is also why it posts nothing but the path: the sides being published are
 * the ones already saved, not the ones currently on screen. An organiser who
 * has moved a radio without saving must press Save first, and sees the same
 * teams the email will describe.
 *
 * Shown only when there is something to publish — a pick has been started, or
 * one was published before. On a fixture nobody has picked, a Publish button
 * would offer to announce an empty pick that the route would then refuse.
 */
function renderPublish(params: TeamPickerParams): string {
  const { gameId, fixtureId, members, published, needsAnotherLook } = params;

  const anyPick = published || needsAnotherLook || members.some((member) => member.team !== null);
  if (!anyPick) return "";

  // `teamsNeedAnotherLook` is true in two different worlds (see
  // `src/domain/teams.ts`), and only one of them has ever sent anything — so
  // the prompt says which one it is rather than telling an organiser their
  // teams "changed since they were sent out" when nobody has been sent
  // anything at all.
  const prompt = !needsAnotherLook
    ? ""
    : published
      ? `<p class="team-note">The teams have changed since they were last sent out. Send them again?</p>`
      : `<p class="team-note">The squad has changed since you started picking. Worth another look before you publish.</p>`;

  return `${prompt}
          <form method="post" action="${escapeHtml(ownerTeamsPublishPath(gameId, fixtureId))}">
            <button class="button primary" type="submit">${published ? "Publish again" : "Publish teams"}</button>
          </form>`;
}

/**
 * The picker, for a fixture that is still taking changes.
 *
 * Saving sends nothing to anybody — publishing is a separate act, in its own
 * form below — so there is no confirmation step on the save and no warning
 * about interrupting anyone. A saved pick stays invisible to players until it
 * is published.
 */
export function renderTeamPicker(params: TeamPickerParams): string {
  const { gameId, fixtureId, names, members, counts, uneven, unassignedProblem } = params;

  if (members.length === 0) {
    return `<h2>Teams</h2>
            <p class="muted">Nobody is in yet, so there is nobody to put on a side.</p>`;
  }

  // Advisory, never a refusal: BR-29 makes even numbers a preference of the
  // game's, not a rule, and an organiser who knows a fourteenth player is on
  // their way should not be nagged into a shape they are about to change.
  const unevenNote = uneven
    ? `<p class="team-note">The sides are uneven at the moment. That's fine if you meant it.</p>`
    : "";

  const problem =
    unassignedProblem === undefined || unassignedProblem.length === 0
      ? ""
      : `<p class="problem">${escapeHtml(
          `Everyone who's in needs a side before you can publish. Still to pick: ${unassignedProblem.join(", ")}.`,
        )}</p>`;

  return `<h2>Teams</h2>
          <p class="team-note">Only players who are in can be given a side. Nobody is told anything until you publish.</p>
          ${problem}
          <form method="post" action="${escapeHtml(ownerTeamsPath(gameId, fixtureId))}">
            ${renderCounts(names, counts)}
            ${unevenNote}
            <ul class="teams">${members.map((member) => renderRow(member, names)).join("")}</ul>
            <button class="button primary" type="submit">Save teams</button>
          </form>
          ${renderPublish(params)}`;
}

/**
 * The same pick, read-only, for a fixture that has stopped taking changes.
 *
 * The controls go and the record stays — the same rule the squad list above
 * follows on a played or cancelled fixture. `members` is expected to be the
 * players who are *`in` and have a side*: a player who dropped out keeps
 * their `team` value on purpose (see `src/domain/teams.ts`), and listing
 * them under a side on a finished fixture would assert they played when they
 * did not.
 */
export function renderTeamsReadOnly(params: {
  names: Record<TeamId, string>;
  members: TeamPickerParams["members"];
}): string {
  const { names, members } = params;
  if (members.length === 0) return "";

  const side = (id: TeamId) => {
    const onIt = members.filter((member) => member.team === id);
    const list =
      onIt.length === 0
        ? `<p class="muted">Nobody.</p>`
        : `<ul class="squad">${onIt
            .map((member) => `<li><span class="name">${escapeHtml(rowName(member))}</span></li>`)
            .join("")}</ul>`;
    return `<h3>${escapeHtml(names[id])} <span class="count">${onIt.length}</span></h3>${list}`;
  };

  return `<h2>Teams</h2>${TEAM_IDS.map(side).join("")}`;
}
