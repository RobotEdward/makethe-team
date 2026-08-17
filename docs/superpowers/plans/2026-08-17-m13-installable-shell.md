# M13 — Installable Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Make The Team installable on Android and iOS home screens — a web app manifest, a home-screen icon, a service worker with an offline fallback, and the Content-Security-Policy directives all of that needs.

**Architecture:** Everything is served from Hono routes, because this Worker has no static assets and gains none here. The icon is authored once as an SVG in `src/views/icon.ts`, rasterised by a committed build script into a TypeScript module of base64 PNG bytes, and served as bytes. The service worker caches exactly one page (`/offline`) and passes everything else through. Its cache name is derived from a hash of what it caches, so it can never go stale by omission — the same technique `src/security/csp.ts` already uses for its style hashes.

**Tech Stack:** Cloudflare Workers, Hono, TypeScript, Vitest (`@cloudflare/vitest-pool-workers`), Playwright, `rsvg-convert` (build-time only, not a dependency).

**Spec:** `docs/superpowers/specs/2026-08-17-pwa-and-push-design.md` — read §§5–8 and §11 before starting. This plan implements the M13 half only.

## Global Constraints

- **No new runtime dependencies.** The project has six. `rsvg-convert` is invoked by a script whose output is committed; CI never runs it.
- **No `any`.** The one carve-out is a documented type-guard boundary, as in `QuotaNotifier`'s handling of `Message.to`.
- **Every inline `<style>` must be a member of `PAGE_STYLE_BLOCKS`** in `src/views/styles.ts`, and every inline `<script>` a member of `PAGE_SCRIPT_BLOCKS` in `src/views/scripts.ts`. `layout()`'s parameters are typed against those unions, so an unenumerated block fails to compile — and `src/security/csp.ts` hashes exactly those enumerations. Never paste a hash.
- **A page must be completely usable with scripting off.** Scripts enhance; they never provide. See the module comment in `src/views/scripts.ts`.
- **A CSP hash lets a script run and nothing more.** Every other capability is a separate directive, and any directive not named falls back to `default-src 'none'`. Omitting `connect-src` is what broke both passkey buttons in production while every server-side test passed.
- **Colours come from the existing palette only:** accent `#1f6f4a`, cream `#fbfaf8`. Both are already in `STYLES` in `src/views/layout.ts`.
- **New pages go in `test/browser/catalogue.ts`.** One list feeds the console/CSP gate, the visual capture and the guide; a page that is not in it is neither checked nor documented.
- Run `npm run typecheck && npm run lint && npm test` before every commit. `npm run test:browser` where the task says so.

---

### Task 1: The icon, authored and rasterised

**Files:**
- Create: `src/views/icon.ts`
- Create: `scripts/build-icons.mjs`
- Create: `src/views/icon-bytes.ts` (generated, committed)
- Test: `test/views/icon.test.ts`

