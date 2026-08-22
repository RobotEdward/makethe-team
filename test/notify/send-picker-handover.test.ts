import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { fixtures, memberships, notificationLog, players } from "../../src/db/schema.js";
import { verifyLeaveToken } from "../../src/domain/token.js";
import { pickerHandoverKey, pushKey } from "../../src/notify/dedupe-key.js";
import type { Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { DAILY_CEILING_REASON } from "../../src/notify/quota.js";
import { sendPickerHandover } from "../../src/notify/send-picker-handover.js";
import { insertGame, insertSubscription, requireEmailMessage, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const SECRET = "test-secret";
const NOW = new Date("2026-08-12T09:00:00Z");
const SET_AT = new Date("2026-08-12T08:55:00Z");
const KICKOFF = new Date("2026-08-13T18:00:00Z");

/** Records every message it was sent, in order, so a test can assert on it. */
class RecordingNotifier implements Notifier {
  readonly sent: Message[][] = [];
  readonly failFor = new Set<string>();
  readonly ceilingFor = new Set<string>();

  get all(): Message[] {
    return this.sent.flat();
  }

  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.sent.push([...messages]);
    return Promise.resolve(
      messages.map((m): SendResult => {
        if (this.ceilingFor.has(m.to)) return { ok: false, error: DAILY_CEILING_REASON };
        if (this.failFor.has(m.to)) return { ok: false, error: "simulated-provider-failure" };
        return { ok: true, providerMessageId: `prov-${m.dedupeKey}` };
      }),
    );
  }
}

/** Rejects outright, the way `QuotaNotifier.reserve()` does when D1 errors mid-batch. */
class RejectingNotifier implements Notifier {
  send(): Promise<SendResult[]> {
    return Promise.reject(new Error("simulated D1 failure inside QuotaNotifier.reserve()"));
  }
}

async function seed(
  delegate: { id: string; name: string; email: string | null; isGuest?: boolean } = {
    id: "delegate",
    name: "Dee Delegate",
    email: "dee@example.com",
  },
) {
  const gameId = await insertGame(db, { name: "Thursday 7-a-side", venueName: "Oxford Sports Park" });
  await db
    .insert(players)
    .values({ id: delegate.id, name: delegate.name, email: delegate.email, isGuest: delegate.isGuest ?? false });
  await db.insert(memberships).values({ id: `m-${delegate.id}`, gameId, playerId: delegate.id, active: true });
  const fixtureId = crypto.randomUUID();
  await db.insert(fixtures).values({
    id: fixtureId,
    gameId,
    kicksOffAt: KICKOFF,
    lifecycle: "open",
    minPlayers: 2,
    maxPlayers: 14,
    prefersEvenNumbers: true,
    shortWarningOffsetHours: 12,
    durationMinutes: 60,
    pickerMode: "delegate",
    teamPickerPlayerId: delegate.id,
    teamPickerSetAt: SET_AT,
  });
  return { gameId, fixtureId, playerId: delegate.id };
}

function send(fixtureId: string, playerId: string, notifier: Notifier) {
  return sendPickerHandover({
    db,
    notifier,
    fixtureId,
    playerId,
    setAt: SET_AT,
    now: NOW,
    responseTokenSecret: SECRET,
  });
}

beforeEach(resetDatabase);

describe("sendPickerHandover (N-13)", () => {
  it("emails the delegate, and nobody else", async () => {
    const { fixtureId, playerId } = await seed();
    const notifier = new RecordingNotifier();

    const outcome = await send(fixtureId, playerId, notifier);

    expect(outcome).toEqual({ kind: "sent" });
    expect(notifier.all).toHaveLength(1);
    expect(notifier.all[0]?.to).toBe("dee@example.com");
  });

  it("links to the picker page for this fixture", async () => {
    const { gameId, fixtureId, playerId } = await seed();
    const notifier = new RecordingNotifier();

    await send(fixtureId, playerId, notifier);
    const email = requireEmailMessage(notifier.all[0]!);

    expect(email.html).toContain(`/g/${gameId}/f/${fixtureId}/teams`);
    expect(email.text).toContain(`/g/${gameId}/f/${fixtureId}/teams`);
  });

  /**
   * The one notification whose recipient is handed a control that mails other
   * people. A delegate who presses Publish expecting a private save would be
   * messaging a whole squad by accident, so the copy has to say so.
   */
  it("says that publishing is what tells the squad", async () => {
    const { fixtureId, playerId } = await seed();
    const notifier = new RecordingNotifier();

    await send(fixtureId, playerId, notifier);
    const email = requireEmailMessage(notifier.all[0]!);

    expect(email.text).toContain("publishing is what tells the squad");
  });

  /** BR-22: every notification carries a working way out of the game. */
  it("carries a leave link that verifies", async () => {
    const { gameId, fixtureId, playerId } = await seed();
    const notifier = new RecordingNotifier();

    await send(fixtureId, playerId, notifier);
    const match = requireEmailMessage(notifier.all[0]!).html.match(/\/leave\/([^"]+)"/);
    const verified = await verifyLeaveToken(match![1]!, SECRET, NOW);

    expect(verified).toMatchObject({ ok: true, payload: { gameId, playerId } });
  });

  it("is idempotent on the same hand-over", async () => {
    const { fixtureId, playerId } = await seed();
    const notifier = new RecordingNotifier();

    await send(fixtureId, playerId, notifier);
    const second = await send(fixtureId, playerId, notifier);

    expect(second).toEqual({ kind: "already-logged" });
    expect(notifier.all).toHaveLength(1);
    const rows = await db.select().from(notificationLog);
    expect(rows.filter((row) => row.dedupeKey === pickerHandoverKey(fixtureId, playerId, SET_AT.toISOString()))).toHaveLength(1);
  });

  /**
   * A second hand-over to the same person carries a new `team_picker_set_at`,
   * which is exactly why that column is in the key: without it the delegate
   * would never learn the job was theirs again.
   */
  it("sends again for a later hand-over to the same player", async () => {
    const { fixtureId, playerId } = await seed();
    const notifier = new RecordingNotifier();
    await send(fixtureId, playerId, notifier);

    const later = new Date(SET_AT.getTime() + 60_000);
    const outcome = await sendPickerHandover({
      db,
      notifier,
      fixtureId,
      playerId,
      setAt: later,
      now: NOW,
      responseTokenSecret: SECRET,
    });

    expect(outcome).toEqual({ kind: "sent" });
    expect(notifier.all).toHaveLength(2);
  });

  it("pushes as well, when the delegate has a device", async () => {
    const { fixtureId, playerId } = await seed();
    await insertSubscription(db, playerId, "https://push.example/endpoint-1");
    const notifier = new RecordingNotifier();

    await send(fixtureId, playerId, notifier);

    const push = notifier.all.find((message) => message.channel === "push");
    expect(push).toBeDefined();
    expect(push?.dedupeKey).toBe(pushKey(pickerHandoverKey(fixtureId, playerId, SET_AT.toISOString())));
  });

  it("skips a player with no address, writing no log row", async () => {
    const { fixtureId, playerId } = await seed({ id: "guest", name: "Gus Guest", email: null, isGuest: true });
    const notifier = new RecordingNotifier();

    const outcome = await send(fixtureId, playerId, notifier);

    expect(outcome).toEqual({ kind: "skipped-no-recipient" });
    expect(await db.select().from(notificationLog)).toHaveLength(0);
  });

  it("reports a ceiling refusal and leaves nothing behind to block a retry", async () => {
    const { fixtureId, playerId } = await seed();
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add("dee@example.com");

    const outcome = await send(fixtureId, playerId, notifier);

    expect(outcome).toEqual({ kind: "deferred" });
    expect(await db.select().from(notificationLog)).toHaveLength(0);
  });

  it("leaves an ambiguous rejection failed, never retried", async () => {
    const { fixtureId, playerId } = await seed();

    const outcome = await send(fixtureId, playerId, new RejectingNotifier());

    expect(outcome.kind).toBe("failed");
    const rows = await db.select().from(notificationLog);
    expect(rows.map((row) => row.status)).toEqual(["failed"]);
  });

  it("reports a missing fixture rather than throwing", async () => {
    const outcome = await send(crypto.randomUUID(), "nobody", new RecordingNotifier());

    expect(outcome).toEqual({ kind: "fixture-not-found" });
  });

  it("reports a missing player rather than throwing", async () => {
    const { fixtureId } = await seed();

    const outcome = await send(fixtureId, "nobody", new RecordingNotifier());

    expect(outcome).toEqual({ kind: "player-not-found" });
  });

  it("files the send under its own notification type", async () => {
    const { fixtureId, playerId } = await seed();

    await send(fixtureId, playerId, new RecordingNotifier());

    const [row] = await db.select().from(notificationLog).where(eq(notificationLog.fixtureId, fixtureId));
    expect(row?.notificationType).toBe("n13");
  });
});
