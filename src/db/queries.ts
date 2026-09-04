import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { isMuted } from "../domain/mute.js";
import type { Lifecycle } from "../domain/lifecycle.js";
import type { ResponseSource, ResponseStatus } from "../domain/response-status.js";
import type { TeamAssignment, TeamId } from "../domain/teams.js";
import type { Db } from "./client.js";
import { fixtures, games, memberships, players, responses } from "./schema.js";

const setter = alias(players, "setter");

export interface SquadMember {
  playerId: string;
  name: string;
  /**
   * `players.erased_at`, carried so the renderer can branch on it (§4, BR-34).
   *
   * Non-null means `name` is the `[erased player]` placeholder, which is
   * deliberately not a plausible name and must never reach a screen: every
   * read of it goes through `displayName` (`src/domain/display-name.ts`). A
   * played fixture keeps its erased participants — that is what stops last
   * month's ten-a-side becoming a nine-a-side — so this is a live case on any
   * squad list, not a theoretical one.
   */
  erasedAt: Date | null;
  status: ResponseStatus;
  /**
   * Which side this player is on (BR-35, M9). Null until an organiser picks
   * teams. Carried through unchanged when `status` moves away from `in` —
   * see `responses.team` in the schema and `src/domain/teams.ts`, which
   * reads that orphaned value as its staleness signal.
   */
  team: TeamId | null;
  /** Rank among current waitlisted members, 1-based. Null unless waitlisted.
   *  Computed here, never the stored column — see spec amendment 5. */
  waitlistRank: number | null;
  /**
   * When this player was invited to this fixture (BR-41), or null if they have
   * not been. Null forever on an ungated Game, where nothing stamps it.
   *
   * Carried so the organiser's page can offer "invite now" on exactly the rows
   * that have not been asked (M46). The renderer must not read it as "gated":
   * a whole squad is unstamped on an ungated fixture too, and every row would
   * sprout a button that stamps a column nothing else reads.
   */
  invitedAt: Date | null;
  /**
   * Who set this response, when it was not the player themselves (BR-27).
   * Null for every self-response, which is the overwhelming majority.
   */
  setBy: { playerId: string; name: string; erasedAt: Date | null } | null;
  /** How the response came to be set. `owner` is what makes `setBy` worth showing. */
  source: ResponseSource;
  /** A one-off guest (J6b §5). Never emailed, occupies a slot. */
  isGuest: boolean;
}

export interface FixtureWithSquad {
  fixture: typeof fixtures.$inferSelect;
  game: typeof games.$inferSelect;
  squad: SquadMember[];
}

// Display order (spec: in, then waitlisted by rank, then pending, then out).
// `withdrawn` never appears — it is filtered out of the query below — but the
// map needs an entry for every ResponseStatus to satisfy the indexed-access
// check, so it is given a value that is simply never read.
const SQUAD_ORDER: Record<ResponseStatus, number> = {
  in: 0,
  waitlisted: 1,
  pending: 2,
  out: 3,
  withdrawn: 4,
};

// Where a status this build cannot read sorts. Last, and defined, which is the
// whole point: `responses.status` is a bare `text NOT NULL` with no CHECK
// constraint, so a row can hold a value with no entry above, and an unmapped
// key makes the subtraction below `NaN`. A comparator that returns `NaN` does
// not throw and does not sort — it hands back an arbitrary order that varies
// with the input, which is the quietest failure of the family this milestone
// has been chasing. A number puts such a row somewhere specific instead.
const UNKNOWN_STATUS_ORDER = 99;

function squadOrder(status: ResponseStatus): number {
  return SQUAD_ORDER[status] ?? UNKNOWN_STATUS_ORDER;
}

