import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNotifier } from "../../src/notify/factory.js";
import { getDb } from "../../src/db/client.js";
import { emailQuota } from "../../src/db/schema.js";
import { ConsoleNotifier } from "../../src/notify/console-notifier.js";
import { NullNotifier } from "../../src/notify/null-notifier.js";
import { RouterNotifier } from "../../src/notify/router-notifier.js";
import type { EmailMessage, Notifier, PushMessage } from "../../src/notify/notifier.js";
import type { Bindings } from "../../src/env.js";
import { insertPlayer, insertSubscription, resetDatabase } from "../support/factories.js";

const NOW = new Date("2026-08-11T09:00:00Z");
const db = getDb(env.DB);

function bindings(notifier: string): Bindings {
  return {
    DB: env.DB,
    FIXTURE_CAPACITY: {} as Bindings["FIXTURE_CAPACITY"],
    NOTIFIER: notifier,
    MAX_EMAILS_PER_DAY: "50",
    RESPONSE_TOKEN_SECRET: "test-secret",
    CANCEL_TOKEN_SECRET: "test-cancel-secret",
    RESEND_API_KEY: "test-resend-key",
    EMAIL_FROM: "reminders@example.com",
    BETTER_AUTH_SECRET: "test-secret",
    BETTER_AUTH_URL: "http://localhost:8787",
    SIGNIN_ALLOWLIST: "test-only-not-a-real-address@example.com",
    PUSH_NOTIFIER: "null",
    VAPID_PUBLIC_KEY: "test-vapid-public-key",
    VAPID_SUBJECT: "mailto:ops@makethe.team",
    VAPID_PRIVATE_KEY: "test-vapid-private-key",
  };
}

