import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { magicLink } from "better-auth/plugins";
import type { Bindings } from "../env.js";
import type { Db } from "../db/client.js";
import { createNotifier } from "../notify/factory.js";
import type { Notifier } from "../notify/notifier.js";
import { renderMagicLinkEmail } from "../notify/templates/magic-link.js";
import { isSignInPermitted, recordSignInRefusal } from "./sign-in-gate.js";

/**
 * How long a sign-in link stays usable. One constant, used both to configure
 * the plugin and to word the email, so the two can never disagree about it.
 */
const MAGIC_LINK_EXPIRY_MINUTES: number = 5;

/**
 * Builds a Better Auth instance for a single request.
 *
 * TR-1: this must be constructed per request, never cached at module level.
 * D1 bindings do not exist at module scope in a Cloudflare Worker, so a
 * module-level singleton would capture a stale/undefined binding depending
 * on bundler behaviour — a failure mode that is hard to diagnose. Call this
 * once per request instead (e.g. from middleware).
 *
 * `db` must be the same `getDb(env.DB)` instance the rest of the request
 * uses (see `src/db/client.ts`) — passed in, never constructed here. Two
 * separate `drizzle(env.DB, ...)` wrappers around the same D1 binding have
 * been observed to deadlock under Miniflare: D1's SQLite WAL blocks a writer
 * against a concurrent reader from the *other* wrapper (e.g. a magic-link
 * verification writing a session while request middleware reads one) for
 * 30+ seconds. A single shared Drizzle instance avoids the cross-wrapper
 * contention entirely, which is also what TR-1's per-request-factory rule
 * naturally pushes toward.
 *
 * Deliberately does not configure `emailAndPassword` (TR-16: no password
 * field anywhere in the codebase). The `account` table in
 * `src/db/schema.ts` therefore has no `password` column — verified safe
 * because every code path in Better Auth's core that reads or writes
 * `account.password` (`/sign-in/email`, `/sign-up/email`,
 * `/request-password-reset`, `/reset-password`, `/change-password`) is
 * gated on `options.emailAndPassword?.enabled` /
 * `options.emailAndPassword?.sendResetPassword` being configured. Since
 * this factory never sets `emailAndPassword`, those routes reject before
 * touching the adapter. If a later change ever configures it, the adapter
 * will throw `BetterAuthError` ("field does not exist") immediately rather
 * than silently succeeding against a column that isn't there.
 */
export function createAuth(env: Bindings, db: Db, now: Date, notifier?: Notifier) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite" }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_EXPIRY_MINUTES * 60,
        sendMagicLink: async ({ email, url }) => {
          // ---- TR-35: the trial sign-in gate, widened in M16 to a union of
          // the secret, the admin-managed table and standing invitees — see
          // `isSignInPermitted` in `sign-in-gate.ts`. Delete this one `if`
          // when the product opens to the public. Nothing else changes. ----
          if (!(await isSignInPermitted(db, env.SIGNIN_ALLOWLIST, email))) {
            // For the admin sign-in doctor (M17). Never throws — a failure
            // here surfacing as a 500 would answer refused addresses
            // differently from permitted ones.
            await recordSignInRefusal(db, email, now);
            return;
          }

          // Not addressable here: an unbounded-length `email` (Better Auth's
          // `z.email()` body schema does not cap local-part length) is
          // written to the `verification` table *before* this callback runs
          // at all, refused or not. Rejecting long addresses in this gate
          // would not stop that write, and adding a pre-validation step of
          // our own would need to answer with the exact same 200 on both
          // branches (§ the whole point of this gate) or reopen the oracle it
          // closes. Left as a recorded storage-amplification footnote rather
          // than a fix; see task-3-report.md.
          await sendSignInLink(env, db, email, url, now, notifier);
        },
      }),
      passkey({
        // The name the operating system's own passkey prompt shows. The
        // hostname is what the plugin would fall back to, and "makethe.team"
        // is not what a player is being asked to trust.
        rpName: RELYING_PARTY_NAME,
        // Pinned to this deployment rather than left to the plugin's default
        // (`options.origin || ctx.headers.get("origin")`). This is *not* what
        // stops a hostile `Origin` header — Better Auth's own trusted-origin
        // check refuses that earlier and unconditionally, with a flat 403
        // (`INVALID_ORIGIN`, or `MISSING_OR_NULL_ORIGIN` if it is absent),
        // before this plugin is ever reached; verified by execution in
        // `test/auth/passkey.test.ts`. What this pin actually defends against
        // is a request whose `Origin` header is completely genuine (this
        // deployment's own) but whose WebAuthn assertion was *signed* for a
        // different site — the header and the signed `clientDataJSON.origin`
        // are two independent claims, and only this line, not the header
        // check, is what compares the second one. It is real defence in
        // depth rather than a redundant restatement: it is the only thing
        // standing if `trustedOrigins` is ever widened, or a future Better
        // Auth upgrade relaxes that earlier check. `rpID` is deliberately
        // *not* set: the plugin derives it from `baseURL`'s hostname, which
        // is the same single source of truth this line uses.
        origin: new URL(env.BETTER_AUTH_URL).origin,
        registration: {
          // The default, restated because it is a security decision and not
          // an implementation detail: a passkey can only ever be added to an
          // identity that is *already* signed in (by magic link). There is
          // deliberately no passkey-first registration path — one would make
          // a lost authenticator into a lost account, and it is the reason
          // `registration.resolveUser` is not configured either.
          requireSession: true,
        },
      }),
    ],
  });
}

