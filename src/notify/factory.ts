import type { Db } from "../db/client.js";
import type { Bindings } from "../env.js";
import { CloudflareEmailNotifier } from "./cloudflare-notifier.js";
import { ConsoleNotifier } from "./console-notifier.js";
import { NullNotifier } from "./null-notifier.js";
import type { Notifier } from "./notifier.js";
import { PushNotifier } from "./push-notifier.js";
import { QuotaNotifier } from "./quota.js";
import { ResendNotifier } from "./resend-notifier.js";
import { SpilloverNotifier } from "./spillover-notifier.js";
import { RouterNotifier } from "./router-notifier.js";
import { assertVapidKeysMatch, importVapidKeys, type VapidKeys } from "./web-push.js";

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
 *
 * # M14: a `RouterNotifier` on top, not inside, the email path
 *
 * Since M14, this returns a `RouterNotifier` that splits every batch by
 * channel: email still goes through exactly the `QuotaNotifier`-wrapped path
 * described above, unchanged; push goes to a separate notifier chosen by
 * `PUSH_NOTIFIER` and never touches the daily ceiling. See
 * `router-notifier.ts`'s doc comment for why the router sits outside the
 * quota wrap rather than the quota wrap learning about channels — in short,
 * push costs nothing to send, the ceiling exists to cap spend, and leaving
 * `QuotaNotifier` untouched keeps its one-result-per-input-in-order property
 * trivially true because it still only ever sees a dense array of email.
 */
export function createNotifier(env: Bindings, db: Db, now: Date): Notifier {
  return new RouterNotifier(selectEmailLeg(env, db, now), selectPushNotifier(env, db, now));
}

/**
 * Builds the email leg: the primary provider under its own daily ceiling,
 * plus — when `EMAIL_SPILLOVER` asks for one — a second provider under a
 * separate ceiling, behind a `SpilloverNotifier` (M42).
 *
 * **Every provider is wrapped in its own `QuotaNotifier` here, and that is
 * the invariant this function exists to hold.** The daily ceiling is the
 * project's only real cost control, and Cloudflare Email Service bills at
 * $0.35/1,000 beyond its included 3,000 a month — so the spill leg is a
 * second sender that can spend money, and it must no more be able to bypass
 * the ceiling than Resend can. `SpilloverNotifier` is given already-wrapped
 * legs rather than raw providers so that no future leg can be added
 * unwrapped without changing this line.
 *
 * With `EMAIL_SPILLOVER: "none"` the result is a `SpilloverNotifier` around
 * a single leg, which behaves identically to the bare `QuotaNotifier` this
 * replaced: one leg means nothing to spill to, so a ceiling refusal is
 * returned unchanged.
 */
function selectEmailLeg(env: Bindings, db: Db, now: Date): Notifier {
  const primary = new QuotaNotifier(
    selectNotifier(env),
    db,
    parseMaxEmailsPerDay(env.MAX_EMAILS_PER_DAY),
    now,
    "resend",
  );

  switch (env.EMAIL_SPILLOVER) {
    // Absent as well as "none": `EMAIL_SPILLOVER` was added after the
    // binding set was already deployed, and an env that predates it (a
    // test harness, a preview) must keep working rather than throwing.
    // This is the one unrecognised-value tolerance in this module, and it
    // is safe for the same reason the others are not: the fallback is
    // "send exactly as before", which cannot cost money or lose mail.
    case undefined:
    case "":
    case "none":
      return new SpilloverNotifier([primary]);
    case "cloudflare":
      return new SpilloverNotifier([
        primary,
        new QuotaNotifier(
          new CloudflareEmailNotifier(
            requireBinding(
              env.CLOUDFLARE_ACCOUNT_ID,
              "CLOUDFLARE_ACCOUNT_ID",
              'the "vars" block in wrangler.jsonc',
              'EMAIL_SPILLOVER is "cloudflare"',
            ),
            requireBinding(
              env.CLOUDFLARE_EMAIL_API_TOKEN,
              "CLOUDFLARE_EMAIL_API_TOKEN",
              "wrangler secret put CLOUDFLARE_EMAIL_API_TOKEN",
              'EMAIL_SPILLOVER is "cloudflare"',
            ),
            requireBinding(
              env.EMAIL_FROM,
              "EMAIL_FROM",
              'the "vars" block in wrangler.jsonc',
              'EMAIL_SPILLOVER is "cloudflare"',
            ),
          ),
          db,
          parseMaxEmailsPerDay(env.MAX_EMAILS_PER_DAY_CLOUDFLARE, "MAX_EMAILS_PER_DAY_CLOUDFLARE"),
          now,
          "cloudflare",
        ),
      ]);
    default:
      throw new Error(
        `unrecognised EMAIL_SPILLOVER binding: ${JSON.stringify(env.EMAIL_SPILLOVER)} (expected "none" or "cloudflare")`,
      );
  }
}

