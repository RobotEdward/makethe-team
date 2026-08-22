/**
 * Who may pick the teams for one fixture (M29), answered in one place so the
 * picker page, the two POST handlers and the organiser's own fixture page
 * cannot disagree about it.
 *
 * The organiser can always pick. On top of that a fixture carries a *mode*
 * naming who else may:
 *
 *   - `organiser` — nobody else. The pre-M29 behaviour, and the default, so a
 *     fixture that existed before this milestone behaves exactly as it did.
 *   - `delegate` — one named squad member, `fixtures.teamPickerPlayerId`.
 *   - `open` — any active member of the game.
 *
 * The mode is on `fixtures` rather than `games` because delegation is about
 * one week: "Ali is picking on Thursday because I'm away" is the request, and
 * a game-level setting would keep handing Thursday's job to Ali for the rest
 * of the season.
 *
 * **Entitlement is never derived from these predicates alone.** They answer
 * "does the mode allow this player?"; the caller has separately established
 * that the player is an *active member of this game* through
 * `loadPickerTarget` (`src/routes/games.ts`). Splitting it that way is what
 * lets a delegate who leaves the squad stop passing immediately, with no
 * sweep over fixtures to clear the pointer they left behind.
 */

/** The three answers to "who, besides the organiser, may pick?" (M29). */
export const PICKER_MODES = ["organiser", "delegate", "open"] as const;

export type PickerMode = (typeof PICKER_MODES)[number];

/** The mode a fixture has until an organiser says otherwise. */
export const INITIAL_PICKER_MODE: PickerMode = "organiser";

export function isPickerMode(value: unknown): value is PickerMode {
  return typeof value === "string" && (PICKER_MODES as readonly string[]).includes(value);
}

/** The columns every question here reads. */
export interface PickerDelegation {
  pickerMode: PickerMode;
  teamPickerPlayerId: string | null;
}

/**
 * The mode as it should be *read*, which is not always the mode as stored.
 *
 * `delegate` with no `teamPickerPlayerId` names nobody, and reading it
 * literally would be a mode that grants the picker to a player id of `null`.
 * The setter writes both columns in one statement so the pair cannot
 * legitimately disagree — this is the reader declining to depend on that,
 * because the columns have no CHECK constraint behind them and the TypeScript
 * type is a claim about the schema rather than a guarantee about the rows.
 *
 * `undefined` is folded in for the same reason `src/db/schema.ts` warns about
 * elsewhere: a stored value indexing a lookup can be a value the enum never
 * listed, and `escapeHtml(undefined)` 500s the page it reaches.
 */
export function effectiveMode(delegation: PickerDelegation): PickerMode {
  const mode = isPickerMode(delegation.pickerMode) ? delegation.pickerMode : INITIAL_PICKER_MODE;
  if (mode === "delegate" && delegation.teamPickerPlayerId === null) return INITIAL_PICKER_MODE;
  return mode;
}

/**
 * May this active member pick the teams, given the fixture's mode?
 *
 * The owner is not asked about here — `loadPickerTarget` short-circuits for
 * them, because an owner's entitlement comes from `findGameForOwner` and has
 * nothing to do with what mode the fixture is in.
 */
export function mayPick(delegation: PickerDelegation, playerId: string): boolean {
  const mode = effectiveMode(delegation);
  if (mode === "open") return true;
  return mode === "delegate" && delegation.teamPickerPlayerId === playerId;
}

/**
 * May this non-owner picker *announce* the teams, emailing the whole squad?
 *
 * Stricter than `mayPick`, and only in `open` mode: the first announcement is
 * anybody's, every later one is the organiser's or the delegate's. Without
 * this any member could mail the squad a fresh set of teams as often as they
 * liked, and the squad would have no way to tell which message was the real
 * one. Saving stays open after publication — the picker page says in words
 * that the organiser announces changes from then on — so a member who spots a
 * mistake can still fix the pick itself.
 *
 * `teamsPublishedAt` and not `teamsSavedAt`: the question is whether an
 * announcement has ever gone out, which is exactly what that column was
 * separated out to answer (see its comment in `src/db/schema.ts`).
 */
export function mayPublish(
  delegation: PickerDelegation,
  playerId: string,
  teamsPublishedAt: Date | null,
): boolean {
  if (!mayPick(delegation, playerId)) return false;
  if (effectiveMode(delegation) === "open") return teamsPublishedAt === null;
  return true;
}
