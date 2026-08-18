import { Hono } from "hono";
import {
  APPLE_TOUCH_ICON_PATH,
  ICON_192_PATH,
  ICON_512_PATH,
  MANIFEST_PATH,
  OFFLINE_PATH,
  SERVICE_WORKER_PATH,
} from "../auth/paths.js";
import type { AppEnv } from "../env.js";
import { APPLE_TOUCH_ICON_PNG, ICON_192_PNG, ICON_512_PNG } from "../views/icon-bytes.js";
import { THEME_COLOR } from "../views/layout.js";
import { renderOfflinePage } from "../views/offline.js";

/**
 * The static half of the installable app (M13): the manifest and the icons.
 *
 * Served from routes rather than an assets binding because this Worker has
 * never served a static file, and adding an assets binding changes request
 * routing for every path in the application in order to deliver three files
 * of a few kilobytes each (spec §5).
 *
 * Everything here is public and unauthenticated on purpose. The browser
 * fetches the manifest and the icons before a visitor has any session, and an
 * install that only works once you are signed in is an install nobody
 * performs.
 */
export const pwa = new Hono<AppEnv>();

/**
 * `start_url` is `/app`, not `/`. A player who has installed the app has
 * chosen it deliberately, and `/` is a holding page that tells them what the
 * product is. `/app` is the dashboard, which redirects to sign-in when there
 * is no session — the right destination in both states.
 */
const MANIFEST = {
  name: "Make The Team",
  short_name: "Make The Team",
  description: "Football, organised.",
  start_url: "/app",
  scope: "/",
  display: "standalone",
  background_color: "#fbfaf8",
  // Imported from src/views/layout.ts rather than pasted a second time: a
  // manifest theme_color that drifts from the page's own <meta name=
  // "theme-color"> shows as one colour in the task switcher and another in
  // the browser chrome, on the same app (see THEME_COLOR's own comment).
  theme_color: THEME_COLOR,
  icons: [
    { src: ICON_192_PATH, sizes: "192x192", type: "image/png", purpose: "maskable any" },
    { src: ICON_512_PATH, sizes: "512x512", type: "image/png", purpose: "maskable any" },
  ],
} as const;

pwa.get(MANIFEST_PATH, (c) =>
  c.body(JSON.stringify(MANIFEST), 200, {
    // Not application/json: some browsers refuse a manifest served as one.
    "content-type": "application/manifest+json; charset=utf-8",
    "cache-control": "public, max-age=3600",
  }),
);

const icon = (bytes: Uint8Array) =>
  new Response(bytes, {
    headers: {
      "content-type": "image/png",
      // Immutable in practice: these bytes change only when the mark in
      // src/views/icon.ts changes, which is a deliberate commit.
      "cache-control": "public, max-age=31536000, immutable",
    },
  });

pwa.get(ICON_192_PATH, () => icon(ICON_192_PNG));
pwa.get(ICON_512_PATH, () => icon(ICON_512_PNG));
pwa.get(APPLE_TOUCH_ICON_PATH, () => icon(APPLE_TOUCH_ICON_PNG));

pwa.get(OFFLINE_PATH, (c) => c.html(renderOfflinePage()));

/**
 * The cache name, derived from a hash of everything the worker caches.
 *
 * Derived rather than hand-maintained for exactly the reason
 * `src/security/csp.ts` computes its style hashes from the stylesheets
 * themselves: a version constant that a human has to remember to bump is one
 * that is eventually not bumped, and here the symptom is silent — an
 * installed player keeps an old offline page forever, and nothing on this
 * side can tell.
 *
 * Hashed over the offline HTML *and* the icon bytes, concatenated — both are
 * `cache.addAll`'d below, so both have to be covered or a change to just the
 * icon (`src/views/icon.ts`) renames nothing, the old cache survives
 * `activate`'s cleanup, and every installed player keeps the stale icon
 * forever with nothing locally able to show it.
 *
 * Cached for the life of the isolate, like `cspHeader()`, because hashing on
 * every request would be work done thousands of times to produce one answer.
 *
 * The name is deliberately *not* rehashed over `push`/`notificationclick`
 * (M14 Task 11): this hash names what `install` puts in `CACHE`, and those
 * two handlers put nothing in it — a browser diffs a service worker byte for
 * byte on every check-for-update, so a changed handler is still picked up on
 * its own schedule with no help from a renamed cache. Renaming the cache on
 * every unrelated script edit would only make `activate`'s cleanup run, and
 * pointlessly evict, on deploys that changed nothing this cache covers.
 */
let cachedScript: Promise<string> | undefined;

export function serviceWorkerScript(): Promise<string> {
  cachedScript ??= buildServiceWorkerScript();
  return cachedScript;
}

