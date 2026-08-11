import { and, eq, ne } from "drizzle-orm";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import type { Db } from "../db/client.js";
import { fixtures, games, notificationLog, players, responses } from "../db/schema.js";
import { openFixture } from "../domain/open-fixture.js";
import { reminderInstant } from "../domain/reminder-time.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { responseTokenExpiry, signResponseToken } from "../domain/token.js";
import type { Message, Notifier, SendResult } from "../notify/notifier.js";
import { reminderKey } from "../notify/dedupe-key.js";
import { DAILY_CEILING_REASON, NO_RECIPIENT_REASON } from "../notify/quota.js";
import { renderReminderEmail } from "../notify/templates/reminder.js";

/**
 * The site's own origin, used to build the absolute links every reminder
 * email carries. There is no `BASE_URL` binding (see `src/env.ts`) — the
 * Worker is only ever deployed at this custom domain (`wrangler.jsonc`), and
 * every test in the repo that needs an absolute URL already hardcodes this
 * same string (e.g. `test/routes/respond-get.test.ts`). If a second
 * environment with a different origin ever exists, this is the one place
 * that needs to change.
 */
const SITE_ORIGIN = "https://makethe.team";

/** One fixture (or game) the sweep could not fully process, and why. */
export interface SweepFailure {
  fixtureId: string;
  gameId: string | null;
  stage: "reminder-instant" | "open" | "prepare" | "send";
  message: string;
}

export interface SweepResult {
  fixturesOpened: number;
  remindersSent: number;
  remindersFailed: number;
  /**
   * Reminders that definitely did not go out (daily ceiling reached, or no
   * usable recipient) and whose `notification_log` row was therefore removed
   * rather than left `failed`, so the next sweep run retries them. See
   * `applyReminderResult` for the reasoning.
   */
  remindersDeferred: number;
  guestsSkipped: number;
  /**
   * Every fixture (or game) whose processing failed outright — a bad
   * timezone, a rejected notifier call, a database error — recorded here
   * instead of aborting the run. One broken fixture must never silence every
   * other Game's reminder that hour (mirrors `materialiseFixtures`).
   */
  failures: SweepFailure[];
}

/**
 * The hourly sweep's first two steps (§2.4): open fixtures whose reminder
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
 * every other Game that hour.
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

interface DueFixture {
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

/**
 * Fixtures in `lifecycle` whose `reminderInstant` (computed from their
 * Game's timezone and reminder configuration) has passed.
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
async function fixturesDueByLifecycle(
  db: Db,
  lifecycle: "scheduled" | "open",
  now: Date,
): Promise<{ due: DueFixture[]; failures: SweepFailure[] }> {
  const rows = await db
    .select({
      id: fixtures.id,
      gameId: fixtures.gameId,
      kicksOffAt: fixtures.kicksOffAt,
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

interface ReminderCandidate {
  playerId: string;
  name: string;
  email: string | null;
  isGuest: boolean;
}

interface PendingReminder {
  logId: string;
  dedupeKey: string;
  playerId: string;
  message: Message;
}

interface RemindResult {
  remindersSent: number;
  remindersFailed: number;
  remindersDeferred: number;
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
        if (candidate.isGuest || !candidate.email) {
          // BR-32: guests (and anyone with no address) are skipped before a
          // message is ever built — no message, no log row, not a failure.
          guestsSkipped++;
          continue;
        }
        toBuild.push(candidate);
      }

      if (toBuild.length === 0) continue;

      const pending = await buildReminderMessages({
        fixture: fixtureRow,
        game: gameRow,
        candidates: toBuild,
        responseTokenSecret,
      });

      const inserted = await insertQueuedLogRows(db, fixture.id, pending);
      if (inserted.length === 0) continue;

      let results;
      try {
        results = await notifier.send(inserted.map((entry) => entry.message));
      } catch (error) {
        // The notifier itself rejected — e.g. `QuotaNotifier.reserve()`
        // hitting a D1 error mid-batch. Whether any message in this batch
        // actually reached a provider before the rejection is unknowable
        // from here, so every row this batch inserted is marked `failed`
        // (ambiguous, not retried automatically — see `applyReminderResult`)
        // and the fixture is recorded as a failure. Critically this is
        // caught *here*, per fixture, rather than letting it propagate out
        // of `sendDueReminders` — a rejection from one fixture's send must
        // not stop every other due fixture from being tried this hour.
        const message = error instanceof Error ? error.message : String(error);
        for (const entry of inserted) {
          await db
            .update(notificationLog)
            .set({ status: "failed", error: message })
            .where(eq(notificationLog.id, entry.logId));
          remindersFailed++;
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
      for (let i = 0; i < inserted.length; i++) {
        const entry = inserted[i];
        const result = results[i];
        if (!entry) continue;
        const outcome = await applyReminderResult(db, entry, result, now);
        if (outcome === "sent") remindersSent++;
        else if (outcome === "failed") remindersFailed++;
        else remindersDeferred++;
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

  return { remindersSent, remindersFailed, remindersDeferred, guestsSkipped, failures };
}

/**
 * Apply one `SendResult` to its `notification_log` row, and report which of
 * three things happened.
 *
 * The asymmetry here is the point: a `SendResult` reports one of three
 * genuinely different situations, and treating them the same loses a real
 * reminder.
 *
 * - **Sent.** Recorded `sent` with the provider id.
 * - **Definitely did not send** (`DAILY_CEILING_REASON`,
 *   `NO_RECIPIENT_REASON`) — the message never left `QuotaNotifier`, so
 *   nothing can have reached a real inbox. It is therefore safe to retry,
 *   and retried automatically: the `queued` row is *removed* rather than
 *   marked `failed`, so the next sweep run's "already logged" check does not
 *   see this player and tries again. Deleting after the attempt, rather than
 *   never inserting the row at all, is what insert-before-send protects —
 *   the row existed for the whole duration of the attempt, so a crash
 *   between the two writes below still leaves a `queued` row a future run
 *   will not double-send against, just an unreachable one it can safely
 *   clean up and retry rather than one that blocks it.
 * - **Ambiguous** (any other `ok: false`, e.g. a real provider error) — the
 *   message *may* have reached the provider before the failure was
 *   reported. Recorded `failed` and left alone: retrying an ambiguous
 *   failure risks sending the same reminder twice, which BR-19 treats as
 *   strictly worse than the player missing one.
 */
