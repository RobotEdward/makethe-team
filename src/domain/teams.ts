/**
 * Every question about a fixture's teams, answered in one place, so the
 * picker, the publish guard, the player-facing view and the notification
 * email cannot disagree about what "the teams" currently are.
 *
 * `responses.team` is set once, when an organiser picks sides, and is
 * **deliberately never cleared** when a player's status moves away from
 * `in` — not by a player leaving (M7a), not by an organiser removing them
 * (J6a), not by erasure (M7b). All three of those write `status =
 * "withdrawn"` and leave `team` exactly as it was. That orphaned value is
 * the only signal that a published side no longer matches who is actually
 * playing, so clearing it anywhere would destroy the evidence this module
 * exists to read. It also means a player who drops out and rejoins lands
 * back on their old side with no special case.
 *
 * Consequently there are exactly two ways the published teams can go stale
 * relative to the current squad:
 *
 *   1. Someone is `in` with no side — a waitlist promotion or a new guest
 *      arrived after the pick was made.
 *   2. Someone still has a side (`team` is set) but is no longer `in` — the
 *      ordinary drop-out (`status = "out"`), or the far more common
 *      `"withdrawn"` case above, which a query filtered to exclude
 *      `withdrawn` rows would never surface.
 *
 * Every function here is a pure predicate over `TeamAssignment[]` — no
 * database, no clock. Callers that need the unfiltered row set (i.e.
 * including `withdrawn`) get it from `listTeamAssignments` in
 * `src/db/queries.ts`, never from `getFixtureWithSquad`, which filters
 * `withdrawn` out and so cannot answer condition 2 correctly.
 */
import type { ResponseStatus } from "./response-status.js";

/** The two sides a player can be placed on (BR-35, M9). */
export const TEAM_IDS = ["a", "b"] as const;

export type TeamId = (typeof TEAM_IDS)[number];

export function isTeamId(value: unknown): value is TeamId {
  return typeof value === "string" && (TEAM_IDS as readonly string[]).includes(value);
}

/** The minimum a staleness or counting question needs about one response row. */
export interface TeamAssignment {
  playerId: string;
  status: ResponseStatus;
  team: TeamId | null;
}

/** Condition 1: players who are `in` but have not been placed on a side. */
export function unassignedIn(rows: readonly TeamAssignment[]): readonly TeamAssignment[] {
  return rows.filter((r) => r.status === "in" && r.team === null);
}

/** Condition 2: players who still carry a side but are no longer `in`. */
export function assignedButNotIn(rows: readonly TeamAssignment[]): readonly TeamAssignment[] {
  return rows.filter((r) => r.team !== null && r.status !== "in");
}

/**
 * Whether the published (or in-progress) teams no longer reflect the squad
 * — see the module doc comment for the two conditions this checks.
 *
 * Condition 1 (someone `in` with no side) only counts once a pick has
 * actually been started — i.e. at least one row has a `team` at all. A
 * fixture where nobody has ever been assigned a side is not "stale", it is
 * simply unpicked, and flagging every unpicked fixture this way would make
 * the signal meaningless. Condition 2 needs no such gate: an
 * `assignedButNotIn` row is itself proof a pick was made.
 */
export function teamsNeedAnotherLook(rows: readonly TeamAssignment[]): boolean {
  if (assignedButNotIn(rows).length > 0) return true;
  const pickStarted = rows.some((r) => r.team !== null);
  return pickStarted && unassignedIn(rows).length > 0;
}

/**
 * How many players are currently `in` on each side.
 *
 * Only `in` rows count. A withdrawn or dropped-out player keeps their
 * `team` value (see module doc comment), so counting every non-null `team`
 * would report a side one player bigger than actually turns up.
 */
export function sideCounts(rows: readonly TeamAssignment[]): { a: number; b: number } {
  const inRows = rows.filter((r) => r.status === "in");
  return {
    a: inRows.filter((r) => r.team === "a").length,
    b: inRows.filter((r) => r.team === "b").length,
  };
}

/** The game's chosen name for each side, keyed by `TeamId`. */
export function teamNames(game: { teamAName: string; teamBName: string }): Record<TeamId, string> {
  return { a: game.teamAName, b: game.teamBName };
}

/**
 * What a player-facing page may say about the teams, or `null` for "say
 * nothing at all".
 *
 * `null` is the unpublished case and it is deliberately not "an empty pick":
 * a page that rendered a Teams heading with nothing under it would tell a
 * player a pick exists, which is exactly what an unpublished pick must not do.
 */
export interface PublishedTeams {
  /** From `teamNames(game)` — what this game calls each side. */
  names: Record<TeamId, string>;
  /**
   * The viewer's own side, always shown to them whatever BR-33 does to the
   * rest of the page, or `null` when they have none to be told about.
   */
  yourSide: TeamId | null;
}

/**
 * The two halves of what a player is told about a published pick, decided
 * once, here, for every player-facing surface (BR-35 §5).
 *
 * **Half one: published or nothing.** `teams_published_at` is the only gate.
 * A saved pick is an organiser trying an arrangement out, and the whole point
 * of a separate publish step is that trying one announces nothing — so an
 * unpublished fixture answers `null` even though `responses.team` is sitting
 * right there in the same row set.
 *
 * **Half two: the viewer's own side is theirs.** It is read from their own
 * response row and never routed through `squadForViewer`, exactly as
 * `src/notify/send-teams.ts` reads it for the N-9 email. BR-33 governs seeing
 * *other people*; a player's own assignment is not somebody else's data, and
 * hiding it would leave the page contradicting an email that cannot be
 * un-sent. The *other* side's names are still `squadForViewer`'s decision, and
 * this function deliberately does not touch them — callers pass it the squad
 * that function already returned.
 *
 * Only an `in` player is told a side. A dropout keeps their `team` value on
 * purpose (see the module comment), so reading it unconditionally would tell
 * someone who has said they can't make it that they are playing for the Reds.
 *
 * Called with the viewer's *unfiltered* squad row — `undefined` when they have
 * none, which is an ordinary case on `/r/:token` for a player removed after
 * their link was sent.
 */
export function publishedTeamsFor(
  fixture: { teamsPublishedAt: Date | null },
  game: { teamAName: string; teamBName: string },
  viewerMember: { status: ResponseStatus; team: TeamId | null } | undefined,
): PublishedTeams | null {
  if (fixture.teamsPublishedAt === null) return null;
  return {
    names: teamNames(game),
    yourSide: viewerMember?.status === "in" ? viewerMember.team : null,
  };
}
