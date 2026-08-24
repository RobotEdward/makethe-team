import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { notificationLog } from "../../src/db/schema.js";
import type { Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { DAILY_CEILING_REASON } from "../../src/notify/quota.js";
import { backfillOpenFixtureResponses } from "../../src/domain/backfill-open-responses.js";
import { sendLateInvitations } from "../../src/notify/send-late-invitations.js";
import { openAndRemind } from "../../src/sweep/open-and-remind.js";
import { kickoffIn, NOW } from "../support/clock.js";
import {
  insertFixture,
  insertGame,
  insertPlayer,
  requireEmailMessage,
  resetDatabase,
} from "../support/factories.js";

const db = getDb(env.DB);
const SECRET = env.RESPONSE_TOKEN_SECRET;

/** Records every message it was sent, so a test can assert on it. */
class RecordingNotifier implements Notifier {
  readonly sent: Message[][] = [];
  /** Recipients this instance should report as refused by the daily ceiling. */
  readonly ceilingFor = new Set<string>();

  get all(): Message[] {
    return this.sent.flat();
  }

  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.sent.push([...messages]);
    return Promise.resolve(
      messages.map((m): SendResult => {
        if (this.ceilingFor.has(m.to)) return { ok: false, error: DAILY_CEILING_REASON };
        return { ok: true, providerMessageId: `prov-${m.dedupeKey}` };
      }),
    );
  }
}

async function seedOpenFixture(): Promise<{ gameId: string; fixtureId: string; playerId: string }> {
  // `reminderDaysBefore: 2` with a kickoff 24h out puts the reminder instant
  // firmly in the past whatever hour the suite runs at, so the sweep in the
  // duplicate test is genuinely due to remind — the vacuous-pass trap named
  // in CLAUDE.md.
  const gameId = await insertGame(db, { reminderDaysBefore: 2 });
  const fixtureId = await insertFixture(db, gameId, { lifecycle: "open", kicksOffAt: kickoffIn(24) });
  const playerId = await insertPlayer(db, { email: "late@example.com" });
  return { gameId, fixtureId, playerId };
}

describe("sendLateInvitations", () => {
  beforeEach(resetDatabase);

  it("sends the N-1 invitation email with respond links and logs it sent", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
    const notifier = new RecordingNotifier();

    const result = await sendLateInvitations({
      db,
      notifier,
      playerId,
      fixtureIds: [fixtureId],
      responseTokenSecret: SECRET,
      now: NOW,
    });

    expect(result.sent).toBe(1);
    const email = requireEmailMessage(notifier.all[0]!);
    expect(email.to).toBe("late@example.com");
    expect(email.html).toContain("https://makethe.team/r/");
    const rows = await db
      .select()
      .from(notificationLog)
      .where(and(eq(notificationLog.playerId, playerId), eq(notificationLog.notificationType, "n1")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
    expect(rows[0]?.fixtureId).toBe(fixtureId);
  });

  it("stops the sweep sending the same player a duplicate N-1", async () => {
    const { gameId, fixtureId, playerId } = await seedOpenFixture();
    // The composed join-flow sequence: backfill the pending row, then invite.
    // The response row is what makes the sweep consider this player at all.
    expect(await backfillOpenFixtureResponses(db, gameId, playerId)).toEqual([fixtureId]);
    const notifier = new RecordingNotifier();

    await sendLateInvitations({
      db,
      notifier,
      playerId,
      fixtureIds: [fixtureId],
      responseTokenSecret: SECRET,
      now: NOW,
    });
    const sweep = await openAndRemind(db, notifier, NOW, SECRET, env.FIXTURE_CAPACITY);

    expect(sweep.remindersSent).toBe(0);
    expect(notifier.all.filter((m) => m.channel === "email" && m.to === "late@example.com")).toHaveLength(1);
  });

  it("skips a fixture that is no longer open, without logging anything", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
    const { fixtures } = await import("../../src/db/schema.js");
    await db.update(fixtures).set({ lifecycle: "cancelled" }).where(eq(fixtures.id, fixtureId));
    const notifier = new RecordingNotifier();

    const result = await sendLateInvitations({
      db,
      notifier,
      playerId,
      fixtureIds: [fixtureId],
      responseTokenSecret: SECRET,
      now: NOW,
    });

    expect(result.sent).toBe(0);
    expect(notifier.all).toHaveLength(0);
    expect(await db.select().from(notificationLog)).toHaveLength(0);
  });

  it("removes the log row on a ceiling refusal so a later sweep retries it", async () => {
    const { fixtureId, playerId } = await seedOpenFixture();
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add("late@example.com");

    const result = await sendLateInvitations({
      db,
      notifier,
      playerId,
      fixtureIds: [fixtureId],
      responseTokenSecret: SECRET,
      now: NOW,
    });

    expect(result.sent).toBe(0);
    expect(result.deferred).toBe(1);
    // The `queued` row is deleted, so the hourly sweep's "already logged"
    // check does not see this player and the reminder is retried there.
    const rows = await db
      .select()
      .from(notificationLog)
      .where(eq(notificationLog.playerId, playerId));
    expect(rows).toHaveLength(0);
  });
});