/**
 * Load a fixture, its game and the current squad in display order.
 *
 * `responses` is joined to `players` for names and filtered to exclude
 * `withdrawn` — a withdrawn player is not a squad member any more, and
 * nothing downstream should ever see them (spec amendment 5).
 *
 * `players.erased_at` is selected for both the member and BR-27's setter, and
 * is the only reason those two columns are here: §4 requires renderers to
 * branch on it rather than print `players.name`, and this is the query every
 * squad list on the site is built from.
 *
 * Reads only, straight to D1 — never touches the FixtureCapacity Durable
 * Object (TR-11).
 */
export async function getFixtureWithSquad(db: Db, fixtureId: string): Promise<FixtureWithSquad | null> {
  const [row] = await db
    .select({ fixture: fixtures, game: games })
    .from(fixtures)
    .innerJoin(games, eq(fixtures.gameId, games.id))
    .where(eq(fixtures.id, fixtureId));

  if (!row) return null;

  const rows = await db
    .select({
      playerId: responses.playerId,
      name: players.name,
      // Both sides of the join: the squad member, and whoever set their
      // response (BR-27). An organiser who has since erased themselves is
      // exactly as capable of having marked somebody in as one who has not,
      // and "marked in by [erased player]" is the placeholder reaching a
      // screen.
      erasedAt: players.erasedAt,
      status: responses.status,
      team: responses.team,
      waitlistPosition: responses.waitlistPosition,
      invitedAt: responses.invitedAt,
      source: responses.source,
      isGuest: players.isGuest,
      setByPlayerId: setter.id,
      setByName: setter.name,
      setByErasedAt: setter.erasedAt,
    })
    .from(responses)
    .innerJoin(players, eq(responses.playerId, players.id))
    // Left, not inner: `set_by_player_id` is null for every self-response, and
    // an inner join would silently drop all of them from the squad.
    .leftJoin(setter, eq(responses.setByPlayerId, setter.id))
    .where(and(eq(responses.fixtureId, fixtureId), ne(responses.status, "withdrawn")))
    .orderBy(asc(responses.respondedAt), asc(responses.createdAt));

  // Waitlist rank is computed here, at render time, never read from the
  // stored `waitlistPosition` column — that column is permanent and never
  // reused, so it develops gaps once people leave the waitlist. Order the
  // currently waitlisted members by their stored position ascending and
  // number them 1, 2, 3 (spec amendment 5).
  const waitlistRanks = new Map<string, number>();
  rows
    .filter((r) => r.status === "waitlisted")
    .sort((a, b) => (a.waitlistPosition ?? 0) - (b.waitlistPosition ?? 0))
    .forEach((r, index) => waitlistRanks.set(r.playerId, index + 1));

  const squad: SquadMember[] = rows.map((r) => ({
    playerId: r.playerId,
    name: r.name,
    erasedAt: r.erasedAt,
    status: r.status,
    team: r.team,
    waitlistRank: waitlistRanks.get(r.playerId) ?? null,
    invitedAt: r.invitedAt,
    setBy:
      r.setByPlayerId === null || r.setByName === null
        ? null
        : { playerId: r.setByPlayerId, name: r.setByName, erasedAt: r.setByErasedAt },
    source: r.source,
    isGuest: r.isGuest,
  }));

  squad.sort((a, b) => {
    const byStatus = squadOrder(a.status) - squadOrder(b.status);
    if (byStatus !== 0) return byStatus;
    if (a.status === "waitlisted") return (a.waitlistRank ?? 0) - (b.waitlistRank ?? 0);
    // Within `in`, `pending` and `out`, the SQL ORDER BY already put rows in
    // response-time order; Array#sort is stable, so returning 0 preserves it.
    return 0;
  });

  return { fixture: row.fixture, game: row.game, squad };
}

