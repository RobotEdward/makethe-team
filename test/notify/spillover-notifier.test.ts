import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { emailQuota } from "../../src/db/schema.js";
import type { EmailMessage, Message, Notifier, SendResult } from "../../src/notify/notifier.js";
import {
  DAILY_CEILING_REASON,
  NO_RECIPIENT_REASON,
  NOTIFIER_CONTRACT_VIOLATION_REASON,
  QuotaNotifier,
} from "../../src/notify/quota.js";
import { PROVIDER_REFUSED_REASON } from "../../src/notify/cloudflare-notifier.js";
import { SpilloverNotifier } from "../../src/notify/spillover-notifier.js";
import { resetDatabase } from "../support/factories.js";

const db = getDb(env.DB);

const DAY = new Date("2026-08-29T10:00:00.000Z");
const DAY_KEY = "2026-08-29";

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

function messages(count: number, prefix = "ply"): Message[] {
  return Array.from({ length: count }, (_, i) =>
    message({ to: `${prefix}-${i}@example.com`, dedupeKey: `n1:fix-1:${prefix}-${i}` }),
  );
}

/** Records what it was asked to send and reports success for each. */
class RecordingNotifier implements Notifier {
  readonly calls: Message[][] = [];

  constructor(private readonly label: string) {}

  send(sent: readonly Message[]): Promise<SendResult[]> {
    this.calls.push([...sent]);
    return Promise.resolve(
      sent.map((m): SendResult => ({ ok: true, providerMessageId: `${this.label}:${m.dedupeKey}` })),
    );
  }
}

/** Fails every message with a fixed reason, recording what it saw. */
class FailingNotifier implements Notifier {
  readonly calls: Message[][] = [];

  constructor(private readonly reason: string) {}

  send(sent: readonly Message[]): Promise<SendResult[]> {
    this.calls.push([...sent]);
    return Promise.resolve(sent.map((): SendResult => ({ ok: false, error: this.reason })));
  }
}

beforeEach(async () => {
  await resetDatabase();
});

