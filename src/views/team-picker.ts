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
 * disabled, and the drag-and-drop enhancement (`TEAM_PICKER_JS`, Task 7)
 * assumes the radios are the source of truth rather than a fallback it has to
 * keep in step with some other state. `test/routes/signin.test.ts` enforces
 * the rule across every page the app serves; this comment records why it
 * matters *here* specifically.
 *
 * What this file gives that script is markup it can find and nothing else: an
 * id on the form, a `data-player` on each row, a `data-team` on each drop
 * list, and two side columns that ship `hidden`. Every one of those is inert
 * with scripting off — a hidden empty column is not an affordance, and an
 * attribute is not behaviour — so the page a person without JavaScript reads
 * is byte-for-byte the page Tasks 1-6 shipped, minus nothing.
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
  /**
   * Whether an announcement has ever gone out for this fixture
   * (`teams_published_at` is set, and nothing ever clears it).
   */
  published: boolean;
  /** From `teamsNeedAnotherLook` — the squad has moved since the pick was made. */
  needsAnotherLook: boolean;
  /** From `announcementOutstanding` — what was sent no longer describes the pick. */
  announcementOutstanding: boolean;
  /** Whether publishing emails the squad for this game (N-9's switch, M26). */
  teamsEmailEnabled: boolean;
  /**
   * Whether this viewer may announce the pick (M29), as opposed to merely
   * save it. False only for a member picking in `open` mode on a fixture
   * whose teams have already gone out — `mayPublish` in
   * `src/domain/picker.ts` holds the rule and the reason.
   *
   * The organiser and a named delegate always pass, so on every page that
   * existed before M29 this is true and the section below is unchanged.
   */
  canPublish: boolean;
  /**
   * The fixture has been played and the organiser is correcting the record
   * (M64). The form stays; the publish control and every sentence about
   * announcing go, because the game the announcement would be about is over.
   */
  correcting?: boolean;
}

/**
 * How a member's name reads on a picker or teams row.
 *
 * `displayName`, never `member.name` — a played fixture keeps its erased
 * participants, so "a former player" on a squad list is a live case, not a
 * theoretical one (BR-34 §4). The guest suffix matches the squad list above
 * it, so the same person reads the same way twice on one page.
 *
 * Exported for the publish route, which lists the players still without a
 * side when it refuses: that list is read *against* these rows, and a refusal
 * naming "Gus Guest" above a row labelled "Gus Guest (guest)" makes an
 * organiser stop and work out whether those are two people.
 */
export function rowName(member: { name: string; erasedAt: Date | null; isGuest: boolean }): string {
  return `${displayName(member.name, member.erasedAt)}${member.isGuest ? " (guest)" : ""}`;
}

/** Saved totals remain useful without the live column enhancement. */
function renderCounts(names: Record<TeamId, string>, counts: { a: number; b: number }): string {
  return `<p class="team-counts" id="team-saved-counts">${TEAM_IDS.map(
    (id) => `<span>${id.toUpperCase()} · ${escapeHtml(names[id])}: ${counts[id]} picked</span>`,
  ).join("")}</p>`;
}

/** The same player rows move between these columns; no duplicate controls. */
function renderColumns(names: Record<TeamId, string>, counts: { a: number; b: number }): string {
  return `<div class="team-columns" id="team-columns" hidden>${TEAM_IDS.map((id) =>
    `<div class="team-column">
      <h3><span class="team-letter">${id.toUpperCase()}</span> ${escapeHtml(names[id])}</h3>
      <p class="team-total"><span data-count="${id}">${counts[id]}</span> picked</p>
      <ul class="teams team-drop" data-team="${id}" aria-label="${escapeHtml(names[id])}"></ul>
    </div>`,
  ).join("")}</div>`;
}

