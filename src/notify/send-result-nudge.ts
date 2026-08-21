import { and, eq, inArray } from "drizzle-orm";
import { fixturePath } from "../auth/paths.js";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import type { Db } from "../db/client.js";
import { resultElectorate } from "../db/result-queries.js";
import { fixtures, games, notificationLog, players } from "../db/schema.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { leaveTokenExpiry, signLeaveToken } from "../domain/token.js";
import type { SweepFailure } from "../sweep/open-and-remind.js";
import { CEILING_DEFERRAL_COLLAPSE_WINDOW_MS, recordCeilingDeferral } from "./ceiling-audit.js";
import { pushKey, resultNudgeKey } from "./dedupe-key.js";
import {
  applySendResult,
  insertQueuedLogRows,
  markOrphanedRowsFailed,
  playersWithPushSubscriptions,
  SITE_ORIGIN,
  type PendingNotification,
} from "./delivery.js";
import type { Notifier } from "./notifier.js";
import { PUSH_COPY } from "./push-copy.js";
import { renderResultNudgeEmail } from "./templates/result-nudge.js";

/**
 * How far back a fixture's full time may be and still earn its squad a nudge.
 *
 * **Selection is bounded by this window, not by "fixtures this run retired".**
 * `retire.ts` documents the hazard from the other direction: a cron backlog
 * mailing people about games that finished days ago. A first deploy that
 * selected every played fixture ever would mail the entire user base about
 * last season. Twelve hours because the sweep is hourly, so a fixture gets
 * twelve chances to be picked up and a run missed for any reason costs nobody
 * their nudge.
 */
export const RESULT_NUDGE_WINDOW_MS = 12 * 60 * 60 * 1000;

export interface ResultNudgeResult {
  /** Played fixtures whose full time falls inside `RESULT_NUDGE_WINDOW_MS` on this run. */
  fixturesConsidered: number;
  emailSent: number;
  /** A provider refusal or a rejected batch. */
  emailFailed: number;
  /** TR-31's daily ceiling. Retried on a later tick, same as every other deferral. */
  emailDeferred: number;
  pushSent: number;
  pushFailed: number;
  /** Eligible players already holding an N-12 row for the fixture — the steady state on every later tick. */
  alreadyNudged: number;
  /** BR-32: an eligible player with no usable email and no registered push device. */
  skippedNoAddress: number;
  failures: SweepFailure[];
}

function emptyResult(): ResultNudgeResult {
  return {
    fixturesConsidered: 0,
    emailSent: 0,
    emailFailed: 0,
    emailDeferred: 0,
    pushSent: 0,
    pushFailed: 0,
    alreadyNudged: 0,
    skippedNoAddress: 0,
    failures: [],
  };
}

/**
 * Sweep step 4b (M25, N-12): once a fixture's full time has passed, ask
 * everyone entitled to file a result to do so, so the feature `src/routes/
 * results.ts` exposes actually gets used instead of sitting unread.
 *
 * **Recipients are `resultElectorate`'s `eligibleIds`** (Task 5): every
 * player who was `in`, plus every active organiser whether or not they
 * played — the same audience the fixture page itself asks to file.
 *
 * **One message per player, on whichever channel they actually have** —
 * unlike N-9, which sends both an email and a push to the same player.
 * **Push is preferred here, email is the fallback** — the reverse of the
 * product's usual default — because TR-31's daily send ceiling is email-only.
 * N-12 is explicitly low-urgency (nobody has to act on it, the fixture page
 * carries the same ask indefinitely), while N-1 is the reminder this product
 * cannot afford to drop; sending N-12 by email first would spend allowance
 * N-1 may need for a notification nobody is required to read. Push-only
 * (N-11's pattern) was rejected because N-12 addresses the whole squad, not
 * just engaged organisers with a device; sending both (`send-teams.ts`'s
 * pattern) was rejected as the worst option for the ceiling of the three. The
 * cost of any fallback scheme — a player's channel flips if they register or
 * remove a device between two sweep ticks — is inherent to this design, not
 * particular to the direction of preference.
 *
 * **Evaluated every tick within the window, sent once ever.** `resultNudgeKey`
 * carries no timestamp; the pre-check below only avoids building messages
 * that the unique index on `notification_log.dedupe_key` would discard, the
 * same reasoning `sendGroupNudges` documents for its own pre-check.
 */
