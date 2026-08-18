import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client.js";
import { pushSubscriptions } from "../../src/db/schema.js";
import type { EmailMessage, PushMessage } from "../../src/notify/notifier.js";
import { PushNotifier } from "../../src/notify/push-notifier.js";
import { NO_RECIPIENT_REASON } from "../../src/notify/quota.js";
import { base64UrlEncode, importVapidKeys, type VapidKeys } from "../../src/notify/web-push.js";
import { insertPlayer, insertSubscription, resetDatabase } from "../support/factories.js";
import { NOW } from "../support/clock.js";

const db = getDb(env.DB);

/**
 * A fresh, self-consistent VAPID pair for these tests. Generated per suite
 * rather than pinned to a fixture — nothing here asserts on the header's
 * exact bytes (that is `web-push-vapid.test.ts`'s job), only on what
 * `PushNotifier` does with the subscriptions and the responses it gets
 * back, so any valid pair will do.
 */
async function testVapidKeys(): Promise<VapidKeys> {
  const generated = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in generated)) {
    throw new Error("expected an ECDSA key pair from generateKey");
  }
  const rawPublic = await crypto.subtle.exportKey("raw", generated.publicKey);
  if (!(rawPublic instanceof ArrayBuffer)) {
    throw new Error('exportKey("raw") did not return raw bytes');
  }
  const jwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
  if (jwk instanceof ArrayBuffer || typeof jwk.d !== "string") {
    throw new Error('exportKey("jwk") did not return a private key with "d"');
  }
  return importVapidKeys(base64UrlEncode(new Uint8Array(rawPublic)), jwk.d, "mailto:ops@makethe.team");
}

const keys = await testVapidKeys();

/** A plausible push message addressed to `to` (a player id). */
function pushMessageFor(to: string, overrides: Partial<PushMessage> = {}): PushMessage {
  return {
    channel: "push",
    to,
    dedupeKey: `push:${crypto.randomUUID()}`,
    title: "Fixture moved",
    body: "Kickoff is now 20:00.",
    url: "https://makethe.team/g/abc/f/def",
    tag: "fixture:def",
    ...overrides,
  };
}

function endpointOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * A `fetch` stand-in that returns `status` for every request, optionally
 * recording the endpoint of each call into `fetched` — so a test can assert
 * on which devices were actually reached without a network (the repo's
 * `vitest.config.ts` blocks outbound network at the miniflare level).
 */
function stubFetch(status: number, fetched?: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    fetched?.push(endpointOf(input));
    return new Response(null, { status });
  }) as typeof fetch;
}

/**
 * A `fetch` stand-in whose response status depends on which endpoint was
 * called: `map` keys are matched as substrings of the endpoint URL (e.g.
 * `{ dead: 410, live: 201 }` matches `https://push.example/dead` and
 * `https://push.example/live`). Endpoints matching no key get 200.
 */
function statusByEndpoint(map: Record<string, number>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = endpointOf(input);
    const key = Object.keys(map).find((candidate) => url.includes(candidate));
    return new Response(null, { status: key === undefined ? 200 : map[key] });
  }) as typeof fetch;
}

/**
 * A `fetch` stand-in that behaves like the *real* one about `this`.
 *
 * Workers' global `fetch` is a builtin that must be called with `this` as
 * `globalThis` (or with no receiver at all); calling it as a method of some
 * other object throws `TypeError: Illegal invocation`. Every other stub in
 * this file is an arrow function, whose `this` is lexical and therefore
 * indifferent to how it is invoked — which is exactly why this defect
 * reached production with a green suite. This one is an ordinary function
 * in a strict-mode module, so `this` is `undefined` when it is called as a
 * free function and the receiver when it is called as a method, the same
 * distinction the builtin makes.
 */
function receiverCheckingFetch(status: number): typeof fetch {
  return function (this: unknown) {
    if (this !== undefined) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference");
    }
    return Promise.resolve(new Response(null, { status }));
  } as typeof fetch;
}

