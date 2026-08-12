import { env } from "cloudflare:test";
import { expect, vi } from "vitest";
import type { createApp } from "../../src/app.js";
import { createApp as buildApp } from "../../src/app.js";
import { SIGN_IN_PATH } from "../../src/auth/paths.js";
import { ConsoleNotifier } from "../../src/notify/console-notifier.js";
import type { Message } from "../../src/notify/notifier.js";
import type { Bindings } from "../../src/env.js";

/**
 * The browser journey through sign-in, shared by every suite that needs a real
 * session cookie.
 *
 * Lifted verbatim out of `test/routes/signin.test.ts` when the dashboard suite
 * needed the same thing: a second, hand-rolled copy would have been a second
 * definition of "signed in", and the two would have drifted the first time the
 * flow changed. Nothing here builds a session row or a cookie by hand — only
 * the app's own public surface is used, because a forged cookie proves only
 * that a forgery is accepted.
 */

/**
 * The origin every request in these suites is made against.
 *
 * It matches `BETTER_AUTH_URL` in `wrangler.jsonc`, which is what `SELF.fetch`
 * runs with — Better Auth's origin checks compare against it, so a test that
 * used a different host would be testing the CSRF rejection path by accident.
 */
export const ORIGIN = "https://makethe.team";

/**
 * The address the test bindings allowlist (`vitest.config.ts`). `SELF.fetch`
 * runs the real Worker with the real bindings and gives no way to override
 * them per request, so the happy path has to use this address.
 */
export const ALLOWED = "test-only-not-a-real-address@example.com";

export function bindings(overrides: Partial<Bindings> = {}): Bindings {
  return { ...env, BETTER_AUTH_URL: ORIGIN, SIGNIN_ALLOWLIST: ALLOWED, ...overrides };
}

/** `POST /sign-in` exactly as the page's form does it: urlencoded, same-origin. */
export function requestLink(email: string) {
  return new Request(`${ORIGIN}${SIGN_IN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    body: new URLSearchParams({ email }),
  });
}

/**
 * The sign-in link this deployment actually emailed.
 *
 * Captured off `ConsoleNotifier` — the notifier the test bindings select —
 * rather than rebuilt from the `verification` row, because the emailed URL is
 * the only place `POST /sign-in`'s choice of `callbackURL` is observable, and
 * that choice is what makes the linking step run at all. Rebuilding the URL
 * here would have quietly supplied the query parameter the route is supposed
 * to be setting.
 *
 * The spy is installed around a single request and always removed.
 */
export async function askForLink(app: ReturnType<typeof createApp>, email: string) {
  const sent: Message[] = [];
  const spy = vi
    .spyOn(ConsoleNotifier.prototype, "send")
    .mockImplementation((messages: readonly Message[]) => {
      sent.push(...messages);
      return Promise.resolve(messages.map(() => ({ ok: true, providerMessageId: null })));
    });
  try {
    const response = await app.fetch(requestLink(email), bindings());
    return { response, sent };
  } finally {
    spy.mockRestore();
  }
}

/** The `/api/auth/magic-link/verify` URL out of the message that was sent. */
export function linkIn(sent: Message[]): string {
  expect(sent).toHaveLength(1);
  const match = /https?:\/\/[^\s"]*magic-link\/verify\?[^\s"]*/.exec(sent[0]!.text);
  expect(match, "the email must carry a verification link").not.toBeNull();
  return match![0];
}

/** Follows the emailed link once and returns the cookie a browser would keep. */
export function followLink(url: string, cookie?: string) {
  return new Request(url, { headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
}

export function cookieFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!)
    .join("; ");
}

/**
 * The whole browser journey: ask for a link, follow it, arrive wherever the
 * app sends you. Returns the cookie jar and the final redirect target.
 */
export async function signIn(email = ALLOWED) {
  const app = buildApp();
  const { response, sent } = await askForLink(app, email);
  expect(response.status).toBe(200);

  const verified = await app.fetch(followLink(linkIn(sent)), bindings());
  const cookie = cookieFrom(verified);
  expect(cookie).not.toBe("");

  // Better Auth redirects to whatever `POST /sign-in` asked for; following it
  // is what actually runs the linking step.
  const landed = await app.fetch(
    new Request(new URL(verified.headers.get("location")!, ORIGIN), { headers: { cookie } }),
    bindings(),
  );
  return { cookie, verified, landed };
}