export async function sendResultNudges(
  db: Db,
  notifier: Notifier,
  now: Date,
  responseTokenSecret: string,
): Promise<ResultNudgeResult> {
  const candidateRows = await db
    .select({
      id: fixtures.id,
      gameId: fixtures.gameId,
      gameName: games.name,
      timezone: games.timezone,
      kicksOffAt: fixtures.kicksOffAt,
      durationMinutes: fixtures.durationMinutes,
    })
    .from(fixtures)
    .innerJoin(games, eq(fixtures.gameId, games.id))
    .where(eq(fixtures.lifecycle, "played"));

  // Filtered in JS against `now.getTime()`, matching `retirePastFixtures`'s
  // own idiom (a broad SQL select, then a precise JS filter for the boundary
  // that matters) rather than inline date arithmetic in the `WHERE` clause.
  const due = candidateRows.filter((row) => {
    const fullTime = row.kicksOffAt.getTime() + row.durationMinutes * 60_000;
    return fullTime <= now.getTime() && now.getTime() - fullTime < RESULT_NUDGE_WINDOW_MS;
  });

  const result = emptyResult();
  result.fixturesConsidered = due.length;

  for (const fixture of due) {
    try {
      await nudgeOneFixture(db, notifier, now, responseTokenSecret, fixture, result);
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

async function alreadyNudgedIds(db: Db, fixtureId: string): Promise<Set<string>> {
  const rows = await db
    .select({ playerId: notificationLog.playerId })
    .from(notificationLog)
    .where(and(eq(notificationLog.fixtureId, fixtureId), eq(notificationLog.notificationType, "n12")));
  return new Set(rows.map((row) => row.playerId));
}

async function nudgeOneFixture(
  db: Db,
  notifier: Notifier,
  now: Date,
  responseTokenSecret: string,
  fixture: { id: string; gameId: string; gameName: string; timezone: string; kicksOffAt: Date; durationMinutes: number },
  result: ResultNudgeResult,
): Promise<void> {
  const { eligibleIds } = await resultElectorate(db, fixture.gameId, fixture.id);
  if (eligibleIds.size === 0) return;

  const alreadyNudged = await alreadyNudgedIds(db, fixture.id);
  const remainingIds = [...eligibleIds].filter((id) => !alreadyNudged.has(id));
  result.alreadyNudged += eligibleIds.size - remainingIds.length;
  if (remainingIds.length === 0) return;

  // A join keyed on an `IN (...)` list rather than a second lookup by squad
  // membership — there is no per-fixture bound on this list the way
  // `send-teams.ts`'s comment warns about, but `remainingIds` is chunked at
  // `INSERT_CHUNK_SIZE` regardless, for the same D1 100-bound-parameter
  // reason (`src/db/chunk.ts`).
  const playerRows: { id: string; name: string; email: string | null }[] = [];
  for (const batch of chunk(remainingIds, INSERT_CHUNK_SIZE)) {
    const rows = await db
      .select({ id: players.id, name: players.name, email: players.email })
      .from(players)
      .where(inArray(players.id, batch));
    playerRows.push(...rows);
  }
  const playerById = new Map(playerRows.map((row) => [row.id, row]));

  const subscribed = await playersWithPushSubscriptions(db, remainingIds);

  const whenLocal = formatLocalDateTime(fixture.kicksOffAt, fixture.timezone);
  const fixtureUrl = `${SITE_ORIGIN}${fixturePath(fixture.gameId, fixture.id)}`;

  const pending: PendingNotification[] = [];

  for (const playerId of remainingIds) {
    const player = playerById.get(playerId);
    // Unreachable in practice: `resultElectorate` reads these ids from
    // `responses`/`memberships` rows that both reference `players`, so a
    // missing row here would mean a foreign key had already been violated.
    // Reported rather than thrown, so one vanished row cannot silence the
    // rest of this fixture's nudges.
    if (!player) {
      console.error(`sendResultNudges: player ${playerId} not found for fixture ${fixture.id}`);
      continue;
    }

    // Push-preferred, email-fallback (see this module's doc comment for why
    // this is the reverse of `send-teams.ts`'s email-first default).
    if (subscribed.has(playerId)) {
      const copy = PUSH_COPY.n12({ gameName: fixture.gameName });
      const dedupeKey = pushKey(resultNudgeKey(fixture.id, playerId));
      pending.push({
        logId: crypto.randomUUID(),
        dedupeKey,
        playerId,
        message: {
          channel: "push",
          to: playerId,
          title: copy.title,
          body: copy.body,
          url: fixtureUrl,
          tag: `n12:${fixture.id}`,
          dedupeKey,
        },
      });
      continue;
    }

    const email = player.email?.trim() ?? "";
    if (email !== "") {
      // A leave token scoped to `(gameId, playerId)`, not to this fixture
      // (BR-22) — the same shape `send-teams.ts` signs its own leave link
      // with, and deliberately not a fixture-scoped token: leaving works long
      // after this one fixture is history, and a leave link is about the
      // squad, not any particular game.
      const leaveToken = await signLeaveToken(
        { gameId: fixture.gameId, playerId, expiresAt: leaveTokenExpiry(now).getTime() },
        responseTokenSecret,
      );
      const leaveUrl = `${SITE_ORIGIN}/leave/${leaveToken}`;
      const rendered = renderResultNudgeEmail({ playerName: player.name, gameName: fixture.gameName, whenLocal, fixtureUrl, leaveUrl });
      const dedupeKey = resultNudgeKey(fixture.id, playerId);
      pending.push({
        logId: crypto.randomUUID(),
        dedupeKey,
        playerId,
        message: { channel: "email", to: email, subject: rendered.subject, html: rendered.html, text: rendered.text, dedupeKey },
      });
      continue;
    }

    // BR-32: no registered device and no usable email. Not a
    // `notification_log` row — there is nothing to send and nothing to
    // retry — so this is a plain count, the same treatment BR-32 gets in
    // `send-teams.ts` and `send-broadcast.ts`.
    result.skippedNoAddress++;
  }

  if (pending.length === 0) return;

  const inserted = await insertQueuedLogRows(db, { fixtureId: fixture.id, notificationType: "n12" }, pending);
  result.alreadyNudged += pending.length - inserted.length;
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

  const deferredPlayerIds: string[] = [];
  let applied = 0;
  try {
    for (; applied < inserted.length; applied++) {
      const entry = inserted[applied];
      const sendResult = results[applied];
      if (!entry) continue;
      const outcome = await applySendResult(db, entry, sendResult, now);
      const isEmail = entry.message.channel === "email";
      if (outcome.kind === "sent") {
        if (isEmail) result.emailSent++;
        else result.pushSent++;
      } else if (outcome.kind === "deferred") {
        // Push has no daily ceiling, so this can only legitimately happen
        // for the email row — see the identical reasoning in `send-teams.ts`.
        if (isEmail) {
          result.emailDeferred++;
          deferredPlayerIds.push(entry.playerId);
        } else {
          result.pushFailed++;
        }
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

  if (deferredPlayerIds.length > 0) {
    // Retried every sweep tick within the window, like N-1 and N-4, so the
    // same collapse window applies (`src/notify/ceiling-audit.ts`).
    await recordCeilingDeferral(db, {
      action: "fixture.result_nudge_email_deferred",
      notificationType: "n12",
      entityType: "fixture",
      entityId: fixture.id,
      playerIds: deferredPlayerIds,
      now,
      collapseWindowMs: CEILING_DEFERRAL_COLLAPSE_WINDOW_MS,
    });
  }
}
