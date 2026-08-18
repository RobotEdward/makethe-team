import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { emailQuota } from "../../src/db/schema.js";
import type { EmailMessage, Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import { DAILY_CEILING_REASON, NO_RECIPIENT_REASON, QuotaNotifier } from "../../src/notify/quota.js";
import { resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);

const DAY_ONE = new Date("2026-08-11T08:59:59.999Z");
const DAY_TWO = new Date("2026-08-12T00:00:00.000Z");

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    channel: "email",
    to: "player@example.com",
    subject: "You're in",
    html: "<p>You're in</p>",
    text: "You're in",
    dedupeKey: `n1:fix-1:${crypto.randomUUID()}`,
    ...overrides,
  };
}

/** A message that reaches this decorator with no usable recipient address —
 * simulating a guest slipping past whatever upstream filtering should have
 * caught it (BR-32, TR-32). `Message.to` is typed `string`, so this cast is
 * deliberate: it exercises the runtime boundary check, not the type system. */
function guestMessage(overrides: Partial<EmailMessage> = {}): Message {
  return message({ to: null as unknown as string, ...overrides });
}

/** Records every batch it was asked to send and reports success for each,
 * in order — a spy standing in for whichever real Notifier the factory
 * would otherwise have chosen. */
class RecordingNotifier implements Notifier {
  readonly calls: Message[][] = [];

  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.calls.push([...messages]);
    return Promise.resolve(messages.map((m): SendResult => ({ ok: true, providerMessageId: `id:${m.dedupeKey}` })));
  }
}

/** A Notifier that always throws — used to prove a ceiling-refused or
 * guest-skipped message never reaches the wrapped notifier at all. */
class ThrowingNotifier implements Notifier {
  send(): Promise<SendResult[]> {
    throw new Error("must not be called");
  }
}

/** A Notifier that violates its own contract (notifier.ts) by returning
 * fewer results than it was given messages — used to prove QuotaNotifier
 * never leaves a typed hole in its own results array when the notifier it
 * wraps misbehaves. */
class ShortNotifier implements Notifier {
  send(messages: readonly Message[]): Promise<SendResult[]> {
    return Promise.resolve(
      messages.slice(0, -1).map((m): SendResult => ({ ok: true, providerMessageId: `id:${m.dedupeKey}` })),
    );
  }
}

beforeEach(async () => {
  await resetDatabase();
});

