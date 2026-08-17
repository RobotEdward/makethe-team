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
 * Cached for the life of the isolate, like `cspHeader()`, because hashing on
 * every request would be work done thousands of times to produce one answer.
 */
let cachedScript: Promise<string> | undefined;

export function serviceWorkerScript(): Promise<string> {
  cachedScript ??= buildServiceWorkerScript();
  return cachedScript;
}

async function buildServiceWorkerScript(): Promise<string> {
  const offline = renderOfflinePage();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(offline));
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

// Pass-through for everything. The only interception is a navigation that
// fails outright, which gets the offline page. Chrome requires a fetch
// handler to consider an app installable; it does not require it to cache
// anything, and this one does not.
self.addEventListener("fetch", function (event) {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(function () {
      return caches.match(OFFLINE);
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