/**
 * Every response row's team assignment for one fixture, **including
 * `withdrawn` ones** (BR-35, M9).
 *
 * That inclusion is the whole reason this exists rather than reusing
 * `getFixtureWithSquad`, which filters `withdrawn` out. Leaving a game (M7a),
 * being removed by an organiser (J6a) and being erased (M7b) all write
 * `withdrawn` — so a staleness check built on the filtered set would miss the
 * most common way published teams stop matching the squad, and would look
 * correct in any test that only drops players to `out`. Feed the result to
 * `src/domain/teams.ts`.
 *
 * Reads only, straight to D1 — never touches the FixtureCapacity Durable
 * Object (TR-11).
 */
export async function listTeamAssignments(db: Db, fixtureId: string): Promise<TeamAssignment[]> {
  return db
    .select({ playerId: responses.playerId, status: responses.status, team: responses.team })
    .from(responses)
    .where(eq(responses.fixtureId, fixtureId));
}

/**
 * The game, if and only if this player is an active Owner of it (TR-18).
 *
 * Returns `null` for "no such game", "not a member", "a member but not an
 * owner" and "an owner whose membership was deactivated" alike — the caller
 * answers 404 for all four, so a game id cannot be probed for existence and a
 * demoted owner learns nothing from the difference.
 *
 * This is the entitlement check for every `/g/:id` route. Middleware cannot do
 * it: which row to check depends on which row the handler is about.
 */
export async function findGameForOwner(
  db: Db,
  gameId: string,
  playerId: string,
): Promise<typeof games.$inferSelect | null> {
  const [row] = await db
    .select({ game: games })
    .from(games)
    .innerJoin(memberships, eq(memberships.gameId, games.id))
    .where(
      and(
        eq(games.id, gameId),
        eq(games.active, true),
        eq(memberships.playerId, playerId),
        eq(memberships.role, "owner"),
        eq(memberships.active, true),
      ),
    )
    .limit(1);
  return row?.game ?? null;
}

/**
 * The game, if and only if this player is an **active member** of it, whatever
 * their role (TR-18).
 *
 * The role-agnostic sibling of `findGameForOwner`. Returns `null` for "no such
 * game", "not a member", "a member who was removed" and "a deactivated game"
 * alike — the caller answers 404 for all four, so a game id cannot be probed
 * and a removed member learns nothing from the difference.
 */
export async function findGameForMember(
  db: Db,
  gameId: string,
  playerId: string,
): Promise<typeof games.$inferSelect | null> {
  const [row] = await db
    .select({ game: games })
    .from(games)
    .innerJoin(memberships, eq(memberships.gameId, games.id))
    .where(
      and(
        eq(games.id, gameId),
        eq(games.active, true),
        eq(memberships.playerId, playerId),
        eq(memberships.active, true),
      ),
    )
    .limit(1);
  return row?.game ?? null;
}

/**
 * Every active game this player is an active member of, with whether they
 * own it — the dashboard's "Your squads" list (M20 B3). This exists because
 * a non-organiser's only other route to a game page is a fixture card that
 * is only there while a fixture is open.
 */
export async function listMemberGames(
  db: Db,
  playerId: string,
): Promise<{ id: string; name: string; owned: boolean; archivedAt: Date | null }[]> {
  const rows = await db
    .select({ id: games.id, name: games.name, role: memberships.role, archivedAt: games.archivedAt })
    .from(games)
    .innerJoin(memberships, eq(memberships.gameId, games.id))
    .where(
      and(
        eq(games.active, true),
        eq(memberships.playerId, playerId),
        eq(memberships.active, true),
      ),
    )
    .orderBy(games.name);
  // Archived games are returned, not filtered: the dashboard lists them under
  // their own heading (M41), since the whole point of archiving over deleting
  // is that the history stays reachable.
  return rows.map((r) => ({ id: r.id, name: r.name, owned: r.role === "owner", archivedAt: r.archivedAt }));
}

/**
 * Every game this player is an *active* member of, with the role they hold
 * there (M7b). Erasure needs both halves at once: the list to leave, and the
 * roles to pre-check the last-organiser invariant against before it leaves
 * anything.
 */
