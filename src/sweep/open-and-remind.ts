import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { fixtures, games, notificationLog, players, responses } from "../db/schema.js";
import { openFixture } from "../domain/open-fixture.js";
import { reminderInstant } from "../domain/reminder-time.js";
import { buildReminderMessages, type ReminderCandidate } from "../notify/reminder-messages.js";
import type { Notifier } from "../notify/notifier.js";
import { CEILING_DEFERRAL_COLLAPSE_WINDOW_MS, recordCeilingDeferral } from "../notify/ceiling-audit.js";
import { applySendResult, insertQueuedLogRows, markOrphanedRowsFailed } from "../notify/delivery.js";

/** One fixture (or game) the sweep could not fully process, and why. */
export interface SweepFailure {
  fixtureId: string;
  gameId: string | null;
  stage: "reminder-instant" | "open" | "prepare" | "send" | "apply";
  message: string;
}

export interface SweepResult {
  fixturesOpened: number;
  /**
   * **Email only.** `src/cron/handler.ts` logs this as an email count
   * ("sent N") on a failed run, the same reasoning `CancellationSendSummary.sent`'s
   * doc comment gives at length: folding a push row in here would report an
   * inflated number of emails sent. See `pushRemindersSent` for the push
   * leg's own count.
   */
  remindersSent: number;
  /** Email only — see `remindersSent`. See `pushRemindersFailed` for the push leg's own count. */
  remindersFailed: number;
  /**
   * Reminders refused by the daily send ceiling (TR-31) and *only* that.
   * Their `notification_log` row is removed rather than left `failed`, so the
   * next sweep run retries them automatically. This is an expected, benign
   * outcome under a low ceiling — never a failure, and deliberately never
   * mixed with any other reason, so `handleScheduled`'s ceiling warning names
   * the condition it is actually reporting. See `applySendResult` (`src/notify/delivery.ts`).
   * Email only — the push leg has no daily ceiling and can never produce this outcome.
   */
  remindersDeferred: number;
  /** The push leg's own `sent` count — informational only, never folded into `remindersSent`. */
  pushRemindersSent: number;
  /** The push leg's own `failed` count — informational only, never folded into `remindersFailed`. Also where a push `deferred` outcome lands, since the push leg can't legitimately produce one. */
  pushRemindersFailed: number;
  guestsSkipped: number;
  /**
   * Every fixture (or game) whose processing failed outright — a bad
   * timezone, a rejected notifier call, a database error, or one or more
   * messages the provider refused — recorded here instead of aborting the
   * run. One broken fixture must never silence every other Game's reminder
   * on that run (mirrors `materialiseFixtures`).
   *
   * A per-message *email* send failure lands here too, not just in
   * `remindersFailed`: a total email provider outage that failed every
   * reminder would otherwise leave an integer in a log line as its only
   * trace, and `handleScheduled` — which rejects only on a non-empty
   * `failures` — would report the invocation as a clean run. That is
   * precisely the failure mode this project already fixed once for
   * materialisation.
   *
   * This escalation is email-only, deliberately, since Task 13: a per-message
   * push failure is folded into `pushRemindersFailed` only and never reaches
   * `failures` (see the `isEmail` branches below). A total push outage is
   * therefore *not* a cron failure the way a total email outage is — push is
   * best-effort and purely additional on top of email, which every reminder
   * still goes out on regardless of push's health, so failing the whole
   * invocation over a push outage would run the invariant backwards: it
   * would make the cron unhealthy over the channel nobody depends on, while
   * staying healthy is exactly what lets email keep going out unaffected.
   * `pushRemindersFailed` remains the record of it; see the `console.warn`
   * below for where an operator would actually notice.
   */
  failures: SweepFailure[];
}