async function buildServiceWorkerScript(): Promise<string> {
  const offlineBytes = new TextEncoder().encode(renderOfflinePage());
  const cached = new Uint8Array(offlineBytes.length + ICON_192_PNG.length);
  cached.set(offlineBytes);
  cached.set(ICON_192_PNG, offlineBytes.length);
  const digest = await crypto.subtle.digest("SHA-256", cached);
  const version = btoa(String.fromCharCode(...new Uint8Array(digest))).slice(0, 16);

  // Written as ES5-flavoured JavaScript on purpose: this string is not
  // compiled, linted or type-checked by anything in this repo — it is text
  // handed to a browser — so it stays in the plainest dialect that every
  // service-worker-capable browser has supported since the API existed.
  return `const CACHE = "mtt-${version}";
const OFFLINE = "${OFFLINE_PATH}";

// Cache the offline page and its mark, and nothing else, ever. See the
// project spec §8: caching a fixture page would cache a squad list and a
// capacity count, and a stale "you're in" is worse than nothing at all.
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll([OFFLINE, "${ICON_192_PATH}"]);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// Drop every cache but the current one. Because CACHE is named after a hash
// of the offline page, editing that page renames the cache, and this handler
// is what actually removes the old copy.
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        return name === CACHE ? null : caches.delete(name);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// A navigation that fails outright gets the offline page. Every other
// same-origin GET checks the cache first and falls through to the network on
// a miss — the only two entries ever in it are OFFLINE and its icon (see
// "install" above), so this is not a general cache-first strategy, just the
// one way the offline page's own <img> (src/views/offline.ts) can be served
// from the cache instead of a network that, on the one occasion this page is
// ever shown, is down. Chrome requires a fetch handler to consider an app
// installable; it does not require it to cache anything, and this one caches
// nothing beyond what "install" already put there.
self.addEventListener("fetch", function (event) {
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(function () {
        // caches.match resolves undefined if OFFLINE was never cached or was
        // evicted under storage pressure. respondWith(undefined) throws and
        // hands the browser its own generic error page instead of this
        // one's — Response.error() keeps the failure a service-worker
        // failure rather than a silent fallback to the browser's chrome.
        return caches.match(OFFLINE).then(function (cached) {
          return cached || Response.error();
        });
      })
    );
    return;
  }
  if (event.request.method !== "GET") return;
  // Cross-origin requests (the Google Fonts stylesheet and its font files,
  // the only other GETs any page issues) are deliberately left untouched.
  // Nothing cross-origin is ever in CACHE, so intercepting them can only
  // reintroduce a request the browser was already handling correctly — and
  // in Chromium it does worse than that: routing a cross-origin no-cors
  // request back out through fetch(event.request) from inside the worker
  // intermittently fails with net::ERR_FAILED (found by the browser suite,
  // not by anything server-side, which is exactly what
  // test/browser/pwa.spec.ts exists to catch).
  if (event.request.url.indexOf(self.location.origin) !== 0) return;
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      return cached || fetch(event.request);
    })
  );
});

// A push service can send an empty push to keep a subscription alive, with
// no payload at all — \`event.data\` is then null and \`.json()\` is never
// reached. An uncaught throw here is not silent: it makes the browser show
// its own "This site has been updated in the background" notification in
// place of the one this handler would have shown, which reads as a bug to
// the player because it is one (M14 spec §9.2).
self.addEventListener("push", function (event) {
  var payload = event.data ? event.data.json() : null;
  if (!payload) return;
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "${ICON_192_PATH}",
      badge: "${ICON_192_PATH}",
      tag: payload.tag,
      data: { url: payload.url }
    })
  );
});

// Focuses a tab already open on the fixture rather than opening a second
// one: a player who already has it open does not want a duplicate. Falls
// back to opening a new window/tab only when no existing client matches.
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = event.notification.data && event.notification.data.url;
  if (!target) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
      for (var i = 0; i < windows.length; i++) {
        if (windows[i].url === target && "focus" in windows[i]) return windows[i].focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
`;
}

pwa.get(SERVICE_WORKER_PATH, async (c) =>
  c.body(await serviceWorkerScript(), 200, {
    "content-type": "text/javascript; charset=utf-8",
    // A stale service worker is permanent: the browser looks for an update by
    // fetching this URL, so a cached response means it checks a copy of the
    // old one forever.
    "cache-control": "no-cache",
    // Allows a worker served from anywhere to claim the root scope. Belt and
    // braces — it is served from the root already.
    "service-worker-allowed": "/",
    // This document is not a page and inherits none of the page CSP. It needs
    // to run itself and reach same-origin URLs and nothing else.
    "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'",
  }),
);
