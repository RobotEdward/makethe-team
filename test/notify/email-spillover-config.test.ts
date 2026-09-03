import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/db/client.js";
import { emailQuota } from "../../src/db/schema.js";
import type { Bindings } from "../../src/env.js";
import { createNotifier, emailCeilingTotal } from "../../src/notify/factory.js";
import type { EmailMessage } from "../../src/notify/notifier.js";
import { DAILY_CEILING_REASON } from "../../src/notify/quota.js";
import { resetDatabase } from "../support/factories.js";

const NOW = new Date("2026-08-29T09:00:00Z");
const DAY_KEY = "2026-08-29";
const db = getDb(env.DB);

function bindings(overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: env.DB,
    FIXTURE_CAPACITY: {} as Bindings["FIXTURE_CAPACITY"],
    NOTIFIER: "console",
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
    ...overrides,
  };
}

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

beforeEach(async () => {
  await resetDatabase();
});

/**
 * Makes the Cloudflare leg's transport succeed, echoing whatever recipient
 * it was given back as delivered.
 *
 * Needed because the spill leg is a real `CloudflareEmailNotifier` even
 * when `NOTIFIER` is `"console"` — the two switches are independent, so
 * there is no console stand-in on that side. Without this the leg's sends
 * fail at the network (which `vitest.config.ts` blocks) and every test
 * below would measure the primary's ceiling alone while appearing to test
 * the pair.
 */
