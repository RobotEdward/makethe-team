import { expect, test } from "@playwright/test";
import { signIn, TEST_OWNER } from "./sign-in.js";

test("an anonymous visitor is offered the sign-in form", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.locator('form.signin input[name="email"]')).toBeVisible();
});

test("signIn reaches an authenticated page with a linked Player", async ({ page }) => {
  await signIn(page, TEST_OWNER);

  // Scoped to the heading rather than the document. A bare page-wide check
  // would also pass on the 403 "We can't find your player" page, which is
  // precisely the failure this test exists to catch — see `signIn`.
  await expect(page.locator("h1")).not.toHaveText(/can.t find your player/i);

  const response = await page.goto("/g/new");
  expect(response?.status()).toBe(200);
});