/** How this deployment introduces itself to an authenticator (see `passkey`). */
const RELYING_PARTY_NAME: string = "Make The Team";

/**
 * Hands the rendered sign-in link to the project's own `Notifier` (N-5).
 *
 * Deliberately routed through `createNotifier` rather than a transport of
 * Better Auth's own: that is where `QuotaNotifier` applies the daily ceiling
 * — a magic-link endpoint is the one place on the site an anonymous stranger
 * can cause an email to be sent, so it is the last thing that should be able
 * to bypass the cost cap — and where `NullNotifier` guarantees that no
 * non-production environment can reach a real inbox. Built lazily, inside the
 * send, so a request that issues no link never constructs one (and never
 * trips `createNotifier`'s by-name failure for a half-configured provider).
 *
 * `db` is `createAuth`'s own handle, passed straight through to
 * `createNotifier` rather than left for it to build with `getDb(env.DB)`.
 * `getDb` is not memoised, so letting `createNotifier` call it internally
 * would open a *second* Drizzle wrapper around the same D1 binding inside a
 * request that already has one — precisely the configuration the doc comment
 * on `createAuth` above warns about. Threading the existing handle through
 * keeps this file honest about the invariant it documents.
 *
 * Nothing is written to `notification_log`, on purpose (§2.8's dedupe table):
 * Better Auth owns issuance and rate limiting for this message, and a sign-in
 * link is not a fixture notification — there is no fixture, no player and no
 * once-per-thing key for it to be idempotent against. `dedupeKey` is a fresh
 * UUID because `Message` requires one and providers use it as an idempotency
 * key: each issuance is a genuinely distinct message, and the alternative —
 * keying on the link's token — would write a live credential into
 * `ConsoleNotifier`'s log line and the provider's dashboard.
 *
 * **Every failure here is swallowed** (logged, never thrown). This function
 * runs only on the allowlisted branch, so a thrown error would turn into a
 * 500 for allowlisted addresses while non-allowlisted ones still got the
 * clean 200 — reintroducing exactly the enumeration oracle the gate exists to
 * prevent, on the day the notifier happened to be misconfigured. The log line
 * carries the reason and never the address.
 */
async function sendSignInLink(
  env: Bindings,
  db: Db,
  email: string,
  url: string,
  now: Date,
  override: Notifier | undefined,
): Promise<void> {
  try {
    const { subject, html, text } = renderMagicLinkEmail({
      signInUrl: url,
      expiresInLabel: `${MAGIC_LINK_EXPIRY_MINUTES} minute${MAGIC_LINK_EXPIRY_MINUTES === 1 ? "" : "s"}`,
    });
    const notifier = override ?? createNotifier(env, db, now);
    const [result] = await notifier.send([
      { channel: "email", to: email, subject, html, text, dedupeKey: `n5:${crypto.randomUUID()}` },
    ]);
    if (result && !result.ok) {
      console.error(`sign-in link not delivered: ${result.error}`);
    }
  } catch (error) {
    console.error(
      `sign-in link failed to send: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}