/**
 * Selects the push leg from `env.PUSH_NOTIFIER`, independently of
 * `env.NOTIFIER` (see the binding's own doc comment in `src/env.ts` for why
 * the two switches are deliberately separate).
 *
 * An unrecognised value throws at startup, exactly as `selectNotifier` does
 * for `NOTIFIER` — a typo here must not quietly disable push the same way a
 * typo there must not quietly disable email.
 *
 * The `"webpush"` branch is the only one that reads a VAPID binding. `"null"`
 * and `"console"` never call `vapidKeys`, which is exactly what lets
 * `wrangler.jsonc` ship `PUSH_NOTIFIER: "null"` today with no `VAPID_*` vars
 * present at all — an unfinished or missing key pair cannot be deployed by
 * accident, because nothing on the `"null"` path ever asks for one.
 */
function selectPushNotifier(env: Bindings, db: Db, now: Date): Notifier {
  switch (env.PUSH_NOTIFIER) {
    case "console":
      return new ConsoleNotifier();
    case "null":
      return new NullNotifier();
    case "webpush":
      // `PushNotifier` accepts `VapidKeys | Promise<VapidKeys>` for exactly
      // this call: importing a key is inherently async (Web Crypto has no
      // synchronous `importKey`), but `createNotifier` must stay synchronous
      // for every one of its existing callers, so the promise is handed
      // straight in rather than awaited here. `PushNotifier` itself resolves
      // it per message, inside the same `try`/`catch` that already turns
      // every other push failure into an ordinary `SendResult` — see its
      // doc comment for why a rejected import must never be allowed to
      // reject `send` and take an unrelated leg (e.g. email, running
      // alongside this one in `RouterNotifier`'s `Promise.all`) down with
      // it. Every binding-presence check inside `vapidKeys` below still
      // runs — and can still throw — synchronously, right here, at
      // construction time, the same as `selectNotifier`'s `requireBinding`
      // calls do for `"resend"`.
      return new PushNotifier(db, vapidKeys(env), fetch, now);
    default:
      throw new Error(
        `unrecognised PUSH_NOTIFIER binding: ${JSON.stringify(env.PUSH_NOTIFIER)} (expected "webpush", "console" or "null")`,
      );
  }
}

