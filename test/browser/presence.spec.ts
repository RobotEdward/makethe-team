import { expect, test } from "@playwright/test";
import { signIn, TEST_OWNER } from "./sign-in.js";

/**
 * The presence ping (M33), in a real browser.
 *
 * Here rather than in Vitest because of exactly what `docs/known-issues.md`'s
 * `connect-src` post-mortem records: workerd returns the CSP header and never
 * enforces it, so a server test cannot tell a `fetch` that left the page from
 * one the browser refused before it did. This block's whole job is that
 * `fetch`, and the only proof it works is a request arriving.
 */

test("a signed-in tab reports the player once, however many pages it visits", async ({ page }) => {
  const sent: unknown[] = [];
  const answered: number[] = [];
  // Both listeners are synchronous, and both are attached before the sign-in.
  // Before, because `signIn` lands on a signed-in page and the tab's one ping
  // has already happened by the time the first `goto` below runs — a listener
  // attached afterwards sees nothing, and reads as a broken ping rather than
  // as the working throttle it is.
  page.on("request", (request) => {
    if (request.url().endsWith("/app/presence") && request.method() === "POST") {
      sent.push(request.postDataJSON());
    }
  });
  page.on("response", (response) => {
    if (response.url().endsWith("/app/presence")) answered.push(response.status());
  });

  await signIn(page, TEST_OWNER);
  await page.goto("/app", { waitUntil: "networkidle" });
  await page.goto("/app/account", { waitUntil: "networkidle" });
  await page.goto("/app", { waitUntil: "networkidle" });

  expect(sent).toEqual([{ standalone: false }]);
  expect(answered).toEqual([204]);
});

test("a public page pings nothing, having no session to report", async ({ page }) => {
  const pings: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/app/presence")) pings.push(request.url());
  });

  await page.goto("/sign-in", { waitUntil: "networkidle" });

  expect(pings).toEqual([]);
});