async function applyReminderResult(
  db: Db,
  entry: PendingReminder,
  result: SendResult | undefined,
  now: Date,
): Promise<"sent" | "failed" | "deferred"> {
  if (result?.ok) {
    await db
      .update(notificationLog)
      .set({ status: "sent", providerMessageId: result.providerMessageId, sentAt: now })
      .where(eq(notificationLog.id, entry.logId));
    return "sent";
  }

  const reason = result?.error;
  if (reason === DAILY_CEILING_REASON || reason === NO_RECIPIENT_REASON) {
    await db.delete(notificationLog).where(eq(notificationLog.id, entry.logId));
    return "deferred";
  }

  await db
    .update(notificationLog)
    .set({ status: "failed", error: reason ?? "notifier-contract-violation" })
    .where(eq(notificationLog.id, entry.logId));
  return "failed";
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

/** Player ids that already have an `n1:` notification_log row for this fixture — sent or failed, both count as done; a `queued` row belongs to a run currently in flight for this same player and also counts. */
async function existingReminderLog(db: Db, fixtureId: string): Promise<Set<string>> {
  const rows = await db
    .select({ playerId: notificationLog.playerId })
    .from(notificationLog)
    .where(and(eq(notificationLog.fixtureId, fixtureId), eq(notificationLog.notificationType, "n1")));
  return new Set(rows.map((r) => r.playerId));
}

async function buildReminderMessages(params: {
  fixture: typeof fixtures.$inferSelect;
  game: typeof games.$inferSelect;
  candidates: ReminderCandidate[];
  responseTokenSecret: string;
}): Promise<PendingReminder[]> {
  const { fixture, game, candidates, responseTokenSecret } = params;

  const kicksOffAtLocal = formatLocalDateTime(fixture.kicksOffAt, game.timezone);
  const inCount = fixture.inCount;
  const spotsLeft = Math.max(0, fixture.maxPlayers - fixture.inCount);
  const expiresAt = responseTokenExpiry(fixture.kicksOffAt).getTime();

  const pending: PendingReminder[] = [];
  for (const candidate of candidates) {
    // Filtered by the caller, but narrowed again here so the compiler — not
    // just the runtime check — refuses to let a null email reach `Message.to`.
    const email = candidate.email;
    if (!email) continue;

    const token = await signResponseToken(
      { playerId: candidate.playerId, fixtureId: fixture.id, expiresAt },
      responseTokenSecret,
    );

    const rendered = renderReminderEmail({
      playerName: candidate.name,
      gameName: game.name,
      venueName: fixture.venueOverride ?? game.venueName,
      kicksOffAtLocal,
      inCount,
      spotsLeft,
      respondInUrl: `${SITE_ORIGIN}/r/${token}?intent=in`,
      respondOutUrl: `${SITE_ORIGIN}/r/${token}?intent=out`,
      // `GET /leave/:token` (src/routes/respond.ts) exists as of task-15 fix
      // round 1 — it is real and it works, but it is not yet self-service:
      // it tells the player plainly that leaving isn't self-service yet and
      // to contact whoever organises the Game. BR-22 will be fully satisfied
      // once a later milestone adds the write path; this link is honest
      // about the interim state rather than 404ing or pretending to act.
      leaveUrl: `${SITE_ORIGIN}/leave/${token}`,
    });

    pending.push({
      logId: crypto.randomUUID(),
      dedupeKey: reminderKey(fixture.id, candidate.playerId),
      playerId: candidate.playerId,
      message: {
        channel: "email",
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        dedupeKey: reminderKey(fixture.id, candidate.playerId),
      },
    });
  }
  return pending;
}

/**
 * Insert-before-send (BR-19): every row lands as `queued` before this
 * function returns, and only rows that actually landed (an `onConflictDoNothing`
 * against the unique `dedupe_key` index handles a concurrent sweep run
 * choosing the same player) are sent. A crash between this insert and the
 * send below leaves a `queued` row that the next sweep run will not retry —
 * lost, not duplicated, which is the safe direction (§2.4).
 */
async function insertQueuedLogRows(
  db: Db,
  fixtureId: string,
  pending: PendingReminder[],
): Promise<PendingReminder[]> {
  const insertedIds = new Set<string>();

  for (const batch of chunk(pending, INSERT_CHUNK_SIZE)) {
    const inserted = await db
      .insert(notificationLog)
      .values(
        batch.map((entry) => ({
          id: entry.logId,
          dedupeKey: entry.dedupeKey,
          notificationType: "n1" as const,
          fixtureId,
          playerId: entry.playerId,
          channel: "email" as const,
          status: "queued" as const,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: notificationLog.id });
    inserted.forEach((row) => insertedIds.add(row.id));
  }

  return pending.filter((entry) => insertedIds.has(entry.logId));
}
