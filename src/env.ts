import type { FixtureCapacity } from "./capacity/fixture-capacity.js";

export interface Bindings {
  DB: D1Database;
  FIXTURE_CAPACITY: DurableObjectNamespace<FixtureCapacity>;
  NOTIFIER: string;
  MAX_EMAILS_PER_DAY: string;
  /** HMAC key for response tokens (TR-13). Set with `wrangler secret put`. */
  RESPONSE_TOKEN_SECRET: string;
  /**
   * Resend API key for `ResendNotifier`. Set with `wrangler secret put`.
   * Required only when `NOTIFIER` is `"resend"`; `createNotifier` throws by
   * name if it is missing or blank at that point (an unset secret arrives as
   * `undefined` at runtime regardless of this non-optional type).
   */
  RESEND_API_KEY: string;
  /**
   * The `from` address `ResendNotifier` sends as, set in `wrangler.jsonc`'s
   * `vars`. Same requirement and same by-name failure as `RESEND_API_KEY`.
   */
  EMAIL_FROM: string;
  /**
   * Signing key for Better Auth's own sessions/tokens. Set with
   * `wrangler secret put`, same as `RESPONSE_TOKEN_SECRET` — never committed,
   * never printed while setting it.
   */
  BETTER_AUTH_SECRET: string;
  /**
   * The public base URL Better Auth issues links against (e.g. magic-link
   * URLs). Not secret; set in `wrangler.jsonc`'s `vars`.
   */
  BETTER_AUTH_URL: string;
  /**
   * Trial-only sign-in allowlist (TR-35): a comma-separated list of addresses
   * allowed to be sent a magic link. A secret, not a var — the list is a set
   * of real people's addresses, and this repo is public.
   *
   * Set with `wrangler secret put SIGNIN_ALLOWLIST`. Unset or empty means
   * *nobody* gets a link (`src/auth/factory.ts` fails closed, same convention
   * as `MAX_EMAILS_PER_DAY`), so it must be set before the trial can begin.
   * Deleted outright when the product opens to the public.
   */
  SIGNIN_ALLOWLIST: string;
}

export type AppEnv = { Bindings: Bindings };