function stubCloudflareTransport(): ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as { to: string };
    return new Response(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: { delivered: [payload.to], permanent_bounces: [], queued: [] },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

describe("EMAIL_SPILLOVER binding", () => {
  it("is optional, so an env predating M42 still builds a notifier", () => {
    expect(() => createNotifier(bindings(), db, NOW)).not.toThrow();
  });

  it('throws by name on a typo rather than silently sending without a spill leg', () => {
    expect(() => createNotifier(bindings({ EMAIL_SPILLOVER: "cloudfalre" }), db, NOW)).toThrow(
      /unrecognised EMAIL_SPILLOVER binding/,
    );
  });

  it("names the missing Cloudflare binding rather than sending with an undefined token", () => {
    expect(() =>
      createNotifier(bindings({ EMAIL_SPILLOVER: "cloudflare", CLOUDFLARE_ACCOUNT_ID: "acct" }), db, NOW),
    ).toThrow(/CLOUDFLARE_EMAIL_API_TOKEN is missing or empty/);

    expect(() =>
      createNotifier(
        bindings({ EMAIL_SPILLOVER: "cloudflare", CLOUDFLARE_EMAIL_API_TOKEN: "tok" }),
        db,
        NOW,
      ),
    ).toThrow(/CLOUDFLARE_ACCOUNT_ID is missing or empty/);
  });

  // The spill leg is a second provider that can spend money past
  // Cloudflare's included 3,000 a month. The ceiling is this project's only
  // real cost control, so the leg must be quota-wrapped exactly as the
  // primary is — this test spends the whole of both ceilings and checks that
  // the counters, not the providers, are what stop the sending.
  it("caps the spill leg with its own ceiling rather than letting it send uncapped", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stubCloudflareTransport();
    try {
      const notifier = createNotifier(
        bindings({
          NOTIFIER: "console",
          MAX_EMAILS_PER_DAY: "2",
          EMAIL_SPILLOVER: "cloudflare",
          MAX_EMAILS_PER_DAY_CLOUDFLARE: "3",
          CLOUDFLARE_ACCOUNT_ID: "acct",
          CLOUDFLARE_EMAIL_API_TOKEN: "tok",
        }),
        db,
        NOW,
      );

      // Six messages against a combined ceiling of five. The sixth must be
      // refused — by the counters, not by either provider, which is the
      // property this test exists for.
      const results = await notifier.send(Array.from({ length: 6 }, () => message()));

      expect(results.filter((r) => r.ok)).toHaveLength(5);
      expect(results[5]).toEqual({ ok: false, error: DAILY_CEILING_REASON });
    } finally {
      vi.restoreAllMocks();
      logSpy.mockRestore();
    }
  });

  it("fails the spill ceiling closed, so a broken value disables the leg instead of uncapping it", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(
        emailCeilingTotal(
          bindings({ EMAIL_SPILLOVER: "cloudflare", MAX_EMAILS_PER_DAY_CLOUDFLARE: "lots" }),
        ),
      ).toBe(50);
      expect(errorSpy.mock.calls.flat().join(" ")).toContain("MAX_EMAILS_PER_DAY_CLOUDFLARE");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("emailCeilingTotal", () => {
  it("reports the primary ceiling alone when there is no spill leg", () => {
    expect(emailCeilingTotal(bindings())).toBe(50);
    expect(emailCeilingTotal(bindings({ EMAIL_SPILLOVER: "none" }))).toBe(50);
  });

  it("adds the spill leg's ceiling when one is configured", () => {
    expect(
      emailCeilingTotal(bindings({ EMAIL_SPILLOVER: "cloudflare", MAX_EMAILS_PER_DAY_CLOUDFLARE: "100" })),
    ).toBe(150);
  });

  // The admin pages report this number while `selectEmailLeg` builds the
  // legs that actually spend it, and the two enumerate the providers
  // separately. This pins them together: whatever capacity the reported
  // total claims must be capacity the built notifier will really send.
  it("matches what the built notifier will actually send in a day", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stubCloudflareTransport();
    try {
      const env2 = bindings({
        MAX_EMAILS_PER_DAY: "4",
        EMAIL_SPILLOVER: "cloudflare",
        MAX_EMAILS_PER_DAY_CLOUDFLARE: "3",
        CLOUDFLARE_ACCOUNT_ID: "acct",
        CLOUDFLARE_EMAIL_API_TOKEN: "tok",
      });
      const total = emailCeilingTotal(env2);

      const results = await createNotifier(env2, db, NOW).send(
        Array.from({ length: total + 1 }, () => message()),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(total);
      const rows = await db.select().from(emailQuota).where(eq(emailQuota.day, DAY_KEY));
      expect(rows.reduce((sum, row) => sum + row.sentCount, 0)).toBe(total);
      // Both legs really contributed — a total that happened to match while
      // one leg sent nothing would not be evidence of anything.
      expect(rows.map((row) => [row.provider, row.sentCount]).sort()).toEqual([
        ["cloudflare", 3],
        ["resend", 4],
      ]);
    } finally {
      vi.restoreAllMocks();
      logSpy.mockRestore();
    }
  });
});

describe("EMAIL_WARMUP_PER_DAY", () => {
  function cloudflareEnv(overrides: Partial<Bindings> = {}): Bindings {
    return bindings({
      NOTIFIER: "console",
      EMAIL_SPILLOVER: "cloudflare",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_EMAIL_API_TOKEN: "tok",
      ...overrides,
    });
  }

  /** Which provider each send went through, in order. */
  async function sendVia(env2: Bindings, count: number): Promise<string[]> {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { to: string };
      seen.push(payload.to);
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { delivered: [payload.to], permanent_bounces: [], queued: [] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    try {
      await createNotifier(env2, db, NOW).send(
        Array.from({ length: count }, (_, i) => message({ to: `ply-${i}@example.com` })),
      );
      return seen;
    } finally {
      vi.restoreAllMocks();
      logSpy.mockRestore();
    }
  }

  it("routes the day's first few through Cloudflare when set", async () => {
    const viaCloudflare = await sendVia(cloudflareEnv({ EMAIL_WARMUP_PER_DAY: "3" }), 10);

    expect(viaCloudflare).toEqual(["ply-0@example.com", "ply-1@example.com", "ply-2@example.com"]);
  });

  it("routes nothing through Cloudflare when absent, as before M54", async () => {
    expect(await sendVia(cloudflareEnv(), 10)).toEqual([]);
  });

  it("routes nothing through Cloudflare when explicitly zero", async () => {
    expect(await sendVia(cloudflareEnv({ EMAIL_WARMUP_PER_DAY: "0" }), 10)).toEqual([]);
  });

  it("fails closed on a broken value rather than sending everything through the newer provider", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await sendVia(cloudflareEnv({ EMAIL_WARMUP_PER_DAY: "all of them" }), 10)).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // The warm-up moves traffic earlier; it must not create any. If it did, the
  // figure the admin pages report would understate what the day can spend.
  it("does not change the day's reported ceiling", () => {
    const withWarmUp = cloudflareEnv({
      MAX_EMAILS_PER_DAY: "95",
      MAX_EMAILS_PER_DAY_CLOUDFLARE: "100",
      EMAIL_WARMUP_PER_DAY: "5",
    });
    const without = cloudflareEnv({
      MAX_EMAILS_PER_DAY: "95",
      MAX_EMAILS_PER_DAY_CLOUDFLARE: "100",
    });

    expect(emailCeilingTotal(withWarmUp)).toBe(195);
    expect(emailCeilingTotal(withWarmUp)).toBe(emailCeilingTotal(without));
  });

  it("still sends exactly the reported ceiling in a day with the warm-up on", async () => {
    const env2 = cloudflareEnv({
      MAX_EMAILS_PER_DAY: "4",
      MAX_EMAILS_PER_DAY_CLOUDFLARE: "3",
      EMAIL_WARMUP_PER_DAY: "2",
    });
    const total = emailCeilingTotal(env2);
    expect(total).toBe(7);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    stubCloudflareTransport();
    try {
      const results = await createNotifier(env2, db, NOW).send(
        Array.from({ length: total + 3 }, () => message()),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(total);
      const rows = await db.select().from(emailQuota).where(eq(emailQuota.day, DAY_KEY));
      expect(rows.map((row) => [row.provider, row.sentCount]).sort()).toEqual([
        ["cloudflare", 3],
        ["resend", 4],
      ]);
    } finally {
      vi.restoreAllMocks();
      logSpy.mockRestore();
    }
  });
});