export async function listActiveMemberships(
  db: Db,
  playerId: string,
): Promise<Array<{ gameId: string; role: "player" | "owner" }>> {
  return db
    .select({ gameId: memberships.gameId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.playerId, playerId), eq(memberships.active, true)))
    .orderBy(asc(memberships.gameId));
}

/**
 * Active squad members, owners first then alphabetical.
 *
 * Deliberately does **not** carry `erased_at` the way `getFixtureWithSquad`
 * does: erasure ends every one of a player's memberships before it anonymises
 * them (`erasePlayer`), so an erased player is by construction never an active
 * member and can never appear in this result. The same reasoning excuses
 * `redactName`'s caller, the public invite page, which lists this set. If a
 * future path ever anonymises without leaving, both need the branch.
 *
 * `role` is `text({ enum: ["player", "owner"] })`, so a plain `desc()`/`asc()`
 * over it sorts lexicographically — `desc()` would put `"player"` before
 * `"owner"` (`p` > `o`), the opposite of "owners first", and an `asc()` would
 * only happen to look right today because `"owner"` sorts before `"player"`
 * alphabetically, a coincidence of these two particular words that a third
 * role would break silently. The explicit `CASE` says the actual intent —
 * owner is rank 0, everything else is rank 1 — so the order does not depend
 * on how the role strings happen to compare.
 */
export async function listSquad(
  db: Db,
  gameId: string,
): Promise<
  Array<{
    playerId: string;
    name: string;
    role: "player" | "owner";
    isGuest: boolean;
    /** The raw columns; the page decides what to say through `isMuted` (M28). */
    mutedAt: Date | null;
    mutedUntil: Date | null;
    /** Null for a member seated before confirm-to-join existed (M39, BR-52). */
    emailVerifiedAt: Date | null;
  }>
> {
  return db
    .select({
      playerId: players.id,
      name: players.name,
      role: memberships.role,
      isGuest: players.isGuest,
      mutedAt: memberships.mutedAt,
      mutedUntil: memberships.mutedUntil,
      emailVerifiedAt: players.emailVerifiedAt,
    })
    .from(memberships)
    .innerJoin(players, eq(players.id, memberships.playerId))
    .where(and(eq(memberships.gameId, gameId), eq(memberships.active, true)))
    .orderBy(sql`CASE WHEN ${memberships.role} = 'owner' THEN 0 ELSE 1 END`, players.name);
}

/**
 * An active game by its invite token, or `null`.
 *
 * Deliberately says nothing about *why* it was null. An unknown token, a token
 * that was rotated away, and a game that has been deactivated are one answer,
 * because the caller answers 404 for all three: a page saying "this link has
 * been replaced" would confirm to whoever is holding it that the token was
 * once real, and this is the one route in the app any stranger can reach.
 */
export async function findGameByInviteToken(
  db: Db,
  token: string,
): Promise<typeof games.$inferSelect | null> {
  const [game] = await db
    .select()
    .from(games)
    // An archived game's link is dead (M41): the owner has said nobody new
    // joins, and a joiner backfilled onto no fixtures would hear nothing ever.
    .where(and(eq(games.inviteToken, token), eq(games.active, true), isNull(games.archivedAt)))
    .limit(1);
  return game ?? null;
}

/**
 * The next upcoming fixture — `open` or `scheduled` — the first one a joiner
 * will be in (BR-2′).
 *
 * `open` fixtures are deliberately *included* since BR-2′: the join flow
 * backfills a `pending` row for every open fixture
 * (`src/domain/backfill-open-responses.ts`), so the game being organised
 * right now is a joiner's first game and the invite/outcome pages may name
 * it. The `lifecycle` comes back with the date because the two callers word
 * the two cases differently — an invitation for an `open` fixture is already
 * on its way, a `scheduled` one is announced nearer the time.
 */
