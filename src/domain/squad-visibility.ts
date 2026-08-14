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
