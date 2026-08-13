import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";

const run = promisify(execFile);

/**
 * **What this helper does not exercise.**
 *
 * Reading the token from storage bypasses TR-35's sign-in allowlist entirely.
 * That gate suppresses the *send* — Better Auth has already written the
 * `verification` row by the time `sendMagicLink` is called, refused or not, as
 * `src/auth/factory.ts` notes and as this suite confirmed by execution: a
 * `POST /sign-in` for an address absent from `SIGNIN_ALLOWLIST` still leaves a
 * usable token behind.
 *
 * So a browser test signing in successfully proves nothing about whether a
 * real person could. The allowlist's behaviour is covered where it can be
 * checked precisely, in `test/routes/signin.test.ts`, and must stay there.
 * `SIGNIN_ALLOWLIST` remains in `.dev.vars` for a human driving the app by
 * hand, who does need a real email to arrive.
 */

/**
 * The identities the browser suite signs in as. Always `@example.test`, never
 * a real address: if `NOTIFIER` is ever left on `resend` locally, these are
 * what would be handed to the provider.
 */
export const TEST_OWNER = "owner@example.test";
export const TEST_PLAYER = "player@example.test";

/**
 * Read the most recent magic-link token for `email` out of local D1.
 *
 * This exists because `ConsoleNotifier` logs a message's recipient, subject and
 * dedupe key but **not its URL** — so even with `NOTIFIER=console` the link
 * never reaches the terminal. Changing that would change production behaviour
 * (production runs on the console notifier), so the token is read from storage
 * instead.
 *
 * Via `wrangler d1 execute`, never by opening the SQLite file directly:
 * Miniflare holds its own connection to it, and a second writer is the
 * WAL-deadlock hazard `src/auth/factory.ts` documents. This only ever reads,
 * but it uses the supported path regardless.
 *
 * `verification.identifier` holds the token; `value` holds the JSON-encoded
 * email, which is what makes it possible to tell two identities' links apart.
 */
async function latestMagicLinkToken(email: string): Promise<string> {
  const { stdout } = await run(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "makethe-team",
      "--local",
      "--json",
      "--command",
      "SELECT identifier, value FROM verification ORDER BY rowid DESC LIMIT 10",
    ],
    { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 },
  );

  // wrangler prints a banner before the JSON payload.
  const jsonStart = stdout.indexOf("[");
  if (jsonStart === -1) throw new Error(`unexpected wrangler output:\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(jsonStart)) as {
    results?: { identifier: string; value: string }[];
  }[];
  const rows = parsed[0]?.results ?? [];
  const match = rows.find((row) => String(row.value).includes(email));

  if (!match) {
    throw new Error(
      `No magic-link token in local D1 for ${email}.\n` +
        `Note this is NOT the allowlist: Better Auth writes the verification ` +
        `row before TR-35's gate runs, so a refused address still gets a row ` +
        `(verified by execution — see this file's header). Likelier causes: ` +
        `the POST never reached the server, BETTER_AUTH_SECRET is unset so ` +
        `the handler threw into signin.ts's deliberate catch, or the token ` +
        `was already consumed (they are single-use and deleted on verify).`,
    );
  }
  return match.identifier;
}

/**
 * Sign `page` in as `email`, ending on an authenticated page with a Player.
 *
 * The callback is `/sign-in/complete` and must stay that way. Linking the
 * authenticated identity to a domain Player happens in *that* handler
 * (`src/routes/signin.ts`), not inside Better Auth's — so a callback pointed
 * straight at the eventual destination produces a perfectly valid session with
 * no Player, and every authenticated page then answers `403 We can't find your
 * player`. That failure looks like a permissions bug and is not one.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/sign-in");
  await page.fill('input[name="email"]', email);
  await page.click('button[type="submit"]');

  const token = await latestMagicLinkToken(email);
  await page.goto(
    `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=/sign-in/complete`,
  );
}
