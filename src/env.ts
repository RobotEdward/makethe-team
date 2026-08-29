import type { AppVariables } from "./auth/session.js";
import type { FixtureCapacity } from "./capacity/fixture-capacity.js";

/**
 * A Workers rate limiting binding (`ratelimits` in `wrangler.jsonc`).
 *
 * Declared here rather than imported from `@cloudflare/workers-types` so the
 * middleware can be exercised against an ordinary stub object: the tests build
 * one by hand, and a structural type is what lets them.
 */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Bindings {
  DB: D1Database;
  FIXTURE_CAPACITY: DurableObjectNamespace<FixtureCapacity>;
  /**
   * Per-token throttle for the unauthenticated link endpoints (TR-37).
   *
   * **Optional on purpose, and every caller must hold with it absent.** The
   * control that actually bounds the cost of `/r/` and `/j/` is the quota
   * wrapper around the notifier (`MAX_EMAILS_PER_DAY`) plus the token's
   * unguessability — this is a supplement, exactly as the WAF rules are, and
   * `src/security/rate-limit.ts` fails open for that reason. It is undefined
   * in every `vitest` run and in `wrangler dev` unless configured, so a
   * required binding here would make the whole suite depend on a Cloudflare
   * feature none of it is testing.
   *
   * Counting is **per machine** — not per colo, not global. The configured
   * limit is therefore a floor on what one caller can do, not a ceiling: see
   * the measurement in `src/security/rate-limit.ts`, where 23 requests to one
   * token passed a 10-per-60s limit untouched because they arrived on
   * different machines. Treat it as a blunt brake on hammering, never as an
   * accurate count.
   */
  TOKEN_LIMITER?: RateLimitBinding;
  /**
   * Per-IP throttle across the same endpoints, keyed on `CF-Connecting-IP`.
   *
   * A second dimension rather than a tighter `TOKEN_LIMITER`, because the two
   * bound different attacks: the per-token key bounds someone hammering one
   * valid link, and cannot see an attacker walking *different* tokens looking
   * for a hit. Only an IP key sees that.
   *
   * Deliberately generous. Cloudflare's own guidance is not to key on IP,
   * because a whole office or mobile network shares one — but these endpoints
   * have no session and no other stable identifier, so the choice is a loose
   * IP limit or nothing. Loose is right: a false positive here breaks the one
   * journey the product depends on.
   */
  TOKEN_IP_LIMITER?: RateLimitBinding;
  NOTIFIER: string;
  MAX_EMAILS_PER_DAY: string;
  /**
   * Whether a second email provider picks up messages the primary's daily
   * ceiling refused (M42): `"none"` (or absent) or `"cloudflare"`.
   *
   * A separate switch from `NOTIFIER` for the same reason `PUSH_NOTIFIER`
   * is: the primary sender and the spill leg are independent choices, and
   * folding them into one value (`"resend+cloudflare"`) would multiply the
   * cases `selectNotifier` has to enumerate every time either side gains an
   * option.
   *
   * Optional, unlike `NOTIFIER` — see the `case undefined` branch in
   * `selectEmailLeg` for why an env that predates this binding must keep
   * working rather than throw.
   */
  EMAIL_SPILLOVER?: string;
  /**
   * The Cloudflare leg's own daily ceiling, counted separately from
   * `MAX_EMAILS_PER_DAY` against `email_quota`'s `"cloudflare"` rows.
   *
   * This doubles as the monthly cost guard. Cloudflare Email Service
   * includes 3,000 sends a month and bills $0.35/1,000 beyond that, so a
   * daily cap of 100 lands at 3,000–3,100 a month — a 31-day month
   * overshoots by about 3p, which is not worth a second counter to prevent.
   * Raising this above 100 means accepting a real monthly bill.
   *
   * Required only when `EMAIL_SPILLOVER` is `"cloudflare"`, and parsed
   * fail-closed to 0 like `MAX_EMAILS_PER_DAY` — a broken value disables
   * the spill leg rather than uncapping it.
   */
  MAX_EMAILS_PER_DAY_CLOUDFLARE?: string;
  /** HMAC key for response tokens (TR-13). Set with `wrangler secret put`. */
  RESPONSE_TOKEN_SECRET: string;
  /**
   * HMAC key for owner cancellation tokens (`/cancel/:token`), deliberately
   * **separate** from `RESPONSE_TOKEN_SECRET` rather than shared with it.
   *
   * The two token kinds are already kept apart by the `kind` discriminator
   * baked into the signed bytes (`src/domain/token.ts`), and that check is
   * pinned by tests — but it is a *correctness* boundary, not a *compromise*
   * boundary. Two things separate keys buy that the discriminator cannot:
   *
   *  1. **Blast radius.** A response token is minted for every player in
   *     every reminder and promotion email, on the hot path of every incoming
   *     link; a cancel token is minted rarely, for owners only, and destroys a
   *     Game. If the response key ever leaks, the attacker can forge a
   *     player's own answer — bad, recoverable. With one shared key they could
   *     also forge a cancellation of any fixture whose id they could obtain.
   *  2. **Independent rotation.** Rotating `RESPONSE_TOKEN_SECRET` breaks
   *     every outstanding response link in every inbox, so in practice an
   *     operator hesitates to do it. Sharing the key would extend that
   *     hesitation to the higher-value one. Separately, either can be rotated
   *     on its own cadence, and rotating this one invalidates only cancel
   *     links, which are few and short-lived (they expire at kickoff).
   *
   * Set with `wrangler secret put CANCEL_TOKEN_SECRET`. There is deliberately
   * **no fallback** to `RESPONSE_TOKEN_SECRET` if it is unset: a fallback
   * would silently restore exactly the shared-key property this binding
   * exists to remove. Unset fails closed and loudly instead — signing throws
   * by name (`signToken`), and verification returns `malformed`, so every
   * cancel link renders the ordinary "this link isn't working" page.
   */
  CANCEL_TOKEN_SECRET: string;
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
   * The Cloudflare account the email API sends on behalf of, in
   * `wrangler.jsonc`'s `vars`. Not a secret — it appears in dashboard URLs
   * and authorises nothing on its own; `CLOUDFLARE_EMAIL_API_TOKEN` is the
   * credential.
   *
   * Required only when `EMAIL_SPILLOVER` is `"cloudflare"`, with the same
   * by-name failure as `RESEND_API_KEY`.
   */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /**
   * API token for Cloudflare Email Service, scoped to email sending only.
   * Set with `wrangler secret put`. Required only when `EMAIL_SPILLOVER` is
   * `"cloudflare"`.
   */
  CLOUDFLARE_EMAIL_API_TOKEN?: string;
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
   *
   * Typed honestly as optional, unlike `RESEND_API_KEY`/`EMAIL_FROM` above:
   * this binding's whole *purpose* is to be read while unset (that is the
   * fail-closed default state before the trial begins), so
   * `isSignInAllowlisted(raw: string | undefined, …)` must be able to accept
   * `undefined` without a cast standing between the type and the runtime
   * value it actually receives.
   */
  SIGNIN_ALLOWLIST: string | undefined;
  /**
   * Which push implementation to use: `"webpush"`, `"console"` or `"null"`.
   * A var, not a secret — set in `wrangler.jsonc`. Deliberately independent
   * of `NOTIFIER`: email and web push are different channels with different
   * failure modes, and forcing one switch to cover both would mean the only
   * way to ship push dark (see `PUSH_NOTIFIER: "null"` below) is to also
   * turn email off, which has nothing to do with it.
   *
   * `wrangler.jsonc` ships this as `"null"` until the real VAPID pair
   * exists: with the notifier at `"null"`, `createNotifier` never reads
   * `VAPID_PUBLIC_KEY` or `VAPID_PRIVATE_KEY` for the push leg, so an
   * unfinished or missing key pair cannot be deployed by accident. See the
   * comment beside `PUSH_NOTIFIER` in `wrangler.jsonc` for the two-line
   * change that turns it on.
   */
  PUSH_NOTIFIER: string;
  /**
   * base64url-encoded P-256 public key (the VAPID "application server key").
   * A var, not a secret: the browser's Push API requires this value to be
   * handed to `PushManager.subscribe()` client-side, so it ships to every
   * subscribing browser by design — there is nothing to protect by hiding it
   * server-side. Not present in `wrangler.jsonc` while `PUSH_NOTIFIER` is
   * `"null"` (see above); added alongside `VAPID_PRIVATE_KEY` when push
   * actually goes live.
   */
  VAPID_PUBLIC_KEY: string;
  /**
   * The `mailto:` address push services may contact about this application
   * server if it misbehaves (RFC 8292 §2). A var, not a secret. Same
   * deploy-dark rule as `VAPID_PUBLIC_KEY` above: absent from
   * `wrangler.jsonc` until `PUSH_NOTIFIER` is switched on.
   */
  VAPID_SUBJECT: string;
  /**
   * The VAPID signing key — the JWK `d` member, base64url, of the P-256
   * private key whose public half is `VAPID_PUBLIC_KEY`. Set with
   * `wrangler secret put VAPID_PRIVATE_KEY`; generated with
   * `scripts/generate-vapid-keys.mjs`, which prints the pair once and writes
   * nothing to disk.
   *
   * This is the one secret in this file that **cannot be rotated cheaply**,
   * unlike `RESPONSE_TOKEN_SECRET` or `CANCEL_TOKEN_SECRET` above, both of
   * which can be regenerated and simply invalidate some in-flight links.
   * The public half of a VAPID pair is baked into every device subscription
   * by the browser at the moment `PushManager.subscribe()` runs — a
   * subscription *is*, in part, a promise to that specific public key. Lose
   * or rotate the private key and every existing subscription becomes
   * permanently undeliverable (a 403 from the push service, forever); there
   * is no re-signing or re-issuing it from this side, at any price. Recovery
   * is: generate a new pair, delete every `push_subscriptions` row, and wait
   * for each player to open the app again and opt in by hand, on their own
   * phone. See `docs/runbooks/cloudflare.md` for the full procedure.
   */
  VAPID_PRIVATE_KEY: string;
}

/**
 * Hono's per-request generics for this app.
 *
 * `Variables` is what `sessionMiddleware` fills in; its shape and its
 * null-versus-undefined contract are documented on `AppVariables` in
 * `src/auth/session.ts`. The type-only import above is a deliberate cycle
 * between these two modules (`session.ts` imports `AppEnv` back) — it is
 * erased at compile time, so there is no runtime cycle, and it keeps the
 * session's type defined next to the middleware that produces it.
 */
export type AppEnv = { Bindings: Bindings; Variables: AppVariables };
