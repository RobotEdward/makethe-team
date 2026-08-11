import { and, eq, ne } from "drizzle-orm";
import { chunk, INSERT_CHUNK_SIZE } from "../db/chunk.js";
import type { Db } from "../db/client.js";
import { fixtures, games, notificationLog, players, responses } from "../db/schema.js";
import { openFixture } from "../domain/open-fixture.js";
import { reminderInstant } from "../domain/reminder-time.js";
import { formatLocalDateTime } from "../domain/time/zone.js";
import { responseTokenExpiry, signResponseToken } from "../domain/token.js";
import type { Message, Notifier } from "../notify/notifier.js";
import { reminderKey } from "../notify/dedupe-key.js";
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

export interface SweepResult {
  fixturesOpened: number;
  remindersSent: number;
  remindersFailed: number;
  guestsSkipped: number;
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
 */
export async function openAndRemind(
  db: Db,
  notifier: Notifier,
  now: Date,
  responseTokenSecret: string,
): Promise<SweepResult> {
  const fixturesOpened = await openDueFixtures(db, now);
  const reminderResult = await sendDueReminders(db, notifier, now, responseTokenSecret);

  return { fixturesOpened, ...reminderResult };
}

interface GameTiming {
  timezone: string;
  reminderDaysBefore: number;
  reminderLocalTime: string;
}

/** Step 1: open every `scheduled` fixture whose reminder instant has passed. */
async function openDueFixtures(db: Db, now: Date): Promise<number> {
  const due = await fixturesDueByLifecycle(db, "scheduled", now);

  let opened = 0;
  for (const fixture of due) {
    const result = await openFixture(db, fixture.id, now);
    if (result.opened) opened++;
  }
  return opened;
}

/**
 * Fixtures in `lifecycle` whose `reminderInstant` (computed from their
 * Game's timezone and reminder configuration) has passed. Read-only — never
 * touches the Durable Object, which is correct here because nothing about
 * deciding *which* fixtures are due affects capacity.
 */
async function fixturesDueByLifecycle(
  db: Db,
  lifecycle: "scheduled" | "open",
  now: Date,
): Promise<Array<{ id: string; kicksOffAt: Date; game: GameTiming }>> {
  const rows = await db
    .select({
      id: fixtures.id,
      kicksOffAt: fixtures.kicksOffAt,
      timezone: games.timezone,
      reminderDaysBefore: games.reminderDaysBefore,
      reminderLocalTime: games.reminderLocalTime,
    })
    .from(fixtures)
    .innerJoin(games, eq(fixtures.gameId, games.id))
    .where(eq(fixtures.lifecycle, lifecycle));

  return rows
    .map((row) => ({
      id: row.id,
      kicksOffAt: row.kicksOffAt,
      game: {
        timezone: row.timezone,
        reminderDaysBefore: row.reminderDaysBefore,
        reminderLocalTime: row.reminderLocalTime,
      },
    }))
    .filter((fixture) => reminderInstant(fixture.game, fixture.kicksOffAt).getTime() <= now.getTime());
}

interface ReminderCandidate {
  playerId: string;
  name: string;
  email: string | null;
  isGuest: boolean;
}

interface ReminderRow {
  logId: string;
  dedupeKey: string;
  playerId: string;
}

interface PendingReminder extends ReminderRow {
  message: Message;
}

/** Step 2: send the N-1 reminder for every `open` fixture whose reminder instant has passed. */
async function sendDueReminders(
  db: Db,
  notifier: Notifier,
  now: Date,
  responseTokenSecret: string,
): Promise<{ remindersSent: number; remindersFailed: number; guestsSkipped: number }> {
  const due = await fixturesDueByLifecycle(db, "open", now);

  let remindersSent = 0;
  let remindersFailed = 0;
  let guestsSkipped = 0;

  for (const fixture of due) {
    const [row] = await db
      .select({ fixture: fixtures, game: games })
      .from(fixtures)
      .innerJoin(games, eq(fixtures.gameId, games.id))
      .where(eq(fixtures.id, fixture.id));
    if (!row) continue;
    const fixtureRow = row.fixture;
    const gameRow = row.game;

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

    const results = await notifier.send(inserted.map((entry) => entry.message));

    for (let i = 0; i < inserted.length; i++) {
      const entry = inserted[i];
      const result = results[i];
      if (!entry) continue;
      if (result?.ok) {
        await db
          .update(notificationLog)
          .set({ status: "sent", providerMessageId: result.providerMessageId, sentAt: now })
          .where(eq(notificationLog.id, entry.logId));
        remindersSent++;
      } else {
        await db
          .update(notificationLog)
          .set({ status: "failed", error: result?.error ?? "notifier-contract-violation" })
          .where(eq(notificationLog.id, entry.logId));
        remindersFailed++;
      }
    }
  }

  return { remindersSent, remindersFailed, guestsSkipped };
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

/** Player ids that already have an `n1:` notification_log row for this fixture — sent, queued or failed, all count. */
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
      // No `/leave` route exists yet (BR-22 is not fully satisfied — see
      // task-15-report.md). This points at the same, real, working
      // response page the two links above use rather than a path that
      // would 404: it is scoped to this player and fixture, so at least it
      // lets them reach a genuine page and mark themselves "out" for this
      // fixture. It does not remove them from the squad or stop future
      // reminders — a dedicated `/leave/:token` route with its own
      // POST-to-confirm step is still required before this is honest.
      leaveUrl: `${SITE_ORIGIN}/r/${token}`,
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
