import { expect, test } from "@playwright/test";

/**
 * `tsconfig.json`'s `lib` is `ES2022` only — this project runs in workerd,
 * which has no DOM — so nothing here can name `Navigator` or
 * `ServiceWorkerRegistration`. These are the two shapes `page.evaluate`
 * actually touches, typed by hand rather than by pulling in `lib.dom.d.ts`,
 * which redefines globals (`fetch`, `Uint8Array`, `SubtleCrypto`, …) that
 * conflict with `@cloudflare/workers-types` everywhere else in the program.
 */
interface BrowserNavigator {
  serviceWorker: {
    ready: Promise<{ active: unknown }>;
  };
}

/** What `waitForServiceWorkerReady` returns: either the registration settled, or it didn't. */
type ServiceWorkerReadyResult = { ready: true; active: boolean } | { ready: false };

/**
 * Waits for `navigator.serviceWorker.ready`, bounded.
 *
 * `SERVICE_WORKER_JS` (`src/views/scripts.ts`) calls `.catch(function () {})`
 * on `register()` — correct in production, where a failed registration must
 * never disturb the page — but it means that if `worker-src` were ever
 * removed from the CSP, `register()` rejects, the `.catch` swallows it, and
 * `ready` never resolves at all. Awaiting it unbounded turns that specific,
 * nameable failure into Playwright's generic 90s per-test timeout, with no
 * indication anywhere of why. Racing against a short local timer — 5s is
 * generous against a `wrangler dev` on localhost — turns it back into an
 * assertion a caller can report on.
 */
async function waitForServiceWorkerReady(
  page: import("@playwright/test").Page,
  timeoutMs = 5_000,
): Promise<ServiceWorkerReadyResult> {
  return page.evaluate(async (timeout) => {
    const nav = navigator as unknown as BrowserNavigator;
    const timedOut = new Promise<{ ready: false }>((resolve) => {
      setTimeout(() => resolve({ ready: false }), timeout);
    });
    const becameReady = nav.serviceWorker.ready.then((registration) => ({
      ready: true as const,
      active: registration.active !== null,
    }));
    return Promise.race([becameReady, timedOut]);
  }, timeoutMs);
}

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

  // `layout()` puts `<link rel="manifest">` on every page, so this
  // navigation is also the only place the browser actually runs its manifest
  // -processing algorithm and enforces `manifest-src` against it — a refused
  // manifest fetch surfaces here as a CSP violation console message, exactly
  // like a refused service-worker script under `worker-src` would. That is
  // what proves the browser *accepts* the manifest under CSP; the second
  // test below proves a different claim (that the route serves valid JSON),
  // and does not touch this one.
  const result = await waitForServiceWorkerReady(page);

  // Asserted first, and regardless of whether the worker ever became ready:
  // a CSP violation must be reported as a CSP violation, not masked by a
  // readiness failure that names no cause.
  expect(violations, violations.join("\n")).toEqual([]);

  expect(result.ready, "the service worker never became ready").toBe(true);
  if (result.ready) expect(result.active).toBe(true);
});

test("the manifest route serves valid JSON with the fields an install needs", async ({ page }) => {
  // Direct navigation, not a `<link>`-triggered fetch: this proves the route
  // answers correctly, not that the browser's manifest-processing algorithm
  // accepts it under CSP. A top-level navigation to a JSON URL never runs
  // that algorithm at all — only a document that carries `<link
  // rel="manifest">` does, which is what the test above actually exercises.
  // Both claims are worth pinning separately; this one is cheap on its own.
  const response = await page.goto("/manifest.webmanifest");

  expect(response?.status()).toBe(200);
  const manifest = (await response?.json()) as { display: string };
  expect(manifest.display).toBe("standalone");
});

test("a failed navigation falls back to the offline page", async ({ page, context }) => {
  await page.goto("/");
  const result = await waitForServiceWorkerReady(page);
  expect(result.ready, "the service worker never became ready").toBe(true);

  await context.setOffline(true);
  await page.goto("/app");

  await expect(page.getByRole("heading", { name: "No connection" })).toBeVisible();
  await context.setOffline(false);
});
