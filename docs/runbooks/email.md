# Email: rotation, quota, and the console → Resend switch

## Rotating `RESEND_API_KEY`

The key is a Worker secret, not a `vars` entry, so it never appears in
`wrangler.jsonc` or in git history.

1. Generate a new API key in the Resend dashboard (Settings → API Keys). Do
   not revoke the old one yet.
2. Upload the new key without ever printing it to a terminal or a file:
   ```bash
   set -a; . ~/.config/makethe-team/deploy.env; set +a
   echo -n "$RESEND_API_KEY" | npx wrangler secret put RESEND_API_KEY
   ```
   (Update the value in `~/.config/makethe-team/deploy.env` first so this
   picks up the new key — that file is outside the repo and mode 600.)
3. Confirm it took:
   ```bash
   npx wrangler secret list
   ```
   This only lists secret *names*; it never echoes the value.
4. Revoke the old key in the Resend dashboard once you've confirmed a
   real send still works (or, while `NOTIFIER` is `"console"`, once the
   deploy is green — nothing reads the key at all in that mode).

`RESPONSE_TOKEN_SECRET` is a separate secret (HMAC key for `/r/:token`
links) and is not affected by this rotation.

## `MAX_EMAILS_PER_DAY`

Currently **95** (50 → 80 → 95; raised in M42 to sit just under Resend's free
tier's hard 100/day). This is the Resend leg's daily send ceiling (TR-31),
enforced by `QuotaNotifier` regardless of which `Notifier` it wraps —
it applies to `console` and `null` too, just against a limit that never
matters because nothing at those two is "real" delivery.

50 was chosen as a conservative cap for the first real game (six
players, minimal traffic) with headroom for the owner exercising the
product live without a runaway bug being able to run up a real email
bill or burn deliverability reputation before anyone notices.
Cloudflare has no account-level spend cap of its own, so this value is
the only ceiling that exists — see `src/notify/quota.ts`. Raise it
deliberately as the player count grows; there is no owner-facing UI for
it yet (planned for M4), so a change means editing `wrangler.jsonc`'s
`vars.MAX_EMAILS_PER_DAY` and redeploying.

Since M42 this is no longer the whole ceiling. A second provider can pick up
what this one refuses, under its own separate counter — see
`docs/runbooks/email-cloudflare-spillover.md`. The total the admin pages report
is `emailCeilingTotal` in `src/notify/factory.ts`, not this var alone.

## Reading `notification_log`

One row per attempted notification, keyed by a unique `dedupe_key`
(the entire idempotency guarantee — see `src/notify/dedupe-key.ts`).

```sql
SELECT notification_type, status, provider_message_id, error, sent_at
FROM notification_log
WHERE fixture_id = '<fixture-id>'
ORDER BY created_at;
```

- **`status = 'sent'`** — delivered to the wrapped notifier successfully.
  `provider_message_id` mirrors whatever the wrapped notifier reports:
  `ConsoleNotifier` always reports `null` (it never calls a real
  provider), while `ResendNotifier` reports the Resend message id.
  `sent_at` is set either way.
- **`status = 'failed'`, `error` set** — the wrapped notifier tried and
  the provider (or network) rejected it. Distinguish two families by
  reading `error`:
  - `error = 'daily-ceiling-reached'` — refused by `QuotaNotifier`
    before it ever reached the wrapped notifier, because
    `MAX_EMAILS_PER_DAY` was hit for the UTC day. **This is the
    "deferred" case**: the sweep does not write a `notification_log`
    row for it at all — it deletes the `queued` placeholder row instead
    so the next hourly run retries the send from scratch. If you need to
    know whether deferrals are happening right now, grep Workers Logs for
    `DAILY EMAIL CEILING REACHED` rather than querying this table.
  - `error = 'no-recipient'` — the player is a guest with no email
    (BR-32/TR-32); never sent, never retried, and never a Resend
    quota consumer.
  - Any other `error` string is a real provider/network failure (HTTP
    non-2xx, malformed body, request exception). These rows are
    permanent — the sweep does not currently retry a `failed` send.
- There is no `queued`-and-still-`queued` steady state: a `queued` row
  only exists transiently mid-sweep. If you see one at rest, either the
  sweep crashed mid-flight (check Workers Logs around `sent_at IS
  NULL`'s `created_at`) or a deferral is about to roll it back to
  nothing on the next run.

Useful summary query:

```sql
SELECT status, count(*) FROM notification_log GROUP BY status;
```

## Switching `NOTIFIER` from `console` to `resend`

Everything up to this point (config, secret, quota, template, sweep
wiring) is already in place. What remains, in order:

1. **Confirm the Resend sending domain has finished verifying** in the
   Resend dashboard (SPF/DKIM/DMARC all green). Sending through an
   unverified domain either fails outright or lands in spam — do not
   proceed on the strength of "it looks verified."
2. **Nothing to wire.** `src/notify/factory.ts` recognises `"resend"` and
   constructs `ResendNotifier` from `RESEND_API_KEY` and `EMAIL_FROM`,
   still wrapped in `QuotaNotifier` so the daily ceiling applies to real
   sends exactly as it does to console ones. Every factory branch,
   including this one and both missing-binding failures, is covered in
   `test/notify/notifier.test.ts`. (Earlier versions of this runbook
   asked you to add the case by hand — it is already there.)
3. **Change `wrangler.jsonc`'s `vars.NOTIFIER`** from `"console"` to
   `"resend"`. `EMAIL_FROM` is already set correctly and does not need
   to change. If `RESEND_API_KEY` is not set (or is blank) at that
   point, every invocation fails immediately with a single log line
   naming the binding — that is deliberate, and it is the fastest way to
   tell this misconfiguration from a provider problem.
4. Run the full suite (`npm test`, `npm run typecheck`, `npm run lint`),
   commit, push, and watch CI to completion as usual.
5. **Before the next sweep fires for real**, do a manual smoke
   send if possible (e.g. a throwaway fixture/game with the owner as
   the only member) so the first real-recipient email isn't also the
   first-ever live test of the Resend path end to end.
6. Watch the next sweep's `notification_log` rows and Workers
   Logs the same way the console dry run was watched — `status = 'sent'`
   with a real Resend `provider_message_id`, not a console placeholder.
7. Only after that succeeds, consider raising `min_players`/`max_players`
   on the live game away from the deliberately small values used for the
   first dry run.

No other code changes are required — `ConsoleNotifier`, `QuotaNotifier`,
the dedupe keys, and the sweep itself are provider-agnostic already.

## Sweep cadence: hourly

The sweep runs **hourly** (`0 * * * *`), the intended production cadence.
It ran every 5 minutes through the M4/M5 testing phase so the owner could
exercise the reminder pipeline against real data without waiting up to an
hour per cycle; that was reverted on 12 August 2026.

The cadence is set in two places that must stay in sync —
`wrangler.jsonc`'s `triggers.crons` entry and the `CRON_SWEEP` constant in
`src/cron/handler.ts`. `handleScheduled` throws on any cron string it does
not recognise, so editing one without the other breaks every invocation
rather than silently reverting the cadence. Every test refers to the
constant rather than the literal, so changing both is sufficient.

One consequence worth remembering if the cadence is ever shortened again:
a ceiling-deferred notification writes an `audit_log` row on every retry,
collapsed to one row per hour per fixture (`src/notify/ceiling-audit.ts`).
That window was chosen against the 5-minute cadence, where it was the
difference between ~288 rows a day and 24.

**To revert to hourly:** change both back to `"0 * * * *"`, run the
full verification suite, deploy, and confirm via the Cloudflare API
(as in the deploy runbook) that only `"0 * * * *"` and `"15 3 * * *"`
are registered.

**Fastest way to re-run a reminder test without waiting for a new
fixture:** delete that fixture's `n1` rows from `notification_log`:

```sql
DELETE FROM notification_log
WHERE fixture_id = '<fixture-id>' AND notification_type = 'n1';
```

The next sweep will treat those reminders as never sent and send them
again. This is safe, not a workaround — `notification_log` *is* the
idempotency record (its unique `dedupe_key` is what makes concurrent
and repeated sweeps safe in the first place, see above), so removing a
row is simply a deliberate "send this again" instruction, exactly like
any other row never having existed. It does not affect the fixture's
lifecycle, responses, or capacity in any way.