/**
 * The sweep's first two steps (§2.4): open fixtures whose reminder
 * instant has passed, then send the day-before reminder (N-1) for fixtures
 * that are already open and due one.
 *
 * The two steps run against fixtures in different lifecycles and are kept
 * separate deliberately: an Owner who opens a fixture early (BR-11) only
 * ever runs step 2 for it, at the fixture's own scheduled reminder instant,
 * because step 2 keys off `reminderInstant`, never off `opened_at`. Folding
 * the steps together would make an early open also fire the reminder
 * immediately, which is exactly what BR-17/§2.4 rule out.
 *
 * Every fixture is processed independently, and a failure on one is recorded
 * in `failures` rather than thrown — a single bad Game (an invalid timezone)
 * or a single rejected notifier call must not stop reminders going out for
 * every other Game on that run.
 */
export async function openAndRemind(
  db: Db,
  notifier: Notifier,
  now: Date,
  responseTokenSecret: string,
): Promise<SweepResult> {
  const { opened, failures: openFailures } = await openDueFixtures(db, now);
  const reminderResult = await sendDueReminders(db, notifier, now, responseTokenSecret);

  return {
    fixturesOpened: opened,
    ...reminderResult,
    failures: [...openFailures, ...reminderResult.failures],
  };
}

interface GameTiming {
  timezone: string;
  reminderDaysBefore: number;
  reminderLocalTime: string;
}

export interface DueFixture {
  id: string;
  gameId: string;
  kicksOffAt: Date;
  game: GameTiming;
}

