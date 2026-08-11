import { getDb } from "../db/client.js";
import type { Bindings } from "../env.js";
import { ConsoleNotifier } from "./console-notifier.js";
import { NullNotifier } from "./null-notifier.js";
import type { Notifier } from "./notifier.js";
import { QuotaNotifier } from "./quota.js";

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
 * `now` is a parameter, not `new Date()`, so callers (and their tests) can
 * place the quota day anywhere in the calendar without touching the clock.
 */
export function createNotifier(env: Bindings, now: Date): Notifier {
  const inner = selectNotifier(env);
  const maxPerDay = parseMaxEmailsPerDay(env.MAX_EMAILS_PER_DAY);
  return new QuotaNotifier(inner, getDb(env.DB), maxPerDay, now);
}

function selectNotifier(env: Bindings): Notifier {
  switch (env.NOTIFIER) {
    case "console":
      return new ConsoleNotifier();
    case "null":
      return new NullNotifier();
    default:
      throw new Error(
        `unrecognised NOTIFIER binding: ${JSON.stringify(env.NOTIFIER)} (expected "console" or "null")`,
      );
  }
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
