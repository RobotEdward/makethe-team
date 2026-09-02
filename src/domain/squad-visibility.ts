import type { SquadMember } from "../db/queries.js";

/**
 * The squad this viewer may see, or `null` for "counts only" (BR-33).
 *
 * An Owner always sees the full list — they are managing the fixture, and the
 * setting is theirs. A player sees it when their game allows it.
 *
 * **This is the only place that decides.** The pages that call it carry no
 * policy of their own: they render a list, or they render counts. A boolean
 * tested at three call sites is how one of them ends up testing it the wrong
 * way round.
 *
 * `null` rather than an empty array, deliberately: an empty list renders as
 * "nobody is playing", which is a different and false statement.
 *
 * A viewer's own response is never routed through here — it is rendered from
 * their own row, so it survives a `null` (§3.1).
 */
export function squadForViewer(
  game: { squadVisibleToPlayers: boolean },
  squad: readonly SquadMember[],
  viewer: { isOwner: boolean },
): readonly SquadMember[] | null {
  if (viewer.isOwner) return squad;
  return game.squadVisibleToPlayers ? squad : null;
}

/**
 * The standings this viewer may see, or `null` for "not for you" (M49, BR-33).
 *
 * The league table names every squad member, so it is a squad list wearing
 * different clothes: an organiser who has turned the squad off has said they
 * do not want their players seeing who else is in it, and a standings table
 * that ignored that would hand back the whole roster — with attendance figures
 * — through the back door.
 *
 * A sibling of `squadForViewer` rather than a boolean read off `game` at each
 * page, for the reason that function's own comment gives: **this module is the
 * only place that decides**, and a condition tested at two call sites is how
 * one of them ends up testing it the wrong way round. Generic in the row type
 * because it decides nothing about the rows — it is the same question, asked
 * of a different list.
 *
 * `null` rather than an empty array, again matching its sibling: an empty
 * table renders as "nobody here has played a game", which is a different
 * statement and usually a false one.
 */
export function standingsForViewer<Row>(
  game: { squadVisibleToPlayers: boolean },
  standings: readonly Row[],
  viewer: { isOwner: boolean },
): readonly Row[] | null {
  if (viewer.isOwner) return standings;
  return game.squadVisibleToPlayers ? standings : null;
}
