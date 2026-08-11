import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb, type Db } from "../../src/db/client.js";
import { auditLog, fixtures, memberships, notificationLog, players } from "../../src/db/schema.js";
import { openFixture } from "../../src/domain/open-fixture.js";
import { openAndRemind } from "../../src/sweep/open-and-remind.js";
import type { Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { insertGame, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const SECRET = "test-secret";

/** Records every message it was sent, in order, so a test can assert on it. */
class RecordingNotifier implements Notifier {
  readonly sent: Message[][] = [];
  /** Player emails (via `to`) this instance should report a failure for. */
  readonly failFor = new Set<string>();
  /** Player emails this instance should report as refused by the daily ceiling. */
  readonly ceilingFor = new Set<string>();

  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.sent.push([...messages]);
    return Promise.resolve(
      messages.map((m): SendResult => {
        if (this.ceilingFor.has(m.to)) return { ok: false, error: "daily-ceiling-reached" };
        if (this.failFor.has(m.to)) return { ok: false, error: "simulated-provider-failure" };
        return { ok: true, providerMessageId: `prov-${m.dedupeKey}` };
      }),
    );
  }
}

/**
 * Simulates `QuotaNotifier.reserve()` hitting a D1 error mid-batch: `send`
 * rejects outright rather than returning `SendResult`s. Every batch it is
 * asked to send is recorded first, exactly like `RecordingNotifier`, so a
 * test can tell whether a later fixture's batch was ever attempted.
 */
class RejectingNotifier implements Notifier {
  readonly sent: Message[][] = [];
  /** Fixture ids (matched by `dedupeKey` prefix `n1:<fixtureId>:`) to reject sends for. */
  readonly rejectForFixture = new Set<string>();

  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.sent.push([...messages]);
    const first = messages[0];
    if (first && this.rejectForFixture.has(first.dedupeKey.split(":")[1] ?? "")) {
      return Promise.reject(new Error("simulated D1 failure inside QuotaNotifier.reserve()"));
    }
    return Promise.resolve(messages.map((m): SendResult => ({ ok: true, providerMessageId: `prov-${m.dedupeKey}` })));
  }
}

interface SeedOptions {
  kicksOffAt: Date;
  timezone?: string;
  reminderDaysBefore?: number;
  reminderLocalTime?: string;
  lifecycle?: "scheduled" | "open";
  minPlayers?: number;
  maxPlayers?: number;
  squad: Array<{ id: string; name: string; email: string | null; isGuest?: boolean }>;
}

async function seedFixture(opts: SeedOptions): Promise<{ gameId: string; fixtureId: string }> {
  const gameId = await insertGame(db, {
    timezone: opts.timezone ?? "Europe/London",
    reminderDaysBefore: opts.reminderDaysBefore ?? 1,
    reminderLocalTime: opts.reminderLocalTime ?? "09:00",
  });
  const fixtureId = crypto.randomUUID();

  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: opts.kicksOffAt,
    minPlayers: opts.minPlayers ?? 10,
    maxPlayers: opts.maxPlayers ?? 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
  });

  for (const member of opts.squad) {
    await db
      .insert(players)
      .values({ id: member.id, name: member.name, email: member.email, isGuest: member.isGuest ?? false });
    await db.insert(memberships).values({
      id: `m-${member.id}`,
      gameId,
      playerId: member.id,
      role: "player",
      active: true,
    });
  }

  if (opts.lifecycle === "open" || opts.lifecycle === undefined) {
    // Open the fixture "in the past" relative to any `now` these tests use,
    // so opening itself never fires a reminder here — that's exercised by
    // its own test below.
    await openFixture(db, fixtureId, new Date(opts.kicksOffAt.getTime() - 100 * 86_400_000));
  }

  return { gameId, fixtureId };
}

const squad = (n: number, prefix = crypto.randomUUID().slice(0, 8)): SeedOptions["squad"] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    name: `Player ${i}`,
    email: `${prefix}-${i}@example.com`,
  }));

