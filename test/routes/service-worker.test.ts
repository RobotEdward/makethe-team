import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { OFFLINE_PATH, SERVICE_WORKER_PATH } from "../../src/auth/paths.js";

const url = (path: string) => `https://makethe.team${path}`;

/**
 * A minimal `self` stand-in that captures listeners the served script
 * registers, so the tests below can actually *call* `push` and
 * `notificationclick` rather than only grep the served text for their
 * names.
 *
 * This exists because a substring assertion like `expect(script).toContain(
 * "event.data ?")` proves the guard is present in the source, not that it
 * behaves — it would keep passing even if the guard covered the wrong case
 * (M14 Task 11 review, finding 1: the original guard only caught a *missing*
 * `event.data`, not a *present but malformed* one, and the substring test
 * could not have told the difference either way). Actually invoking the
 * listener with a `event.data.json()` that throws is the only way to prove
 * the handler survives it.
 *
 * Deliberately narrow: only the handful of worker globals the `push` and
 * `notificationclick` listeners touch are stubbed. The other listeners
 * (`install`, `activate`, `fetch`) are registered here too, since they are
 * unconditional top-level `self.addEventListener` calls in the same script,
 * but nothing below invokes them — `test/browser/pwa.spec.ts` is what
 * exercises those against a real browser.
 */
interface FakeServiceWorkerGlobal {
  addEventListener: (type: string, handler: (event: unknown) => void) => void;
  location: { origin: string };
  registration: { showNotification: ReturnType<typeof vi.fn> };
  clients: { matchAll: ReturnType<typeof vi.fn>; openWindow: ReturnType<typeof vi.fn> };
  skipWaiting: () => Promise<void>;
}

function loadListeners(script: string): {
  listeners: Record<string, (event: unknown) => void>;
  self: FakeServiceWorkerGlobal;
} {
  const listeners: Record<string, (event: unknown) => void> = {};
  const fakeSelf: FakeServiceWorkerGlobal = {
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
    location: { origin: "https://makethe.team" },
    registration: { showNotification: vi.fn() },
    clients: { matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn().mockResolvedValue(undefined) },
    skipWaiting: () => Promise.resolve(),
  };

  // The served text is data, not a module — this is the browser's own
  // execution model for a service worker (a plain script evaluated with
  // `self` as the global), reproduced just enough to register its
  // listeners. `caches` and `fetch` are stubbed as no-ops: the top level of
  // the script never calls either, only the `install`/`fetch` listener
  // bodies do, and nothing here invokes those.
  // `new Function` is the only way to actually run text served as a script;
  // this project's eslint config carries no `no-new-func` rule to disable.
  const run = new Function("self", "caches", "fetch", script) as (
    self: FakeServiceWorkerGlobal,
    caches: unknown,
    fetch: unknown,
  ) => void;
  run(fakeSelf, {}, () => Promise.resolve());

  return { listeners, self: fakeSelf };
}

