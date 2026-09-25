import { eq, inArray } from "drizzle-orm";
import { fixturePath } from "../auth/paths.js";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import type { Db } from "../db/client.js";
import { loadPotmState, potmEnabled } from "../db/potm-queries.js";
import { fixtures, games, notificationLog, players } from "../db/schema.js";
import { resultDeadline } from "../domain/result-lock.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { leaveTokenExpiry, signLeaveToken } from "../domain/token.js";
import type { SweepFailure } from "../sweep/open-and-remind.js";
import { potmKey, pushKey } from "./dedupe-key.js";
import {
  applySendResult,
  insertQueuedLogRows,
  markOrphanedRowsFailed,
  playersWithPushSubscriptions,
  SITE_ORIGIN,
  type PendingNotification,
} from "./delivery.js";
import { loadNotificationSettings, type EffectiveSettings } from "./notification-settings.js";
import type { Notifier } from "./notifier.js";
import { PUSH_COPY } from "./push-copy.js";
import { renderPotmEmail } from "./templates/potm.js";

/**
 * How long after voting closes a winner may still be told. Bounded for
 * `RESULT_NUDGE_WINDOW_MS`'s reason: the first deploy must not congratulate
 * everybody for last season, and twelve hourly ticks survive a missed run.
 */
export const POTM_NOTIFY_WINDOW_MS = 12 * 60 * 60 * 1000;

export interface PotmNotifyResult {
  fixturesConsidered: number;
  emailSent: number;
  emailFailed: number;
  /** TR-31's daily ceiling; the row is cleared and a later tick retries it. */
  emailDeferred: number;
  pushSent: number;
  pushFailed: number;
  failures: SweepFailure[];
}

/**
 * Sweep step 4c (M68, N-15): once a fixture's vote has closed, tell each
 * winner — by push and by email, both, as N-9 does. The award is good news
 * nobody has to act on, so it goes on every channel the player has and the
 * owner has left on, rather than N-12's one-channel fallback.
 *
 * Guests win but are never told: they have no address and no device. A game
 * that does not run the vote (`potmEnabled`) is skipped outright.
 */