export async function findFirstUpcomingFixture(
  db: Db,
  gameId: string,
  now: Date,
): Promise<{ kicksOffAt: Date; lifecycle: "open" | "scheduled" } | null> {
  const [fixture] = await db
    .select({ kicksOffAt: fixtures.kicksOffAt, lifecycle: fixtures.lifecycle })
    .from(fixtures)
    .where(
      and(
        eq(fixtures.gameId, gameId),
        inArray(fixtures.lifecycle, ["open", "scheduled"]),
        gte(fixtures.kicksOffAt, now),
      ),
    )
    .orderBy(asc(fixtures.kicksOffAt))
    .limit(1);
  if (!fixture) return null;
  // The filter above admits only these two values; the narrowing is for the
  // stored-lifecycle caveat (`test/stored-lookups.test.ts`): a row whose text
  // is neither is a schema violation better surfaced here than rendered.
  if (fixture.lifecycle !== "open" && fixture.lifecycle !== "scheduled") return null;
  return { kicksOffAt: fixture.kicksOffAt, lifecycle: fixture.lifecycle };
}

/**
 * Every fixture from `now` onward, soonest first — *all* lifecycles, including
 * the terminal `played` and `cancelled`.
 *
 * Deliberately unfiltered: the owner page this feeds renders each row's
 * lifecycle, so a cancelled fixture reads as cancelled rather than vanishing,
 * and an owner asking "what happened to Thursday?" is better served by seeing
 * it than by an unexplained gap. Named `listUpcoming…` for the `kicks_off_at`
 * bound, which is the only filter it applies.
 */
export async function listUpcomingFixtures(
  db: Db,
  gameId: string,
  now: Date,
  // `lifecycle` is the column's own enum, not a widened `string`: the pages
  // that render these rows map it to words through `fixtureStatusWords`, and
  // a widened type there means an unmapped value renders as the raw token.
): Promise<Array<{ id: string; kicksOffAt: Date; lifecycle: Lifecycle; inCount: number }>> {
  return db
    .select({
      id: fixtures.id,
      kicksOffAt: fixtures.kicksOffAt,
      lifecycle: fixtures.lifecycle,
      inCount: fixtures.inCount,
    })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), gte(fixtures.kicksOffAt, now)))
    .orderBy(fixtures.kicksOffAt);
}

/**
 * Every fixture of a game from before `now`, most recent first — *all*
 * lifecycles, the organiser's past-fixtures page (M27).
 *
 * The mirror image of `listUpcomingFixtures` above, and unfiltered by
 * lifecycle for the same reason it is: the page renders each row's state, so
 * a cancelled fixture reads as cancelled rather than vanishing. Its own
 * function rather than a direction flag on that one — the name is what tells
 * the next reader which way a row sorts, and a flag would leave both
 * behaviours behind one name that describes only one of them.
 *
 * `limit` is the caller's, and mandatory (TR-38): a game running weekly for
 * years has an unbounded history, and the page derives a result summary per
 * row through a batched claims read that D1 caps at 100 bound parameters.
 * `fixtures.id` breaks a kickoff tie so the cut is stable rather than
 * whatever order SQLite happens to return.
 */
export async function listPastFixturesForGame(
  db: Db,
  gameId: string,
  now: Date,
  limit: number,
): Promise<
  Array<{
    id: string;
    kicksOffAt: Date;
    durationMinutes: number;
    lifecycle: Lifecycle;
    inCount: number;
  }>
> {
  return db
    .select({
      id: fixtures.id,
      kicksOffAt: fixtures.kicksOffAt,
      // Full time, for the result lock (M57), as `findLastPlayedFixture`
      // selects it for the same reason.
      durationMinutes: fixtures.durationMinutes,
      lifecycle: fixtures.lifecycle,
      inCount: fixtures.inCount,
    })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), lt(fixtures.kicksOffAt, now)))
    .orderBy(desc(fixtures.kicksOffAt), asc(fixtures.id))
    .limit(limit);
}