/**
 * The imported, verified VAPID keypair, memoised per isolate (spec §10.3):
 * `importVapidKeys` and `assertVapidKeysMatch` — an async JWK import plus a
 * sign-then-verify round trip — run once per isolate, the first time a
 * `"webpush"` request builds a notifier, not once per request. Every
 * binding-presence check below still runs on every call, synchronously, so a
 * rotated-but-incomplete VAPID config fails immediately rather than only on
 * whichever request happens to be first after a deploy.
 *
 * `requireBinding` applies the same by-name failure `RESEND_API_KEY` and
 * `EMAIL_FROM` already get above, for the same reason: an unset secret
 * arrives as `undefined` at runtime regardless of `Bindings`' non-optional
 * types, and signing every push JWT with `undefined` would fail opaquely at
 * every subscribed device instead of loudly, once, by name, here.
 *
 * The cache is keyed on the three raw binding values, not just "has anything
 * been cached yet": production never rotates a `wrangler secret put` mid
 * isolate-lifetime, so in practice this is exactly the module-level memo the
 * doc above describes, but keying it this way costs nothing and means a test
 * suite that builds two different `Bindings` in the same module (this file's
 * own tests, for instance) gets the keys that actually match what it passed,
 * not whatever the first caller happened to import.
 *
 * A failed import or a mismatched pair is cached too, deliberately, and
 * stays cached: both are deterministic configuration errors, not transient
 * ones — the same two bindings will fail the same way on every subsequent
 * call for as long as they're set to the same values, so nothing is gained
 * by re-attempting, and every caller of `vapidKeys` already treats the
 * rejection as an ordinary failure rather than something to retry (see
 * `PushNotifier.sendOne`). Do not "fix" this into re-importing on every
 * call in the name of retrying a transient failure — there is no transient
 * failure here to retry.
 *
 * The returned promise is deliberately given a second, no-op `.catch` right
 * here, in addition to being returned for real handling by its actual
 * caller. Most requests build a notifier and never send a push in that
 * request; if `PUSH_NOTIFIER` is `"webpush"` with a broken pair, the
 * rejection would otherwise be entirely unhandled — no `.then`/`.catch`
 * attached to it anywhere — until (if ever) some other request's
 * `PushNotifier.sendOne` awaits the same cached promise, which is exactly
 * the "unhandled promise rejection on any request that never sends a push"
 * failure mode this comment exists to prevent. The no-op catch only marks
 * the promise handled for that bookkeeping; it does not change what
 * `vapidKeys` returns, and `PushNotifier` still observes the rejection when
 * it awaits the same promise later.
 */
let cachedVapidKeys: { publicKey: string; privateKey: string; subject: string; keys: Promise<VapidKeys> } | undefined;

/**
 * Exported since the account page's per-device Test button: `POST
 * PUSH_TEST_PATH` (`src/routes/push.ts`) sends to a single named endpoint
 * via `sendTestPush`, outside the notifier fan-out, and needs the same
 * memoised, verified pair rather than importing its own. Call only when
 * `env.PUSH_NOTIFIER` is `"webpush"` — the binding-presence checks below
 * throw, by design, on a deployment that has no pair to check.
 */
export function vapidKeys(env: Bindings): Promise<VapidKeys> {
  const publicKey = requireBinding(
    env.VAPID_PUBLIC_KEY,
    "VAPID_PUBLIC_KEY",
    'the "vars" block in wrangler.jsonc',
    'PUSH_NOTIFIER is "webpush"',
  );
  const privateKey = requireBinding(
    env.VAPID_PRIVATE_KEY,
    "VAPID_PRIVATE_KEY",
    "wrangler secret put VAPID_PRIVATE_KEY",
    'PUSH_NOTIFIER is "webpush"',
  );
  const subject = requireBinding(
    env.VAPID_SUBJECT,
    "VAPID_SUBJECT",
    'the "vars" block in wrangler.jsonc',
    'PUSH_NOTIFIER is "webpush"',
  );

  if (
    !cachedVapidKeys ||
    cachedVapidKeys.publicKey !== publicKey ||
    cachedVapidKeys.privateKey !== privateKey ||
    cachedVapidKeys.subject !== subject
  ) {
    const keys = importVapidKeys(publicKey, privateKey, subject).then(async (imported) => {
      await assertVapidKeysMatch(imported);
      return imported;
    });
    keys.catch(() => {
      // Deliberately swallowed — see the doc comment above. This exists
      // only to mark the promise handled; the real handling happens in
      // whichever `PushNotifier.sendOne` call eventually awaits `keys`
      // (returned below, untouched) and reports the rejection as a failed
      // `SendResult`.
    });
    cachedVapidKeys = { publicKey, privateKey, subject, keys };
  }
  return cachedVapidKeys.keys;
}