export async function sendPotmAwards(
  db: Db,
  notifier: Notifier,
  now: Date,
  responseTokenSecret: string,
): Promise<PotmNotifyResult> {
  const result: PotmNotifyResult = {
    fixturesConsidered: 0,
    emailSent: 0,
    emailFailed: 0,
    emailDeferred: 0,
    pushSent: 0,
    pushFailed: 0,
    failures: [],
  };

  const rows = await db
    .select({ fixture: fixtures, game: games })
    .from(fixtures)
    .innerJoin(games, eq(fixtures.gameId, games.id))
    .where(eq(fixtures.lifecycle, "played"));
  const due = rows.filter(({ fixture, game }) => {
    if (!potmEnabled(game)) return false;
    const closed = resultDeadline(fixture, game.resultLockHoursAfter).getTime();
    return closed <= now.getTime() && now.getTime() - closed < POTM_NOTIFY_WINDOW_MS;
  });
  result.fixturesConsidered = due.length;
  if (due.length === 0) return result;

  const settings = await loadNotificationSettings(db, due.map(({ game }) => game.id));
  for (const { fixture, game } of due) {
    try {
      await awardOneFixture(db, notifier, now, responseTokenSecret, fixture, game, settings, result);
    } catch (error) {
      result.failures.push({
        fixtureId: fixture.id,
        gameId: game.id,
        stage: "prepare",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

async function awardOneFixture(
  db: Db,
  notifier: Notifier,
  now: Date,
  responseTokenSecret: string,
  fixture: typeof fixtures.$inferSelect,
  game: typeof games.$inferSelect,
  settings: EffectiveSettings,
  result: PotmNotifyResult,
): Promise<void> {
  const state = await loadPotmState(db, game, fixture, now);
  if (state.outcome === null) return;
  const { winnerIds, votes } = state.outcome;

  const winners: { id: string; name: string; email: string | null }[] = [];
  for (const batch of chunk(winnerIds, INSERT_CHUNK_SIZE)) {
    winners.push(
      ...(await db
        .select({ id: players.id, name: players.name, email: players.email, isGuest: players.isGuest })
        .from(players)
        .where(inArray(players.id, batch))).filter((row) => !row.isGuest),
    );
  }
  if (winners.length === 0) return;

  const channels = {
    email: settings.isEnabled(game.id, "n15", "email"),
    push: settings.isEnabled(game.id, "n15", "push"),
  };
  const subscribed = await playersWithPushSubscriptions(db, winners.map((winner) => winner.id));
  const whenLocal = formatLocalDateTime(fixture.kicksOffAt, game.timezone);
  const fixtureUrl = `${SITE_ORIGIN}${fixturePath(game.id, fixture.id)}`;
  const joint = winnerIds.length > 1;

  const pending: PendingNotification[] = [];
  for (const winner of winners) {
    if (channels.push && subscribed.has(winner.id)) {
      const copy = PUSH_COPY.n15({ gameName: game.name, whenLocal });
      const dedupeKey = pushKey(potmKey(fixture.id, winner.id));
      pending.push({
        logId: crypto.randomUUID(),
        dedupeKey,
        playerId: winner.id,
        message: { channel: "push", to: winner.id, title: copy.title, body: copy.body, url: fixtureUrl, tag: `n15:${fixture.id}`, dedupeKey },
      });
    }
    const email = winner.email?.trim() ?? "";
    if (channels.email && email !== "") {
      const leaveToken = await signLeaveToken(
        { gameId: game.id, playerId: winner.id, expiresAt: leaveTokenExpiry(now).getTime() },
        responseTokenSecret,
      );
      const rendered = renderPotmEmail({
        playerName: winner.name,
        gameName: game.name,
        whenLocal,
        votes,
        joint,
        fixtureUrl,
        leaveUrl: `${SITE_ORIGIN}/leave/${leaveToken}`,
      });
      const dedupeKey = potmKey(fixture.id, winner.id);
      pending.push({
        logId: crypto.randomUUID(),
        dedupeKey,
        playerId: winner.id,
        message: { channel: "email", to: email, subject: rendered.subject, html: rendered.html, text: rendered.text, dedupeKey },
      });
    }
  }
  if (pending.length === 0) return;

  // The unique `dedupe_key` index is what makes every later tick in the
  // window a no-op: rows already written come back not inserted.
  const inserted = await insertQueuedLogRows(db, { fixtureId: fixture.id, notificationType: "n15" }, pending);
  if (inserted.length === 0) return;

  let results;
  try {
    results = await notifier.send(inserted.map((entry) => entry.message));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const entry of inserted) {
      await db.update(notificationLog).set({ status: "failed", error: message }).where(eq(notificationLog.id, entry.logId));
      if (entry.message.channel === "email") result.emailFailed++;
      else result.pushFailed++;
    }
    return;
  }

  let applied = 0;
  try {
    for (; applied < inserted.length; applied++) {
      const entry = inserted[applied]!;
      const outcome = await applySendResult(db, entry, results[applied], now);
      const isEmail = entry.message.channel === "email";
      if (outcome.kind === "sent") {
        if (isEmail) result.emailSent++;
        else result.pushSent++;
      } else if (outcome.kind === "deferred" && isEmail) {
        result.emailDeferred++;
      } else if (isEmail) {
        result.emailFailed++;
      } else {
        result.pushFailed++;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const orphaned = inserted.slice(applied);
    for (const entry of orphaned) {
      if (entry.message.channel === "email") result.emailFailed++;
      else result.pushFailed++;
    }
    await markOrphanedRowsFailed(db, orphaned, `abandoned mid-apply: ${message}`);
  }
}
