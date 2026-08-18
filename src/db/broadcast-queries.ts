import { and, eq, gte } from "drizzle-orm";
import type { Db } from "./client.js";
import { auditLog, memberships, players, pushSubscriptions, responses } from "./schema.js";

/** One person a broadcast could reach, and what is known about how to reach them. */
export interface BroadcastRecipient {
  playerId: string;
  name: string;
  /** Nullable in the schema — guests have none. */
  email: string | null;
  isGuest: boolean;
  /** At least one row in `push_subscriptions`. */
  hasDevice: boolean;
  /**
   * The raw `responses.status` for a fixture-scoped query, `null` for a
   * game-scoped one. Typed `string`, not `ResponseStatus`: the column has no
   * CHECK constraint (see `broadcast-audience.ts`), and widening it here is
   * what forces every caller through `audienceSelectsStatus`.
   */
  status: string | null;
}

/**
 * A `players` row joined to whether it owns any `push_subscriptions` row,
 * without duplicating the player for each device.
 *
 * A `selectDistinct` on `push_subscriptions.player_id`, left-joined onto
 * `players`, rather than joining the raw table: a player with two registered
 * devices has two rows there, and a naive join would return that player
 * twice — once per device — and this milestone would message them twice.
 */
function deviceOwnersSubquery(db: Db) {
  return db.selectDistinct({ playerId: pushSubscriptions.playerId }).from(pushSubscriptions).as("device_owners");
}

/**
 * Every active member of a game, for the `everyone` audience (BR-36, §2).
 *
 * Joins `memberships` to `players` rather than collecting player ids first
 * and querying `players` with an `IN (...)` list: `MAX_PLAYERS_CEILING`
 * (`src/domain/game-form.ts`) allows a squad of up to 200, D1 binds at most
 * 100 parameters per statement (`src/db/chunk.ts`), and `sendTeamsEmails`
 * documents a first version of that exact trap. Joining keeps this query's
 * parameter count fixed at two, regardless of squad size.
 */
export async function listGameRecipients(db: Db, gameId: string): Promise<BroadcastRecipient[]> {
  const deviceOwners = deviceOwnersSubquery(db);
  const rows = await db
    .select({
      playerId: players.id,
      name: players.name,
      email: players.email,
      isGuest: players.isGuest,
      devicePlayerId: deviceOwners.playerId,
    })
    .from(memberships)
    .innerJoin(players, eq(memberships.playerId, players.id))
    .leftJoin(deviceOwners, eq(deviceOwners.playerId, players.id))
    .where(and(eq(memberships.gameId, gameId), eq(memberships.active, true)));

  return rows.map((row) => ({
    playerId: row.playerId,
    name: row.name,
    email: row.email,
    isGuest: row.isGuest,
    hasDevice: row.devicePlayerId !== null,
    status: null,
  }));
}

/**
 * Every response row on a fixture, carrying the raw status, for the four
 * fixture-scoped audiences (BR-36, §2).
 *
 * Joins `responses` to `players` for the same reason `listGameRecipients`
 * joins `memberships` to `players`: the parameter count must not grow with
 * squad size. `status` is passed through unfiltered — `audienceSelectsStatus`
 * is where a caller narrows this list to one audience, not here.
 */
export async function listFixtureRecipients(db: Db, fixtureId: string): Promise<BroadcastRecipient[]> {
  const deviceOwners = deviceOwnersSubquery(db);
  const rows = await db
    .select({
      playerId: players.id,
      name: players.name,
      email: players.email,
      isGuest: players.isGuest,
      status: responses.status,
      devicePlayerId: deviceOwners.playerId,
    })
    .from(responses)
    .innerJoin(players, eq(responses.playerId, players.id))
    .leftJoin(deviceOwners, eq(deviceOwners.playerId, players.id))
    .where(eq(responses.fixtureId, fixtureId));

  return rows.map((row) => ({
    playerId: row.playerId,
    name: row.name,
    email: row.email,
    isGuest: row.isGuest,
    hasDevice: row.devicePlayerId !== null,
    status: row.status,
  }));
}

/**
 * How many broadcasts this game has sent at or after `since` (BR-36, §7) —
 * the count `broadcast-limit.ts`'s per-game daily cap is enforced against.
 * `audit_log` is the only record of a send: there is no message table.
 */
export async function countBroadcastsSince(db: Db, gameId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "game"),
        eq(auditLog.entityId, gameId),
        eq(auditLog.action, "game.broadcast_sent"),
        gte(auditLog.createdAt, since),
      ),
    );
  return rows.length;
}