/**
 * "Randomise teams", shipped `hidden` like the columns above it.
 *
 * `TEAM_PICKER_JS` reveals it and wires the click: a shuffle that sets the
 * radios through the same `place` the drag and the radios use, so the form
 * posts the random pick exactly as it posts a hand-made one. With scripting
 * off it stays hidden — a button with no handler is not an affordance.
 * `type="button"` so it can never submit the form it sits in; the pick is
 * not saved until Save is pressed, and the test counting submits depends on it.
 */
function renderRandomise(): string {
  return `<button class="button" type="button" id="team-randomise" hidden>Randomise teams</button>`;
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
    `<label aria-label="${escapeHtml(label)}"><input type="radio" name="${group}" value="${escapeHtml(value)}"${
      (member.team ?? "") === value ? " checked" : ""
    }><span aria-hidden="true">${value === "" ? "—" : escapeHtml(value.toUpperCase())}</span></label>`;

  // `data-player` is what the drag-and-drop script identifies a row by. Not
  // `draggable`: that attribute is set by the script, so a browser that never
  // runs it is never offered a gesture that would do nothing.
  return `<li data-player="${group}">
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
 *
 * **The two states must never be indistinguishable.** "Publish teams" means
 * nobody has ever been told; "Publish again" means somebody has. That is why
 * `published` reads a column nothing clears — an earlier version cleared it on
 * every save, so an organiser who published and then swapped two players got
 * the never-published page verbatim, no prompt and all, while the squad held
 * the previous email.
 */
function renderPublish(params: TeamPickerParams): string {
  const { gameId, fixtureId, members, published, needsAnotherLook } = params;

  const anyPick = published || needsAnotherLook || members.some((member) => member.team !== null);
  if (!anyPick) return "";

  // A member picking in `open` mode after the teams have gone out keeps the
  // form above — a wrong side is worth fixing by whoever spots it — and loses
  // only the button that mails the squad. Said in words rather than by
  // rendering nothing: a Save button with no Publish beside it, on a page
  // that had both a moment ago, reads as something broken.
  // Said in words for the same reason as the member case below: a Save
  // button on its own where Publish used to be reads as something missing.
  if (params.correcting) {
    return `<p class="team-note">The game has been played, so there is nothing to announce. What you save here is the record of who played on which side.</p>`;
  }

  if (!params.canPublish) {
    return `<p class="team-note">These teams have been sent out. A change you save here shows on everyone's page straight away, but only the organiser can send the squad a fresh message about it.</p>`;
  }

  // Two different worlds, and only one of them has ever sent anything — so the
  // prompt says which one it is rather than telling an organiser their teams
  // "changed since they were sent out" when nobody has been sent anything at
  // all. Published: the prompt is `announcementOutstanding`, which covers both
  // a save made after the announcement and a roster that has moved under it.
  // Not published: only the roster question can arise.
  const prompt = published
    ? params.announcementOutstanding
      ? `<p class="team-note">The teams have changed since they were last sent out. Send them again?</p>`
      : ""
    : needsAnotherLook
      ? `<p class="team-note">The squad has changed since you started picking. Worth another look before you publish.</p>`
      : "";

  // With N-9 switched off (M26) publishing sends nothing, so the two prompts
  // above — both of which offer to send the teams out again — describe an act
  // this game does not perform. Said once, under the button, rather than by
  // rewording each prompt: the button still does something worth doing, and
  // what changes is only who hears about it.
  const emailNote = params.teamsEmailEnabled
    ? ""
    : `<p class="team-note">Email is off for this game, so publishing shows the teams on players' pages without sending anything.</p>`;

  return `${prompt}${emailNote}
          <form method="post" action="${escapeHtml(ownerTeamsPublishPath(gameId, fixtureId))}" id="team-publish">
            <button class="button primary" type="submit">${published ? "Publish again" : "Publish teams"}</button>
          </form>`;
}

