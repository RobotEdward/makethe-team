import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { fixtures, memberships, notificationLog, players, pushSubscriptions, responses } from "./schema.js";

/**
 * How far back a failed send still counts against a member (M33).
 *
 * Longer than the usage screen's seven days, and for a different question:
 * that page asks "is delivery broken right now", this one asks "is there any
 * reason to think this person is not hearing from us". A squad playing
 * fortnightly can go three weeks between notifications, and a bounce that
 * scrolled out of a seven-day window would leave the row looking healthy
 * while the address stayed dead.
 */
export const DELIVERY_FAILURE_WINDOW_DAYS = 30;

/** One squad member's reachability, as the columns hold it. */
export interface SquadPresenceRow {
  playerId: string;
  lastSeenAt: Date | null;
  /** Their newest *answered* response on a fixture of this game. */
  lastAnsweredAt: Date | null;
  lastStandaloneAt: Date | null;
  pushDevices: number;
  deliveryFailing: boolean;
}

/**
 * What is known about reaching each active member of one game (M33).
 *
 * Four queries merged in memory, for `listGameUsage`'s reason: devices,
 * answers and log rows all hang off `player_id`, and joining any two of them
 * to `memberships` in one statement multiplies one set by the other — two
 * devices on a member who answered three fixtures reads as six devices, which
 * looks plausible enough on a small squad to ship.
 *
 * Each query is anchored on `memberships` for this game rather than taking a
 * list of player ids: a squad of more than a hundred would otherwise exceed
 * D1's bound-parameter limit, which is a fault that only appears once a real
 * squad gets big.
 *
 * Two of the four signals are player-level, not game-level, and deliberately:
 * a dead push endpoint and a bouncing address are facts about the person, and
 * an organiser looking at "why is this member never answering" is entitled to
 * know we cannot reach them. What they see is only that we cannot — never
 * which other game a failed notification belonged to.
 */
export async function getSquadPresence(
  db: Db,
  gameId: string,
  now: Date,
): Promise<SquadPresenceRow[]> {
  const failuresSince = new Date(
    now.getTime() - DELIVERY_FAILURE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const activeMembers = and(eq(memberships.gameId, gameId), eq(memberships.active, true));

  const [memberRows, deviceRows, answerRows, failureRows] = await Promise.all([
    db
      .select({
        playerId: players.id,
        lastSeenAt: players.lastSeenAt,
        lastStandaloneAt: players.lastStandaloneAt,
      })
      .from(memberships)
      .innerJoin(players, eq(players.id, memberships.playerId))
      .where(activeMembers),
    // `last_failure_at` with no window on it, unlike the log below: a device
    // whose last send failed is a device that is still failing, however long
    // ago that was. It stops counting when a send to it succeeds, or when the
    // player removes it — both of which are the state changing, not time
    // passing.
    db
      .select({
        playerId: pushSubscriptions.playerId,
        devices: sql<number>`count(*)`,
        failing: sql<number>`coalesce(sum(case when ${pushSubscriptions.lastFailureAt} is not null and (${pushSubscriptions.lastSuccessAt} is null or ${pushSubscriptions.lastFailureAt} > ${pushSubscriptions.lastSuccessAt}) then 1 else 0 end), 0)`,
      })
      .from(pushSubscriptions)
      .innerJoin(memberships, eq(memberships.playerId, pushSubscriptions.playerId))
      .where(activeMembers)
      .groupBy(pushSubscriptions.playerId),
    // `responded_at`, never `created_at`: materialisation writes a row per
    // member the moment a fixture appears, so reading `created_at` would
    // report every member of a live game as active whether or not they had
    // said a word — the same trap `getActivityCounts` documents.
    db
      .select({
        playerId: responses.playerId,
        lastAt: sql<number | null>`max(${responses.respondedAt})`,
      })
      .from(responses)
      .innerJoin(fixtures, eq(fixtures.id, responses.fixtureId))
      .innerJoin(
        memberships,
        and(eq(memberships.playerId, responses.playerId), eq(memberships.gameId, fixtures.gameId)),
      )
      .where(and(activeMembers, sql`${responses.respondedAt} is not null`))
      .groupBy(responses.playerId),
    db
      .select({ playerId: notificationLog.playerId, failures: sql<number>`count(*)` })
      .from(notificationLog)
      .innerJoin(memberships, eq(memberships.playerId, notificationLog.playerId))
      .where(
        and(
          activeMembers,
          eq(notificationLog.status, "failed"),
          gte(notificationLog.createdAt, failuresSince),
        ),
      )
      .groupBy(notificationLog.playerId),
  ]);

  const devices = new Map(deviceRows.map((r) => [r.playerId, r]));
  const answers = new Map(answerRows.map((r) => [r.playerId, r.lastAt]));
  const failures = new Map(failureRows.map((r) => [r.playerId, r.failures]));

  return memberRows.map((member) => {
    const device = devices.get(member.playerId);
    const lastAnswer = answers.get(member.playerId);
    return {
      playerId: member.playerId,
      lastSeenAt: member.lastSeenAt,
      lastAnsweredAt:
        lastAnswer === null || lastAnswer === undefined ? null : new Date(lastAnswer),
      lastStandaloneAt: member.lastStandaloneAt,
      pushDevices: device?.devices ?? 0,
      deliveryFailing: (device?.failing ?? 0) > 0 || (failures.get(member.playerId) ?? 0) > 0,
    };
  });
}
