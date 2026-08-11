import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { Bindings } from "../env.js";
import type { Db } from "../db/client.js";

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
export function createAuth(env: Bindings, db: Db) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite" }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
  });
}
