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
    const registration = await (navigator as unknown as BrowserNavigator).serviceWorker.ready;
    return registration.active !== null;
  });

  expect(violations, violations.join("\n")).toEqual([]);
  expect(registered).toBe(true);
});

test("the manifest is fetched and parsed, not refused", async ({ page }) => {
  const response = await page.goto("/manifest.webmanifest");

  expect(response?.status()).toBe(200);
  const manifest = (await response?.json()) as { display: string };
  expect(manifest.display).toBe("standalone");
});

test("a failed navigation falls back to the offline page", async ({ page, context }) => {
  await page.goto("/");
  await page.evaluate(() => (navigator as unknown as BrowserNavigator).serviceWorker.ready);

  await context.setOffline(true);
  await page.goto("/app");

  await expect(page.getByRole("heading", { name: "No connection" })).toBeVisible();
  await context.setOffline(false);
});
