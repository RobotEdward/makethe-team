import { and, eq } from "drizzle-orm";
import { fixturePath } from "../auth/paths.js";
import type { Db } from "../db/client.js";
import { fixtures, games, notificationLog } from "../db/schema.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { groupNudgeKey, pushKey } from "../notify/dedupe-key.js";
import {
  applySendResult,
  insertQueuedLogRows,
  playersWithPushSubscriptions,
  SITE_ORIGIN,
  type PendingNotification,
} from "../notify/delivery.js";
import type { Notifier } from "../notify/notifier.js";
import { PUSH_COPY } from "../notify/push-copy.js";
import { WHATSAPP_CARD_ID } from "../views/whatsapp.js";
import { activeOwners } from "./attention.js";
import { fixturesDueByLifecycle, type SweepFailure } from "./open-and-remind.js";

export interface GroupNudgeResult {
  /** Open fixtures past their reminder instant on this run. */
  fixturesConsidered: number;
  /** Push only — N-11 has no email leg, so there is no email count to confuse it with. */
  nudgesSent: number;
  /** Push only. A provider refusal or a rejected batch; never a cron failure on its own. */
  nudgesFailed: number;
  /** Owners with no registered device, who simply see the card on their next visit. */
  ownersWithoutPush: number;
  /** Owners already holding an N-11 row for the fixture — the steady state on every later tick. */
  ownersAlreadyTold: number;
  failures: SweepFailure[];
}

/**
 * Sweep step 2b (M22, N-11): tell each organiser, once, that a fixture of
 * theirs is open and has numbers worth posting to the group — and land
 * them on the "Post to WhatsApp" card to do it.
 *
 * **Fires at the reminder instant, not at opening.** The two coincide for a
 * fixture the sweep opened itself (step 1 opens at the reminder instant),
 * and an organiser who opened early (BR-11) was looking at the card when
 * they did it; what they cannot see is the headcount a day later, which is
 * what this carries. `fixturesDueByLifecycle(db, "open", now)` is exactly
 * step 2's own due-set, reused rather than re-derived so the nudge and the
 * N-1 reminder cannot disagree about which fixtures are due.
 *
 * **Push only.** An email saying "go and open WhatsApp" is noise next to the
 * N-1 the organiser already receives as a player, and an organiser without
 * a device gets nothing here — the card is on the fixture page whenever they
 * next open it. Because there is no email leg, a per-message failure is a
 * `nudgesFailed` count and never a `failures` entry, the same rule the
 * reminder sweep applies to its push leg: push is best-effort, and the cron
 * must not go unhealthy over the channel nothing depends on. A throw while
 * processing a fixture — a D1 error, a bad timezone — *is* a failure, per
 * fixture, so one bad Game silences no other Game's organiser.
 *
 * **Evaluated every tick, sent once ever.** `groupNudgeKey(fixtureId,
 * ownerId)` carries no timestamp, and the unique index on
 * `notification_log.dedupe_key` is the guarantee; the pre-check below only
 * avoids building messages that would be discarded.
 */
