import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { emailQuota, fixtures, notificationLog, players, responses } from "../../src/db/schema.js";
import {
  CRON_DAILY_MATERIALISE,
  CRON_HOURLY_SWEEP,
  handleScheduled,
} from "../../src/cron/handler.js";
import { insertGame, resetDatabase, testDb } from "../support/factories.js";

const db = testDb();
const NOW = new Date("2026-08-10T03:15:00Z");

/** Inserts an `open` fixture directly, bypassing `openFixture`/materialisation. */
async function insertOpenFixture(
  gameId: string,
  overrides: { kicksOffAt: Date; durationMinutes?: number },
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(fixtures).values({
    id,
    gameId,
    kicksOffAt: overrides.kicksOffAt,
    lifecycle: "open",
    minPlayers: 10,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: overrides.durationMinutes ?? 60,
  });
  return id;
}

/** Adds a player with a `pending` response to a fixture, so a reminder is due for them. */
async function addRespondent(fixtureId: string, email: string): Promise<void> {
  const playerId = crypto.randomUUID();
  await db.insert(players).values({ id: playerId, name: "Respondent", email });
  await db.insert(responses).values({
    id: crypto.randomUUID(),
    fixtureId,
    playerId,
    status: "pending",
    source: "system",
  });
}

async function lifecycleOf(fixtureId: string): Promise<string | undefined> {
  const [row] = await db.select({ lifecycle: fixtures.lifecycle }).from(fixtures).where(eq(fixtures.id, fixtureId));
  return row?.lifecycle;
}

beforeEach(async () => {
  await resetDatabase();
  await insertGame(db, { id: "game-1", inviteToken: "invite-1" });
});

describe("handleScheduled", () => {
  it("materialises fixtures on the daily schedule", async () => {
    await handleScheduled(CRON_DAILY_MATERIALISE, env, NOW);

    const rows = await db.select().from(fixtures);
    expect(rows).toHaveLength(5);
  });

  it("does not materialise on the hourly schedule", async () => {
    await handleScheduled(CRON_HOURLY_SWEEP, env, NOW);

    const rows = await db.select().from(fixtures);
    expect(rows).toHaveLength(0);
  });

  it("throws on an unrecognised schedule rather than failing silently", async () => {
    await expect(handleScheduled("*/5 * * * *", env, NOW)).rejects.toThrow(/Unrecognised cron/);
  });

  it("is safe to run twice", async () => {
    await handleScheduled(CRON_DAILY_MATERIALISE, env, NOW);
    await handleScheduled(CRON_DAILY_MATERIALISE, env, NOW);

    const rows = await db.select().from(fixtures);
    expect(rows).toHaveLength(5);
  });

  it("rejects when a game fails to materialise, naming the counts", async () => {
    await insertGame(db, { recurrenceRule: "FREQ=MONTHLY;BYDAY=TH" });

    await expect(handleScheduled(CRON_DAILY_MATERIALISE, env, NOW)).rejects.toThrow(
      /materialise failed for 1 of 2 games/,
    );
  });

  it("still materialises the healthy games before rejecting", async () => {
    await insertGame(db, { recurrenceRule: "FREQ=MONTHLY;BYDAY=TH" });

    await expect(handleScheduled(CRON_DAILY_MATERIALISE, env, NOW)).rejects.toThrow();

    // The rejection must not have short-circuited the sweep: game-1 is healthy
    // and its fixtures have to exist regardless of the other game's bad rule.
    const rows = await db.select().from(fixtures);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.gameId === "game-1")).toBe(true);
  });
});

describe("handleScheduled: the hourly sweep", () => {
  it("resolves on a healthy run with nothing due", async () => {
    await expect(handleScheduled(CRON_HOURLY_SWEEP, env, NOW)).resolves.toBeUndefined();
  });

  it("retires an open fixture whose kickoff plus duration has passed", async () => {
    const fixtureId = await insertOpenFixture("game-1", {
      kicksOffAt: new Date(NOW.getTime() - 2 * 3_600_000),
      durationMinutes: 60,
    });

    await handleScheduled(CRON_HOURLY_SWEEP, env, NOW);

    expect(await lifecycleOf(fixtureId)).toBe("played");
  });

  it("retires past fixtures even when open-and-remind reports a failure", async () => {
    // An invalid IANA timezone makes `reminderInstant` throw, which
    // `openAndRemind` records as a per-fixture failure rather than letting it
    // abort the run (src/sweep/open-and-remind.ts, `fixturesDueByLifecycle`).
    const brokenGameId = await insertGame(db, { id: "game-broken", inviteToken: "invite-broken", timezone: "Not/AZone" });
    await insertOpenFixture(brokenGameId, {
      kicksOffAt: new Date(NOW.getTime() - 100 * 86_400_000),
    });

    const dueFixtureId = await insertOpenFixture("game-1", {
      kicksOffAt: new Date(NOW.getTime() - 2 * 3_600_000),
      durationMinutes: 60,
    });

    await expect(handleScheduled(CRON_HOURLY_SWEEP, env, NOW)).rejects.toThrow();

    // The rejection must not have short-circuited retirement: the healthy
    // fixture still has to retire regardless of the broken game's reminder failure.
    expect(await lifecycleOf(dueFixtureId)).toBe("played");
  });

  it("rejects and names the failure count when open-and-remind fails", async () => {
    const brokenGameId = await insertGame(db, { id: "game-broken", inviteToken: "invite-broken", timezone: "Not/AZone" });
    await insertOpenFixture(brokenGameId, {
      kicksOffAt: new Date(NOW.getTime() - 100 * 86_400_000),
    });

    await expect(handleScheduled(CRON_HOURLY_SWEEP, env, NOW)).rejects.toThrow(
      /hourly sweep failed for 1 fixture/,
    );
  });

  it("resolves cleanly when nothing failed, including a healthy reminder send", async () => {
    // game-1 is Europe/London, reminder 1 day before at local 09:00 (factory
    // defaults). Kickoff 2026-08-13T18:00 UTC -> reminder instant 2026-08-12T08:00 UTC.
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const remindNow = new Date("2026-08-12T09:00:00Z");
    const fixtureId = await insertOpenFixture("game-1", { kicksOffAt });
    await addRespondent(fixtureId, "player@example.com");

    await expect(handleScheduled(CRON_HOURLY_SWEEP, env, remindNow)).resolves.toBeUndefined();

    const logRows = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(logRows).toHaveLength(1);
    expect(logRows[0]?.status).toBe("sent");
  });

  it("does not reject when a reminder is only deferred by the daily send ceiling", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const remindNow = new Date("2026-08-12T09:00:00Z");

    // MAX_EMAILS_PER_DAY is "50" (wrangler.jsonc); pre-filling today's quota
    // to that ceiling makes QuotaNotifier refuse every send this run with
    // DAILY_CEILING_REASON, which openAndRemind reports as `deferred`, not a
    // failure (src/sweep/open-and-remind.ts, `applyReminderResult`).
    await db.insert(emailQuota).values({ day: remindNow.toISOString().slice(0, 10), sentCount: 50 });

    const fixtureId = await insertOpenFixture("game-1", { kicksOffAt });
    await addRespondent(fixtureId, "player@example.com");

    await expect(handleScheduled(CRON_HOURLY_SWEEP, env, remindNow)).resolves.toBeUndefined();

    // Deferred, not sent or failed: the queued row was deleted so a future run retries it.
    expect(await db.select().from(responses).where(eq(responses.fixtureId, fixtureId))).toHaveLength(1);
  });
});
