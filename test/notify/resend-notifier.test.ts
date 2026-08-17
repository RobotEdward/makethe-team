/**
 * Testing note: the brief for this task illustrates mocking with
 * `fetchMock` imported from `"cloudflare:test"`. That export does not exist
 * in the installed toolchain (`@cloudflare/vitest-pool-workers@0.20.3`,
 * the version this repo's `^0.20.3` resolves to, matching the
 * `cloudflareTest` v4-plugin config already in `vitest.config.ts`) — it was
 * checked directly against the package's shipped `.d.ts` and bundled
 * worker code, neither of which declares it. Cloudflare's own current
 * example fixture for this exact plugin/config shape
 * (`workers-sdk/fixtures/vitest-pool-workers-examples/request-mocking`)
 * mocks outbound `fetch` imperatively with `vi.spyOn(globalThis, "fetch")`
 * instead, so that is what is used here.
 *
 * The safety property the brief cares about — "a missed interceptor
 * surfaces as a test failure rather than a real API call" — is reproduced
 * explicitly: `beforeEach` installs a spy whose default implementation
 * throws for any call no test has configured, so an un-mocked `fetch` can
 * never reach the real network from this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResendNotifier } from "../../src/notify/resend-notifier.js";
import type { EmailMessage, Message, PushMessage } from "../../src/notify/notifier.js";

const API_KEY = "test-fake-resend-key-not-real";
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

function messages(count: number, prefix = "ply"): Message[] {
  return Array.from({ length: count }, (_, i) =>
    message({ to: `${prefix}-${i}@example.com`, dedupeKey: `n1:fix-1:${prefix}-${i}` }),
  );
}

function pushMessage(overrides: Partial<PushMessage> = {}): PushMessage {
  return {
    channel: "push",
    to: "player-1",
    dedupeKey: "push:n1:fix-1:ply-1",
    title: "You're in for Thursday",
    body: "19:00 · Goals Vauxhall",
    url: "https://makethe.team/r/token",
    tag: "fixture-1",
    ...overrides,
  };
}

const NON_EMAIL_REASON = "resend-notifier-received-non-email";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Reads the request a given call to `fetch` was made with. */
function requestFromCall(callIndex: number): Request {
  const call = fetchSpy.mock.calls[callIndex];
  if (!call) throw new Error(`expected a fetch call at index ${callIndex}`);
  const [input, init] = call;
  return new Request(input as RequestInfo, init as RequestInit);
}

describe("ResendNotifier: success path", () => {
  it("maps provider ids back onto results in input order", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, { data: [{ id: "id-a" }, { id: "id-b" }, { id: "id-c" }] }),
      ),
    );

    const notifier = new ResendNotifier(API_KEY, FROM);
    const input = [
      message({ to: "a@example.com", dedupeKey: "n1:fix-1:a" }),
      message({ to: "b@example.com", dedupeKey: "n1:fix-1:b" }),
      message({ to: "c@example.com", dedupeKey: "n1:fix-1:c" }),
    ];

    const results = await notifier.send(input);

    expect(results).toEqual([
      { ok: true, providerMessageId: "id-a" },
      { ok: true, providerMessageId: "id-b" },
      { ok: true, providerMessageId: "id-c" },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("posts to the batch endpoint with both html and text, and from/to/subject as given", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { data: [{ id: "id-1" }] })),
    );

    const notifier = new ResendNotifier(API_KEY, FROM);
    await notifier.send([
      message({ to: "a@example.com", subject: "Reminder", html: "<p>hi</p>", text: "hi" }),
    ]);

    const request = requestFromCall(0);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.resend.com/emails/batch");
    expect(request.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(request.headers.get("content-type")).toBe("application/json");

    const body = (await request.json()) as unknown;
    expect(body).toEqual([
      { from: FROM, to: "a@example.com", subject: "Reminder", html: "<p>hi</p>", text: "hi" },
    ]);
  });
});

describe("ResendNotifier: empty input", () => {
  it("returns an empty array without making any request", async () => {
    const notifier = new ResendNotifier(API_KEY, FROM);
    const results = await notifier.send([]);
    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ResendNotifier: push messages (M14)", () => {
  // ResendNotifier cannot deliver a push. In production it never sees one
  // (createNotifier only routes email here, until Task 8), but the class is
  // exported and constructible on its own, so these pin the refusal itself:
  // a distinct, greppable reason per push slot, index-correct even when
  // pushes and emails share a batch, and — the specific regression this
  // finding was about — no HTTP request at all for an all-push batch.
  it("refuses every message in an all-push batch without calling fetch", async () => {
    const notifier = new ResendNotifier(API_KEY, FROM);
    const input = [pushMessage({ dedupeKey: "push:1" }), pushMessage({ dedupeKey: "push:2" })];

    const results = await notifier.send(input);

    expect(results).toEqual([
      { ok: false, error: NON_EMAIL_REASON },
      { ok: false, error: NON_EMAIL_REASON },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a single push without calling fetch", async () => {
    const notifier = new ResendNotifier(API_KEY, FROM);

    const results = await notifier.send([pushMessage()]);

    expect(results).toEqual([{ ok: false, error: NON_EMAIL_REASON }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("attributes each result to its own message in an interleaved batch", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { data: [{ id: "id-a" }, { id: "id-c" }] })),
    );

    const notifier = new ResendNotifier(API_KEY, FROM);
    const input: Message[] = [
      message({ to: "a@example.com", dedupeKey: "n1:fix-1:a" }),
      pushMessage({ to: "push-player", dedupeKey: "push:n1:fix-1:b" }),
      message({ to: "c@example.com", dedupeKey: "n1:fix-1:c" }),
    ];

    const results = await notifier.send(input);

    // Each result lands on its own message — not merely three results of
    // the right shape in some order. The push slot is refused; the two
    // email slots carry the ids Resend returned for *them* specifically
    // (only two emails ever reached Resend), preserving `input`'s order.
    expect(results).toEqual([
      { ok: true, providerMessageId: "id-a" },
      { ok: false, error: NON_EMAIL_REASON },
      { ok: true, providerMessageId: "id-c" },
    ]);

    // Only the two emails were ever sent to Resend — the push never reached
    // the request body.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = (await requestFromCall(0).json()) as unknown[];
    expect(body).toHaveLength(2);
    expect(body).toEqual([
      expect.objectContaining({ to: "a@example.com" }),
      expect.objectContaining({ to: "c@example.com" }),
    ]);
  });
});

describe("ResendNotifier: non-2xx responses", () => {
  it("fails every message in the batch on a 4xx without throwing", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse(422, { message: "invalid `to` field" })),
    );

    const notifier = new ResendNotifier(API_KEY, FROM);
    const results = await notifier.send(messages(3));

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("422");
    }
  });

  it("fails every message in the batch on a 5xx without throwing", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse(503, { message: "upstream unavailable" })),
    );

    const notifier = new ResendNotifier(API_KEY, FROM);
    const results = await notifier.send(messages(2));

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("503");
    }
  });
});

