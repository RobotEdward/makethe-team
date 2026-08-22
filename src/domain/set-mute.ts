import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { buildAuditInsert } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { listOpenFixtureIds } from "../db/queries.js";
import { memberships, responses } from "../db/schema.js";
import type { SetResponseOutcome } from "../capacity/types.js";
import { muteExpiryFor, type MuteDuration } from "./mute.js";

/** One membership a mute (or an unmute) was written to. */
interface TargetMembership {
  membershipId: string;
  gameId: string;
}

export interface SetMuteParams {
  db: Db;
  /** The player muting themselves. There is no path by which anyone else may. */
  playerId: string;
  /** The game whose page or invitation they acted from. */
  gameId: string;
  duration: MuteDuration;
  /** Whether to write the same mute to every squad they are currently in. */
  applyToAll: boolean;
  now: Date;
  /**
   * Declines one fixture on the player's behalf. Injected rather than reached
   * for, exactly as `removeMember` injects `withdraw`, so this module holds no
   * Workers binding: the route passes
   * `(id) => env.FIXTURE_CAPACITY.getByName(id).setResponse({intent: "out", …})`.
   */
  decline: (fixtureId: string, playerId: string) => Promise<SetResponseOutcome>;
}

export type SetMuteResult =
  | {
      kind: "muted";
      /** How many memberships were stamped — 1, or every active squad. */
      gamesAffected: number;
      /** How many open fixtures this declined on the player's behalf. */
      declined: number;
    }
  | { kind: "not-a-member" };

export interface ClearMuteParams {
  db: Db;
  playerId: string;
  gameId: string;
  applyToAll: boolean;
  now: Date;
}

export type ClearMuteResult =
  | {
      kind: "cleared";
      /** How many memberships were actually muted and are no longer. */
      gamesAffected: number;
    }
  | { kind: "not-a-member" };

/**
 * Turn on auto-decline (M28), and apply it to the fixtures that are already
 * open.
 *
 * **Why it touches open fixtures at all.** The switch itself only changes what
 * `openFixture` writes *next* time. A player who mutes on Monday, with this
 * Thursday's fixture already open and unanswered, would go on being reminded
 * about it — and would read that, correctly, as the setting not working. So
 * the mute answers those fixtures for them, through the same Durable Object
 * call their own "Can't play" button makes, which is what keeps the waitlist
 * promotion that a decline may trigger working exactly as it always does.
 *
 * **It answers only the fixtures they had not answered.** A place they hold
 * (`in`) and a place they are queued for (`waitlisted`) are theirs and are
 * left alone: muting says "stop asking me", not "give away what I already
 * took", and it mirrors the rule that accepting one fixture while muted does
 * not cancel the mute. The status is read here rather than passed to the
 * object because `setResponse` has no "only if unanswered" mode; the window
 * between that read and the write is a few milliseconds of one player's own
 * request, and the worst case is a fixture they accepted in another tab in
 * that instant being declined — recoverable in one tap, on a page that says
 * so.
 *
 * **Order matters, for the reason `removeMember` gives.** The membership rows
 * are written first, in one batch with their audit rows, so a failure in the
 * fixture loop leaves the player muted (silence begins, which is what they
 * asked for) with work a retry would finish — never half-unmuted.
 *
 * **It causes no promotion, so it returns none and sends nothing.** Only a
 * `pending` row is ever declined here, and a pending player holds no slot —
 * there is nothing to free and nobody to promote off a waitlist. That is a
 * consequence of the rule two paragraphs up, not an independent claim: if this
 * ever grew to decline an `in` row it would owe its caller a `WaitlistPromotion`
 * and an N-2, exactly as `removeMember` does.
 */
