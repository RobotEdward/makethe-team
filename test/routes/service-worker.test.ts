import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OFFLINE_PATH, SERVICE_WORKER_PATH } from "../../src/auth/paths.js";

const url = (path: string) => `https://makethe.team${path}`;

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

  it("shows a notification and opens its url when tapped", async () => {
    const script = await (await SELF.fetch(url(SERVICE_WORKER_PATH))).text();

    expect(script).toContain('addEventListener("push"');
    expect(script).toContain('addEventListener("notificationclick"');
    // Focus an existing tab rather than opening a second one: a player who
    // already has the fixture page open does not want two.
    expect(script).toContain("clients.matchAll");
  });

  it("survives a push with no payload", async () => {
    // Some services send an empty push to keep a subscription alive, and
    // `event.data.json()` throws on it — an uncaught throw in a push handler
    // shows the browser's own "This site has been updated in the background"
    // notification, which looks like a bug to the player because it is one.
    const script = await (await SELF.fetch(url(SERVICE_WORKER_PATH))).text();

    expect(script).toContain("event.data ?");
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
