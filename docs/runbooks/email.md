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

Currently **50**. This is the account-wide daily send ceiling (TR-31),
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
2. **Wire `ResendNotifier` into the factory.** `src/notify/factory.ts`'s
   `selectNotifier` currently only recognises `"console"` and `"null"`;
   there is no `"resend"` case yet. Add one:
   ```ts
   case "resend":
     return new ResendNotifier(env.RESEND_API_KEY, env.EMAIL_FROM);
   ```
   and import `ResendNotifier`. Cover it with a test the same way the
   existing two cases are covered, and update the "expected `console`
   or `null`" wording in the error message.
3. **Change `wrangler.jsonc`'s `vars.NOTIFIER`** from `"console"` to
   `"resend"`. `EMAIL_FROM` is already set correctly and does not need
   to change.
4. Run the full suite (`npm test`, `npm run typecheck`, `npm run lint`),
   commit, push, and watch CI to completion as usual.
5. **Before the next hourly sweep fires for real**, do a manual smoke
   send if possible (e.g. a throwaway fixture/game with the owner as
   the only member) so the first real-recipient email isn't also the
   first-ever live test of the Resend path end to end.
6. Watch the next hourly sweep's `notification_log` rows and Workers
   Logs the same way the console dry run was watched — `status = 'sent'`
   with a real Resend `provider_message_id`, not a console placeholder.
7. Only after that succeeds, consider raising `min_players`/`max_players`
   on the live game away from the deliberately small values used for the
   first dry run.

No other code changes are required — `ConsoleNotifier`, `QuotaNotifier`,
the dedupe keys, and the sweep itself are provider-agnostic already.
