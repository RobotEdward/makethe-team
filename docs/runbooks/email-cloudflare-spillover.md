# Cloudflare Email Service: the spill-over leg (M42)

Turning on the second email provider. Code shipped 29 August 2026 and is live
behind `EMAIL_SPILLOVER: "none"`; everything below is configuration.

See `docs/runbooks/email.md` for Resend, `notification_log`, and quota reading.

## Target end state

### DNS on `makethe.team`

Cloudflare's onboarding creates the four `cf-bounce` records itself because the
zone is on Cloudflare. Verify, do not hand-write them.

| Type | Name | Value | Owner | Today |
|---|---|---|---|---|
| MX | `cf-bounce.makethe.team` | `route1.mx.cloudflare.net` (+`route2`, `route3`) | Cloudflare | absent |
| TXT | `cf-bounce.makethe.team` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | Cloudflare | absent |
| TXT | `cf-bounce._domainkey.makethe.team` | DKIM public key, issued at onboarding | Cloudflare | absent |
| TXT | `send.makethe.team` | `v=spf1 include:amazonses.com ~all` | Resend | **present, leave alone** |
| MX | `send.makethe.team` | `10 feedback-smtp.eu-west-1.amazonses.com` | Resend | **present, leave alone** |
| TXT | `resend._domainkey.makethe.team` | `p=MIGfMA0GCSqG…` | Resend | **present, leave alone** |
| TXT | `_dmarc.makethe.team` | `v=DMARC1; p=reject; rua=mailto:<your-inbox>` | **shared** | `p=reject`, no `rua` |

The two senders do not collide. Each uses its own return-path subdomain, so
each has its own SPF, and each DKIM-signs under its own selector.

`_dmarc` is the one shared record. Cloudflare's onboarding created it at
`p=reject` on 29 August 2026.

An earlier version of this runbook said to start at `p=none` and tighten later.
That was over-cautious and is withdrawn: `p=reject` was verified against a real
Resend delivery and does not affect it. Resend signs `d=makethe.team`, an exact
match for the From domain, so DKIM aligns; and `send.makethe.team`'s
organisational domain is `makethe.team`, so SPF aligns under relaxed matching
too. The record sets neither `aspf` nor `adkim`, so relaxed is what applies.
Cloudflare's leg aligns the same way, via `cf-bounce.makethe.team`.

What the record is missing is `rua=`. Without it there are no aggregate
reports, so a misaligned sender is *silently rejected* with nothing to tell you
— which is the failure mode `p=reject` makes worse than a weaker policy would.
Add a reporting address before enabling the spill leg.

### Cloudflare dashboard

| Item | Target |
|---|---|
| Email Sending | enabled, Workers Paid plan |
| Onboarded domain | `makethe.team`, all DNS checks green |
| Account ID | `ddf9dbf3081e8206ea763519dceb2c56` |
| API token | scoped to **Email Sending: Edit**, account-level, nothing else |
| Daily send limit | reputation ramp — read the actual figure, do not assume |

### Worker configuration

| Binding | Where | Target value |
|---|---|---|
| `EMAIL_SPILLOVER` | `wrangler.jsonc` vars | `"cloudflare"` |
| `CLOUDFLARE_ACCOUNT_ID` | `wrangler.jsonc` vars | `"ddf9dbf3081e8206ea763519dceb2c56"` |
| `MAX_EMAILS_PER_DAY_CLOUDFLARE` | `wrangler.jsonc` vars | `"100"` (already set) |
| `MAX_EMAILS_PER_DAY` | `wrangler.jsonc` vars | `"95"` (already set) |
| `EMAIL_FROM` | `wrangler.jsonc` vars | unchanged, shared by both legs |
| `CLOUDFLARE_EMAIL_API_TOKEN` | Worker secret | the token above |

Resulting ceiling: 195/day. Today it is 95.

## Runbook

### 1. Onboard the domain

1. Dashboard → **Compute → Email Service → Email Sending**. Confirm the
   account is on Workers Paid.
2. **Onboard Domain** → `makethe.team` → confirm.
3. **Settings → DNS records**. Wait for all four `cf-bounce` checks green.
4. Confirm the Resend records are untouched:
   ```bash
   dig +short TXT send.makethe.team @1.1.1.1
   dig +short TXT resend._domainkey.makethe.team @1.1.1.1
   ```
   Expect the SES include and the `p=MIGf…` key. If either is gone, stop and
   restore before doing anything else — Resend is the live sender.
5. Add `rua=mailto:<your-inbox>` to `_dmarc.makethe.team`, keeping `p=reject`.
   If the record is not editable under **DNS → Records** it is a managed
   record: edit it under **Email Security → DMARC Management**, or wherever the
   onboarding flow that created it exposes it, rather than adding a second
   `_dmarc` TXT — two DMARC records on one name is a config error, and
   resolvers treat it as no policy at all.