export async function sendGroupNudges(db: Db, notifier: Notifier, now: Date): Promise<GroupNudgeResult> {
  // The due-set's own failures (a malformed timezone or reminder time) are
  // deliberately dropped here, not carried into `failures`: step 2 computes
  // the identical set moments earlier on the same tick and has already
  // reported each one, so repeating them would count one bad Game twice in
  // the run's failure total. A fixture that cannot say when its reminder is
  // simply is not due a nudge either.
  const { due: allDue } = await fixturesDueByLifecycle(db, "open", now);
  // The owner's switch (M26). Filtered here rather than skipped in the loop so
  // `fixturesConsidered` keeps meaning "fixtures this step could have nudged
  // for" — a run that considered nothing because every game has the nudge off
  // is not the same as one that found nothing due.
  const due = allDue.filter((fixture) => fixture.switches.groupNudgeEnabled);
  const result: GroupNudgeResult = {
    fixturesConsidered: due.length,
    nudgesSent: 0,
    nudgesFailed: 0,
    ownersWithoutPush: 0,
    ownersAlreadyTold: 0,
    failures: [],
  };

  for (const fixture of due) {
    try {
      await nudgeOwnersOf(db, notifier, now, fixture.id, fixture.gameId, result);
    } catch (error) {
      result.failures.push({
        fixtureId: fixture.id,
        gameId: fixture.gameId,
        stage: "prepare",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

async function nudgeOwnersOf(
  db: Db,
  notifier: Notifier,
  now: Date,
  fixtureId: string,
  gameId: string,
  result: GroupNudgeResult,
): Promise<void> {
  const { owners } = await activeOwners(db, gameId);
  if (owners.length === 0) return;

  const subscribed = await playersWithPushSubscriptions(
    db,
    owners.map((owner) => owner.playerId),
  );
  const alreadyTold = await ownersAlreadyNudged(db, fixtureId);

  const candidates = owners.filter((owner) => {
    if (alreadyTold.has(owner.playerId)) {
      result.ownersAlreadyTold++;
      return false;
    }
    if (!subscribed.has(owner.playerId)) {
      result.ownersWithoutPush++;
      return false;
    }
    return true;
  });
  if (candidates.length === 0) return;

  // Read only once somebody is actually going to be told: the steady state
  // of this step is "every owner already has a row", and that should cost
  // one query, not three.
  const [row] = await db
    .select({ fixture: fixtures, game: games })
    .from(fixtures)
    .innerJoin(games, eq(fixtures.gameId, games.id))
    .where(eq(fixtures.id, fixtureId));
  if (!row) return;
  const { fixture, game } = row;

  const copy = PUSH_COPY.n11({
    gameName: game.name,
    // The single permitted place cross-zone formatting happens (TR-20).
    kicksOffAtLocal: formatLocalDateTime(fixture.kicksOffAt, game.timezone),
    inCount: fixture.inCount,
  });
  // The card, not the top of the page: a fixture page is long, and the
  // point of the tap is to post.
  const url = `${SITE_ORIGIN}${fixturePath(gameId, fixtureId)}#${WHATSAPP_CARD_ID}`;

  const pending: PendingNotification[] = candidates.map((owner) => {
    const dedupeKey = pushKey(groupNudgeKey(fixtureId, owner.playerId));
    return {
      logId: crypto.randomUUID(),
      dedupeKey,
      playerId: owner.playerId,
      message: {
        channel: "push",
        to: owner.playerId,
        title: copy.title,
        body: copy.body,
        url,
        // The real fixture id rather than `PUSH_COPY`'s name-and-date
        // approximation, as every other caller sharpens it.
        tag: `n11:${fixtureId}`,
        dedupeKey,
      },
    };
  });

  const inserted = await insertQueuedLogRows(db, { fixtureId, notificationType: "n11" }, pending);
  result.ownersAlreadyTold += pending.length - inserted.length;
  if (inserted.length === 0) return;

  let results;
  try {
    results = await notifier.send(inserted.map((entry) => entry.message));
  } catch (error) {
    // The notifier itself rejected. Whether anything reached the push
    // service first is unknowable, so every row is left `failed` (ambiguous,
    // never retried — BR-19) and, push being best-effort, the run stays
    // healthy: this is counted, not escalated.
    const message = error instanceof Error ? error.message : String(error);
    for (const entry of inserted) {
      await db
        .update(notificationLog)
        .set({ status: "failed", error: message })
        .where(eq(notificationLog.id, entry.logId));
      result.nudgesFailed++;
    }
    return;
  }

  for (const [index, entry] of inserted.entries()) {
    const outcome = await applySendResult(db, entry, results[index], now);
    // Push has no daily ceiling, so a `deferred` cannot legitimately happen
    // here; if it ever did it would be a provider lying, which is a failure.
    if (outcome.kind === "sent") result.nudgesSent++;
    else result.nudgesFailed++;
  }
}

async function ownersAlreadyNudged(db: Db, fixtureId: string): Promise<Set<string>> {
  const rows = await db
    .select({ playerId: notificationLog.playerId })
    .from(notificationLog)
    .where(and(eq(notificationLog.fixtureId, fixtureId), eq(notificationLog.notificationType, "n11")));
  return new Set(rows.map((row) => row.playerId));
}