/**
 * The most recently played fixture of a game, if it has one — the "last
 * result" line on both game pages (M25 Task 13).
 *
 * Its own query rather than a widening of `listUpcomingFixtures`: that
 * function's contract is "from `now` onward", stated in its own comment
 * above, and a fixture that has been played is by definition in the past. A
 * function named `listUpcoming…` that started returning past fixtures would
 * be a trap for the next reader who trusts the name.
 */
export async function findLastPlayedFixture(
  db: Db,
  gameId: string,
): Promise<{ id: string; kicksOffAt: Date; durationMinutes: number } | null> {
  const [fixture] = await db
    .select({
      id: fixtures.id,
      kicksOffAt: fixtures.kicksOffAt,
      // Full time, for the result lock (M57). The caller already holds the
      // Game row the offset comes from.
      durationMinutes: fixtures.durationMinutes,
    })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), eq(fixtures.lifecycle, "played")))
    .orderBy(desc(fixtures.kicksOffAt))
    .limit(1);
  return fixture ?? null;
}

export interface MembershipInGame {
  membershipId: string;
  playerId: string;
  name: string;
  email: string | null;
  isGuest: boolean;
  role: "player" | "owner";
  active: boolean;
  /**
   * When this player's data was erased, or `null`. Selected so a caller that
   * renders `name` can pass this straight to `displayName` instead of a
   * literal `null` — this row's own `active` guard makes the erased case
   * genuinely unreachable through most callers (erasure deactivates every
   * membership), but a renderer that says it handles erasure should actually
   * be able to, not rely on a caller-side guarantee it cannot see.
   */
  erasedAt: Date | null;
  /**
   * When they left, or `null` while they are still in the squad. Read by
   * `removeMember`'s resume path, which must reuse the *original* `left_at` so
   * N-7's dedupe key (`n7:<membershipId>:<leftAt>`) is unchanged and a retry
   * cannot send a second removal email.
   */
  leftAt: Date | null;
  /**
   * When this player's *current* spell in the squad began — rewritten by
   * `joinSquad` every time it reactivates a membership, so it moves forward
   * on a rejoin rather than recording the first ever join.
   *
   * Read by `/leave/:token`, which refuses a leave token minted before it:
   * such a token belongs to a previous spell, and honouring it would let one
   * copy of an old email evict the same player again after every rejoin.
   */
  joinedAt: Date;
}

/**
 * One player's membership of one game, active or not, or `null`.
 *
 * Scoped by `gameId` as well as `playerId`, which is the whole point: the
 * squad routes take two ids in the path, and without this scoping `:playerId`
 * would read as a global identifier and one owner could act on another
 * squad's membership. The caller answers 404 on `null` (TR-18).
 *
 * Reports an inactive membership rather than hiding it, so a caller can tell
 * "not in this squad" from "was, and left" and answer each correctly.
 */
export async function findMembershipInGame(
  db: Db,
  gameId: string,
  playerId: string,
): Promise<MembershipInGame | null> {
  const [row] = await db
    .select({
      membershipId: memberships.id,
      playerId: memberships.playerId,
      name: players.name,
      email: players.email,
      isGuest: players.isGuest,
      role: memberships.role,
      active: memberships.active,
      erasedAt: players.erasedAt,
      leftAt: memberships.leftAt,
      joinedAt: memberships.joinedAt,
    })
    .from(memberships)
    .innerJoin(players, eq(players.id, memberships.playerId))
    .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, playerId)))
    .limit(1);
  return row ?? null;
}

/** How many active owners this game has. The input to J6a's one invariant. */
export async function countActiveOwners(db: Db, gameId: string): Promise<number> {
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(eq(memberships.gameId, gameId), eq(memberships.active, true), eq(memberships.role, "owner")),
    );
  return rows.length;
}

