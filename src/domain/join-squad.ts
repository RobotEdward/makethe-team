import { and, eq, sql } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { memberships, players } from "../db/schema.js";

/**
 * Put someone in a squad from the public invite link (J1, spec §4.4).
 *
 * Shared rather than inlined in the route, because J6's "add a squad member
 * directly" is the same operation with a different caller — and because the
 * three outcomes below (`joined`, `rejoined`, `already-member`) are the
 * interesting part, not the HTTP around them.
 *
 * **One address is one person.** An email that already exists reuses the
 * `players` row and the *stored* name wins; the name typed on the form is
 * discarded. Joining a second squad therefore cannot rename you in the first,
 * and there is no unaudited path by which one squad's form input changes how
 * you appear to another. The cost is that a typo'd name cannot be corrected
 * here — that belongs to a profile-edit surface (§1.6, M7).
 *
 * **BR-2′ (M21): a joiner is backfilled into open fixtures — by the caller,
 * not here.** `pending` rows are written for the eligible set when a fixture
 * opens (BR-1); `backfillOpenFixtureResponses` is the one sanctioned
 * addition, and the join route runs it after this returns. It stays out of
 * this function because J6's "add a squad member by hand" shares this code
 * and decides separately whether the new member joins the current game.
 */

export type JoinOutcome =
  | { kind: "joined"; playerId: string; membershipId: string; joinedAt: Date; playerName: string }
  | { kind: "rejoined"; playerId: string; membershipId: string; joinedAt: Date; playerName: string }
  | { kind: "already-member"; playerId: string; playerName: string };

export interface JoinSquadParams {
  db: Db;
  gameId: string;
  name: string;
  /** Raw from the form. Normalised here, not by the caller. */
  email: string;
  now: Date;
  /**
   * M39. Set by the caller once BR-47's confirmation has proved this address
   * — never trusted from the form itself. Stamped on a freshly-created row;
   * `coalesce`d onto a reused one so a later, unrelated confirmation can never
   * move an existing verification date forward.
   */
  emailVerifiedAt?: Date;
}

/**
 * Trimmed and lowercased, so `Ed@x.com` and `ed@x.com` cannot become two
 * Players under the `UNIQUE (email) WHERE email IS NOT NULL` index.
 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * A shape check, not a deliverability check — nothing here can know whether an
 * address exists, and the N-6 welcome is what actually tests that (spec §4.4:
 * the email doubles as proof of address).
 */
export function isPlausibleEmail(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  if (/\s/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  return domain.length > 0 && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

/**
 * Is this the database refusing a duplicate, as opposed to any other failure?
 *
 * Matched on SQLite's message because D1 gives no error code through Drizzle.
 * Walks the `cause` chain: Drizzle wraps the D1 error, which wraps SQLite's.
 * Deliberately narrow — every other error still propagates and still becomes a
 * 500, because "we could not tell what went wrong" must not be answered with
 * "you're already in the squad".
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current.message.includes("UNIQUE constraint failed")) return true;
    current = current.cause;
  }
  return false;
}

/**
 * One attempt per constraint a concurrent identical join can beat us to: the
 * `players.email` index and the `(game_id, player_id)` membership index.
 */
const MAX_JOIN_ATTEMPTS = 3;

/**
 * Join, re-running the lookups when a concurrent identical join beat us to a
 * row rather than turning the collision into a 500.
 *
 * The read-then-write below is not atomic and cannot be made so: D1 has no
 * interactive transactions, so `attemptJoin` looks for a player, finds none,
 * and inserts — and a double-tapped "Join the squad" button runs that twice at
 * once. The loser hits `UNIQUE (email)` (or `UNIQUE (game_id, player_id)`) and,
 * before this, handed the person a 500 for an operation that had *succeeded*,
 * leaving them with no way to tell whether they had joined.
 *
 * **Why more than one retry.** Losing the player-insert race and losing the
 * membership-insert race are two different collisions, and one request can lose
 * both in turn: it retries past the player row the winner created, reaches the
 * membership insert, and finds the winner has just got there too. Each
 * violation is raised only *after* the row that caused it is committed, so
 * every retry starts from strictly more state than the last and the loop
 * cannot spin — with two constraints in play, a third attempt always finds
 * both rows and inserts nothing. The bound is a backstop, not the mechanism;
 * exhausting it rethrows, because a violation nobody can make progress against
 * is a real fault and must not be reported as a successful join.
 */
export async function joinSquad(params: JoinSquadParams): Promise<JoinOutcome> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptJoin(params);
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= MAX_JOIN_ATTEMPTS) throw error;
    }
  }
}