describe("SpilloverNotifier", () => {
  it("refuses to be built with no legs, rather than impersonating an exhausted ceiling", () => {
    expect(() => new SpilloverNotifier([])).toThrow(/at least one leg/);
  });

  it("returns one result per input, in order, across both legs", async () => {
    const primary = new QuotaNotifier(new RecordingNotifier("a"), db, 2, DAY, "resend");
    const spill = new QuotaNotifier(new RecordingNotifier("b"), db, 10, DAY, "cloudflare");

    const results = await new SpilloverNotifier([primary, spill]).send(messages(5));

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.ok)).toBe(true);
    // Slots 0-1 went to the primary, 2-4 spilled — and each result is still
    // at the index of the message that produced it.
    expect(results.map((r) => (r.ok ? r.providerMessageId : r.error))).toEqual([
      "a:n1:fix-1:ply-0",
      "a:n1:fix-1:ply-1",
      "b:n1:fix-1:ply-2",
      "b:n1:fix-1:ply-3",
      "b:n1:fix-1:ply-4",
    ]);
  });

  it("passes only the ceiling-refused messages to the second leg", async () => {
    const first = new RecordingNotifier("a");
    const second = new RecordingNotifier("b");
    const notifier = new SpilloverNotifier([
      new QuotaNotifier(first, db, 2, DAY, "resend"),
      new QuotaNotifier(second, db, 10, DAY, "cloudflare"),
    ]);

    await notifier.send(messages(5));

    expect(first.calls[0]?.map((m) => m.to)).toEqual(["ply-0@example.com", "ply-1@example.com"]);
    expect(second.calls[0]?.map((m) => m.to)).toEqual([
      "ply-2@example.com",
      "ply-3@example.com",
      "ply-4@example.com",
    ]);
  });

  it("never touches the second leg when the first has room", async () => {
    const second = new RecordingNotifier("b");
    const notifier = new SpilloverNotifier([
      new QuotaNotifier(new RecordingNotifier("a"), db, 10, DAY, "resend"),
      new QuotaNotifier(second, db, 10, DAY, "cloudflare"),
    ]);

    await notifier.send(messages(3));

    expect(second.calls).toEqual([]);
  });

  it("spends each leg's own daily counter, not a shared one", async () => {
    const notifier = new SpilloverNotifier([
      new QuotaNotifier(new RecordingNotifier("a"), db, 2, DAY, "resend"),
      new QuotaNotifier(new RecordingNotifier("b"), db, 10, DAY, "cloudflare"),
    ]);

    await notifier.send(messages(5));

    const rows = await db.select().from(emailQuota).where(eq(emailQuota.day, DAY_KEY));
    expect(rows.map((r) => [r.provider, r.sentCount]).sort()).toEqual([
      ["cloudflare", 3],
      ["resend", 2],
    ]);
  });

  it("still reports the ceiling reason when no leg has room", async () => {
    const notifier = new SpilloverNotifier([
      new QuotaNotifier(new RecordingNotifier("a"), db, 1, DAY, "resend"),
      new QuotaNotifier(new RecordingNotifier("b"), db, 1, DAY, "cloudflare"),
    ]);

    const results = await notifier.send(messages(3));

    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(true);
    expect(results[2]).toEqual({ ok: false, error: DAILY_CEILING_REASON });
  });

  // The three tests below are the class's whole safety story: a message that
  // might already have been delivered must never be offered to a second
  // provider. Widening the spill condition beyond an exact
  // DAILY_CEILING_REASON match is what these exist to catch.
  it("spills a definite provider refusal, which is certain nothing was sent", async () => {
    const spill = new RecordingNotifier("b");
    const notifier = new SpilloverNotifier([
      new QuotaNotifier(
        new FailingNotifier(`${PROVIDER_REFUSED_REASON}: cloudflare send failed: HTTP 403 bad token`),
        db,
        10,
        DAY,
        "cloudflare",
      ),
      new QuotaNotifier(spill, db, 10, DAY, "resend"),
    ]);

    const results = await notifier.send(messages(2));

    expect(spill.calls[0]?.map((m) => m.to)).toEqual(["ply-0@example.com", "ply-1@example.com"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("spills a bare refusal reason carrying no diagnostic detail", async () => {
    const spill = new RecordingNotifier("b");
    const notifier = new SpilloverNotifier([
      new QuotaNotifier(new FailingNotifier(PROVIDER_REFUSED_REASON), db, 10, DAY, "cloudflare"),
      new QuotaNotifier(spill, db, 10, DAY, "resend"),
    ]);

    await notifier.send(messages(1));

    expect(spill.calls[0]).toHaveLength(1);
  });

  // The reason is matched as a prefix so the provider's diagnostic survives
  // in the log line. That must not turn into a substring match: a reason
  // that merely *mentions* the refusal text elsewhere is not a refusal.
  it("does not spill an error that only contains the refusal reason later in the string", async () => {
    const spill = new RecordingNotifier("b");
    const notifier = new SpilloverNotifier([
      new QuotaNotifier(
        new FailingNotifier(`upstream said ${PROVIDER_REFUSED_REASON}: but this is a timeout`),
        db,
        10,
        DAY,
        "cloudflare",
      ),
      new QuotaNotifier(spill, db, 10, DAY, "resend"),
    ]);

    await notifier.send(messages(1));

    expect(spill.calls).toEqual([]);
  });

  it("does not spill a provider error, which is ambiguous about delivery", async () => {
    const spill = new RecordingNotifier("b");
    const notifier = new SpilloverNotifier([
      new QuotaNotifier(new FailingNotifier("resend batch failed: HTTP 500"), db, 10, DAY, "resend"),
      new QuotaNotifier(spill, db, 10, DAY, "cloudflare"),
    ]);

    const results = await notifier.send(messages(2));

    expect(spill.calls).toEqual([]);
    expect(results.map((r) => (r.ok ? "sent" : r.error))).toEqual([
      "resend batch failed: HTTP 500",
      "resend batch failed: HTTP 500",
    ]);
  });

  it("does not spill a successful send", async () => {
    const spill = new RecordingNotifier("b");
    await new SpilloverNotifier([
      new QuotaNotifier(new RecordingNotifier("a"), db, 10, DAY, "resend"),
      new QuotaNotifier(spill, db, 10, DAY, "cloudflare"),
    ]).send(messages(2));

    expect(spill.calls).toEqual([]);
  });

  it("does not spill a message with no recipient", async () => {
    const spill = new RecordingNotifier("b");
    const notifier = new SpilloverNotifier([
      new QuotaNotifier(new RecordingNotifier("a"), db, 10, DAY, "resend"),
      new QuotaNotifier(spill, db, 10, DAY, "cloudflare"),
    ]);

    const results = await notifier.send([message({ to: null as unknown as string })]);

    expect(results[0]).toEqual({ ok: false, error: NO_RECIPIENT_REASON });
    expect(spill.calls).toEqual([]);
  });

  it("records a contract violation without spilling when a leg returns a short array", async () => {
    const shortLeg: Notifier = {
      send: (sent) => Promise.resolve(sent.slice(0, 1).map((): SendResult => ({ ok: true, providerMessageId: null }))),
    };
    const spill = new RecordingNotifier("b");

    const results = await new SpilloverNotifier([shortLeg, spill]).send(messages(3));

    expect(results[1]).toEqual({ ok: false, error: NOTIFIER_CONTRACT_VIOLATION_REASON });
    expect(results[2]).toEqual({ ok: false, error: NOTIFIER_CONTRACT_VIOLATION_REASON });
    expect(spill.calls).toEqual([]);
  });

  it("behaves exactly like a bare quota wrapper when configured with one leg", async () => {
    const notifier = new SpilloverNotifier([new QuotaNotifier(new RecordingNotifier("a"), db, 1, DAY, "resend")]);

    const results = await notifier.send(messages(2));

    expect(results[0]?.ok).toBe(true);
    expect(results[1]).toEqual({ ok: false, error: DAILY_CEILING_REASON });
  });

  it("returns an empty array for an empty input without calling any leg", async () => {
    const first = new RecordingNotifier("a");
    expect(await new SpilloverNotifier([first]).send([])).toEqual([]);
    expect(first.calls).toEqual([]);
  });
});

describe("QuotaNotifier provider scoping", () => {
  it("keeps two providers' counters independent on the same day", async () => {
    const resend = new QuotaNotifier(new RecordingNotifier("a"), db, 1, DAY, "resend");
    const cloudflare = new QuotaNotifier(new RecordingNotifier("b"), db, 1, DAY, "cloudflare");

    expect((await resend.send(messages(1, "x")))[0]?.ok).toBe(true);
    // Resend is now full for the day; Cloudflare must be unaffected.
    expect((await resend.send(messages(1, "y")))[0]).toEqual({ ok: false, error: DAILY_CEILING_REASON });
    expect((await cloudflare.send(messages(1, "z")))[0]?.ok).toBe(true);

    const [row] = await db
      .select({ n: emailQuota.sentCount })
      .from(emailQuota)
      .where(and(eq(emailQuota.day, DAY_KEY), eq(emailQuota.provider, "cloudflare")));
    expect(row?.n).toBe(1);
  });

  it("defaults to the resend counter, matching the pre-M42 rows the migration backfills", async () => {
    await new QuotaNotifier(new RecordingNotifier("a"), db, 5, DAY).send(messages(2));

    const rows = await db.select().from(emailQuota).where(eq(emailQuota.day, DAY_KEY));
    expect(rows).toEqual([{ day: DAY_KEY, provider: "resend", sentCount: 2 }]);
  });
});

describe("the M54 warm-up arrangement", () => {
  /** The three legs `selectEmailLeg` builds when EMAIL_WARMUP_PER_DAY > 0. */
  function warmUp(warmUpPerDay: number, resendCeiling: number, cloudflareCeiling: number) {
    const cloudflare = new RecordingNotifier("cf");
    const resend = new RecordingNotifier("rs");
    const notifier = new SpilloverNotifier([
      new QuotaNotifier(cloudflare, db, warmUpPerDay, DAY, "cloudflare"),
      new QuotaNotifier(resend, db, resendCeiling, DAY, "resend"),
      new QuotaNotifier(cloudflare, db, cloudflareCeiling, DAY, "cloudflare"),
    ]);
    return { notifier, cloudflare, resend };
  }

  it("sends the day's first few through Cloudflare and the rest through Resend", async () => {
    const { notifier, cloudflare, resend } = warmUp(5, 95, 100);

    await notifier.send(messages(12));

    expect(cloudflare.calls[0]?.map((m) => m.to)).toEqual([
      "ply-0@example.com",
      "ply-1@example.com",
      "ply-2@example.com",
      "ply-3@example.com",
      "ply-4@example.com",
    ]);
    expect(resend.calls[0]).toHaveLength(7);
  });

  it("stops warming up once the day's slice is spent, across separate batches", async () => {
    const { notifier, cloudflare, resend } = warmUp(5, 95, 100);

    await notifier.send(messages(3, "a"));
    await notifier.send(messages(3, "b"));
    await notifier.send(messages(3, "c"));

    // 3 + 2 warm-up sends, then nothing more through that leg.
    expect(cloudflare.calls.map((c) => c.length)).toEqual([3, 2]);
    expect(resend.calls.map((c) => c.length)).toEqual([1, 3]);
  });

  // The property the whole three-leg arrangement rests on: both Cloudflare
  // legs share one counter row, so the warm-up spends from the same daily
  // allowance the spill leg draws on rather than adding to it.
  it("adds no capacity — the day's total is unchanged by the warm-up", async () => {
    const { notifier } = warmUp(5, 10, 20);

    const results = await notifier.send(messages(40));

    // 10 via Resend + 20 via Cloudflare (5 warming, 15 spilling), not 35.
    expect(results.filter((r) => r.ok)).toHaveLength(30);
    const rows = await db.select().from(emailQuota).where(eq(emailQuota.day, DAY_KEY));
    expect(rows.map((r) => [r.provider, r.sentCount]).sort()).toEqual([
      ["cloudflare", 20],
      ["resend", 10],
    ]);
  });

  it("falls through to Resend when the warm-up leg refuses, losing nothing", async () => {
    const cloudflare = new FailingNotifier(`${PROVIDER_REFUSED_REASON}: HTTP 403 bad token`);
    const resend = new RecordingNotifier("rs");
    const notifier = new SpilloverNotifier([
      new QuotaNotifier(cloudflare, db, 5, DAY, "cloudflare"),
      new QuotaNotifier(resend, db, 95, DAY, "resend"),
      new QuotaNotifier(cloudflare, db, 100, DAY, "cloudflare"),
    ]);

    const results = await notifier.send(messages(8));

    expect(results.every((r) => r.ok)).toBe(true);
    expect(resend.calls[0]).toHaveLength(8);
  });
});
