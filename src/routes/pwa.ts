import { Hono } from "hono";
import {
  APPLE_TOUCH_ICON_PATH,
  ICON_192_PATH,
  ICON_512_PATH,
  MANIFEST_PATH,
} from "../auth/paths.js";
import type { AppEnv } from "../env.js";
import { APPLE_TOUCH_ICON_PNG, ICON_192_PNG, ICON_512_PNG } from "../views/icon-bytes.js";

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
  theme_color: "#1f6f4a",
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