beforeEach(async () => {
  await resetDatabase();
});

describe("openAndRemind", () => {
  it("sends a reminder once the reminder instant has passed, and not before", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z"); // Thu 19:00 BST
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: squad(3) });
    const notifier = new RecordingNotifier();

    const before = await openAndRemind(db, notifier, new Date("2026-08-12T07:59:00Z"), SECRET);
    expect(before.remindersSent).toBe(0);
    expect(notifier.sent).toHaveLength(0);

    const after = await openAndRemind(db, notifier, new Date("2026-08-12T08:00:00Z"), SECRET);
    expect(after.remindersSent).toBe(3);
    expect(notifier.sent.flat()).toHaveLength(3);

    const logRows = await db
      .select()
      .from(notificationLog)
      .where(and(eq(notificationLog.fixtureId, fixtureId), eq(notificationLog.notificationType, "n1")));
    expect(logRows).toHaveLength(3);
    expect(logRows.every((r) => r.status === "sent")).toBe(true);
    expect(logRows.every((r) => r.providerMessageId !== null)).toBe(true);
  });

  it("running the sweep twice sends exactly one email per player (BR-19)", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    await seedFixture({ kicksOffAt, squad: squad(4) });
    const notifier = new RecordingNotifier();
    const now = new Date("2026-08-12T09:00:00Z");

    const first = await openAndRemind(db, notifier, now, SECRET);
    const second = await openAndRemind(db, notifier, now, SECRET);

    expect(first.remindersSent).toBe(4);
    expect(second.remindersSent).toBe(0);
    expect(notifier.sent.flat()).toHaveLength(4);
  });

  it("a fixture opened early by an Owner still reminds at the scheduled time, not at opening", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    // Seed as `scheduled`; open it "early" ourselves well before the reminder instant.
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: squad(2), lifecycle: "scheduled" });
    await openFixture(db, fixtureId, new Date("2026-08-10T12:00:00Z"));

    const notifier = new RecordingNotifier();

    // Well after the early open, but before the scheduled reminder instant (08:00Z on the 12th).
    const stillEarly = await openAndRemind(db, notifier, new Date("2026-08-11T12:00:00Z"), SECRET);
    expect(stillEarly.remindersSent).toBe(0);

    const atReminderTime = await openAndRemind(db, notifier, new Date("2026-08-12T08:00:00Z"), SECRET);
    expect(atReminderTime.remindersSent).toBe(2);
  });

  it("opens a scheduled fixture whose reminder instant has passed, and only that", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: squad(2), lifecycle: "scheduled" });
    const notifier = new RecordingNotifier();

    const result = await openAndRemind(db, notifier, new Date("2026-08-12T08:00:00Z"), SECRET);

    expect(result.fixturesOpened).toBe(1);
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.lifecycle).toBe("open");
    // Opening and reminding run in the same sweep pass once open, so the reminder
    // for the squad also goes out immediately since the reminder instant has already passed.
    expect(result.remindersSent).toBe(2);
  });

  it("leaves a scheduled fixture untouched before its reminder instant", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: squad(2), lifecycle: "scheduled" });
    const notifier = new RecordingNotifier();

    const result = await openAndRemind(db, notifier, new Date("2026-08-11T00:00:00Z"), SECRET);

    expect(result.fixturesOpened).toBe(0);
    expect(result.remindersSent).toBe(0);
    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.lifecycle).toBe("scheduled");
  });

  it("does not open or remind a stale scheduled fixture whose kickoff-plus-duration has already passed", async () => {
    // A backlog shape: both the reminder instant and the fixture's own end
    // are in the past relative to `now` (fix round 1, finding: a cron gap
    // must not turn into a "tomorrow" email for a game that already finished).
    const kicksOffAt = new Date("2026-08-01T18:00:00Z");
    const now = new Date("2026-08-11T09:00:00Z");
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: squad(1), lifecycle: "scheduled" });
    const notifier = new RecordingNotifier();

    const result = await openAndRemind(db, notifier, now, SECRET);

    expect(result.fixturesOpened).toBe(0);
    expect(result.remindersSent).toBe(0);
    expect(result.failures).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0);

    const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
    expect(fixture?.lifecycle).toBe("scheduled");
    expect(await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId))).toHaveLength(0);
  });

  it("does not remind a stale open fixture whose kickoff-plus-duration has already passed", async () => {
    const kicksOffAt = new Date("2026-08-01T18:00:00Z");
    const now = new Date("2026-08-11T09:00:00Z");
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: squad(1), lifecycle: "open" });
    const notifier = new RecordingNotifier();

    const result = await openAndRemind(db, notifier, now, SECRET);

    expect(result.remindersSent).toBe(0);
    expect(result.failures).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0);
    expect(await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId))).toHaveLength(0);
  });

  it("still reminds a fixture that has kicked off but not yet ended (mid-game)", async () => {
    // 90 minutes into a 120-minute fixture: kicked off, not yet ended, and its
    // reminder instant (a day before) is naturally long past — a real, if
    // unusual, situation that must stay distinct from the stale/backlog case.
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const now = new Date(kicksOffAt.getTime() + 90 * 60_000);
    const { fixtureId } = await seedFixture({
      kicksOffAt,
      squad: squad(1),
      lifecycle: "open",
      // seedFixture's default duration is 60; override via a direct update so
      // "mid-game" (90 minutes in) is unambiguous.
    });
    await db.update(fixtures).set({ durationMinutes: 120 }).where(eq(fixtures.id, fixtureId));
    const notifier = new RecordingNotifier();

    const result = await openAndRemind(db, notifier, now, SECRET);

    expect(result.remindersSent).toBe(1);
    expect(result.failures).toHaveLength(0);
    const logRows = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(logRows).toHaveLength(1);
    expect(logRows[0]?.status).toBe("sent");
  });

  it("a normal future fixture is entirely unaffected by the end check", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const now = new Date("2026-08-12T09:00:00Z");
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: squad(2), lifecycle: "open" });
    const notifier = new RecordingNotifier();

    const result = await openAndRemind(db, notifier, now, SECRET);

    expect(result.remindersSent).toBe(2);
    expect(result.failures).toHaveLength(0);
    expect(await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId))).toHaveLength(2);
  });

  it("skips guests: no message, no log row, not a failure", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const mixed: SeedOptions["squad"] = [
      { id: "p-real", name: "Real Player", email: "real@example.com" },
      { id: "p-guest", name: "Guest Player", email: null, isGuest: true },
    ];
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: mixed });
    const notifier = new RecordingNotifier();

    const result = await openAndRemind(db, notifier, new Date("2026-08-12T09:00:00Z"), SECRET);

    expect(result.remindersSent).toBe(1);
    expect(result.guestsSkipped).toBe(1);
    expect(notifier.sent.flat()).toHaveLength(1);
    expect(notifier.sent.flat()[0]?.to).toBe("real@example.com");

    const logRows = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(logRows).toHaveLength(1);
    expect(logRows[0]?.playerId).toBe("p-real");
  });

  it("a send failure marks that row failed, does not block others, and is not retried", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const mixed: SeedOptions["squad"] = [
      { id: "p-ok", name: "OK Player", email: "ok@example.com" },
      { id: "p-bad", name: "Bad Player", email: "bad@example.com" },
    ];
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: mixed });
    const notifier = new RecordingNotifier();
    notifier.failFor.add("bad@example.com");
    const now = new Date("2026-08-12T09:00:00Z");

    const result = await openAndRemind(db, notifier, now, SECRET);

    expect(result.remindersSent).toBe(1);
    expect(result.remindersFailed).toBe(1);
    // A counter alone is not enough: `handleScheduled` rejects only on a
    // non-empty `failures`, so without this the twenty-four-reminders-all-fail
    // case would be recorded by Cloudflare as a completely healthy run. The
    // entry must carry enough to act on — which fixture, how many, and why.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ fixtureId, stage: "send" });
    expect(result.failures[0]?.message).toContain("1 of 2");
    expect(result.failures[0]?.message).toContain("simulated-provider-failure");

    const rows = await db.select().from(notificationLog);
    const okRow = rows.find((r) => r.playerId === "p-ok");
    const badRow = rows.find((r) => r.playerId === "p-bad");
    expect(okRow?.status).toBe("sent");
    expect(badRow?.status).toBe("failed");
    expect(badRow?.error).toBe("simulated-provider-failure");

    // A second run must not retry the failed row — it already has a log row.
    const second = await openAndRemind(db, notifier, now, SECRET);
    expect(second.remindersSent).toBe(0);
    expect(second.remindersFailed).toBe(0);
    expect(second.failures).toHaveLength(0);
    expect(await db.select().from(notificationLog)).toHaveLength(2);
  });

  it("sends the DST-crossing fixture's reminder at 09:00 local", async () => {
    // Thursday 29 October 2026, 19:00 GMT kickoff — reminder due Wed 28 Oct 09:00 GMT (09:00Z).
    const kicksOffAt = new Date("2026-10-29T19:00:00Z");
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: squad(1) });
    const notifier = new RecordingNotifier();

    const tooEarly = await openAndRemind(db, notifier, new Date("2026-10-28T08:59:00Z"), SECRET);
    expect(tooEarly.remindersSent).toBe(0);

    const onTime = await openAndRemind(db, notifier, new Date("2026-10-28T09:00:00Z"), SECRET);
    expect(onTime.remindersSent).toBe(1);

    const logRows = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(logRows).toHaveLength(1);
  });

  it("a rejecting notifier for one fixture does not stop reminders for other fixtures that hour (fix round 1, finding 1)", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const { fixtureId: badFixtureId } = await seedFixture({ kicksOffAt, squad: squad(2) });
    const { fixtureId: goodFixtureId } = await seedFixture({ kicksOffAt, squad: squad(2) });

    const notifier = new RejectingNotifier();
    notifier.rejectForFixture.add(badFixtureId);
    const now = new Date("2026-08-12T09:00:00Z");

    const result = await openAndRemind(db, notifier, now, SECRET);

    // The healthy fixture still got its reminders.
    expect(result.remindersSent).toBe(2);
    expect(result.remindersFailed).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ fixtureId: badFixtureId, stage: "send" });

    const badRows = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, badFixtureId));
    expect(badRows).toHaveLength(2);
    expect(badRows.every((r) => r.status === "failed")).toBe(true);

    const goodRows = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, goodFixtureId));
    expect(goodRows).toHaveLength(2);
    expect(goodRows.every((r) => r.status === "sent")).toBe(true);
  });

  it("one game with an invalid timezone does not silence every other game's reminders (fix round 1, finding 2)", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const { fixtureId: badFixtureId } = await seedFixture({
      kicksOffAt,
      timezone: "Not/AZone",
      squad: squad(1),
    });
    const { fixtureId: goodFixtureId } = await seedFixture({ kicksOffAt, squad: squad(2) });

    const notifier = new RecordingNotifier();
    const now = new Date("2026-08-12T09:00:00Z");

    const result = await openAndRemind(db, notifier, now, SECRET);

    expect(result.remindersSent).toBe(2);
    expect(result.failures.some((f) => f.fixtureId === badFixtureId && f.stage === "reminder-instant")).toBe(true);

    const goodRows = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, goodFixtureId));
    expect(goodRows).toHaveLength(2);
    expect(await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, badFixtureId))).toHaveLength(
      0,
    );
  });

  it("a reminder refused by the daily ceiling is retried and sent once quota is available (fix round 1, finding 3)", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const solo = squad(1);
    const playerEmail = solo[0]?.email as string;
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: solo });
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add(playerEmail);
    const now = new Date("2026-08-12T09:00:00Z");

    const first = await openAndRemind(db, notifier, now, SECRET);
    expect(first.remindersSent).toBe(0);
    expect(first.remindersDeferred).toBe(1);
    // A deferral is expected under a low ceiling, so it must NOT reject the
    // invocation — it is deliberately kept out of `failures`, unlike a send
    // failure.
    expect(first.failures).toHaveLength(0);
    expect(first.remindersFailed).toBe(0);
    // Definitely-did-not-send: the row is removed, not left `queued`, so a future run retries.
    expect(await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId))).toHaveLength(0);

    notifier.ceilingFor.delete(playerEmail);
    const second = await openAndRemind(db, notifier, now, SECRET);
    expect(second.remindersSent).toBe(1);
    expect(second.remindersDeferred).toBe(0);

    const rows = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
  });

  it("records an audit row naming everyone an N-1 ceiling refusal stopped being told (TR-31)", async () => {
    // N-1 is the highest-volume notification in the system, and the exact
    // case TR-31 was filed about: a MAX_EMAILS_PER_DAY typo failing closed to
    // zero silently stops every reminder. The audit row is the durable trace
    // that a real message was owed and refused, surviving the deleted
    // `notification_log` row.
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const solo = squad(1);
    const playerEmail = solo[0]?.email as string;
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: solo });
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add(playerEmail);
    const now = new Date("2026-08-12T09:00:00Z");

    await openAndRemind(db, notifier, now, SECRET);

    const deferred = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "fixture.reminder_email_deferred"));
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.entityId).toBe(fixtureId);
    expect(deferred[0]?.actorPlayerId).toBeNull();
    const after = JSON.parse(deferred[0]?.afterJson ?? "{}") as { notificationType: string; playerIds: string[] };
    expect(after.notificationType).toBe("n1");
    expect(after.playerIds).toEqual([solo[0]?.id]);
  });

  it("writes no reminder deferral audit row when every reminder went out", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    await seedFixture({ kicksOffAt, squad: squad(1) });
    const notifier = new RecordingNotifier();
    const now = new Date("2026-08-12T09:00:00Z");

    await openAndRemind(db, notifier, now, SECRET);

    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "fixture.reminder_email_deferred")),
    ).toHaveLength(0);
  });

  it("collapses repeated N-1 ceiling deferrals for the same fixture within the collapse window, but writes a fresh row once it elapses", async () => {
    // A sustained ceiling retries N-1 every sweep tick; without a bound this
    // would write one audit row per tick, forever, into a table nothing
    // prunes. One row per collapse window still shows the condition is
    // ongoing, without flooding the table.
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const solo = squad(1);
    const playerEmail = solo[0]?.email as string;
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: solo });
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add(playerEmail);

    const first = new Date("2026-08-12T09:00:00Z");
    await openAndRemind(db, notifier, first, SECRET);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "fixture.reminder_email_deferred")),
    ).toHaveLength(1);

    // Five minutes later — well inside the one-hour collapse window — the
    // sweep retries and is refused again. No second row.
    const second = new Date(first.getTime() + 5 * 60 * 1000);
    await openAndRemind(db, notifier, second, SECRET);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, "fixture.reminder_email_deferred")),
    ).toHaveLength(1);

    // An hour and one minute after the first row, the window has elapsed and
    // a fresh row is written — proving the condition is still ongoing rather
    // than a single one-off row that looks identical to a resolved blip.
    const third = new Date(first.getTime() + 61 * 60 * 1000);
    await openAndRemind(db, notifier, third, SECRET);
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "fixture.reminder_email_deferred"));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.entityId === fixtureId)).toBe(true);
  });

  it("a provider-failed reminder is left failed and is not retried automatically (fix round 1, finding 3)", async () => {
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const solo = squad(1);
    const playerEmail = solo[0]?.email as string;
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: solo });
    const notifier = new RecordingNotifier();
    notifier.failFor.add(playerEmail);
    const now = new Date("2026-08-12T09:00:00Z");

    const first = await openAndRemind(db, notifier, now, SECRET);
    expect(first.remindersFailed).toBe(1);
    expect(first.remindersDeferred).toBe(0);

    notifier.failFor.delete(playerEmail);
    const second = await openAndRemind(db, notifier, now, SECRET);
    expect(second.remindersSent).toBe(0);
    expect(second.remindersFailed).toBe(0);

    const rows = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
  });

  it("skips a whitespace-only email like a guest instead of retrying it forever (whole-branch review, important 3)", async () => {
    // `" "` is truthy, so it used to pass the sweep's `!candidate.email`
    // guard, get a token signed and a `queued` row written, then be trimmed
    // to empty inside QuotaNotifier and come back `no-recipient` — which the
    // sweep treated as retryable and deleted. Every five minutes. Forever.
    // And it raised a daily-ceiling alarm each time, for a condition that has
    // nothing to do with the ceiling.
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const { fixtureId } = await seedFixture({
      kicksOffAt,
      squad: [
        { id: "p-blank", name: "Blank Address", email: "   " },
        { id: "p-real", name: "Real Address", email: "real@example.com" },
      ],
    });
    const notifier = new RecordingNotifier();
    const now = new Date("2026-08-12T09:00:00Z");

    const first = await openAndRemind(db, notifier, now, SECRET);
    expect(first.remindersSent).toBe(1);
    expect(first.guestsSkipped).toBe(1);
    expect(first.remindersDeferred).toBe(0);
    expect(first.remindersFailed).toBe(0);
    expect(first.failures).toHaveLength(0);

    // No message was ever built for them, so no row exists to churn.
    const rows = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.playerId).toBe("p-real");
    expect(notifier.sent.flat().map((m) => m.to)).toEqual(["real@example.com"]);

    // The loop is closed: a second run does exactly the same nothing, rather
    // than re-signing a token and re-inserting a row.
    const second = await openAndRemind(db, notifier, now, SECRET);
    expect(second.remindersSent).toBe(0);
    expect(second.guestsSkipped).toBe(1);
    expect(second.remindersDeferred).toBe(0);
    expect(notifier.sent.flat()).toHaveLength(1);
    expect(await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId))).toHaveLength(1);
  });

  it("leaves no orphaned queued rows when applying results aborts part-way (whole-branch review, important 4)", async () => {
    // The application loop does one sequential D1 write per message. A throw
    // part-way used to leave the remaining rows `queued` — and
    // `existingReminderLog` counts `queued` as already handled, so those
    // players would never be reminded, never marked failed, and never
    // counted, with nothing anywhere to reap them.
    const kicksOffAt = new Date("2026-08-13T18:00:00Z");
    const { fixtureId } = await seedFixture({ kicksOffAt, squad: squad(3) });
    const notifier = new RecordingNotifier();
    const now = new Date("2026-08-12T09:00:00Z");

    // Fails the second per-row write; the bulk recovery write that follows
    // is allowed through, which is the behaviour under test.
    let updates = 0;
    const flakyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "update") {
          return (...args: Parameters<Db["update"]>) => {
            updates++;
            if (updates === 2) throw new Error("simulated D1 outage mid-apply");
            return target.update(...args);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;

    const result = await openAndRemind(flakyDb, notifier, now, SECRET);

    const rows = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === "queued")).toHaveLength(0);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(1);

    const abandoned = rows.filter((r) => r.status === "failed");
    expect(abandoned).toHaveLength(2);
    expect(abandoned.every((r) => r.error?.includes("abandoned mid-apply"))).toBe(true);

    expect(result.remindersSent).toBe(1);
    expect(result.remindersFailed).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ fixtureId, stage: "apply" });
    expect(result.failures[0]?.message).toContain("simulated D1 outage mid-apply");

    // Marked failed, not deleted: the notifier already returned results, so
    // these may well have been delivered, and BR-19 prefers a miss to a
    // duplicate. A later run must therefore not retry them.
    const second = await openAndRemind(db, notifier, now, SECRET);
    expect(second.remindersSent).toBe(0);
    expect(second.remindersFailed).toBe(0);
    expect(await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId))).toHaveLength(3);
  });
});