function selectNotifier(env: Bindings): Notifier {
  switch (env.NOTIFIER) {
    case "console":
      return new ConsoleNotifier();
    case "null":
      return new NullNotifier();
    case "resend":
      return new ResendNotifier(
        requireBinding(env.RESEND_API_KEY, "RESEND_API_KEY", 'wrangler secret put RESEND_API_KEY', 'NOTIFIER is "resend"'),
        requireBinding(env.EMAIL_FROM, "EMAIL_FROM", 'the "vars" block in wrangler.jsonc', 'NOTIFIER is "resend"'),
      );
    default:
      throw new Error(
        `unrecognised NOTIFIER binding: ${JSON.stringify(env.NOTIFIER)} (expected "console", "null" or "resend")`,
      );
  }
}

/**
 * Reads a binding a provider cannot work without, failing loudly and
 * specifically when it is missing or blank.
 *
 * Every caller's bindings are declared non-optional in `Bindings`, but the
 * type says nothing about what Cloudflare actually injects at runtime: an
 * unset secret simply arrives as `undefined`, and a var can be set to `""`.
 * Neither would throw on its own — `ResendNotifier` would send
 * `Authorization: Bearer undefined`; the VAPID path would sign every push
 * JWT with `undefined` — and every message would come back as an opaque
 * provider rejection logged once per player per sweep. One named line at
 * construction time is the whole point: the failure is diagnosable from the
 * first log entry, and nothing is attempted, so no quota is consumed (email)
 * and no device is signed to (push) on a run that never had a chance.
 *
 * `context` names the switch and value that put the caller on this path
 * (e.g. `NOTIFIER is "resend"`, `PUSH_NOTIFIER is "webpush"`), so the same
 * function serves every provider without the message hardcoding one of them.
 */
function requireBinding(value: string | undefined, name: string, howToSet: string, context: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${context} but ${name} is missing or empty — set it via ${howToSet}, or switch away from this mode until it is ready`,
    );
  }
  return value;
}

/**
 * The whole day's email capacity across every configured provider (M42) —
 * what the admin pages mean by "ceiling" and what `handleScheduled` checks
 * for zero.
 *
 * Mirrors `selectEmailLeg`'s switch deliberately rather than asking a built
 * notifier for its own total: the pages that show this number run on
 * requests that never construct a notifier, and giving `Notifier` a
 * capacity method would put a reporting concern into the one interface the
 * whole product sends through. The cost is that a new leg must be added in
 * both places; the test in `test/notify/factory.test.ts` pins them together.
 *
 * An unrecognised `EMAIL_SPILLOVER` reports the primary's ceiling alone.
 * `selectEmailLeg` throws on that value, so no send is ever attempted under
 * it — this function only has to avoid inventing capacity that does not
 * exist.
 */
export function emailCeilingTotal(env: Bindings): number {
  const primary = parseMaxEmailsPerDay(env.MAX_EMAILS_PER_DAY);
  if (env.EMAIL_SPILLOVER !== "cloudflare") return primary;
  return primary + parseMaxEmailsPerDay(env.MAX_EMAILS_PER_DAY_CLOUDFLARE, "MAX_EMAILS_PER_DAY_CLOUDFLARE");
}

/**
 * Parses a daily email ceiling var (a `wrangler.jsonc` var, so always a
 * string). `name` appears in the failure lines so the Cloudflare leg's
 * ceiling (M42) reports against its own binding rather than Resend's.
 *
 * Missing or unparseable fails *closed* to 0 — refusing every send for the
 * day — rather than falling back to "no limit". For a cost guard whose
 * entire purpose is capping a runaway sender, treating a broken config as
 * "unlimited" is the one failure mode that defeats the guard's own point;
 * treating it as "send nothing" is loud (every message comes back
 * `daily-ceiling-reached`, which is easy to notice and impossible to
 * mistake for a working system) and never costs money or reputation.
 */
export function parseMaxEmailsPerDay(raw: string | undefined, name = "MAX_EMAILS_PER_DAY"): number {
  if (raw === undefined) {
    console.error(`${name} is not set; failing closed to a daily ceiling of 0`);
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== raw.trim()) {
    console.error(
      `${name} (${JSON.stringify(raw)}) is not a non-negative integer; failing closed to a daily ceiling of 0`,
    );
    return 0;
  }
  return parsed;
}
