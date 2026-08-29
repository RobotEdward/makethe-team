import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/client.js";
import { fixtures, memberships, notificationLog, players, responses } from "../../src/db/schema.js";
import {
  CRON_DAILY_MATERIALISE,
  CRON_SWEEP,
  handleScheduled,
} from "../../src/cron/handler.js";
import { ERASED_NAME } from "../../src/domain/erase-player.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { createNotifier } from "../../src/notify/factory.js";
import { openAndRemind } from "../../src/sweep/open-and-remind.js";
import { retirePastFixtures } from "../../src/sweep/retire.js";
import {
  fillEmailQuota,
  insertFixture,
  insertGame,
  insertMembership,
  insertPlayer,
  insertSubscription,
  resetDatabase,
  testDb,
} from "../support/factories.js";

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

/** Adds an active owner to a game, so the attention email (N-4) has a recipient. */
async function addOwner(gameId: string, email: string): Promise<string> {
  const playerId = crypto.randomUUID();
  await db.insert(players).values({ id: playerId, name: "Olive Owner", email });
  await db.insert(memberships).values({ id: crypto.randomUUID(), gameId, playerId, role: "owner", active: true });
  return playerId;
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

  it("does not materialise on the sweep schedule", async () => {
    await handleScheduled(CRON_SWEEP, env, NOW);

    const rows = await db.select().from(fixtures);
    expect(rows).toHaveLength(0);
  });

  it("throws on an unrecognised schedule rather than failing silently", async () => {
    await expect(handleScheduled("*/10 * * * *", env, NOW)).rejects.toThrow(/Unrecognised cron/);
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

describe("handleScheduled: the sweep", () => {
  it("resolves on a healthy run with nothing due", async () => {
    await expect(handleScheduled(CRON_SWEEP, env, NOW)).resolves.toBeUndefined();
  });

  it("retires an open fixture whose kickoff plus duration has passed", async () => {
    const fixtureId = await insertOpenFixture("game-1", {
      kicksOffAt: new Date(NOW.getTime() - 2 * 3_600_000),
      durationMinutes: 60,
    });

    await handleScheduled(CRON_SWEEP, env, NOW);

    expect(await lifecycleOf(fixtureId)).toBe("played");
  });

  it("retires past fixtures even when open-and-remind reports a failure", async () => {
    // An invalid IANA timezone makes `reminderInstant` throw, which
    // `openAndRemind` records as a per-fixture failure rather than letting it
    // abort the run (src/sweep/open-and-remind.ts, `fixturesDueByLifecycle`).
    // Not yet ended (kickoff an hour from now, default 60-minute duration) —
    // deliberately distinct from the stale/backlog case, so the invalid
    // timezone is what causes the failure rather than the end-check skipping
    // it silently before `reminderInstant` is even attempted.
    const brokenGameId = await insertGame(db, { id: "game-broken", inviteToken: "invite-broken", timezone: "Not/AZone" });
    await insertOpenFixture(brokenGameId, {
      kicksOffAt: new Date(NOW.getTime() + 3_600_000),
    });

    const dueFixtureId = await insertOpenFixture("game-1", {
      kicksOffAt: new Date(NOW.getTime() - 2 * 3_600_000),
      durationMinutes: 60,
    });

    await expect(handleScheduled(CRON_SWEEP, env, NOW)).rejects.toThrow();

    // The rejection must not have short-circuited retirement: the healthy
    // fixture still has to retire regardless of the broken game's reminder failure.
    expect(await lifecycleOf(dueFixtureId)).toBe("played");
  });

  it("rejects and names the failure count when open-and-remind fails", async () => {
    // Not yet ended (kickoff an hour from now, default 60-minute duration) —
    // deliberately distinct from the stale/backlog case, so the invalid
    // timezone is what causes the failure rather than the end-check skipping
    // it silently before `reminderInstant` is even attempted.
    const brokenGameId = await insertGame(db, { id: "game-broken", inviteToken: "invite-broken", timezone: "Not/AZone" });
    await insertOpenFixture(brokenGameId, {
      kicksOffAt: new Date(NOW.getTime() + 3_600_000),
    });

    await expect(handleScheduled(CRON_SWEEP, env, NOW)).rejects.toThrow(
      /sweep failed for 1 fixture/,
    );
  });

  it("resolves cleanly when nothing failed, including a healthy reminder send", async () => {
    // game-1 is Europe/London, reminder 1 day before at local 09:00 (factory
    // defaults). Kickoff 2026-08-13T18:00 UTC -> reminder instant 2026-08-12T08:00 UTC.
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const remindNow = new Date("2026-08-12T09:00:00Z");
    const fixtureId = await insertOpenFixture("game-1", { kicksOffAt });
    await addRespondent(fixtureId, "player@example.com");

    await expect(handleScheduled(CRON_SWEEP, env, remindNow)).resolves.toBeUndefined();

    const logRows = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(logRows).toHaveLength(1);
    expect(logRows[0]?.status).toBe("sent");
  });

  it("stays idempotent across repeated sweeps: several runs over the same due fixture send one notification per player", async () => {
    // A fixture stays due across more than one sweep, so the sweep genuinely
    // runs several times before anything about it changes. `notification_log`'s
    // unique `dedupe_key` is what makes that safe, and this pins it by invoking
    // the sweep back-to-back — deliberately tighter than the hourly cadence, so
    // the guarantee is tested against the worst case rather than the scheduled
    // one. It was written during the temporary 5-minute testing cadence and is
    // kept at that tightness on purpose.
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const remindNow = new Date("2026-08-12T09:00:00Z");
    const fixtureId = await insertOpenFixture("game-1", { kicksOffAt });
    await addRespondent(fixtureId, "player-a@example.com");
    await addRespondent(fixtureId, "player-b@example.com");

    // Five consecutive ticks at the same instant, standing in for five
    // 5-minute-apart invocations where nothing about the fixture changed.
    for (let i = 0; i < 5; i++) {
      await expect(handleScheduled(CRON_SWEEP, env, remindNow)).resolves.toBeUndefined();
    }

    const logRows = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(logRows).toHaveLength(2);
    expect(logRows.every((r) => r.status === "sent")).toBe(true);
  });

  it("does not reject when a reminder is only deferred by the daily send ceiling", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const remindNow = new Date("2026-08-12T09:00:00Z");

    // Pre-filling today's quota to the configured ceiling makes
    // QuotaNotifier refuse every send this run with
    // DAILY_CEILING_REASON, which openAndRemind reports as `deferred`, not a
    // failure (src/sweep/open-and-remind.ts, `applyReminderResult`).
    await fillEmailQuota(db, remindNow.toISOString().slice(0, 10));

    const fixtureId = await insertOpenFixture("game-1", { kicksOffAt });
    await addRespondent(fixtureId, "player@example.com");

    await expect(handleScheduled(CRON_SWEEP, env, remindNow)).resolves.toBeUndefined();

    // Deferred, not sent or failed: the queued row was deleted so a future run retries it.
    expect(await db.select().from(responses).where(eq(responses.fixtureId, fixtureId))).toHaveLength(1);
  });

  it("reproduces the reviewer's stale-fixture case: no email sent, and it is retired in the same run", async () => {
    // A `scheduled` fixture whose kickoff was 10 days ago — the shape a
    // multi-day cron gap leaves behind. Fix round 1's finding: this used to
    // be opened and mailed "tomorrow", then retired by the very same tick.
    const playerId = crypto.randomUUID();
    await db.insert(players).values({ id: playerId, name: "Stale Squad Member", email: "stale@example.com" });
    await db.insert(memberships).values({
      id: crypto.randomUUID(),
      gameId: "game-1",
      playerId,
      role: "player",
      active: true,
    });

    const staleFixtureId = crypto.randomUUID();
    await db.insert(fixtures).values({
      id: staleFixtureId,
      gameId: "game-1",
      kicksOffAt: new Date(NOW.getTime() - 10 * 86_400_000),
      lifecycle: "scheduled",
      minPlayers: 10,
      maxPlayers: 14,
      prefersEvenNumbers: true,
      shortWarningOffsetHours: 12,
      durationMinutes: 60,
    });

    await expect(handleScheduled(CRON_SWEEP, env, NOW)).resolves.toBeUndefined();

    expect(await lifecycleOf(staleFixtureId)).toBe("played");
    expect(
      await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, staleFixtureId)),
    ).toHaveLength(0);
  });

  it("sends the owner attention email as sweep step 3 (N-4, BR-31)", async () => {
    // 9 hours before kickoff, inside the 12-hour warning window, 8 in against
    // a minimum of 10. Times are constructed explicitly, never derived from
    // the clock.
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const attentionNow = new Date("2026-08-13T09:00:00Z");
    const fixtureId = await insertOpenFixture("game-1", { kicksOffAt });
    await db.update(fixtures).set({ inCount: 8 }).where(eq(fixtures.id, fixtureId));
    await addOwner("game-1", "owner@example.com");

    await expect(handleScheduled(CRON_SWEEP, env, attentionNow)).resolves.toBeUndefined();

    const rows = await db
      .select()
      .from(notificationLog)
      .where(and(eq(notificationLog.fixtureId, fixtureId), eq(notificationLog.notificationType, "n4")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
  });

  it("nudges a subscribed organiser to post the open fixture to the group as sweep step 2b (N-11, M22)", async () => {
    // Past the game's reminder instant (1 day before, 09:00 Europe/London =
    // 2026-08-12T08:00Z) and before kickoff: the same moment the N-1 goes
    // out. Times constructed explicitly, never derived from the clock.
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const sweepNow = new Date("2026-08-12T10:00:00Z");
    const fixtureId = await insertOpenFixture("game-1", { kicksOffAt });
    const owner = await addOwner("game-1", "owner@example.com");
    await insertSubscription(db, owner, "https://push.example.com/owner-device");

    await expect(handleScheduled(CRON_SWEEP, env, sweepNow)).resolves.toBeUndefined();

    const rows = await db
      .select()
      .from(notificationLog)
      .where(and(eq(notificationLog.fixtureId, fixtureId), eq(notificationLog.notificationType, "n11")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.playerId).toBe(owner);
    expect(rows[0]?.dedupeKey).toBe(`push:n11:${fixtureId}:${owner}`);

    // And once only, however many sweeps follow.
    await expect(handleScheduled(CRON_SWEEP, env, new Date(sweepNow.getTime() + 3_600_000))).resolves.toBeUndefined();
    const again = await db
      .select()
      .from(notificationLog)
      .where(and(eq(notificationLog.fixtureId, fixtureId), eq(notificationLog.notificationType, "n11")));
    expect(again).toHaveLength(1);
  });

  it("retires past fixtures even when the attention step fails for want of CANCEL_TOKEN_SECRET", async () => {
    // Exactly production's situation at the time of writing: the binding is
    // not set, so `signCancelToken` throws by name. The attention email
    // cannot go out — but that must cost nothing else on the run.
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const attentionNow = new Date("2026-08-13T09:00:00Z");
    const shortFixtureId = await insertOpenFixture("game-1", { kicksOffAt });
    await db.update(fixtures).set({ inCount: 8 }).where(eq(fixtures.id, shortFixtureId));
    await addOwner("game-1", "owner@example.com");

    const endedFixtureId = await insertOpenFixture("game-1", {
      kicksOffAt: new Date(attentionNow.getTime() - 2 * 3_600_000),
      durationMinutes: 60,
    });

    await expect(
      handleScheduled(CRON_SWEEP, { ...env, CANCEL_TOKEN_SECRET: "" }, attentionNow),
    ).rejects.toThrow(/sweep failed for 1 fixture/);

    // Retirement ran anyway.
    expect(await lifecycleOf(endedFixtureId)).toBe("played");
    // And nothing half-built was left behind for the fixture that failed.
    expect(
      await db
        .select()
        .from(notificationLog)
        .where(eq(notificationLog.notificationType, "n4")),
    ).toHaveLength(0);
  });

  // The wiring, end to end: nothing erases anything until the sweep does, so
  // this proves the fifth step is actually reached by a real invocation rather
  // than only by `runDueErasures`' own tests.
  //
  // The squad and the full open fixture are not scenery. `runDueErasures`'
  // own tests always substitute their own `withdraw`, so the closure
  // `handleScheduled` actually passes — the one that binds `playerId`,
  // `actorPlayerId` and `fixtureId` onto the real Durable Object call — has no
  // other execution coverage anywhere in the suite. With them, a swapped
  // `playerId`/`fixtureId` or an `actorPlayerId` bound to the wrong person
  // fails here instead of passing silently into production. They also make
  // the promotion below real: the erasing player holds the fixture's only
  // slot, so their withdrawal has someone to promote.
  it("performs a due erasure, and tells the player it promotes off the waitlist", async () => {
    const gameId = await insertGame(db, { maxPlayers: 1 });

    const erasingId = await insertPlayer(db, {
      name: "Edward Cooper",
      email: "edward@example.com",
      erasesAt: new Date(NOW.getTime() - 3_600_000),
    });
    await insertMembership(db, gameId, erasingId, { role: "player", active: true });

    const waitingId = await insertPlayer(db, { name: "Waiting Winnie", email: "winnie@example.com" });
    await insertMembership(db, gameId, waitingId, { role: "player", active: true });

    const fixtureId = await insertFixture(db, gameId, {
      minPlayers: 1,
      maxPlayers: 1,
      kicksOffAt: new Date(NOW.getTime() + 7 * 86_400_000),
    });
    // Opened through the real path, which is also what creates the `pending`
    // response rows the capacity object then works from.
    await openFixture(db, fixtureId, NOW);
    // Through the real capacity path, so the waitlist position is genuine
    // rather than a hand-written `responses` row the object knows nothing of.
    for (const playerId of [erasingId, waitingId]) {
      await env.FIXTURE_CAPACITY.getByName(fixtureId).setResponse({
        playerId,
        intent: "in",
        actorPlayerId: null,
        source: "system",
        whenFull: "waitlist",
        now: NOW.getTime(),
      });
    }

    await handleScheduled(CRON_SWEEP, env, NOW);

    const [row] = await db.select().from(players).where(eq(players.id, erasingId));
    expect(row?.name).toBe(ERASED_NAME);
    expect(row?.email).toBeNull();
    expect(row?.erasedAt?.getTime()).toBe(NOW.getTime());

    // The withdrawal really went through the capacity object: the waiting
    // player holds the slot now.
    const [promotedResponse] = await db
      .select()
      .from(responses)
      .where(and(eq(responses.fixtureId, fixtureId), eq(responses.playerId, waitingId)));
    expect(promotedResponse?.status).toBe("in");
    expect(promotedResponse?.waitlistPosition).toBeNull();

    // And they were told. Without this the sweep would move a real person into
    // a fixture in silence — and it is the only path on which an
    // erasure-driven promotion happens at all.
    const n2 = await db
      .select()
      .from(notificationLog)
      .where(and(eq(notificationLog.playerId, waitingId), eq(notificationLog.notificationType, "n2")));
    expect(n2).toHaveLength(1);
    expect(n2[0]?.status).toBe("sent");
  });

  it("leaves an erasure whose window has not elapsed alone", async () => {
    const playerId = crypto.randomUUID();
    await db.insert(players).values({
      id: playerId,
      name: "Edward Cooper",
      email: "edward@example.com",
      erasesAt: new Date(NOW.getTime() + 3_600_000),
    });

    await handleScheduled(CRON_SWEEP, env, NOW);

    const [row] = await db.select().from(players).where(eq(players.id, playerId));
    expect(row?.name).toBe("Edward Cooper");
    expect(row?.erasedAt).toBeNull();
  });

  it("keeps reminders already committed even if retirement itself were to fail afterwards", async () => {
    // Pins the ordering by construction rather than leaving it incidental: if
    // a future edit reversed the two steps, or made a `retirePastFixtures`
    // failure somehow roll back or skip the reminder step's own writes, this
    // would catch it.
    //
    // `handleScheduled` builds its own `db`/`notifier` internally and offers
    // no seam to inject a failure into just one of its two steps — and
    // `vi.mock`ing `src/sweep/retire.js` does not intercept the call
    // `handleScheduled` makes under `vitest-pool-workers` (verified: the
    // mock's call count stayed 0 while the real function ran), so this
    // exercises the exact same two calls, in the exact same order, with the
    // exact same real `db`, that `handleScheduled`'s sweep branch makes.
    // Step 1 uses the real `db` throughout, so its commit is genuinely
    // durable in D1 before step 2 is ever attempted. Step 2 is handed a
    // `db` stand-in that throws the moment it is used, standing in for a
    // genuine mid-step outage (a rejected D1 call) without touching schema
    // or state any other test in this file depends on.
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const remindNow = new Date("2026-08-12T09:00:00Z");
    const fixtureId = await insertOpenFixture("game-1", { kicksOffAt });
    await addRespondent(fixtureId, "player@example.com");

    const notifier = createNotifier(env, db, remindNow);
    const remindResult = await openAndRemind(db, notifier, remindNow, env.RESPONSE_TOKEN_SECRET, env.FIXTURE_CAPACITY);
    expect(remindResult.remindersSent).toBe(1);
    expect(remindResult.failures).toHaveLength(0);

    // Committed to real D1 before retirement is ever attempted.
    const committedBefore = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(committedBefore).toHaveLength(1);
    expect(committedBefore[0]?.status).toBe("sent");

    const brokenDb = new Proxy(db, {
      get(): never {
        throw new Error("simulated retirement outage");
      },
    }) as Db;

    await expect(retirePastFixtures(brokenDb, remindNow)).rejects.toThrow(/simulated retirement outage/);

    // Still there: the induced failure in retirement did not touch — let
    // alone roll back — the reminder step's already-committed write.
    const committedAfter = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(committedAfter).toHaveLength(1);
    expect(committedAfter[0]?.status).toBe("sent");
  });
});