/** What the auto-decline panel needs to render for one viewer (M28). */
export interface ViewerMuteState {
  muted: boolean;
  /** The expiry, or `null` — either because it is indefinite or because it is off. */
  mutedUntil: Date | null;
  /** Active squads this player is in *besides* this one. */
  otherGamesCount: number;
}

/**
 * The viewer's auto-decline state for one game, or `null` when they are not an
 * active member of it — which every caller answers with a 404 (TR-18).
 *
 * One read of every active membership rather than two queries, because the
 * panel needs both the state here and a count of the squads elsewhere, and two
 * reads could disagree about a membership that changed between them.
 */
export async function muteStateFor(
  db: Db,
  gameId: string,
  playerId: string,
  now: Date,
): Promise<ViewerMuteState | null> {
  const rows = await db
    .select({ gameId: memberships.gameId, mutedAt: memberships.mutedAt, mutedUntil: memberships.mutedUntil })
    .from(memberships)
    .where(and(eq(memberships.playerId, playerId), eq(memberships.active, true)));

  const here = rows.find((row) => row.gameId === gameId);
  if (here === undefined) return null;

  return {
    muted: isMuted(here, now),
    // Reported only while the mute is live. An expired row keeps its columns
    // (see `src/domain/mute.ts`), and a date from one would render as an
    // auto-decline that ended weeks ago still being in force.
    mutedUntil: isMuted(here, now) ? here.mutedUntil : null,
    otherGamesCount: rows.length - 1,
  };
}

/**
 * Every `open` fixture of this game — the exact set BR-3's consequence pass
 * walks.
 *
 * `scheduled` fixtures are excluded because they hold no response rows at all
 * (BR-1 writes them when a fixture opens), and `cancelled`/`played` because
 * they are terminal and rewriting their rows would be rewriting history.
 */
export async function listOpenFixtureIds(db: Db, gameId: string): Promise<string[]> {
  const rows = await db
    .select({ id: fixtures.id })
    .from(fixtures)
    .where(and(eq(fixtures.gameId, gameId), eq(fixtures.lifecycle, "open")))
    .orderBy(fixtures.kicksOffAt);
  return rows.map((row) => row.id);
}

/**
 * What a player currently holds on this game's open fixtures: confirmed places
 * and waitlist places. Read only to make the removal confirmation page state
 * consequences in specifics rather than in general terms.
 */
export async function countCommitments(
  db: Db,
  gameId: string,
  playerId: string,
): Promise<{ in: number; waitlisted: number }> {
  const rows = await db
    .select({ status: responses.status })
    .from(responses)
    .innerJoin(fixtures, eq(fixtures.id, responses.fixtureId))
    .where(
      and(
        eq(fixtures.gameId, gameId),
        eq(fixtures.lifecycle, "open"),
        eq(responses.playerId, playerId),
      ),
    );
  return {
    in: rows.filter((row) => row.status === "in").length,
    waitlisted: rows.filter((row) => row.status === "waitlisted").length,
  };
}

/**
 * Every other active game a player belongs to, besides `excludeGameId` (M7a
 * Task 4's "your other squads").
 *
 * Only ever called once the caller has already confirmed the viewer *is*
 * `playerId` — see `respond.ts`'s `GET /leave/:token`, whose identity match is
 * BR-25's line: a leave token names one player and one game, and this query is
 * the multi-game view that only a matching session may unlock, never the token
 * alone.
 */
export async function listOtherActiveGames(
  db: Db,
  playerId: string,
  excludeGameId: string,
): Promise<Array<{ gameId: string; gameName: string }>> {
  const rows = await db
    .select({ gameId: games.id, gameName: games.name })
    .from(memberships)
    .innerJoin(games, eq(games.id, memberships.gameId))
    .where(
      and(
        eq(memberships.playerId, playerId),
        eq(memberships.active, true),
        eq(games.active, true),
        isNull(games.archivedAt),
        ne(memberships.gameId, excludeGameId),
      ),
    )
    .orderBy(asc(games.name));
  return rows;
}