describe("the service worker", () => {
  it("is served as JavaScript from the root, so it can control every page", async () => {
    // A service worker's scope is capped by the directory it is served from.
    // Served from anywhere but the root, it would control a subtree and the
    // app would be uninstallable with no error anywhere.
    const response = await SELF.fetch(url(SERVICE_WORKER_PATH));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
  });

  it("is never cached, because it is the only thing that can replace itself", async () => {
    // A stale service worker is permanent: the browser checks for an update
    // by fetching this URL, and a cached response means it checks a copy of
    // the old one forever.
    const response = await SELF.fetch(url(SERVICE_WORKER_PATH));

    expect(response.headers.get("cache-control")).toContain("no-cache");
  });

  it("caches the offline page and nothing else", async () => {
    // The product is server-rendered and stays that way. Caching a fixture
    // page would cache a squad list and a capacity count, and showing a
    // player a stale "you're in" is worse than showing them nothing.
    const script = await (await SELF.fetch(url(SERVICE_WORKER_PATH))).text();

    expect(script).toContain(OFFLINE_PATH);
    for (const path of ["/r/", "/g/", "/app/account", "/j/"]) {
      expect(script, `${path} must never be cached`).not.toContain(path);
    }
  });

  it("names its cache after a hash of what it caches", async () => {
    // Derived, not hand-maintained — the same argument src/security/csp.ts
    // makes for its style hashes. A version constant somebody has to remember
    // to bump is one that eventually is not bumped, and the symptom is an
    // installed player pinned to an old offline page forever with nothing
    // locally to show for it.
    const script = await (await SELF.fetch(url(SERVICE_WORKER_PATH))).text();

    expect(script).toMatch(/const CACHE = "mtt-[A-Za-z0-9+/=]{16,}";/);
  });

  it("registers a push and a notificationclick listener", async () => {
    // A cheap smoke check only — it proves the two listeners are wired up,
    // not that they behave correctly. The behavioural tests below actually
    // call them.
    const script = await (await SELF.fetch(url(SERVICE_WORKER_PATH))).text();

    expect(script).toContain('addEventListener("push"');
    expect(script).toContain('addEventListener("notificationclick"');
  });

  it("shows a notification built from the push payload", async () => {
    const script = await (await SELF.fetch(url(SERVICE_WORKER_PATH))).text();
    const { listeners, self } = loadListeners(script);

    const event = {
      data: { json: () => ({ title: "Saturday 5-a-side", body: "You're in", tag: "fixture-1", url: "/g/1" }) },
      waitUntil: (promise: Promise<unknown>) => promise,
    };
    listeners.push!(event);
    // `showNotification` is called from inside `event.waitUntil`, which this
    // fake resolves synchronously, so it has already run by the time
    // `listeners.push!` returns.
    await Promise.resolve();

    expect(self.registration.showNotification).toHaveBeenCalledWith(
      "Saturday 5-a-side",
      expect.objectContaining({ body: "You're in", tag: "fixture-1", data: { url: "/g/1" } }),
    );
  });

  it("survives a push with no payload", async () => {
    // Some services send an empty push to keep a subscription alive, and
    // `event.data` is then `null` — `.json()` is never reached.
    const script = await (await SELF.fetch(url(SERVICE_WORKER_PATH))).text();
    const { listeners, self } = loadListeners(script);

    const event = { data: null, waitUntil: vi.fn() };

    expect(() => listeners.push!(event)).not.toThrow();
    expect(self.registration.showNotification).not.toHaveBeenCalled();
    expect(event.waitUntil).not.toHaveBeenCalled();
  });

  it("survives a push whose payload is not valid JSON", async () => {
    // A payload can be *present* but malformed — a plain-text body, a
    // truncated one — and `event.data.json()` throws on that exactly as
    // readily as it does on a missing payload (M14 Task 11 review, finding
    // 1). Both must leave the listener without an uncaught throw: that is
    // what stops the browser showing its own generic "This site has been
    // updated in the background" notification in place of this app's.
    const script = await (await SELF.fetch(url(SERVICE_WORKER_PATH))).text();
    const { listeners, self } = loadListeners(script);

    const event = {
      data: {
        json: () => {
          throw new SyntaxError("Unexpected token in JSON");
        },
      },
      waitUntil: vi.fn(),
    };

    expect(() => listeners.push!(event)).not.toThrow();
    expect(self.registration.showNotification).not.toHaveBeenCalled();
    expect(event.waitUntil).not.toHaveBeenCalled();
  });

  it("focuses an existing tab on the notification's url rather than opening a second one", async () => {
    const script = await (await SELF.fetch(url(SERVICE_WORKER_PATH))).text();
    const { listeners, self } = loadListeners(script);

    const matchingClient = { url: "https://makethe.team/g/1", focus: vi.fn() };
    self.clients.matchAll.mockResolvedValue([{ url: "https://makethe.team/g/2", focus: vi.fn() }, matchingClient]);

    const event = {
      notification: { close: vi.fn(), data: { url: "https://makethe.team/g/1" } },
      waitUntil: (promise: Promise<unknown>) => promise,
    };
    await listeners.notificationclick!(event);

    expect(matchingClient.focus).toHaveBeenCalled();
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens a new window when no existing tab matches the notification's url", async () => {
    const script = await (await SELF.fetch(url(SERVICE_WORKER_PATH))).text();
    const { listeners, self } = loadListeners(script);

    self.clients.matchAll.mockResolvedValue([{ url: "https://makethe.team/g/2", focus: vi.fn() }]);

    const event = {
      notification: { close: vi.fn(), data: { url: "https://makethe.team/g/1" } },
      waitUntil: (promise: Promise<unknown>) => promise,
    };
    await listeners.notificationclick!(event);

    expect(self.clients.openWindow).toHaveBeenCalledWith("https://makethe.team/g/1");
  });
});

describe("the offline page", () => {
  it("renders as an ordinary page", async () => {
    const response = await SELF.fetch(url(OFFLINE_PATH));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("says what happened and offers nothing it cannot do", async () => {
    // No retry button: a button that needs the network to work is a button
    // that does nothing at the one moment this page is on screen. The browser
    // already has a reload control and it is the honest one.
    const body = await (await SELF.fetch(url(OFFLINE_PATH))).text();

    expect(body).toContain("no connection");
    expect(body).not.toContain("<form");
  });
});