async function attemptJoin(params: JoinSquadParams): Promise<JoinOutcome> {
  const { db, gameId, name, now } = params;
  const email = normaliseEmail(params.email);

  const [existing] = await db.select().from(players).where(eq(players.email, email)).limit(1);

  // A guest can never collide here: guests have `email IS NULL` by definition
  // (§2.8) and this lookup is by email.
  const playerId = existing?.id ?? crypto.randomUUID();
  const playerName = existing?.name ?? name.trim();

  if (!existing) {
    await db.insert(players).values({
      id: playerId,
      name: playerName,
      email,
      createdAt: now,
      emailVerifiedAt: params.emailVerifiedAt ?? null,
    });
  } else if (params.emailVerifiedAt) {
    // An earlier verification is never moved forward (link-player.ts's rule):
    // the column records when we *first* knew the address reached them.
    await db
      .update(players)
      .set({ emailVerifiedAt: sql`coalesce(${players.emailVerifiedAt}, ${params.emailVerifiedAt.getTime()})` })
      .where(eq(players.id, existing.id));
  }

  const [membership] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.gameId, gameId), eq(memberships.playerId, playerId)))
    .limit(1);

  if (membership?.active === true) {
    return { kind: "already-member", playerId, playerName };
  }

  if (membership) {
    // Reactivate rather than insert: UNIQUE (game_id, player_id) forbids a
    // second row. `joinedAt` is reset because it is what makes the N-6 dedupe
    // key differ, which is what lets a rejoin be welcomed again (§4.4).
    //
    // **`role: "player"` is a security boundary, not tidying — do not remove
    // it.** This runs for an unauthenticated visitor holding a public invite
    // link, with no proof of identity beyond an address typed into a form. A
    // link like that must never confer ownership of a game, whatever the
    // stale membership row happens to say. `removeMember` also demotes on the
    // way out, so today no inactive row *should* read `owner` — this is the
    // half that holds even if a row somehow does, and it is unconditional for
    // exactly that reason. Without it, an owner removes a co-organiser and
    // that person walks back in through `/j/:token` able to edit the game,
    // rotate the invite link and remove the remaining organiser.
    await db.batch([
      db
        .update(memberships)
        .set({ active: true, leftAt: null, joinedAt: now, role: "player" })
        .where(eq(memberships.id, membership.id)),
      buildAuditInsert(db, {
        // Null, not `playerId`. See the `membership.joined` comment in
        // `src/domain/audit.ts`: whoever holds the invite link is anonymous,
        // and naming the joiner as actor asserts a consent that may not exist.
        actorPlayerId: null,
        entityType: "membership",
        entityId: membership.id,
        action: "membership.rejoined",
        // `role` on both sides so the audit trail shows an invite-link rejoin
        // can only ever land on `player` (BR-27).
        before: { role: membership.role },
        after: { gameId, playerId, via: "invite_link", role: "player" },
        now,
      }),
    ]);
    return { kind: "rejoined", playerId, membershipId: membership.id, joinedAt: now, playerName };
  }

  const membershipId = crypto.randomUUID();
  await db.batch([
    db.insert(memberships).values({
      id: membershipId,
      gameId,
      playerId,
      role: "player",
      active: true,
      joinedAt: now,
    }),
    buildAuditInsert(db, {
      // Null, not `playerId`. See the `membership.joined` comment in
      // `src/domain/audit.ts`: whoever holds the invite link is anonymous,
      // and naming the joiner as actor asserts a consent that may not exist.
      actorPlayerId: null,
      entityType: "membership",
      entityId: membershipId,
      action: "membership.joined",
      after: { gameId, playerId, via: "invite_link" },
      now,
    }),
  ]);

  return { kind: "joined", playerId, membershipId, joinedAt: now, playerName };
}
