import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { notificationLog } from "../../src/db/schema.js";
import { erasureScheduledKey } from "../../src/notify/dedupe-key.js";
import type { Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { DAILY_CEILING_REASON } from "../../src/notify/quota.js";
import { sendErasureScheduledEmail } from "../../src/notify/send-erasure-scheduled.js";
import { insertPlayer, requireEmailMessage, resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);
const NOW = new Date("2026-08-12T09:00:00Z");
const ERASES_AT = new Date("2026-08-14T09:00:00Z");

/** Records every message it was sent, in order, so a test can assert on it. */
class RecordingNotifier implements Notifier {
  readonly sent: Message[][] = [];
  /** Recipients this instance should report a provider failure for. */
  readonly failFor = new Set<string>();
  /** Recipients this instance should report as refused by the daily ceiling. */
  readonly ceilingFor = new Set<string>();

  /** Every message this notifier was ever handed, flattened across batches. */
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
  readonly sent: Message[][] = [];
  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.sent.push([...messages]);
    return Promise.reject(new Error("simulated D1 failure inside QuotaNotifier.reserve()"));
  }
}

function send(playerId: string, notifier: Notifier, erasesAt: Date = ERASES_AT) {
  return sendErasureScheduledEmail({ db, notifier, playerId, erasesAt, now: NOW });
}

async function logRows() {
  return db.select().from(notificationLog);
}

beforeEach(async () => {
  await resetDatabase();
});

describe("sendErasureScheduledEmail (N-8)", () => {
  it("sends once and records the log row with a null fixture_id", async () => {
    const playerId = await insertPlayer(db, { name: "Alex", email: "alex@example.com" });
    const notifier = new RecordingNotifier();

    const outcome = await send(playerId, notifier);

    expect(outcome).toEqual({ kind: "sent" });
    expect(notifier.all).toHaveLength(1);
    expect(notifier.all[0]?.to).toBe("alex@example.com");
    expect(requireEmailMessage(notifier.all[0]!).text).toContain("14 August");

    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      notificationType: "n8",
      playerId,
      channel: "email",
      status: "sent",
      fixtureId: null,
      dedupeKey: erasureScheduledKey(playerId, ERASES_AT.toISOString()),
    });
  });

  it("carries a sign-in link, not a token link", async () => {
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    const notifier = new RecordingNotifier();

    await send(playerId, notifier);

    const message = requireEmailMessage(notifier.all[0]!);
    expect(message.html).toContain("https://makethe.team/sign-in");
    expect(message.text).toContain("https://makethe.team/sign-in");
  });

  it("skips a guest without writing a row (BR-32)", async () => {
    const playerId = await insertPlayer(db, { email: "guest@example.com", isGuest: true });
    const notifier = new RecordingNotifier();

    const outcome = await send(playerId, notifier);

    expect(outcome).toEqual({ kind: "skipped-no-recipient" });
    expect(notifier.sent).toEqual([]);
    expect(await logRows()).toEqual([]);
  });

  it("skips a player whose address is blank whitespace, for the same reason", async () => {
    const playerId = await insertPlayer(db, { email: "   " });
    const notifier = new RecordingNotifier();

    const outcome = await send(playerId, notifier);

    expect(outcome).toEqual({ kind: "skipped-no-recipient" });
    expect(notifier.sent).toEqual([]);
    expect(await logRows()).toEqual([]);
  });

  it("skips a player id that no longer resolves", async () => {
    const notifier = new RecordingNotifier();

    const outcome = await send("nobody-by-that-id", notifier);

    expect(outcome).toEqual({ kind: "skipped-no-recipient" });
    expect(notifier.sent).toEqual([]);
    expect(await logRows()).toEqual([]);
  });

  it("returns already-logged for a repeated send with the same erasesAt", async () => {
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    const notifier = new RecordingNotifier();

    await send(playerId, notifier);
    const second = await send(playerId, notifier);

    expect(second).toEqual({ kind: "already-logged" });
    expect(notifier.all).toHaveLength(1);
    expect(await logRows()).toHaveLength(1);
  });

  it("sends again for a different erasesAt, because a new request is new information", async () => {
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    const notifier = new RecordingNotifier();

    await send(playerId, notifier);

    // A cancel-and-retry: same player, a fresh deadline.
    const secondDeadline = new Date(ERASES_AT.getTime() + 86_400_000);
    const second = await send(playerId, notifier, secondDeadline);

    expect(second).toEqual({ kind: "sent" });
    expect(notifier.all).toHaveLength(2);
    const rows = await logRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(
      [
        erasureScheduledKey(playerId, ERASES_AT.toISOString()),
        erasureScheduledKey(playerId, secondDeadline.toISOString()),
      ].sort(),
    );
  });

  it("defers rather than failing when the daily ceiling refuses it", async () => {
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    const notifier = new RecordingNotifier();
    notifier.ceilingFor.add("alex@example.com");

    const outcome = await send(playerId, notifier);

    expect(outcome).toEqual({ kind: "deferred" });
    expect(await logRows()).toEqual([]);
  });

  it("leaves the row failed after a provider error — never retried, because it may have been delivered", async () => {
    const playerId = await insertPlayer(db, { email: "alex@example.com" });
    const notifier = new RecordingNotifier();
    notifier.failFor.add("alex@example.com");

    const outcome = await send(playerId, notifier);

    expect(outcome).toEqual({ kind: "failed", reason: "simulated-provider-failure" });
    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", error: "simulated-provider-failure" });
  });

  it("does not throw when the notifier itself rejects, and leaves the row failed", async () => {
    const playerId = await insertPlayer(db, { email: "alex@example.com" });

    const outcome = await send(playerId, new RejectingNotifier());

    expect(outcome.kind).toBe("failed");
    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
  });
});