/** Step 1: open every `scheduled` fixture whose reminder instant has passed. */
async function openDueFixtures(db: Db, now: Date): Promise<{ opened: number; failures: SweepFailure[] }> {
  const { due, failures } = await fixturesDueByLifecycle(db, "scheduled", now);

  let opened = 0;
  for (const fixture of due) {
    try {
      const result = await openFixture(db, fixture.id, now);
      if (result.opened) opened++;
    } catch (error) {
      failures.push({
        fixtureId: fixture.id,
        gameId: fixture.gameId,
        stage: "open",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { opened, failures };
}

const MINUTE_MS = 60_000;

/**
 * Fixtures in `lifecycle` whose `reminderInstant` (computed from their
 * Game's timezone and reminder configuration) has passed, and which have not
 * already ended.
 *
 * The end check is what keeps a cron gap from mattering here: without it, a
 * fixture whose reminder instant *and* whose kickoff-plus-duration have both
 * already passed — the exact shape of a backlog after a missed run or two —
 * would still be opened and mailed as if it were upcoming, then retired by
 * the very same sweep tick. A fixture is `ended` on the identical boundary
 * `retirePastFixtures` uses (`kicksOffAt + durationMinutes <= now`), so the
 * instant a fixture would be retired is also the instant it stops being
 * reminder- or open-eligible — nothing is ever both mailed and closed out in
 * the same run. A fixture that has kicked off but not yet ended (mid-game)
 * is deliberately still eligible: that's a real, if unusual, situation and
 * not the backlog case this guards against.
 *
 * `reminderInstant` throws on a malformed timezone or reminder time
 * (`LocalTimeError`, `src/domain/time/local.ts`/`zone.ts`). Computing it
 * inside a plain `Array#filter` would let one bad Game's row throw out of
 * the whole callback and silence every fixture behind it in the list — so
 * each row is evaluated in its own `try`/`catch` and a failure is recorded
 * and skipped, never allowed to abort the batch.
 *
 * Read-only — never touches the Durable Object, which is correct here
 * because nothing about deciding *which* fixtures are due affects capacity.
 */
export async function fixturesDueByLifecycle(
  db: Db,
  lifecycle: "scheduled" | "open",
  now: Date,
): Promise<{ due: DueFixture[]; failures: SweepFailure[] }> {
  const rows = await db
    .select({
      id: fixtures.id,
      gameId: fixtures.gameId,
      kicksOffAt: fixtures.kicksOffAt,
      durationMinutes: fixtures.durationMinutes,
      timezone: games.timezone,
      reminderDaysBefore: games.reminderDaysBefore,
      reminderLocalTime: games.reminderLocalTime,
    })
    .from(fixtures)
    .innerJoin(games, eq(fixtures.gameId, games.id))
    .where(eq(fixtures.lifecycle, lifecycle));

  const due: DueFixture[] = [];
  const failures: SweepFailure[] = [];

  for (const row of rows) {
    const endedAt = row.kicksOffAt.getTime() + row.durationMinutes * MINUTE_MS;
    if (endedAt <= now.getTime()) continue;

    const fixture: DueFixture = {
      id: row.id,
      gameId: row.gameId,
      kicksOffAt: row.kicksOffAt,
      game: {
        timezone: row.timezone,
        reminderDaysBefore: row.reminderDaysBefore,
        reminderLocalTime: row.reminderLocalTime,
      },
    };
    try {
      if (reminderInstant(fixture.game, fixture.kicksOffAt).getTime() <= now.getTime()) due.push(fixture);
    } catch (error) {
      failures.push({
        fixtureId: fixture.id,
        gameId: fixture.gameId,
        stage: "reminder-instant",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { due, failures };
}

interface RemindResult {
  remindersSent: number;
  remindersFailed: number;
  remindersDeferred: number;
  pushRemindersSent: number;
  pushRemindersFailed: number;
  guestsSkipped: number;
  failures: SweepFailure[];
}

/** Step 2: send the N-1 reminder for every `open` fixture whose reminder instant has passed. */
async function sendDueReminders(
  db: Db,
  notifier: Notifier,
  now: Date,
  responseTokenSecret: string,
): Promise<RemindResult> {
  const { due, failures } = await fixturesDueByLifecycle(db, "open", now);

  let remindersSent = 0;
  let remindersFailed = 0;
  let remindersDeferred = 0;
  let pushRemindersSent = 0;
  let pushRemindersFailed = 0;
  let guestsSkipped = 0;

  for (const fixture of due) {
    try {
      const [row] = await db
        .select({ fixture: fixtures, game: games })
        .from(fixtures)
        .innerJoin(games, eq(fixtures.gameId, games.id))
        .where(eq(fixtures.id, fixture.id));
      if (!row) continue;
      const { fixture: fixtureRow, game: gameRow } = row;

      const candidates = await eligiblePlayers(db, fixture.id);
      const alreadyLogged = await existingReminderLog(db, fixture.id);

      const toBuild: ReminderCandidate[] = [];
      for (const candidate of candidates) {
        if (alreadyLogged.has(candidate.playerId)) continue;
        if (candidate.isGuest || !candidate.email || candidate.email.trim() === "") {
          // BR-32: guests (and anyone with no usable address) are skipped
          // before a message is ever built — no message, no log row, not a
          // failure.
          //
          // The `.trim()` is load-bearing, not defensive tidying. A
          // `players.email` of `" "` is truthy, so it used to pass this guard,
          // get a token signed and a `queued` row inserted, then be trimmed to
          // empty inside `QuotaNotifier` and come back `NO_RECIPIENT_REASON` —
          // which the sweep treated as retryable and deleted, so the whole
          // cycle repeated on every single sweep run, forever, while raising a
          // false daily-ceiling alarm each time. Trimming *here*, at the same
          // place a null address is caught, makes "no usable address" the one
          // permanent, silent skip it always should have been.
          guestsSkipped++;
          continue;
        }
        toBuild.push(candidate);
      }

      if (toBuild.length === 0) continue;

      const pending = await buildReminderMessages({
        db,
        fixture: fixtureRow,
        game: gameRow,
        candidates: toBuild,
        responseTokenSecret,
        now,
      });

      const inserted = await insertQueuedLogRows(db, { fixtureId: fixture.id, notificationType: "n1" }, pending);
      if (inserted.length === 0) continue;

      let results;
      try {
        results = await notifier.send(inserted.map((entry) => entry.message));
      } catch (error) {
        // The notifier itself rejected — e.g. `QuotaNotifier.reserve()`
        // hitting a D1 error mid-batch. Whether any message in this batch
        // actually reached a provider before the rejection is unknowable
        // from here, so every row this batch inserted is marked `failed`
        // (ambiguous, not retried automatically — see `applySendResult` in `src/notify/delivery.ts`)
        // and the fixture is recorded as a failure. Critically this is
        // caught *here*, per fixture, rather than letting it propagate out
        // of `sendDueReminders` — a rejection from one fixture's send must
        // not stop every other due fixture from being tried on this run.
        const message = error instanceof Error ? error.message : String(error);
        for (const entry of inserted) {
          await db
            .update(notificationLog)
            .set({ status: "failed", error: message })
            .where(eq(notificationLog.id, entry.logId));
          // Split by channel — see `SweepResult.remindersSent`'s doc comment
          // for why `remindersFailed` must count only the email rows.
          if (entry.message.channel === "email") remindersFailed++;
          else pushRemindersFailed++;
        }
        failures.push({ fixtureId: fixture.id, gameId: fixture.gameId, stage: "send", message });
        continue;
      }

      // `results` and `inserted` are the same length, in the same order —
      // guaranteed by the Notifier contract (src/notify/notifier.ts) and by
      // both calls above being built from the one `inserted` array, so
      // pairing `inserted[i]` with `results[i]` by index never drifts. The
      // subsequent database write is still keyed by `entry.logId`, not by
      // `i` — the index only ever selects *which* entry to update, it is
      // never itself used to identify a row, so a bug that reordered
      // `results` (in violation of the contract) would misapply an outcome
      // to the wrong message content but could not misapply it to the wrong
      // `notification_log` row.
      //
      // The loop does one D1 write per message, sequentially, so it can abort
      // part-way through with rows still `queued`. Those rows are poison:
      // `existingReminderLog` counts `queued` as already handled, so nobody
      // would ever be reminded, marked failed, or counted — an invisible,
      // permanent hole with nothing to reap it. The `catch` below closes it by
      // marking every not-yet-applied row `failed` in one statement. Marking
      // them failed (rather than deleting them for retry) is deliberate and
      // follows this file's existing asymmetry: the notifier already returned
      // results, so a message whose result was never applied may well have
      // been delivered, and BR-19 treats a duplicate as strictly worse than a
      // miss. A reaper would work too, but this needs no new scheduled job,
      // no new query, and no new state — the recovery sits at the only place
      // that knows which rows were left behind.
      const deferredPlayerIds: string[] = [];
      const sendFailureReasons: string[] = [];
      let applied = 0;
      try {
        for (; applied < inserted.length; applied++) {
          const entry = inserted[applied];
          const result = results[applied];
          if (!entry) continue;
          const outcome = await applySendResult(db, entry, result, now);
          const isEmail = entry.message.channel === "email";
          if (outcome.kind === "sent") {
            if (isEmail) remindersSent++;
            else pushRemindersSent++;
          } else if (outcome.kind === "deferred") {
            // The push leg has no daily ceiling, so this can only
            // legitimately happen for the email row — a push landing here
            // regardless is folded into `pushRemindersFailed` rather than
            // `remindersDeferred`, which is documented as email-only.
            if (isEmail) {
              remindersDeferred++;
              deferredPlayerIds.push(entry.playerId);
            } else {
              pushRemindersFailed++;
            }
          } else if (isEmail) {
            remindersFailed++;
            sendFailureReasons.push(outcome.reason);
          } else {
            pushRemindersFailed++;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const orphaned = inserted.slice(applied);
        for (const entry of orphaned) {
          if (entry.message.channel === "email") remindersFailed++;
          else pushRemindersFailed++;
        }
        await markOrphanedRowsFailed(db, orphaned, `abandoned mid-apply: ${message}`);
        failures.push({
          fixtureId: fixture.id,
          gameId: fixture.gameId,
          stage: "apply",
          message: `${message} (${orphaned.length} row(s) left unapplied and marked failed)`,
        });
        continue;
      }

      if (deferredPlayerIds.length > 0) {
        // TR-31's durable signal for N-1 — the highest-volume notification in
        // the system, and the exact case TR-31 was filed about (a
        // `MAX_EMAILS_PER_DAY` typo failing closed to zero silently stopping
        // every reminder). Retried every sweep tick like N-4, so the same
        // collapse window applies — see `src/notify/ceiling-audit.ts`.
        await recordCeilingDeferral(db, {
          action: "fixture.reminder_email_deferred",
          notificationType: "n1",
          entityType: "fixture",
          entityId: fixture.id,
          playerIds: deferredPlayerIds,
          now,
          collapseWindowMs: CEILING_DEFERRAL_COLLAPSE_WINDOW_MS,
        });
      }

      if (sendFailureReasons.length > 0) {
        // A per-message failure is a real failure of the run, not just a
        // counter: without this, a provider outage that failed every reminder
        // would end in `handleScheduled` reporting success. One entry per
        // fixture (rather than per message) keeps a large squad from burying
        // every other fixture's failure, and carries a representative reason
        // so the cause is legible from the single log line the handler emits.
        failures.push({
          fixtureId: fixture.id,
          gameId: fixture.gameId,
          stage: "send",
          message: `${sendFailureReasons.length} of ${inserted.length} reminder(s) failed to send; first reason: ${sendFailureReasons[0]}`,
        });
      }
    } catch (error) {
      failures.push({
        fixtureId: fixture.id,
        gameId: fixture.gameId,
        stage: "prepare",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (pushRemindersFailed > 0) {
    // A total push outage never reaches `failures` (see that field's doc
    // comment above), and never should — but it must not be silent either.
    // This is the operator-visible trace of it: a warning, not an error,
    // since email reminders for this run were unaffected.
    console.warn(`openAndRemind: ${pushRemindersFailed} push reminder(s) failed to send this run`);
  }

  return {
    remindersSent,
    remindersFailed,
    remindersDeferred,
    pushRemindersSent,
    pushRemindersFailed,
    guestsSkipped,
    failures,
  };
}


/**
 * "All eligible players" for N-1 (§2.8's dedupe-key table): every current
 * squad member with a Response row for this fixture, i.e. the same set
 * `getFixtureWithSquad` shows a viewer, `withdrawn` excluded — a withdrawn
 * player is not a squad member any more and is not reminded (mirrors that
 * query's own filter, kept separate here only because this needs `email`
 * and `is_guest`, which that read model does not carry).
 */
async function eligiblePlayers(db: Db, fixtureId: string): Promise<ReminderCandidate[]> {
  return db
    .select({
      playerId: responses.playerId,
      name: players.name,
      email: players.email,
      isGuest: players.isGuest,
    })
    .from(responses)
    .innerJoin(players, eq(responses.playerId, players.id))
    .where(and(eq(responses.fixtureId, fixtureId), ne(responses.status, "withdrawn")));
}

/**
 * Player ids that already have an `n1:` notification_log row for this
 * fixture — sent or failed, both count as done; a `queued` row belongs to a
 * run currently in flight for this same player and also counts.
 *
 * Filtered to `channel: "email"` — load-bearing, not tidying. A player's
 * push row can outlive their email row: a ceiling refusal *deletes* the
 * email's `queued` row (`applySendResult`) precisely so a later sweep
 * retries it, but the push leg has no ceiling and its own row survives. If
 * this query counted either channel as "already told", the surviving push
 * row would permanently mask the deleted email row on every later tick —
 * the reminder email would never be retried, while a player with no device
 * at all keeps getting theirs retried correctly. Do not remove this filter.
 */
async function existingReminderLog(db: Db, fixtureId: string): Promise<Set<string>> {
  const rows = await db
    .select({ playerId: notificationLog.playerId })
    .from(notificationLog)
    .where(
      and(
        eq(notificationLog.fixtureId, fixtureId),
        eq(notificationLog.notificationType, "n1"),
        eq(notificationLog.channel, "email"),
      ),
    );
  return new Set(rows.map((r) => r.playerId));
}