describe("QuotaNotifier", () => {
  it("returns an empty array for an empty input, without touching D1", async () => {
    const notifier = new QuotaNotifier(new ThrowingNotifier(), db, 50, DAY_ONE);
    const results = await notifier.send([]);
    expect(results).toEqual([]);
  });

  it("sends everything and increments the counter by the right amount when under the ceiling", async () => {
    const recorder = new RecordingNotifier();
    const notifier = new QuotaNotifier(recorder, db, 50, DAY_ONE);
    const messages = [message(), message(), message()];

    const results = await notifier.send(messages);

    expect(results).toHaveLength(3);
    results.forEach((r) => expect(r.ok).toBe(true));
    expect(recorder.calls).toEqual([messages]);

    const [row] = await db.select().from(emailQuota);
    expect(row?.sentCount).toBe(3);
  });

  it("sends nothing and refuses every message once the ceiling is already reached", async () => {
    await db.insert(emailQuota).values({ day: "2026-08-11", sentCount: 5 });
    const notifier = new QuotaNotifier(new ThrowingNotifier(), db, 5, DAY_ONE);
    const messages = [message(), message()];

    const results = await notifier.send(messages);

    expect(results).toEqual([
      { ok: false, error: DAILY_CEILING_REASON },
      { ok: false, error: DAILY_CEILING_REASON },
    ]);

    const [row] = await db.select().from(emailQuota);
    expect(row?.sentCount).toBe(5);
  });

  it("sends exactly the remainder and refuses the rest for a batch straddling the ceiling, aligned by index", async () => {
    await db.insert(emailQuota).values({ day: "2026-08-11", sentCount: 3 });
    const recorder = new RecordingNotifier();
    const notifier = new QuotaNotifier(recorder, db, 5, DAY_ONE);
    const messages = [
      message({ to: "a@example.com" }),
      message({ to: "b@example.com" }),
      message({ to: "c@example.com" }),
      message({ to: "d@example.com" }),
    ];

    const results = await notifier.send(messages);

    // Only room for 2 more (5 - 3). The first two in the batch are sent; the
    // rest are refused — and results stay aligned to the original indices.
    expect(recorder.calls).toEqual([[messages[0], messages[1]]]);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(true);
    expect(results[2]).toEqual({ ok: false, error: DAILY_CEILING_REASON });
    expect(results[3]).toEqual({ ok: false, error: DAILY_CEILING_REASON });

    const [row] = await db.select().from(emailQuota);
    expect(row?.sentCount).toBe(5);
  });

  it("rolls the counter over at UTC midnight: two sends either side of the boundary each get a full allowance", async () => {
    const recorder = new RecordingNotifier();
    const beforeMidnight = new QuotaNotifier(recorder, db, 2, DAY_ONE);
    const afterMidnight = new QuotaNotifier(recorder, db, 2, DAY_TWO);

    const firstDay = [message(), message()];
    const secondDay = [message(), message()];

    const firstResults = await beforeMidnight.send(firstDay);
    const secondResults = await afterMidnight.send(secondDay);

    firstResults.forEach((r) => expect(r.ok).toBe(true));
    secondResults.forEach((r) => expect(r.ok).toBe(true));

    const rows = await db.select().from(emailQuota);
    const byDay = new Map(rows.map((r) => [r.day, r.sentCount]));
    expect(byDay.get("2026-08-11")).toBe(2);
    expect(byDay.get("2026-08-12")).toBe(2);
  });

  it("skips a null-email recipient with a distinct refusal: no quota consumed, no upstream call for it", async () => {
    const recorder = new RecordingNotifier();
    const notifier = new QuotaNotifier(recorder, db, 50, DAY_ONE);
    const real = message({ to: "real@example.com" });

    const results = await notifier.send([guestMessage(), real]);

    expect(results[0]).toEqual({ ok: false, error: NO_RECIPIENT_REASON });
    expect(results[1]?.ok).toBe(true);
    // The guest never appears in what reaches the wrapped notifier.
    expect(recorder.calls).toEqual([[real]]);

    const [row] = await db.select().from(emailQuota);
    // Only the one real send counted.
    expect(row?.sentCount).toBe(1);
  });

  it("does not shift result alignment around a skipped guest in the middle of a batch", async () => {
    const recorder = new RecordingNotifier();
    const notifier = new QuotaNotifier(recorder, db, 50, DAY_ONE);
    const a = message({ to: "a@example.com" });
    const c = message({ to: "c@example.com" });

    const results = await notifier.send([a, guestMessage(), c]);

    expect(results).toHaveLength(3);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]).toEqual({ ok: false, error: NO_RECIPIENT_REASON });
    expect(results[2]?.ok).toBe(true);
    expect(recorder.calls).toEqual([[a, c]]);
  });

  it("sends nothing and makes no upstream call for a batch of only guests, returning all-refused without error", async () => {
    const notifier = new QuotaNotifier(new ThrowingNotifier(), db, 50, DAY_ONE);

    const results = await notifier.send([guestMessage(), guestMessage()]);

    expect(results).toEqual([
      { ok: false, error: NO_RECIPIENT_REASON },
      { ok: false, error: NO_RECIPIENT_REASON },
    ]);

    const rows = await db.select().from(emailQuota);
    expect(rows).toEqual([]);
  });

  it("cannot let concurrent sends together exceed the ceiling", async () => {
    const recorder = new RecordingNotifier();
    const limit = 10;
    const notifiers = Array.from({ length: 8 }, () => new QuotaNotifier(recorder, db, limit, DAY_ONE));

    // Each of 8 concurrent callers tries to send 3 messages (24 requested
    // against a ceiling of 10).
    const batches = await Promise.all(
      notifiers.map((notifier) => notifier.send([message(), message(), message()])),
    );

    const totalSent = batches.flat().filter((r) => r.ok).length;
    const totalRefused = batches
      .flat()
      .filter((r) => !r.ok && r.error === DAILY_CEILING_REASON).length;

    expect(totalSent).toBe(limit);
    expect(totalSent + totalRefused).toBe(24);

    const [row] = await db.select().from(emailQuota);
    expect(row?.sentCount).toBe(limit);

    const totalRecorded = recorder.calls.reduce((sum, call) => sum + call.length, 0);
    expect(totalRecorded).toBe(limit);
  });

  it("fills a gap explicitly, never leaving a hole, when the wrapped notifier returns too few results", async () => {
    const notifier = new QuotaNotifier(new ShortNotifier(), db, 50, DAY_ONE);
    const messages = [message(), message(), message()];

    const results = await notifier.send(messages);

    expect(results).toHaveLength(3);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(true);
    expect(results[2]).toEqual({ ok: false, error: "notifier-contract-violation" });
  });
});
