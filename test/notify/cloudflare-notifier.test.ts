/**
 * Mocks outbound `fetch` with `vi.spyOn(globalThis, "fetch")`, matching
 * `resend-notifier.test.ts` — see that file's header for why `fetchMock`
 * from `"cloudflare:test"` is not used. The default implementation throws,
 * so an un-mocked call fails the test rather than reaching the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareEmailNotifier, PROVIDER_REFUSED_REASON } from "../../src/notify/cloudflare-notifier.js";
import type { EmailMessage, Message, PushMessage, SendResult } from "../../src/notify/notifier.js";

const ACCOUNT_ID = "test-fake-account-id";
const API_TOKEN = "test-fake-cloudflare-token-not-real";
const FROM = "reminders@example.com";

let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("unexpected fetch call: no mock installed for this test");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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

function messages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) =>
    message({ to: `ply-${i}@example.com`, dedupeKey: `n1:fix-1:ply-${i}` }),
  );
}

/** A 200 body in Cloudflare's documented success shape. */
function deliveredBody(recipients: string[]): string {
  return JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result: { delivered: recipients, permanent_bounces: [], queued: [] },
  });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

/** Answers every request by looking up the recipient in `bodyFor`. */
function respondPerRecipient(bodyFor: (to: string) => Response): void {
  fetchSpy.mockImplementation(async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as { to: string };
    return bodyFor(payload.to);
  });
}

/**
 * Whether a result carries the spillable "the provider said no" verdict.
 * Written once here so each assertion reads as the question it is asking
 * rather than as null-handling.
 */
function isRefusal(result: SendResult | undefined): boolean {
  return result !== undefined && !result.ok && result.error.startsWith(PROVIDER_REFUSED_REASON);
}

function notifier(): CloudflareEmailNotifier {
  return new CloudflareEmailNotifier(ACCOUNT_ID, API_TOKEN, FROM);
}