6. Record the account's current **daily send limit** from the dashboard.

### 2. Create the token

1. **My Profile → API Tokens → Create Token → Custom token**.
2. Permission: **Account → Email Sending → Edit**. Nothing else.
3. Account resources: this account only.
4. Copy the token straight into the deploy env file, do not paste it into a
   terminal:
   ```bash
   $EDITOR ~/.config/makethe-team/deploy.env   # add CLOUDFLARE_EMAIL_API_TOKEN=…
   ```

### 3. Smoke test before touching the Worker

Send one email by hand, from the exact `EMAIL_FROM` string the Worker uses.

1. ```bash
   set -a; . ~/.config/makethe-team/deploy.env; set +a
   curl -s "https://api.cloudflare.com/client/v4/accounts/ddf9dbf3081e8206ea763519dceb2c56/email/sending/send" \
     -H "Authorization: Bearer $CLOUDFLARE_EMAIL_API_TOKEN" \
     -H "Content-Type: application/json" \
     --data '{"to":"<your-address>","from":"Make The Team <no-reply@makethe.team>","subject":"M42 spill-over smoke test","html":"<p>ok</p>","text":"ok"}'
   ```
2. Expect `"success": true` and your address in `result.delivered` or
   `result.queued`.
3. **If it rejects the `from`**, Cloudflare wants a bare address where Resend
   accepts a display name. That is a code change, not a config one —
   `CloudflareEmailNotifier` passes `EMAIL_FROM` through verbatim. Stop and
   report it; do not work around it by changing `EMAIL_FROM`, which the Resend
   leg also uses.
4. Check the message actually arrived, and check its headers: `SPF=pass`,
   `DKIM=pass`, `dmarc=pass`. Check the spam folder too — arriving in spam is a
   failure here, not a pass.

### 4. Switch it on

1. In `wrangler.jsonc` `vars`: set `EMAIL_SPILLOVER` to `"cloudflare"` and add
   `"CLOUDFLARE_ACCOUNT_ID": "ddf9dbf3081e8206ea763519dceb2c56"`.
2. Push the secret:
   ```bash
   set -a; . ~/.config/makethe-team/deploy.env; set +a
   echo -n "$CLOUDFLARE_EMAIL_API_TOKEN" | npx wrangler secret put CLOUDFLARE_EMAIL_API_TOKEN
   npx wrangler secret list
   ```
   The secret must land **before** the deploy. `EMAIL_SPILLOVER: "cloudflare"`
   with no token throws on every invocation, by design.
3. `npm test && npm run lint && npx tsc --noEmit`
4. Commit, push, watch CI to green.
5. Confirm the ceiling moved — admin usage page should read `of 195`.

### 5. Verify the leg actually sends

The spill leg only runs once the Resend ceiling is exhausted, so it will not
exercise itself on a normal day.

1. Force it: fill today's Resend counter, then trigger any real send.
   ```bash
   source .cf-token && npx wrangler d1 execute makethe-team --remote --command \
     "INSERT INTO email_quota (day, provider, sent_count) VALUES (date('now'), 'resend', 95) \
      ON CONFLICT(day, provider) DO UPDATE SET sent_count = 95;"
   ```
2. Trigger a send you can account for — a broadcast to a game where you are the
   only member is the cleanest.
3. Confirm the Cloudflare counter moved:
   ```bash
   source .cf-token && npx wrangler d1 execute makethe-team --remote --command \
     "SELECT day, provider, sent_count FROM email_quota WHERE day = date('now');"
   ```
   Expect a `cloudflare` row.
4. Confirm the mail arrived, and that `notification_log` shows `status='sent'`
   with a `NULL` `provider_message_id` — Cloudflare returns no message id, so
   null there is correct and is how you tell the two legs apart.
5. Reset the counter to its true value, or leave it — it resets at UTC midnight
   and the only cost of leaving it is a day of sends going out via Cloudflare.

### 6. Rollback

Set `EMAIL_SPILLOVER` back to `"none"`, push, deploy. No migration to undo, no
data to clean up: the `cloudflare` rows in `email_quota` are inert history and
the DNS records are harmless when unused. Leave the token in place.

## Afterwards

- Read the first week of `rua` reports and confirm both senders pass. `p=reject`
  is already in force, so this is verification after the fact rather than a
  gate before tightening — which is the one respect in which the onboarding
  default is worse than doing it by hand.
- Re-read the actual Cloudflare daily limit after a fortnight of real sending;
  `MAX_EMAILS_PER_DAY_CLOUDFLARE: "100"` is an assumption, and the ramp moves.
- `docs/known-issues.md` records the two deliberate gaps: no monthly counter,
  and no idempotency key on this leg.