describe("ResendNotifier: network error", () => {
  it("fails every message in the batch without throwing", async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new Error("getaddrinfo ENOTFOUND api.resend.com")));

    const notifier = new ResendNotifier(API_KEY, FROM);
    const results = await notifier.send(messages(4));

    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("ENOTFOUND");
    }
  });
});

describe("ResendNotifier: Idempotency-Key header", () => {
  it("is present, within 256 characters, and stable for the same batch contents", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { data: [{ id: "id-1" }] })),
    );

    const notifier = new ResendNotifier(API_KEY, FROM);
    await notifier.send([message({ dedupeKey: "n1:fix-1:ply-1" })]);
    const key1 = requestFromCall(0).headers.get("idempotency-key");

    await notifier.send([message({ dedupeKey: "n1:fix-1:ply-1" })]);
    const key2 = requestFromCall(1).headers.get("idempotency-key");

    expect(key1).toBeTruthy();
    expect(key1!.length).toBeLessThanOrEqual(256);
    expect(key2).toBe(key1);
  });

  it("differs for batches with different dedupe keys", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { data: [{ id: "id-1" }] })),
    );

    const notifier = new ResendNotifier(API_KEY, FROM);
    await notifier.send([message({ dedupeKey: "n1:fix-1:ply-1" })]);
    const key1 = requestFromCall(0).headers.get("idempotency-key");

    await notifier.send([message({ dedupeKey: "n1:fix-1:ply-2" })]);
    const key2 = requestFromCall(1).headers.get("idempotency-key");

    expect(key2).not.toBe(key1);
  });
});

describe("ResendNotifier: chunking at 100", () => {
  it("sends a 250-message batch as exactly three upstream calls", async () => {
    let call = 0;
    fetchSpy.mockImplementation(() => {
      const size = call === 2 ? 50 : 100;
      const label = call;
      call += 1;
      return Promise.resolve(
        jsonResponse(200, {
          data: Array.from({ length: size }, (_, i) => ({ id: `batch-${label}-${i}` })),
        }),
      );
    });

    const notifier = new ResendNotifier(API_KEY, FROM);
    const results = await notifier.send(messages(250));

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(250);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("attributes results to the right inputs when one batch fails and another succeeds", async () => {
    let call = 0;
    fetchSpy.mockImplementation(() => {
      const thisCall = call;
      call += 1;
      if (thisCall === 0) {
        return Promise.resolve(
          jsonResponse(200, { data: Array.from({ length: 100 }, (_, i) => ({ id: `ok-${i}` })) }),
        );
      }
      return Promise.resolve(jsonResponse(500, { message: "server error" }));
    });

    const notifier = new ResendNotifier(API_KEY, FROM);
    const results = await notifier.send(messages(200));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(200);
    const firstHundred = results.slice(0, 100);
    const secondHundred = results.slice(100);

    firstHundred.forEach((r, i) => {
      expect(r).toEqual({ ok: true, providerMessageId: `ok-${i}` });
    });
    expect(secondHundred.every((r) => !r.ok)).toBe(true);
  });
});

describe("ResendNotifier: malformed success bodies", () => {
  it("fails every message when the body has no data array", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(200, { unexpected: "shape" })));

    const notifier = new ResendNotifier(API_KEY, FROM);
    const results = await notifier.send(messages(2));

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("data");
    }
  });

  it("fails only the unmatched inputs when data is shorter than the request", async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(200, { data: [{ id: "id-1" }] })));

    const notifier = new ResendNotifier(API_KEY, FROM);
    const results = await notifier.send(messages(3));

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true, providerMessageId: "id-1" });
    expect(results[1]?.ok).toBe(false);
    expect(results[2]?.ok).toBe(false);
  });

  it("fails only the null entry when data contains a null", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { data: [{ id: "id-1" }, null, { id: "id-3" }] })),
    );

    const notifier = new ResendNotifier(API_KEY, FROM);
    const results = await notifier.send(messages(3));

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true, providerMessageId: "id-1" });
    expect(results[1]?.ok).toBe(false);
    expect(results[2]).toEqual({ ok: true, providerMessageId: "id-3" });
  });

  it("fails the whole batch when the body is not valid JSON", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response("not json at all", { status: 200, headers: { "content-type": "text/plain" } }),
      ),
    );

    const notifier = new ResendNotifier(API_KEY, FROM);
    const results = await notifier.send(messages(2));

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.ok).toBe(false);
    }
  });
});
