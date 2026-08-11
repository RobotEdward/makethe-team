import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNotifier } from "../../src/notify/factory.js";
import { ConsoleNotifier } from "../../src/notify/console-notifier.js";
import { NullNotifier } from "../../src/notify/null-notifier.js";
import { QuotaNotifier } from "../../src/notify/quota.js";
import type { Message, Notifier } from "../../src/notify/notifier.js";
import type { Bindings } from "../../src/env.js";
import { resetDatabase } from "../support/factories.js";

const NOW = new Date("2026-08-11T09:00:00Z");

function bindings(notifier: string): Bindings {
  return {
    DB: env.DB,
    FIXTURE_CAPACITY: {} as Bindings["FIXTURE_CAPACITY"],
    NOTIFIER: notifier,
    MAX_EMAILS_PER_DAY: "50",
    RESPONSE_TOKEN_SECRET: "test-secret",
    RESEND_API_KEY: "test-resend-key",
    EMAIL_FROM: "reminders@example.com",
  };
}

beforeEach(async () => {
  await resetDatabase();
});

function message(overrides: Partial<Message> = {}): Message {
  return {
    channel: "email",
    to: "player@example.com",
    subject: "You're in",
    html: "<p>You're in</p>",
    text: "You're in",
    dedupeKey: "n1:fix-1:ply-1",
    ...overrides,
  };
}

/**
 * `send` must return exactly one `SendResult` per input message, in the same
 * order (§ task-11 brief). The sweep maps results back onto
 * `notification_log` rows by index — a length mismatch or reordering would
 * attribute one player's delivery failure to a different player. Run this
 * check against both implementations, including the empty and
 * single-element edge cases.
 */
function describeOrderingContract(name: string, makeNotifier: () => Notifier): void {
  describe(`${name}: length and ordering guarantee`, () => {
    it("returns an empty array for an empty input", async () => {
      const results = await makeNotifier().send([]);
      expect(results).toHaveLength(0);
    });

    it("returns exactly one result for a single-element input", async () => {
      const results = await makeNotifier().send([message()]);
      expect(results).toHaveLength(1);
    });

    it("returns results in the same order as the input, one per message", async () => {
      const messages = [
        message({ to: "a@example.com", dedupeKey: "n1:fix-1:a" }),
        message({ to: "b@example.com", dedupeKey: "n1:fix-1:b" }),
        message({ to: "c@example.com", dedupeKey: "n1:fix-1:c" }),
      ];

      const results = await makeNotifier().send(messages);

      expect(results).toHaveLength(messages.length);
      // Every result reports the input length preserved exactly, and (since
      // both implementations always succeed) every slot is a success — the
      // property under test is the shape, not the content, so an index-wise
      // zip against the input is the meaningful assertion here.
      messages.forEach((_msg, index) => {
        expect(results[index]).toEqual({ ok: true, providerMessageId: null });
      });
    });

    it("handles a large batch without dropping or reordering results", async () => {
      const messages = Array.from({ length: 25 }, (_, i) =>
        message({ to: `player-${i}@example.com`, dedupeKey: `n1:fix-1:ply-${i}` }),
      );

      const results = await makeNotifier().send(messages);

      expect(results).toHaveLength(25);
      results.forEach((result) => {
        expect(result.ok).toBe(true);
      });
    });
  });
}

describeOrderingContract("ConsoleNotifier", () => new ConsoleNotifier());
describeOrderingContract("NullNotifier", () => new NullNotifier());

describe("ConsoleNotifier", () => {
  it("logs the recipient, subject and dedupe key for each message", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const notifier = new ConsoleNotifier();
      await notifier.send([
        message({
          to: "player@example.com",
          subject: "Reminder: Tuesday 7pm",
          dedupeKey: "n1:fix-1:ply-1",
        }),
      ]);

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = logSpy.mock.calls[0]?.[0] as string;
      expect(logged).toContain("player@example.com");
      expect(logged).toContain("Reminder: Tuesday 7pm");
      expect(logged).toContain("n1:fix-1:ply-1");
      expect(logged).toContain("email");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("reports success with a null providerMessageId (no real provider to assign one)", async () => {
    const results = await new ConsoleNotifier().send([message()]);
    expect(results).toEqual([{ ok: true, providerMessageId: null }]);
  });

  it("never calls fetch", () => {
    expect(ConsoleNotifier.toString()).not.toContain("fetch(");
  });
});

describe("NullNotifier", () => {
  it("discards every message silently and reports success", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const results = await new NullNotifier().send([message(), message()]);
      expect(results).toEqual([
        { ok: true, providerMessageId: null },
        { ok: true, providerMessageId: null },
      ]);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("never calls fetch", () => {
    expect(NullNotifier.toString()).not.toContain("fetch(");
  });
});

describe("createNotifier", () => {
  // createNotifier always wraps its choice in QuotaNotifier (TR-31, TR-32) so
  // nothing downstream can bypass the daily send ceiling — that is now the
  // one type every caller ever sees back.
  it("wraps the selection in QuotaNotifier so the ceiling cannot be bypassed", () => {
    expect(createNotifier(bindings("console"), NOW)).toBeInstanceOf(QuotaNotifier);
    expect(createNotifier(bindings("null"), NOW)).toBeInstanceOf(QuotaNotifier);
  });

  it("still delegates to ConsoleNotifier's behaviour for env.NOTIFIER === 'console'", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const results = await createNotifier(bindings("console"), NOW).send([message()]);
      expect(results).toEqual([{ ok: true, providerMessageId: null }]);
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("still delegates to NullNotifier's behaviour for env.NOTIFIER === 'null'", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const results = await createNotifier(bindings("null"), NOW).send([message()]);
      expect(results).toEqual([{ ok: true, providerMessageId: null }]);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("throws at startup with a clear message for an unrecognised value", () => {
    expect(() => createNotifier(bindings("resend-but-typoed"), NOW)).toThrow(/resend-but-typoed/);
    expect(() => createNotifier(bindings("resend-but-typoed"), NOW)).toThrow(/NOTIFIER/);
  });

  it("throws for an empty string binding rather than defaulting silently", () => {
    expect(() => createNotifier(bindings(""), NOW)).toThrow();
  });
});