describe("CloudflareEmailNotifier", () => {
  it("posts to the account's send endpoint with a bearer token", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(deliveredBody(["player@example.com"])));

    await notifier().send([message()]);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/email/sending/send`,
    );
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${API_TOKEN}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      from: FROM,
      to: "player@example.com",
      subject: "You're in",
      html: "<p>You're in</p>",
      text: "You're in",
    });
  });

  it("sends one request per message — there is no batch endpoint", async () => {
    respondPerRecipient((to) => jsonResponse(deliveredBody([to])));

    const results = await notifier().send(messages(5));

    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("returns results in input order even when responses resolve out of order", async () => {
    // Later recipients answer first, so a naive implementation that pushed
    // results as they arrived would reorder them — and the sweep maps
    // results onto notification_log rows by index.
    respondPerRecipient((to) => (to === "ply-0@example.com" ? jsonResponse(deliveredBody([to])) : jsonResponse(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: { delivered: [], permanent_bounces: [to], queued: [] },
      }),
    )));

    const results = await notifier().send(messages(3));

    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
  });

  it("treats a permanent bounce on an HTTP 200 as a failure", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { delivered: [], permanent_bounces: ["player@example.com"], queued: [] },
        }),
      ),
    );

    const [result] = await notifier().send([message()]);

    expect(result).toEqual({ ok: false, error: "cloudflare send permanently bounced" });
  });

  it("counts a queued recipient as sent", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { delivered: [], permanent_bounces: [], queued: ["player@example.com"] },
        }),
      ),
    );

    expect((await notifier().send([message()]))[0]).toEqual({ ok: true, providerMessageId: null });
  });

  it("fails when a 200 mentions the recipient nowhere at all", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { delivered: ["someone-else@example.com"], permanent_bounces: [], queued: [] },
        }),
      ),
    );

    const [result] = await notifier().send([message()]);

    expect(result).toEqual({
      ok: false,
      error: "cloudflare send reported neither delivery nor bounce for this recipient",
    });
  });

  it("reports Cloudflare's error codes when success is false", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        JSON.stringify({
          success: false,
          errors: [{ code: 10004, message: "Rate limit exceeded" }],
          messages: [],
          result: null,
        }),
      ),
    );

    const [result] = await notifier().send([message()]);

    expect(result).toEqual({
      ok: false,
      error: `${PROVIDER_REFUSED_REASON}: cloudflare send rejected: 10004: Rate limit exceeded`,
    });
  });

  it("fails every message without throwing when the request itself fails", async () => {
    fetchSpy.mockRejectedValue(new Error("connection reset"));

    const results = await notifier().send(messages(3));

    expect(results).toHaveLength(3);
    expect(results.map((r) => (r.ok ? "sent" : r.error))).toEqual([
      "cloudflare send request failed: connection reset",
      "cloudflare send request failed: connection reset",
      "cloudflare send request failed: connection reset",
    ]);
  });

  it("reports a non-2xx status with its body", async () => {
    fetchSpy.mockResolvedValue(new Response("nope", { status: 403 }));

    const [result] = await notifier().send([message()]);

    expect(result).toEqual({
      ok: false,
      error: `${PROVIDER_REFUSED_REASON}: cloudflare send failed: HTTP 403 nope`,
    });
  });

  it("reports a 200 whose body is not JSON", async () => {
    fetchSpy.mockResolvedValue(new Response("<html>", { status: 200 }));

    const [result] = await notifier().send([message()]);

    expect(result).toEqual({
      ok: false,
      error: "cloudflare send succeeded but response body was not valid JSON",
    });
  });

  it("tolerates a malformed result object rather than throwing", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(JSON.stringify({ success: true, result: { delivered: "not-an-array" } })),
    );

    const [result] = await notifier().send([message()]);

    expect(result).toEqual({
      ok: false,
      error: "cloudflare send reported neither delivery nor bounce for this recipient",
    });
  });

  it("refuses a push per-slot without sending it, and still sends the emails beside it", async () => {
    respondPerRecipient((to) => jsonResponse(deliveredBody([to])));
    const push: PushMessage = {
      channel: "push",
      to: "player-1",
      dedupeKey: "n1:fix-1:ply-1",
      title: "Fixture moved",
      body: "Kickoff is now 20:00.",
      url: "https://makethe.team/g/abc",
      tag: "fixture:def",
    };

    const results = await notifier().send([message({ to: "a@example.com" }), push]);

    expect(results[0]?.ok).toBe(true);
    expect(results[1]).toEqual({ ok: false, error: "cloudflare-notifier-received-non-email" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // The verdict split (M54). A 4xx or a `success: false` means Cloudflare
  // parsed the request and rejected it, so nothing was queued and the message
  // is safe for another leg to try. A 5xx or a network error may have been
  // accepted before the failure surfaced, so it must stay final.
  it("marks a 5xx as ambiguous, not a refusal, so it is never spilled", async () => {
    fetchSpy.mockResolvedValue(new Response("upstream boom", { status: 503 }));

    const [result] = await notifier().send([message()]);

    expect(result).toEqual({ ok: false, error: "cloudflare send failed: HTTP 503 upstream boom" });
  });

  it("marks a network error as ambiguous, not a refusal", async () => {
    fetchSpy.mockRejectedValue(new Error("connection reset"));

    const [result] = await notifier().send([message()]);

    expect(isRefusal(result)).toBe(false);
  });

  it("marks a malformed 200 body as ambiguous — it answered 2xx, so it may have queued", async () => {
    fetchSpy.mockResolvedValue(new Response("<html>", { status: 200 }));

    const [result] = await notifier().send([message()]);

    expect(isRefusal(result)).toBe(false);
  });

  // A bounce is just as certain as a refusal, and deliberately not treated as
  // one: it is a fact about the address, so retrying it on Resend would burn
  // a second provider's reputation to reach the same verdict.
  it("does not mark a permanent bounce as a refusal", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { delivered: [], permanent_bounces: ["player@example.com"], queued: [] },
        }),
      ),
    );

    const [result] = await notifier().send([message()]);

    expect(result).toEqual({ ok: false, error: "cloudflare send permanently bounced" });
  });

  it("marks a 401 as a refusal — the realistic bad-token case", async () => {
    fetchSpy.mockResolvedValue(new Response("unauthorized", { status: 401 }));

    const [result] = await notifier().send([message()]);

    expect(isRefusal(result)).toBe(true);
  });

  it("returns an empty array without calling fetch", async () => {
    expect(await notifier().send([])).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