describe("PushNotifier", () => {
  beforeEach(resetDatabase);

  it("reaches every device a player has registered", async () => {
    // The reason `to` is a player id and not an endpoint: one message, one
    // log row, every device.
    const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
    await insertSubscription(db, playerId, "https://push.example/phone");
    await insertSubscription(db, playerId, "https://push.example/tablet");
    const fetched: string[] = [];
    const notifier = new PushNotifier(db, keys, stubFetch(201, fetched), NOW);

    const [result] = await notifier.send([pushMessageFor(playerId)]);

    expect(result).toEqual({ ok: true, providerMessageId: null });
    expect(fetched.sort()).toEqual(["https://push.example/phone", "https://push.example/tablet"]);
  });

  it("succeeds if any device accepts, and fails only if none do", async () => {
    // A player whose old tablet was wiped is not a failed notification.
    const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
    await insertSubscription(db, playerId, "https://push.example/dead");
    await insertSubscription(db, playerId, "https://push.example/live");
    const notifier = new PushNotifier(db, keys, statusByEndpoint({ dead: 410, live: 201 }), NOW);

    const [result] = await notifier.send([pushMessageFor(playerId)]);

    expect(result?.ok).toBe(true);
  });

  it("deletes a subscription the push service says is gone (410)", async () => {
    // The only self-healing in the system. Without it the table accumulates
    // dead endpoints forever and every later send burns subrequests on
    // devices that no longer exist.
    const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
    await insertSubscription(db, playerId, "https://push.example/gone");
    const notifier = new PushNotifier(db, keys, stubFetch(410), NOW);

    await notifier.send([pushMessageFor(playerId)]);

    const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.playerId, playerId));
    expect(rows).toHaveLength(0);
  });

  it("deletes a subscription the push service says is gone (404)", async () => {
    // 404 and 410 are the two "gone for good" statuses (RFC 8030 §7.2). Only
    // 410 was exercised above; the `isGone` check is a plain OR of both, so
    // this proves the other side of it independently rather than trusting
    // that 410 passing implies 404 does too.
    const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
    await insertSubscription(db, playerId, "https://push.example/gone");
    const notifier = new PushNotifier(db, keys, stubFetch(404), NOW);

    await notifier.send([pushMessageFor(playerId)]);

    const rows = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.playerId, playerId));
    expect(rows).toHaveLength(0);
  });

  it("keeps a subscription that failed for a reason that might pass (429), and stamps last_failure_at", async () => {
    // 429 and 5xx are the push service having a bad day. Deleting on those
    // would unsubscribe a working phone because of someone else's outage.
    // The stamp is the only record an operator has of when this still-
    // registered device last actually worked (spec §10.4).
    const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
    await insertSubscription(db, playerId, "https://push.example/busy");
    const notifier = new PushNotifier(db, keys, stubFetch(429), NOW);

    const [result] = await notifier.send([pushMessageFor(playerId)]);

    expect(result?.ok).toBe(false);
    const rows = await db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastFailureAt).toEqual(NOW);
    expect(rows[0]?.lastSuccessAt).toBeNull();
  });

  it("keeps a subscription that failed with a 5xx, and does not delete it", async () => {
    // Independent of the 429 case: a server error is a different branch of
    // the same "might pass later" bucket, and the brief calls out both
    // directions explicitly.
    const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
    await insertSubscription(db, playerId, "https://push.example/flaky");
    const notifier = new PushNotifier(db, keys, stubFetch(503), NOW);

    const [result] = await notifier.send([pushMessageFor(playerId)]);

    expect(result?.ok).toBe(false);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(1);
  });

  it("calls the injected fetch as a free function, never as a method of itself", async () => {
    // Production passes the global `fetch` in unbound (`factory.ts`). Calling
    // it as `this.fetchImpl(...)` gives it the PushNotifier as its receiver,
    // and a Workers builtin refuses that with "Illegal invocation" before a
    // byte leaves the isolate — so every push of every type failed, silently,
    // from the day web push shipped until this test was written.
    const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
    await insertSubscription(db, playerId, "https://push.example/phone");
    const notifier = new PushNotifier(db, keys, receiverCheckingFetch(201), NOW);

    const [result] = await notifier.send([pushMessageFor(playerId)]);

    expect(result?.ok).toBe(true);
  });

  it("stamps last_success_at on a device that accepted the push", async () => {
    const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
    await insertSubscription(db, playerId, "https://push.example/phone");
    const notifier = new PushNotifier(db, keys, stubFetch(201), NOW);

    await notifier.send([pushMessageFor(playerId)]);

    const rows = await db.select().from(pushSubscriptions);
    expect(rows[0]?.lastSuccessAt).toEqual(NOW);
    expect(rows[0]?.lastFailureAt).toBeNull();
  });

  it("still delivers to a device with valid keys when a sibling device's keys are malformed", async () => {
    // encryptPayload (web-push.ts) throws on a wrong-length p256dh/auth —
    // exactly what a corrupted row would produce. That throw must be
    // recorded as this one device's failure, not abort the whole message
    // or the sweep, since PushNotifier.sendToDevice wraps it in try/catch.
    const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
    await insertSubscription(db, playerId, "https://push.example/corrupt", {
      p256dh: base64UrlEncode(new Uint8Array(64)), // one byte short of the required 65
    });
    await insertSubscription(db, playerId, "https://push.example/fine");
    const notifier = new PushNotifier(db, keys, stubFetch(201), NOW);

    const [result] = await notifier.send([pushMessageFor(playerId)]);

    expect(result).toEqual({ ok: true, providerMessageId: null });
  });

  it("reports no-recipient for a player with no devices", async () => {
    // Distinct from success, for the same reason QuotaNotifier's guest skip
    // is: a caller mapping results onto notification_log rows must never
    // record a delivery that never happened.
    const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
    const notifier = new PushNotifier(db, keys, stubFetch(201), NOW);

    const [result] = await notifier.send([pushMessageFor(playerId)]);

    expect(result).toEqual({ ok: false, error: NO_RECIPIENT_REASON });
  });

  it("returns exactly one result per message, in order", async () => {
    // The contract every Notifier owes the sweep, which maps results onto
    // rows by index.
    const [a, b] = await Promise.all([
      insertPlayer(db, { name: "A", email: "a@x.com" }),
      insertPlayer(db, { name: "B", email: "b@x.com" }),
    ]);
    if (a === undefined || b === undefined) throw new Error("expected two player ids");
    await insertSubscription(db, b, "https://push.example/b");
    const notifier = new PushNotifier(db, keys, stubFetch(201), NOW);

    const results = await notifier.send([pushMessageFor(a), pushMessageFor(b)]);

    expect(results).toHaveLength(2);
    expect(results[0]?.ok).toBe(false); // a has no devices
    expect(results[1]?.ok).toBe(true);
  });

  it("returns an empty array for no messages", async () => {
    const notifier = new PushNotifier(db, keys, stubFetch(201), NOW);

    expect(await notifier.send([])).toEqual([]);
  });

  it("refuses a non-push message rather than throwing or silently succeeding", async () => {
    // PushNotifier is exported and constructible on its own — nothing
    // guarantees a caller only ever hands it push messages. A silent
    // success for something never sent is exactly the failure
    // notification_log exists to prevent.
    const email: EmailMessage = {
      channel: "email",
      to: "sam@example.com",
      dedupeKey: `email:${crypto.randomUUID()}`,
      subject: "You're in",
      html: "<p>You're in</p>",
      text: "You're in",
    };
    const notifier = new PushNotifier(db, keys, stubFetch(201), NOW);

    const [result] = await notifier.send([email]);

    expect(result?.ok).toBe(false);
  });

  it("accepts a Promise<VapidKeys> and resolves it lazily, so a request that never sends a push never awaits it", async () => {
    // `createNotifier` (factory.ts) hands a still-pending Promise<VapidKeys>
    // to PushNotifier so the async key import never forces createNotifier
    // itself to become async — see PushNotifier's doc comment. This proves
    // the happy path of that seam: a promise that resolves after send() is
    // called still produces a normal successful result.
    const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
    await insertSubscription(db, playerId, "https://push.example/phone");
    const notifier = new PushNotifier(db, Promise.resolve(keys), stubFetch(201), NOW);

    const [result] = await notifier.send([pushMessageFor(playerId)]);

    expect(result).toEqual({ ok: true, providerMessageId: null });
  });

  it("turns a rejected keys promise into a failed result for that message, never a thrown error", async () => {
    // The Critical this test guards against: a mismatched or malformed
    // VAPID pair rejects the keys promise `vapidKeys` (factory.ts) hands
    // in. If PushNotifier let that rejection propagate out of `send`
    // instead of catching it per message, RouterNotifier's `Promise.all`
    // over [email.send(...), push.send(...)] would reject as a whole,
    // discarding the email leg's already-computed results even though
    // those emails may have genuinely been sent — attributing a push
    // misconfiguration's damage to an unrelated channel. `send` here must
    // resolve, not reject, and every push message in the batch must come
    // back `ok: false` naming the cause.
    const playerId = await insertPlayer(db, { name: "Sam", email: "sam@example.com" });
    await insertSubscription(db, playerId, "https://push.example/phone");
    const brokenKeys: Promise<VapidKeys> = Promise.reject(new Error("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY do not match"));
    brokenKeys.catch(() => {}); // keep this test's own setup from tripping an unhandled-rejection failure
    const notifier = new PushNotifier(db, brokenKeys, stubFetch(201), NOW);

    const results = await notifier.send([pushMessageFor(playerId), pushMessageFor(playerId)]);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result).toEqual({ ok: false, error: expect.stringContaining("do not match") });
    }
  });
});