export async function setMute(params: SetMuteParams): Promise<SetMuteResult> {
  const { db, playerId, gameId, duration, applyToAll, now, decline } = params;

  const targets = await targetMemberships(db, playerId, gameId, applyToAll);
  if (targets === null) return { kind: "not-a-member" };

  const mutedUntil = muteExpiryFor(duration, now);
  const gameIds = targets.map((t) => t.gameId);

  const statements = [
    db
      .update(memberships)
      .set({ mutedAt: now, mutedUntil })
      .where(and(eq(memberships.playerId, playerId), inArray(memberships.gameId, gameIds))),
    ...targets.map((target) =>
      buildAuditInsert(db, {
        actorPlayerId: playerId,
        entityType: "membership",
        entityId: target.membershipId,
        action: "membership.muted",
        after: {
          mutedUntil: mutedUntil === null ? null : mutedUntil.toISOString(),
          appliedToAllGames: applyToAll,
        },
        now,
      }),
    ),
  ];
  await db.batch(statements as [(typeof statements)[number], ...typeof statements]);

  let declined = 0;
  for (const target of targets) {
    for (const fixtureId of await unansweredOpenFixtures(db, target.gameId, playerId)) {
      const outcome = await decline(fixtureId, playerId);
      if (outcome.kind === "recorded") declined += 1;
    }
  }

  return { kind: "muted", gamesAffected: targets.length, declined };
}

/**
 * Turn auto-decline back off (M28).
 *
 * Deliberately asymmetric with {@link setMute}: it touches no fixture. The
 * fixtures a mute declined were declined on the player's behalf and are theirs
 * to accept again one at a time, from the pages that already offer it —
 * re-opening them all here would put a player back into squads' numbers with
 * no act of their own, which is the failure `openFixture` writing an honest
 * `out` exists to prevent.
 *
 * `gamesAffected` counts memberships that really were muted, so a page can
 * tell "turned it off" from "there was nothing to turn off", and only those
 * are audited.
 */
export async function clearMute(params: ClearMuteParams): Promise<ClearMuteResult> {
  const { db, playerId, gameId, applyToAll, now } = params;

  const targets = await targetMemberships(db, playerId, gameId, applyToAll);
  if (targets === null) return { kind: "not-a-member" };

  const wasMuted = await db
    .select({ id: memberships.id, gameId: memberships.gameId })
    .from(memberships)
    .where(
      and(
        eq(memberships.playerId, playerId),
        inArray(
          memberships.gameId,
          targets.map((t) => t.gameId),
        ),
        isNotNull(memberships.mutedAt),
      ),
    );

  if (wasMuted.length === 0) return { kind: "cleared", gamesAffected: 0 };

  const statements = [
    db
      .update(memberships)
      .set({ mutedAt: null, mutedUntil: null })
      .where(
        and(
          eq(memberships.playerId, playerId),
          inArray(
            memberships.gameId,
            wasMuted.map((m) => m.gameId),
          ),
        ),
      ),
    ...wasMuted.map((row) =>
      buildAuditInsert(db, {
        actorPlayerId: playerId,
        entityType: "membership",
        entityId: row.id,
        action: "membership.unmuted",
        after: { appliedToAllGames: applyToAll },
        now,
      }),
    ),
  ];
  await db.batch(statements as [(typeof statements)[number], ...typeof statements]);

  return { kind: "cleared", gamesAffected: wasMuted.length };
}

/**
 * The memberships one submission writes to, or `null` when the player is not
 * in `gameId` at all — which the routes answer with a 404 (TR-18).
 *
 * The membership of `gameId` is required even for an "all my games"
 * submission: the form was rendered on that game's page, so a submission
 * naming a game the player is not in is not a request to mute their other
 * squads, it is a forged one.
 *
 * "All my games" is every **active** membership at this instant, and only
 * those. Muting a squad they have left would lie in wait for a rejoin, months
 * later, as silence nobody could account for.
 */
async function targetMemberships(
  db: Db,
  playerId: string,
  gameId: string,
  applyToAll: boolean,
): Promise<TargetMembership[] | null> {
  const rows = await db
    .select({ membershipId: memberships.id, gameId: memberships.gameId })
    .from(memberships)
    .where(and(eq(memberships.playerId, playerId), eq(memberships.active, true)));

  const here = rows.find((row) => row.gameId === gameId);
  if (here === undefined) return null;
  return applyToAll ? rows : [here];
}

/** This game's open fixtures on which the player has not answered yet. */
async function unansweredOpenFixtures(db: Db, gameId: string, playerId: string): Promise<string[]> {
  const openIds = await listOpenFixtureIds(db, gameId);
  if (openIds.length === 0) return [];

  const rows = await db
    .select({ fixtureId: responses.fixtureId })
    .from(responses)
    .where(
      and(
        eq(responses.playerId, playerId),
        eq(responses.status, "pending"),
        inArray(responses.fixtureId, openIds),
      ),
    );
  return rows.map((row) => row.fixtureId);
}