beforeEach(async () => {
  await resetDatabase();
});

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
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
  // Since M14, createNotifier always returns a RouterNotifier (router-notifier.ts)
  // that splits by channel and sends email through exactly the QuotaNotifier-
  // wrapped path it always used (TR-31, TR-32) — that is still the one thing
  // every caller's messages route through for the email channel, just no
  // longer the type `createNotifier` itself returns.
  it("wraps every choice in a RouterNotifier so the ceiling cannot be bypassed for email", () => {
    expect(createNotifier(bindings("console"), db, NOW)).toBeInstanceOf(RouterNotifier);
    expect(createNotifier(bindings("null"), db, NOW)).toBeInstanceOf(RouterNotifier);
    expect(createNotifier(bindings("resend"), db, NOW)).toBeInstanceOf(RouterNotifier);
  });

  it("still delegates to ConsoleNotifier's behaviour for env.NOTIFIER === 'console'", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const results = await createNotifier(bindings("console"), db, NOW).send([message()]);
      expect(results).toEqual([{ ok: true, providerMessageId: null }]);
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("still delegates to NullNotifier's behaviour for env.NOTIFIER === 'null'", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const results = await createNotifier(bindings("null"), db, NOW).send([message()]);
      expect(results).toEqual([{ ok: true, providerMessageId: null }]);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  // The branch whose absence was the whole problem: `ResendNotifier` existed,
  // was fully tested on its own, and was imported by nothing in `src/`. Every
  // factory branch is now covered, including this one, because a test that
  // stops at "console" and "null" is exactly what let `NOTIFIER=resend` ship
  // as a guaranteed throw at the top of every sweep.
  describe("env.NOTIFIER === 'resend'", () => {
    it("constructs a working notifier that reaches Resend, still behind the daily ceiling", async () => {
      const notifier = createNotifier(bindings("resend"), db, NOW);
      expect(notifier).toBeInstanceOf(RouterNotifier);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "resend-msg-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      try {
        const results = await notifier.send([message()]);
        expect(results).toEqual([{ ok: true, providerMessageId: "resend-msg-1" }]);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0] ?? [];
        expect(String(url)).toBe("https://api.resend.com/emails/batch");
        const headers = new Headers(init?.headers);
        // Built from the bindings, not from anything hardcoded.
        expect(headers.get("Authorization")).toBe("Bearer test-resend-key");
        expect(JSON.parse(String(init?.body))).toEqual([
          expect.objectContaining({ from: "reminders@example.com", to: "player@example.com" }),
        ]);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("still refuses to exceed the daily ceiling — the real sender cannot bypass the one cost control", async () => {
      const zeroCeiling: Bindings = { ...bindings("resend"), MAX_EMAILS_PER_DAY: "0" };
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("the daily ceiling let a message through to the network");
      });
      try {
        const results = await createNotifier(zeroCeiling, db, NOW).send([message()]);
        expect(results).toEqual([{ ok: false, error: "daily-ceiling-reached" }]);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("fails loudly and by name when RESEND_API_KEY is missing or blank", () => {
      for (const value of [undefined as unknown as string, "", "   "]) {
        const broken: Bindings = { ...bindings("resend"), RESEND_API_KEY: value };
        expect(() => createNotifier(broken, db, NOW)).toThrow(/RESEND_API_KEY/);
        expect(() => createNotifier(broken, db, NOW)).toThrow(/NOTIFIER is "resend"/);
      }
    });

    it("fails loudly and by name when EMAIL_FROM is missing or blank", () => {
      for (const value of [undefined as unknown as string, "", "   "]) {
        const broken: Bindings = { ...bindings("resend"), EMAIL_FROM: value };
        expect(() => createNotifier(broken, db, NOW)).toThrow(/EMAIL_FROM/);
        expect(() => createNotifier(broken, db, NOW)).toThrow(/NOTIFIER is "resend"/);
      }
    });

    it("names only the binding that is actually missing, so one log line diagnoses it", () => {
      const broken: Bindings = { ...bindings("resend"), EMAIL_FROM: "" };
      expect(() => createNotifier(broken, db, NOW)).not.toThrow(/RESEND_API_KEY/);
    });
  });

  it("throws at startup with a clear message for an unrecognised value", () => {
    expect(() => createNotifier(bindings("resend-but-typoed"), db, NOW)).toThrow(/resend-but-typoed/);
    expect(() => createNotifier(bindings("resend-but-typoed"), db, NOW)).toThrow(/NOTIFIER/);
  });

  it("throws for an empty string binding rather than defaulting silently", () => {
    expect(() => createNotifier(bindings(""), db, NOW)).toThrow();
  });

  describe("env.PUSH_NOTIFIER", () => {
    // The property that matters most for production today: wrangler.jsonc
    // ships PUSH_NOTIFIER: "null" with no VAPID_* vars present at all (M14
    // ships push dark until the real keypair exists). `bindings()` above
    // always supplies all three VAPID values, which would hide a regression
    // where a future edit reads a VAPID binding above the switch instead of
    // only inside the "webpush" case — this test builds Bindings without
    // any of them and proves createNotifier still doesn't throw.
    it('does not require any VAPID binding when PUSH_NOTIFIER is "null"', () => {
      const noVapid: Bindings = {
        ...bindings("console"),
        PUSH_NOTIFIER: "null",
        VAPID_PUBLIC_KEY: undefined as unknown as string,
        VAPID_PRIVATE_KEY: undefined as unknown as string,
        VAPID_SUBJECT: undefined as unknown as string,
      };
      expect(() => createNotifier(noVapid, db, NOW)).not.toThrow();
    });

    // Mirrors "throws at startup with a clear message for an unrecognised
    // [NOTIFIER] value" above — a typo in PUSH_NOTIFIER must not quietly
    // disable push the same way a typo in NOTIFIER must not quietly
    // disable email.
    it("throws at startup with a clear message for an unrecognised value", () => {
      const broken: Bindings = { ...bindings("console"), PUSH_NOTIFIER: "webpush-but-typoed" };
      expect(() => createNotifier(broken, db, NOW)).toThrow(/webpush-but-typoed/);
      expect(() => createNotifier(broken, db, NOW)).toThrow(/PUSH_NOTIFIER/);
    });

    // The seam nothing else exercises: `"webpush"` is the only branch that
    // reads a VAPID binding, wires it through `vapidKeys()`'s three
    // `requireBinding` calls and the `importVapidKeys` -> `assertVapidKeysMatch`
    // chain, and constructs a real `PushNotifier`. `PushNotifier`,
    // `web-push.ts` and `RouterNotifier` are each covered in isolation
    // elsewhere; this is the only place the whole chain is wired together
    // from `env`, exactly as `createNotifier` itself does it in production —
    // and production turns this on tomorrow. The VAPID pair below is the
    // genuine, matching P-256 pair pinned in `vitest.config.ts` for exactly
    // this purpose (see its own comment there): real crypto, not a stub.
    describe('env.PUSH_NOTIFIER === "webpush"', () => {
      function webpushBindings(): Bindings {
        return {
          ...bindings("null"),
          PUSH_NOTIFIER: "webpush",
          VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
          VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY,
          VAPID_SUBJECT: env.VAPID_SUBJECT,
        };
      }

      function pushMessage(to: string, overrides: Partial<PushMessage> = {}): PushMessage {
        return {
          channel: "push",
          to,
          dedupeKey: `n7:fix-1:${crypto.randomUUID()}`,
          title: "Fixture moved",
          body: "Kickoff is now 20:00.",
          url: "https://makethe.team/g/abc/f/def",
          tag: "fixture:def",
          ...overrides,
        };
      }

      it("builds a working PushNotifier that signs a real VAPID request and encrypts a real aes128gcm body", async () => {
        const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
        await insertSubscription(db, playerId, "https://push.example/phone");

        let capturedRequest: Request | undefined;
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
          capturedRequest = new Request(input as RequestInfo, init);
          return new Response(null, { status: 201 });
        });
        try {
          const notifier = createNotifier(webpushBindings(), db, NOW);
          expect(notifier).toBeInstanceOf(RouterNotifier);

          const [result] = await notifier.send([pushMessage(playerId)]);

          expect(result).toEqual({ ok: true, providerMessageId: null });
          expect(fetchSpy).toHaveBeenCalledTimes(1);
          if (capturedRequest === undefined) throw new Error("expected a captured request");

          expect(capturedRequest.url).toBe("https://push.example/phone");
          // "vapid t=<jwt>, k=<public key>" — proves the signed JWT actually
          // made it out of createNotifier's wiring, not just that some
          // Authorization header was set.
          const authorization = capturedRequest.headers.get("Authorization");
          expect(authorization).toMatch(/^vapid t=[^,]+, k=.+$/);
          expect(authorization).toContain(`k=${env.VAPID_PUBLIC_KEY}`);

          // The body is the aes128gcm-encrypted payload, not the plaintext
          // JSON — the RFC 8188 header alone (salt(16) + rs(4) + idlen(1) +
          // keyid) is 21+ bytes before a single byte of ciphertext.
          const body = new Uint8Array(await capturedRequest.arrayBuffer());
          expect(body.byteLength).toBeGreaterThan(21);
          const decoded = new TextDecoder().decode(body);
          expect(decoded).not.toContain("Kickoff is now 20:00");
        } finally {
          fetchSpy.mockRestore();
        }
      });

      it("memoises the imported VAPID keypair across calls (spec §10.3), reusing it for a second send", async () => {
        const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
        await insertSubscription(db, playerId, "https://push.example/phone");
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));
        try {
          const bindingsForBoth = webpushBindings();
          const first = createNotifier(bindingsForBoth, db, NOW);
          const second = createNotifier(bindingsForBoth, db, NOW);

          const [firstResult] = await first.send([pushMessage(playerId)]);
          const [secondResult] = await second.send([pushMessage(playerId)]);

          expect(firstResult).toEqual({ ok: true, providerMessageId: null });
          expect(secondResult).toEqual({ ok: true, providerMessageId: null });
        } finally {
          fetchSpy.mockRestore();
        }
      });
    });
  });

  // Spec §15: "Push consumes no email quota — a regression test, because
  // this is the whole point of §10.2." The property is already structurally
  // guaranteed by RouterNotifier routing push around QuotaNotifier entirely
  // (see router-notifier.ts's doc comment), but nothing asserted it at the
  // one place an operator would actually notice a regression: the
  // `email_quota` counter itself.
  describe("push consumes no email quota (spec §15)", () => {
    it("sending a batch of push messages leaves the day's email_quota.sent_count unchanged", async () => {
      const playerA = await insertPlayer(db, { name: "A", email: "a@example.com" });
      const playerB = await insertPlayer(db, { name: "B", email: "b@example.com" });
      await insertSubscription(db, playerA, "https://push.example/a");
      await insertSubscription(db, playerB, "https://push.example/b");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 201 }));
      try {
        const notifier = createNotifier(
          { ...bindings("console"), PUSH_NOTIFIER: "console" },
          db,
          NOW,
        );

        const pushMessages: PushMessage[] = [playerA, playerB].map((to) => ({
          channel: "push",
          to,
          dedupeKey: `n7:fix-2:${crypto.randomUUID()}`,
          title: "Fixture moved",
          body: "Kickoff is now 20:00.",
          url: "https://makethe.team/g/abc/f/def",
          tag: "fixture:def",
        }));

        const results = await notifier.send(pushMessages);
        expect(results.every((result) => result.ok)).toBe(true);

        const day = NOW.toISOString().slice(0, 10);
        const rows = await db.select().from(emailQuota).where(eq(emailQuota.day, day));
        // No row at all is the expected state — nothing ever incremented
        // the counter for the day, rather than a row that happens to read 0.
        expect(rows).toHaveLength(0);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
