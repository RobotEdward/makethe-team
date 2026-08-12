import type { Db } from "../db/client.js";
import type { Bindings } from "../env.js";
import { ConsoleNotifier } from "./console-notifier.js";
import { NullNotifier } from "./null-notifier.js";
import type { Notifier } from "./notifier.js";
import { QuotaNotifier } from "./quota.js";
import { ResendNotifier } from "./resend-notifier.js";

/**
 * Selects a `Notifier` implementation from `env.NOTIFIER` and wraps it in
 * `QuotaNotifier` (TR-31, TR-32) so nothing downstream can bypass the daily
 * send ceiling — the wrapping happens here, once, rather than being left to
 * every caller to remember.
 *
 * An unrecognised value throws at startup rather than falling back to
 * anything — a typo in the binding (e.g. `wrangler.jsonc`'s `vars.NOTIFIER`)
 * would otherwise quietly disable all email, and the only way anyone would
 * find out is a player not getting a reminder.
 *
 * Every branch — including `"resend"` — returns through the same
 * `QuotaNotifier` wrap below. The daily ceiling is the project's only real
 * cost control, and the one provider that can actually spend money must not
 * be the one that bypasses it, so the wrap deliberately lives here, outside
 * `selectNotifier`, where no future branch can forget it.
 *
 * `now` is a parameter, not `new Date()`, so callers (and their tests) can
 * place the quota day anywhere in the calendar without touching the clock.
 *
 * `db` is taken as a parameter rather than built here with `getDb(env.DB)`:
 * `getDb` is not memoised, so constructing one internally would build a
 * *second* Drizzle wrapper around the same D1 binding inside every caller
 * that already holds one from its own request/invocation — exactly the
 * configuration `src/auth/factory.ts` documents as a Miniflare WAL-deadlock
 * hazard. Callers must pass the `db` they already have.
 */
export function createNotifier(env: Bindings, db: Db, now: Date): Notifier {
  const inner = selectNotifier(env);
  const maxPerDay = parseMaxEmailsPerDay(env.MAX_EMAILS_PER_DAY);
  return new QuotaNotifier(inner, db, maxPerDay, now);
}

function selectNotifier(env: Bindings): Notifier {
  switch (env.NOTIFIER) {
    case "console":
      return new ConsoleNotifier();
    case "null":
      return new NullNotifier();
    case "resend":
      return new ResendNotifier(
        requireBinding(env.RESEND_API_KEY, "RESEND_API_KEY", 'wrangler secret put RESEND_API_KEY'),
        requireBinding(env.EMAIL_FROM, "EMAIL_FROM", 'the "vars" block in wrangler.jsonc'),
      );
    default:
      throw new Error(
        `unrecognised NOTIFIER binding: ${JSON.stringify(env.NOTIFIER)} (expected "console", "null" or "resend")`,
      );
  }
}

/**
 * Reads a binding `ResendNotifier` cannot work without, failing loudly and
 * specifically when it is missing or blank.
 *
 * Both of these are declared non-optional in `Bindings`, but the type says
 * nothing about what Cloudflare actually injects at runtime: an unset secret
 * simply arrives as `undefined`, and a var can be set to `""`. Neither would
 * throw on its own — `ResendNotifier` would send `Authorization: Bearer
 * undefined`, or a `from` of `""`, and every message would come back as an
 * opaque provider rejection logged once per player per sweep. One named line
 * at construction time is the whole point: the failure is diagnosable from
 * the first log entry, and nothing is attempted, so no quota is consumed and
 * no `notification_log` row is written on a run that never had a chance.
 */
function requireBinding(value: string | undefined, name: string, howToSet: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `NOTIFIER is "resend" but ${name} is missing or empty — set it via ${howToSet}, or set NOTIFIER to "console" until it is ready`,
    );
  }
  return value;
}

/**
 * Parses `MAX_EMAILS_PER_DAY` (a `wrangler.jsonc` var, so always a string).
 *
 * Missing or unparseable fails *closed* to 0 — refusing every send for the
 * day — rather than falling back to "no limit". For a cost guard whose
 * entire purpose is capping a runaway sender, treating a broken config as
 * "unlimited" is the one failure mode that defeats the guard's own point;
 * treating it as "send nothing" is loud (every message comes back
 * `daily-ceiling-reached`, which is easy to notice and impossible to
 * mistake for a working system) and never costs money or reputation.
 */
export function parseMaxEmailsPerDay(raw: string | undefined): number {
  if (raw === undefined) {
    console.error("MAX_EMAILS_PER_DAY is not set; failing closed to a daily ceiling of 0");
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== raw.trim()) {
    console.error(
      `MAX_EMAILS_PER_DAY (${JSON.stringify(raw)}) is not a non-negative integer; failing closed to a daily ceiling of 0`,
    );
    return 0;
  }
  return parsed;
}