**Interfaces:**
- Produces: `ICON_SVG: string` (`src/views/icon.ts`); `ICON_192_PNG`, `ICON_512_PNG`, `APPLE_TOUCH_ICON_PNG` — each `Uint8Array` (`src/views/icon-bytes.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// test/views/icon.test.ts
import { describe, expect, it } from "vitest";
import { ICON_SVG } from "../../src/views/icon.js";
import { APPLE_TOUCH_ICON_PNG, ICON_192_PNG, ICON_512_PNG } from "../../src/views/icon-bytes.js";

/**
 * The mark (spec §5). These assertions are about the two properties that make
 * it work as an *icon*, not about taste: it is full-bleed, so an Android
 * launcher can crop it to any shape; and every dot sits inside the maskable
 * safe zone, so that crop never takes a bite out of the tick.
 */
describe("the app icon", () => {
  it("is full bleed, so a maskable crop always lands on the accent colour", () => {
    expect(ICON_SVG).toContain('viewBox="0 0 512 512"');
    expect(ICON_SVG).toContain('<rect width="512" height="512" fill="#1f6f4a"/>');
  });

  it("keeps every dot inside the maskable safe zone", () => {
    // Android crops maskable icons to whatever shape it likes; only the
    // centre circle of radius 40% (204.8 of 512) is guaranteed to survive.
    // A dot whose *edge* crosses that line gets clipped on some launchers
    // and not others, which is the worst way to find out.
    const dots = [...ICON_SVG.matchAll(/<circle cx="(\d+)" cy="(\d+)" r="(\d+)"/g)].map((m) => ({
      cx: Number(m[1]),
      cy: Number(m[2]),
      r: Number(m[3]),
    }));

    expect(dots).toHaveLength(5);
    for (const dot of dots) {
      const distance = Math.hypot(dot.cx - 256, dot.cy - 256);
      expect(distance + dot.r, `dot at ${dot.cx},${dot.cy} escapes the safe zone`).toBeLessThan(204.8);
    }
  });

  it("has one hollow dot — four in, one spot left", () => {
    // The whole idea of the mark. A later "tidy-up" that fills this dot in
    // turns a squad with a place going spare into five identical dots.
    expect(ICON_SVG).toContain('fill="none" stroke="#fbfaf8"');
  });

  it("ships the three raster sizes the platforms actually read", () => {
    // Android reads the manifest's 192 and 512; iOS ignores the manifest
    // entirely and reads only <link rel="apple-touch-icon">.
    for (const [name, bytes] of [
      ["icon-192", ICON_192_PNG],
      ["icon-512", ICON_512_PNG],
      ["apple-touch-icon", APPLE_TOUCH_ICON_PNG],
    ] as const) {
      expect(bytes.length, `${name} is empty`).toBeGreaterThan(100);
      // PNG magic number. Proves the build script produced an image and not,
      // say, an error message that got base64'd by accident.
      expect([...bytes.slice(0, 4)], `${name} is not a PNG`).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/views/icon.test.ts`
Expected: FAIL — `Cannot find module '../../src/views/icon.js'`

- [ ] **Step 3: Write the SVG master**

```ts
// src/views/icon.ts
/**
 * The home-screen icon (spec §5), authored once here and rasterised by
 * `scripts/build-icons.mjs` into `src/views/icon-bytes.ts`.
 *
 * Five dots along a checkmark: four filled, the fifth hollow — a five-a-side
 * squad with one spot left, which is the number the whole product exists to
 * move. Large it reads as a group of people; small the gaps close and it
 * resolves into a plain tick, which is the size it spends its life at in a
 * notification tray.
 *
 * # The geometry is not arbitrary — do not "tidy" the numbers
 *
 * The dots are spaced *outward from the vertex*, one before and three after,
 * at 86.5 units. The obvious alternative — equal distances along the path
 * from its start — puts **no dot on the corner at all**, so the turn is
 * described by a gap and the elbow reads as visibly slipped down and left.
 * That version was drawn and rejected.
 *
 * The vertex dot at (213,369) is then nudged 7 units further into the corner
 * along the outer bisector, because at a turn the eye follows the *outside*
 * of the bend and a dot centred on the true vertex looks like it has fallen
 * inside it. That is why its coordinates do not sit exactly on the two arms.
 *
 * Short arm 45° down, long arm 55° up. The asymmetry is what separates a tick
 * from a V.
 *
 * Full bleed on purpose: Android crops maskable icons to whatever shape the
 * launcher prefers, and a transparent or inset background produces a mark
 * floating in a grey circle on exactly the devices you did not test on.
 */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<rect width="512" height="512" fill="#1f6f4a"/>
<g fill="#fbfaf8">
<circle cx="151" cy="301" r="36"/>
<circle cx="213" cy="369" r="36"/>
<circle cx="262" cy="291" r="36"/>
<circle cx="311" cy="221" r="36"/>
</g>
<circle cx="361" cy="150" r="30" fill="none" stroke="#fbfaf8" stroke-width="11" stroke-opacity="0.8"/>
</svg>`;
```

- [ ] **Step 4: Write the build script**

```js
// scripts/build-icons.mjs
/**
 * Rasterises `src/views/icon.ts` into `src/views/icon-bytes.ts`.
 *
 * Run by hand (`node scripts/build-icons.mjs`) whenever the mark changes; its
 * output is **committed**, so CI never runs it and no rasteriser joins a
 * dependency list that has six entries in it.
 *
 * Bytes are emitted as base64 and decoded at module load. A Worker cannot
 * read a file from disk, and this project has no assets binding — see the
 * spec §5 for why adding one to serve three small files is the wrong trade.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ICON_SVG } from "../src/views/icon.ts";

const SIZES = [
  { size: 192, constant: "ICON_192_PNG" },
  { size: 512, constant: "ICON_512_PNG" },
  { size: 180, constant: "APPLE_TOUCH_ICON_PNG" },
];

try {
  execFileSync("rsvg-convert", ["--version"], { stdio: "ignore" });
} catch {
  console.error("rsvg-convert is not installed. On Arch: pacman -S librsvg");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "mtt-icons-"));
const svgPath = join(dir, "icon.svg");
writeFileSync(svgPath, ICON_SVG);

const emitted = SIZES.map(({ size, constant }) => {
  const out = join(dir, `icon-${size}.png`);
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", out, svgPath]);
  const base64 = readFileSync(out).toString("base64");
  return `/** ${size}×${size}, generated from ICON_SVG. */\nexport const ${constant} = decode(\n  "${base64}",\n);`;
});

writeFileSync(
  new URL("../src/views/icon-bytes.ts", import.meta.url),
  `// GENERATED BY scripts/build-icons.mjs — DO NOT EDIT BY HAND.
// Regenerate with: node scripts/build-icons.mjs
//
// The mark lives in src/views/icon.ts; this file is only its rasterised form,
// committed so that CI and deploys never need a rasteriser installed.

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

${emitted.join("\n\n")}
`,
);

console.log(`wrote src/views/icon-bytes.ts (${SIZES.map((s) => s.size).join(", ")})`);
```

- [ ] **Step 5: Generate the bytes and run the tests**

Run: `node scripts/build-icons.mjs && npx vitest run test/views/icon.test.ts`
Expected: the script prints `wrote src/views/icon-bytes.ts (192, 512, 180)`, then PASS.

If `node` refuses the `.ts` import, run it as `node --experimental-strip-types scripts/build-icons.mjs`; Node 26 on this machine strips types natively, so the plain form should work.

- [ ] **Step 6: Add the npm script**

In `package.json`, beside `db:generate`:

```json
"icons:build": "node scripts/build-icons.mjs",
```

- [ ] **Step 7: Commit**

```bash
git add src/views/icon.ts src/views/icon-bytes.ts scripts/build-icons.mjs test/views/icon.test.ts package.json
git commit -m "feat: the home-screen mark, and the script that rasterises it"
```

---

### Task 2: Serving the manifest and the icons

**Files:**
- Modify: `src/auth/paths.ts`
- Create: `src/routes/pwa.ts`
- Modify: `src/app.ts:103` (route registration)
- Test: `test/routes/pwa.test.ts`

**Interfaces:**
- Consumes: `ICON_192_PNG`, `ICON_512_PNG`, `APPLE_TOUCH_ICON_PNG` from Task 1.
- Produces: `MANIFEST_PATH`, `ICON_192_PATH`, `ICON_512_PATH`, `APPLE_TOUCH_ICON_PATH` (all `string`, in `src/auth/paths.ts`); the `pwa` Hono router (`src/routes/pwa.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// test/routes/pwa.test.ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  APPLE_TOUCH_ICON_PATH,
  ICON_192_PATH,
  ICON_512_PATH,
  MANIFEST_PATH,
} from "../../src/auth/paths.js";

const url = (path: string) => `https://makethe.team${path}`;

describe("the web app manifest", () => {
  it("is served to anyone, with the content type browsers require", async () => {
    // A manifest behind a session is a manifest no first-time visitor can
    // install from — and the browser fetches it before any sign-in exists.
    const response = await SELF.fetch(url(MANIFEST_PATH));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
  });

  it("declares the fields that make an app installable", async () => {
    // Chrome refuses to treat the app as installable if any of these is
    // missing, and says so only in a devtools panel nobody is looking at.
    const manifest = (await (await SELF.fetch(url(MANIFEST_PATH))).json()) as Record<string, unknown>;

    expect(manifest.name).toBe("Make The Team");
    expect(manifest.short_name).toBe("Make The Team");
    expect(manifest.start_url).toBe("/app");
    expect(manifest.display).toBe("standalone");
    expect(manifest.background_color).toBe("#fbfaf8");
    expect(manifest.theme_color).toBe("#1f6f4a");
  });

  it("offers both icon sizes as maskable", async () => {
    // "maskable any" and not "any" alone: without the maskable purpose,
    // Android draws the icon shrunken inside a white circle.
    const manifest = (await (await SELF.fetch(url(MANIFEST_PATH))).json()) as {
      icons: { src: string; sizes: string; type: string; purpose: string }[];
    };

    expect(manifest.icons).toEqual([
      { src: ICON_192_PATH, sizes: "192x192", type: "image/png", purpose: "maskable any" },
      { src: ICON_512_PATH, sizes: "512x512", type: "image/png", purpose: "maskable any" },
    ]);
  });
});

describe("the icons", () => {
  it("serves each size as a cacheable PNG", async () => {
    for (const path of [ICON_192_PATH, ICON_512_PATH, APPLE_TOUCH_ICON_PATH]) {
      const response = await SELF.fetch(url(path));

      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toBe("image/png");
      // These bytes change only when the mark does, and the mark is in the
      // repo. A year is not too long; a re-deploy changes the URL only if we
      // rename the file, which is the moment to think about it.
      expect(response.headers.get("cache-control"), path).toContain("max-age=31536000");
      expect((await response.arrayBuffer()).byteLength, path).toBeGreaterThan(100);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/pwa.test.ts`
Expected: FAIL — `MANIFEST_PATH` is not exported.

- [ ] **Step 3: Add the path constants**

Append to `src/auth/paths.ts`. (These are not auth paths, but this file is in
practice the application's path registry — `PRIVACY_PATH` and `GAMES_PREFIX`
already live here, and `test/browser/catalogue.ts` imports from it. Splitting
a second registry out would leave two places to look.)

```ts
/**
 * The web app manifest (M13). Served to everyone, unauthenticated: the
 * browser fetches it on first visit, long before any session exists.
 */
export const MANIFEST_PATH = "/manifest.webmanifest";

/** The service worker. Must be served from the root to control every page. */
export const SERVICE_WORKER_PATH = "/sw.js";

/** The one page the service worker caches (M13, spec §8). */
export const OFFLINE_PATH = "/offline";

export const ICON_192_PATH = "/icon-192.png";
export const ICON_512_PATH = "/icon-512.png";

/**
 * iOS ignores the manifest's icon list completely and reads only
 * `<link rel="apple-touch-icon">`. This path exists for that link alone.
 */
export const APPLE_TOUCH_ICON_PATH = "/apple-touch-icon.png";
```

- [ ] **Step 4: Write the routes**

```ts
// src/routes/pwa.ts
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
```

- [ ] **Step 5: Register the router**

In `src/app.ts`, beside `app.route("/", robots);`:

```ts
  // The manifest, the icons and (from Task 3) the service worker. Public and
  // unauthenticated like robots.txt, and for the same reason: the browser
  // asks for these before a visitor is anyone.
  app.route("/", pwa);
```

Add the import alongside the other route imports at the top of the file.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/routes/pwa.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/auth/paths.ts src/routes/pwa.ts src/app.ts test/routes/pwa.test.ts
git commit -m "feat: serve the web app manifest and the home-screen icons"
```

---

### Task 3: The offline page and the service worker

**Files:**
- Modify: `src/views/styles.ts` (add `OFFLINE_STYLES_CSS` to `PAGE_STYLE_BLOCKS`)
- Create: `src/views/offline.ts`
- Modify: `src/routes/pwa.ts`
- Test: `test/routes/service-worker.test.ts`

**Interfaces:**
- Consumes: `SERVICE_WORKER_PATH`, `OFFLINE_PATH` from Task 2.
- Produces: `renderOfflinePage(): string` (`src/views/offline.ts`); `serviceWorkerScript(): Promise<string>` (`src/routes/pwa.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// test/routes/service-worker.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/service-worker.test.ts`
Expected: FAIL — 404 for both paths.

- [ ] **Step 3: Write the offline page**

Add to `src/views/styles.ts`, and add `OFFLINE_STYLES_CSS` to the
`PAGE_STYLE_BLOCKS` array (the CSP hashes that enumeration; a block that is
not in it fails to compile at the `layout()` call site):

```ts
/**
 * The offline page (M13). One rule beyond the shared primitives: the mark is
 * shown at a size that reads as an illustration rather than a favicon.
 */
export const OFFLINE_STYLES_CSS = `
  .offline-mark { width: 88px; height: 88px; border-radius: 22%; margin: 0 auto 1.5rem; display: block; }
`;
```

```ts
// src/views/offline.ts
import { OFFLINE_PATH, ICON_192_PATH } from "../auth/paths.js";
import { layout } from "./layout.js";
import { OFFLINE_STYLES_CSS } from "./styles.js";

/**
 * What an installed app shows when a navigation fails (M13, spec §8).
 *
 * `centred: true` — this page says one thing and offers nothing to scan,
 * which is exactly the test `LayoutOptions.centred` documents.
 *
 * Deliberately has no retry button. A button that needs the network is a
 * button that does nothing at the only moment this page is ever on screen;
 * the browser's own reload control already exists and is honest about what
 * it does.
 */
export function renderOfflinePage(): string {
  return layout({
    title: "No connection",
    centred: true,
    pageStyles: [OFFLINE_STYLES_CSS],
    body: `
      <img class="offline-mark" src="${ICON_192_PATH}" alt="" width="88" height="88">
      <h1>No connection</h1>
      <p>
        Make The Team needs to be online — kickoff times, who's in and how many
        places are left all change while you're not looking, so there's nothing
        here worth showing you from memory.
      </p>
      <p>Reconnect and try again.</p>
    `,
  });
}

export { OFFLINE_PATH };
```

- [ ] **Step 4: Write the service worker route**

Append to `src/routes/pwa.ts`:

```ts
import { OFFLINE_PATH, SERVICE_WORKER_PATH } from "../auth/paths.js";
import { renderOfflinePage } from "../views/offline.js";

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
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/routes/service-worker.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/views/offline.ts src/views/styles.ts src/routes/pwa.ts test/routes/service-worker.test.ts
git commit -m "feat: an offline page, and a service worker that caches only it"
```

---

### Task 4: The Content-Security-Policy directives

**Files:**
- Modify: `src/security/csp.ts`
- Test: `test/security/csp.test.ts`

**Interfaces:**
- Produces: three new directives in the header `cspHeader()` builds.

This is the task most likely to break something that already works, and the
one where a mistake is invisible server-side. Read the module comment in
`src/security/csp.ts` in full before editing it.

- [ ] **Step 1: Write the failing test**

Add to `test/security/csp.test.ts`:

```ts
describe("the directives the installable app needs (M13)", () => {
  it("allows the manifest, the service worker and same-origin images", async () => {
    // Each of these falls back to default-src — which is 'none' — when it is
    // not named. The failure mode is the one that reached production with
    // connect-src in M5: the browser refuses before the request leaves the
    // device, so the Worker logs nothing and every server-side test passes.
    const header = (await SELF.fetch("https://makethe.team/")).headers.get("content-security-policy");

    expect(header).toContain("manifest-src 'self'");
    expect(header).toContain("worker-src 'self'");
    expect(header).toContain("img-src 'self'");
  });

  it("does not widen anything else to get there", async () => {
    // The point of a strict policy is that it stays strict. 'self' for
    // scripts would defeat the hashing entirely, and a wildcard img-src is
    // the usual way a policy quietly becomes decorative.
    const header = (await SELF.fetch("https://makethe.team/")).headers.get("content-security-policy") ?? "";

    expect(header).toContain("default-src 'none'");
    expect(header).not.toContain("'unsafe-inline'");
    expect(header).not.toContain("img-src *");
    expect(header).not.toMatch(/script-src[^;]*'self'/);
  });

  it("serves the service worker under its own policy, not a page's", async () => {
    // /sw.js is a document, not a page. It inherits nothing, so it says for
    // itself what it may do — which is run, and reach same-origin URLs.
    const response = await SELF.fetch("https://makethe.team/sw.js");
    const header = response.headers.get("content-security-policy") ?? "";

    expect(header).toContain("script-src 'self'");
    expect(header).toContain("connect-src 'self'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/security/csp.test.ts`
Expected: FAIL — the header contains no `manifest-src`.

- [ ] **Step 3: Add the directives**

In `buildCspHeader()` in `src/security/csp.ts`, after the `connect-src` entry:

```ts
    // M13. Every directive below is one the header previously omitted, and
    // omission is not permissive: an unnamed directive falls back to
    // `default-src`, which is `'none'`.
    //
    // - `manifest-src` — the manifest is fetched under its own directive, and
    //   a refused manifest means the app is simply not installable, reported
    //   nowhere except a devtools panel nobody has open.
    // - `worker-src` — a service worker falls back through `child-src` to
    //   `script-src`, which here is a list of SHA-256 hashes and nothing
    //   else, so registration fails. This is the same shape of failure as the
    //   missing `connect-src` documented above: it happens in the browser,
    //   before any request reaches the Worker.
    // - `img-src` — needed the moment a page renders an icon, which the
    //   offline page does.
    //
    // All three are `'self'` and must not be widened. There is no CDN in this
    // project and every one of these URLs is a same-origin absolute path.
    "manifest-src 'self'",
    "worker-src 'self'",
    "img-src 'self'",
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS. Every page's CSP assertions still hold; a failure here means a
page inlines something the policy no longer covers.

- [ ] **Step 5: Commit**

```bash
git add src/security/csp.ts test/security/csp.test.ts
git commit -m "feat: allow the manifest, the service worker and same-origin images"
```

---

### Task 5: Wiring the head, and registering the worker

**Files:**
- Modify: `src/views/layout.ts`
- Modify: `src/views/scripts.ts` (add `SERVICE_WORKER_JS` to `PAGE_SCRIPT_BLOCKS`)
- Test: `test/views/layout.test.ts`

**Interfaces:**
- Consumes: `MANIFEST_PATH`, `APPLE_TOUCH_ICON_PATH`, `SERVICE_WORKER_PATH` from Task 2.
- Produces: `SERVICE_WORKER_JS: string` (`src/views/scripts.ts`).

- [ ] **Step 1: Write the failing test**

Add to `test/views/layout.test.ts`:

```ts
describe("the installable app's head (M13)", () => {
  it("links the manifest and the apple-touch-icon on every page", async () => {
    // Both are needed and neither substitutes for the other: Android reads
    // the manifest's icon list, and iOS ignores that list completely and
    // reads only the apple-touch-icon link. Ship one and half your players
    // get a screenshot of the page as their home-screen icon.
    const body = await (await SELF.fetch("https://makethe.team/")).text();

    expect(body).toContain(`<link rel="manifest" href="${MANIFEST_PATH}">`);
    expect(body).toContain(`<link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON_PATH}">`);
  });

  it("sets a theme colour matching the manifest", async () => {
    // A mismatch shows as one colour in the task switcher and another in the
    // browser chrome, on the same app.
    const body = await (await SELF.fetch("https://makethe.team/")).text();

    expect(body).toContain('<meta name="theme-color" content="#1f6f4a">');
  });
});
```

Add to `test/views/scripts.test.ts`:

```ts
it("registers the service worker without requiring it to succeed", () => {
  // The rule this whole module is built on: scripting off and scripting on
  // must be the same experience. Registration failing — an old browser, a
  // private window, a policy — must leave every page exactly as it was.
  expect(SERVICE_WORKER_JS).toContain('"serviceWorker" in navigator');
  expect(SERVICE_WORKER_JS).toContain(".catch(");
});

it("is enumerated, so the CSP hashes it", () => {
  // A block that is not in this array is script the browser silently drops.
  expect(SCRIPT_BLOCKS).toContain(SERVICE_WORKER_JS);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/views/layout.test.ts test/views/scripts.test.ts`
Expected: FAIL — no manifest link; `SERVICE_WORKER_JS` not exported.

- [ ] **Step 3: Write the registration block**

In `src/views/scripts.ts`, before `PAGE_SCRIPT_BLOCKS`:

```ts
/**
 * Registers the service worker (M13).
 *
 * The third script block in the project, and it earns its place on the same
 * ground as the passkey ones: there is no server-side substitute — a service
 * worker can only be registered by a page, from script.
 *
 * Enhancement, not provision. Registration failing for any reason at all —
 * an old browser, a private window, a corporate policy, a user who has
 * scripting off — must leave every page exactly as it already was, which is
 * fully working. Nothing on this site needs the worker to function; it adds
 * an offline page and makes the app installable.
 *
 * The `catch` is deliberately empty rather than logging. A failed
 * registration is not an error condition for the visitor, and a console error
 * on every page load would trip the browser-test console gate for something
 * that is working as designed.
 */
export const SERVICE_WORKER_JS = `
(function () {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("${SERVICE_WORKER_PATH}").catch(function () {});
  });
})();
`;
```

Add `SERVICE_WORKER_JS` to `PAGE_SCRIPT_BLOCKS`, and import `SERVICE_WORKER_PATH` at the top of the file.

- [ ] **Step 4: Wire the head and register the script on every page**

In `src/views/layout.ts`, in the `<head>` it emits, after the existing font links:

```html
    <link rel="manifest" href="${MANIFEST_PATH}">
    <!-- iOS reads only this. It ignores the manifest's icon list entirely. -->
    <link rel="apple-touch-icon" href="${APPLE_TOUCH_ICON_PATH}">
    <meta name="theme-color" content="#1f6f4a">
```

The registration script is the one script that belongs on *every* page rather
than being opted into per page, since the worker's job is app-wide. Emit it
from `layout()` unconditionally, alongside the `pageScripts` blocks — and note
in `LayoutOptions.pageScripts`'s comment that it is no longer true that
"almost every page should leave this unset" applies to the site-wide block,
which is not passed in at all.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS — including `test/security/csp.test.ts`, which recomputes
`script-src` from `SCRIPT_BLOCKS` and will now find a third hash.

- [ ] **Step 6: Commit**

```bash
git add src/views/layout.ts src/views/scripts.ts test/views/layout.test.ts test/views/scripts.test.ts
git commit -m "feat: link the manifest and register the service worker"
```

---

### Task 6: The install affordance

**Files:**
- Create: `src/views/install.ts`
- Modify: `src/views/styles.ts` (add `INSTALL_STYLES_CSS` to `PAGE_STYLE_BLOCKS`)
- Modify: `src/views/scripts.ts` (add `INSTALL_JS` to `PAGE_SCRIPT_BLOCKS`)
- Modify: `src/views/account.ts`
- Test: `test/routes/account.test.ts`

**Interfaces:**
- Produces: `renderInstallSection(): string` (`src/views/install.ts`); `INSTALL_STYLES_CSS`; `INSTALL_JS`.

M13 ships two of the five states in spec §11 — "install me" and "already
installed". The notification-permission states arrive in M14 and slot into the
same component.

- [ ] **Step 1: Write the failing test**

Add to `test/routes/account.test.ts`:

```ts
describe("the install section (M13)", () => {
  it("tells a player how to install with no script at all", async () => {
    // The baseline, and the whole no-JS rule in one assertion: the manual
    // route works on every platform — iOS has no install API at all, and
    // Chrome's menu has the same item — so the server renders it visible and
    // script only upgrades it to a button where one is possible.
    const body = await signedInPlayerPage(ACCOUNT_PATH);

    expect(body).toContain("Add to Home Screen");
    expect(body).toContain("Share");
  });

  it("ships the button hidden, for script to reveal", async () => {
    // [hidden] is honoured with !important by STYLES precisely so a later
    // display rule cannot un-hide a control whose platform cannot use it.
    const body = await signedInPlayerPage(ACCOUNT_PATH);

    expect(body).toMatch(/<button[^>]*data-install-button[^>]*hidden/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/routes/account.test.ts`
Expected: FAIL — the account page contains no install section.

- [ ] **Step 3: Write the styles**

Add to `src/views/styles.ts` and to `PAGE_STYLE_BLOCKS`:

```ts
/** The install section on the account page (M13). */
export const INSTALL_STYLES_CSS = `
  .install { margin-top: 2rem; padding: 1rem 1.1rem; border: 1px solid var(--line); border-radius: 0.7rem; }
  .install h2 { margin-top: 0; }
  .install ol { margin: 0.5rem 0 0; padding-left: 1.2rem; color: var(--mut); font-size: var(--t-support); }
  .install li + li { margin-top: 0.35rem; }
`;
```

- [ ] **Step 4: Write the component**

```ts
// src/views/install.ts
import { INSTALL_STYLES_CSS } from "./styles.js";

/**
 * "Add to your home screen" (M13, spec §11).
 *
 * Three states, and the *server* renders the one that works everywhere:
 * manual instructions. Script then upgrades it — to a real button on a
 * browser that fired `beforeinstallprompt`, or to a confirmation on a device
 * where the app is already installed.
 *
 * Rendering the instructions as the baseline rather than the button is the
 * whole no-JS rule applied honestly. iOS has no install API of any kind: the
 * Share sheet is the only route Apple offers, so a player on an iPhone reads
 * these instructions whether or not anything runs. Chrome's menu carries the
 * same item, so the instructions are never wrong — only sometimes bettered.
 */
export function renderInstallSection(): string {
  return `
    <section class="install">
      <h2>Add to your home screen</h2>
      <p data-install-instructions>
        Keep Make The Team a tap away, and it opens like an app rather than a tab.
      </p>
      <ol data-install-steps>
        <li>Open the browser's <strong>Share</strong> or menu button.</li>
        <li>Choose <strong>Add to Home Screen</strong>.</li>
      </ol>
      <button class="button" type="button" data-install-button hidden>Add to home screen</button>
      <p data-install-done hidden>Make The Team is installed on this device.</p>
    </section>
  `;
}

export { INSTALL_STYLES_CSS };
```

- [ ] **Step 5: Write the script**

Add to `src/views/scripts.ts` and to `PAGE_SCRIPT_BLOCKS`:

```ts
/**
 * Upgrades the install section (M13).
 *
 * Feature detection only — never user-agent sniffing. `beforeinstallprompt`
 * is a Chromium event and its absence is exactly the signal that the manual
 * instructions are the only route, which is the case on every iPhone.
 *
 * Three transitions, all of them subtractive if anything is missing:
 *   - already installed (display-mode: standalone) → hide the how-to, show
 *     the confirmation;
 *   - installable → hide the how-to, show the button, and fire the saved
 *     prompt on click;
 *   - neither → change nothing, and the server-rendered instructions stand.
 */
export const INSTALL_JS = `
(function () {
  var section = document.querySelector(".install");
  if (!section) return;

  var steps = section.querySelector("[data-install-steps]");
  var intro = section.querySelector("[data-install-instructions]");
  var button = section.querySelector("[data-install-button]");
  var done = section.querySelector("[data-install-done]");

  if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) {
    if (steps) steps.hidden = true;
    if (intro) intro.hidden = true;
    if (done) done.hidden = false;
    return;
  }

  var saved = null;
  window.addEventListener("beforeinstallprompt", function (event) {
    // Chromium shows its own prompt otherwise, at a moment of its choosing.
    event.preventDefault();
    saved = event;
    if (steps) steps.hidden = true;
    if (button) button.hidden = false;
  });

  if (button) {
    button.addEventListener("click", function () {
      if (!saved) return;
      saved.prompt();
      // A prompt can only be used once. Whatever the player chose, this one
      // is spent, and holding a stale event would give them a button that
      // does nothing the second time.
      saved = null;
      button.hidden = true;
      if (steps) steps.hidden = false;
    });
  }

  window.addEventListener("appinstalled", function () {
    if (button) button.hidden = true;
    if (steps) steps.hidden = true;
    if (intro) intro.hidden = true;
    if (done) done.hidden = false;
  });
})();
`;
```

- [ ] **Step 6: Mount it on the account page**

In `src/views/account.ts`, render `renderInstallSection()` into the page body,
and add `INSTALL_STYLES_CSS` to that page's `pageStyles` array and `INSTALL_JS`
to its `pageScripts`.

- [ ] **Step 7: Run the tests**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/views/install.ts src/views/account.ts src/views/styles.ts src/views/scripts.ts test/routes/account.test.ts
git commit -m "feat: offer installation on the account page"
```

---

### Task 7: Browser verification, catalogue and docs

**Files:**
- Modify: `test/browser/catalogue.ts`
- Create: `test/browser/pwa.spec.ts`
- Modify: `docs/runbooks/browser-testing.md`
- Modify: `docs/known-issues.md`

This is the task that proves M13 actually works, because every failure mode in
Task 4 is invisible to the Vitest suite: the browser refuses before a request
reaches the Worker.

- [ ] **Step 1: Add the offline page to the catalogue**

In `test/browser/catalogue.ts`, add an entry:

```ts
  {
    id: "offline",
    title: "No connection",
    path: () => OFFLINE_PATH,
    persona: "anonymous",
    note: "What an installed app shows when a navigation fails with no network.",
  },
```

Import `OFFLINE_PATH` from `../../src/auth/paths.js` alongside the others.

- [ ] **Step 2: Write the browser test**

```ts
// test/browser/pwa.spec.ts
import { expect, test } from "@playwright/test";

/**
 * The assertions that can only be made in a browser (M13).
 *
 * Every one of these fails *client-side*: the browser refuses a resource
 * before the request leaves the device, so the Worker logs nothing and every
 * Vitest test still passes. That is precisely how M5 shipped two passkey
 * buttons that could run and could not fetch.
 */
test("the service worker registers with no CSP violation", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text());
  });

  await page.goto("/");
  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active !== null;
  });

  expect(violations, violations.join("\n")).toEqual([]);
  expect(registered).toBe(true);
});

test("the manifest is fetched and parsed, not refused", async ({ page }) => {
  const response = await page.goto("/manifest.webmanifest");

  expect(response?.status()).toBe(200);
  const manifest = await response?.json();
  expect(manifest.display).toBe("standalone");
});

test("a failed navigation falls back to the offline page", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);

  await context.setOffline(true);
  await page.goto("/app");

  await expect(page.getByRole("heading", { name: "No connection" })).toBeVisible();
  await context.setOffline(false);
});
```

- [ ] **Step 3: Run the browser suite**

Run: `npm run test:browser`
Expected: PASS, including the existing console/CSP gate over the whole
catalogue — which now includes `/offline`.

If the offline test is flaky because the worker has not yet claimed the page,
the fix is to wait on `navigator.serviceWorker.ready` and re-navigate once, not
to relax the assertion.

- [ ] **Step 4: Capture the guide screenshots**

Run: `npm run guide:capture`
Expected: a new shot for `/offline`, and unchanged shots elsewhere. Review the
diff before committing — an unexpected change anywhere else means the head
additions in Task 5 moved something.

- [ ] **Step 5: Document the manual checks**

Add to `docs/runbooks/browser-testing.md` a short section stating what cannot
be automated and must be checked on real hardware before a production deploy:

- On an Android phone: the install prompt appears, the installed app opens at
  `/app` without browser chrome, and the home-screen icon is the mark rather
  than a screenshot of the page.
- On an iPhone: Share → Add to Home Screen produces the mark as the icon (this
  is the only assertion that proves the `apple-touch-icon` link is right, since
  iOS reads nothing else), and the installed app opens without Safari chrome.

- [ ] **Step 6: Commit**

```bash
git add test/browser docs/runbooks/browser-testing.md docs/known-issues.md
git commit -m "test: verify the installable app in a real browser"
```

---

## Self-Review

**Spec coverage.** §5 icon → Task 1. §6 routes → Tasks 2 and 3 (the two push
routes are M14). §7 CSP → Task 4. §8 service worker → Task 3, M13 handlers
only. §11 install affordance → Task 6, states 1–3 of five; states 4 and 5 are
permission states and belong to M14. §15 browser testing → Task 7.

Not covered here, and correctly so: §§4, 9, 10, 12, 13, 14 are all M14.

**Known gap, deliberate.** The spec's §11 offer on the response-confirmation
page is a *push* offer gated on `push_offered_at`; M13 puts the install section
on `/app/account` only. A player who never signs in sees no install affordance
until M14 adds it to the token page. That is the right order — there is nothing
to gain by installing until notifications exist — but it means M13 shipped
alone reaches only signed-in players.