/**
 * The picker, for a fixture that is still taking changes.
 *
 * Saving sends nothing to anybody — publishing is a separate act, in its own
 * form below — so there is no confirmation step on the save and no warning
 * about interrupting anyone. A saved pick stays invisible to players until
 * the fixture is first published; after that, every save is live on their
 * pages straight away, while the email they already hold is unchanged —
 * which is exactly what the re-publish prompt above is for.
 *
 * The list of rows carries `data-team=""` because it is the third drop target
 * once the script runs: the players nobody has placed. That is the same value
 * as the "Not picked yet" radio, so a name dragged out of a side and a name
 * whose radio was cleared end up in the same state — the gesture can reach
 * every placement the form can, in both directions.
 *
 * It carries `team-drop` for the same reason the columns do, and that class is
 * load-bearing rather than decorative: it is what gives an emptied list a
 * height. Without it, dragging the last name into a column collapsed the pool
 * to nothing and left no target to drag anybody back onto — the undo existed
 * in the markup and not on the screen.
 *
 * **"Save teams" is the outlined default, not `.button.primary` (M12 §2.2).**
 * `renderPublish` below renders a filled button of its own on every fixture
 * where a pick has been started or published, and both forms are on screen at
 * once — so a filled Save put two filled accent buttons on one page, with
 * nothing saying which one mattered. Publish is the one that keeps the fill:
 * it is the act with a consequence off this page, since it emails the whole
 * squad and cannot be taken back, while saving tells nobody anything and can
 * be repeated. Demoting Publish instead would leave the quiet button as the
 * one that messages everyone.
 */
export function renderTeamPicker(params: TeamPickerParams): string {
  const { gameId, fixtureId, names, members, counts, uneven, unassignedProblem } = params;

  if (members.length === 0) {
    return `<section class="team-workspace" aria-labelledby="team-heading"><h2 id="team-heading">Teams</h2>
            <p class="muted">Nobody is in yet, so there is nobody to put on a side.</p></section>`;
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

  return `<section class="team-workspace" aria-labelledby="team-heading">
          <h2 id="team-heading">Teams</h2>
          <p class="team-note">Move players between sides until you’re happy with the balance. A and B match the team headings; — leaves a player unpicked.</p>
          <p class="team-note">${params.correcting
            ? "Saving changes updates the teams on players’ pages and in the game’s history."
            : params.published
              ? params.canPublish
                ? "Saving changes updates the teams on players’ pages. Publish again to announce the saved teams."
                : "Saving changes updates the teams on players’ pages. Only the organiser can send a fresh message about them."
              : "Save your progress as often as you like. Players see the teams once you publish."}</p>
          ${problem}
          <form method="post" action="${escapeHtml(ownerTeamsPath(gameId, fixtureId))}" id="team-picker">
            ${renderCounts(names, counts)}
            ${unevenNote}
            ${renderColumns(names, counts)}
            <h3 class="team-pool-heading" id="team-pool-heading">Players</h3>
            <ul class="teams team-drop" id="team-pool" data-team="">${members.map((member) => renderRow(member, names)).join("")}</ul>
            <p class="team-draft-status" id="team-draft-status" role="status" aria-live="polite">Save changes before publishing. Publishing uses the saved teams.</p>
            <div class="team-actions">
              ${renderRandomise()}
              <button class="button" type="submit">Save teams</button>
            </div>
          </form>
          ${renderPublish(params)}</section>`;
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
  return `<h2>Teams</h2>${renderTeamSides(names, members)}`;
}

/**
 * Both sides, named and counted, with no heading of their own.
 *
 * Split out of `renderTeamsReadOnly` above so the player-facing pages
 * (`renderPublishedTeamsSection` in `src/views/fixture.ts`) can put the
 * viewer's own side *between* the heading and the line-ups without owning a
 * second copy of how a line-up looks. One renderer means an organiser
 * reviewing a finished pick and a player reading the same pick see the same
 * markup — which is the point, since the player is checking it against an
 * email built from the same rows.
 *
 * `members` is expected to be already filtered to the players who should
 * appear (`in`, with a side); this function only groups them.
 */
export function renderTeamSides(
  names: Record<TeamId, string>,
  members: TeamPickerParams["members"],
): string {
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

  return TEAM_IDS.map(side).join("");
}
