import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, notificationLog, players } from "../../src/db/schema.js";
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
    await seedFixture({ kicksOffAt, squad: mixed });
    const notifier = new RecordingNotifier();
    notifier.failFor.add("bad@example.com");
    const now = new Date("2026-08-12T09:00:00Z");

    const result = await openAndRemind(db, notifier, now, SECRET);

    expect(result.remindersSent).toBe(1);
    expect(result.remindersFailed).toBe(1);

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
});
