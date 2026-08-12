# Cloudflare edge configuration

Everything here is dashboard or API configuration, not code. It supplements the
application's own access controls (§2.13) — the app is written to be safe with
all of it switched off.

## Deployment ownership

GitHub Actions is the only thing that deploys this Worker (§2.9). If the repo is
ever connected to Cloudflare Workers Builds, **disable automatic deployments
there**. Two systems deploying one Worker is a failure mode.

## Worker secrets

Three, all set with `wrangler secret put` and never present in
`wrangler.jsonc` (which is committed):

| Secret | What it signs or opens | Rotation blast radius |
| --- | --- | --- |
| `RESPONSE_TOKEN_SECRET` | `/r/:token` and `/leave/:token` links (TR-13) | Every outstanding response link in every inbox stops working |
| `CANCEL_TOKEN_SECRET` | `/cancel/:token` owner cancellation links | Outstanding cancel links only — few, and they expire at kickoff |
| `RESEND_API_KEY` | The Resend API (see `email.md`) | No links affected |

The first two are deliberately **separate keys**, not one shared key with a
purpose marker: see `CANCEL_TOKEN_SECRET`'s doc comment in `src/env.ts` for
the reasoning. Never reuse one value for both — the point is that a leak of
the widely-minted response key cannot forge a cancellation, and that the
higher-value key can be rotated without breaking every player's link.

> **`CANCEL_TOKEN_SECRET` is not yet set in production.** Nothing mints a
> cancel token in production until the owner-attention email (N-4) ships, so
> until then an unset secret is inert — `/cancel/:token` simply renders the
> ordinary "this link isn't working" page for everything, and signing throws
> by name. It must be set **before** N-4 goes out, or every attention email
> will fail to send.

Setting it, without ever printing the value:

```bash
head -c 32 /dev/urandom | base64 | npx wrangler secret put CANCEL_TOKEN_SECRET
npx wrangler secret list   # names only; never echoes a value
```

## Rate limiting (TR-37) — deferred to M2

**Not configured yet, deliberately.** An earlier version of this runbook specified
a rule matching `http.request.method eq "POST"` with a 60-second mitigation
timeout. That rule cannot be created on this zone, and the reasons are worth
recording so nobody tries again:

On the Free plan, rate limiting rules are restricted well beyond the one-rule
count. They may match on **path and verified-bot only** — `http.request.method`
is not an available field — the counting period is fixed at **10 seconds**, and
the mitigation timeout is capped at **10 seconds**. Counting is per-IP only.
Those limits apply to rate limiting rules specifically, not to the WAF custom
rules below, which have the ordinary expression language available.

There is also nothing to protect yet: the Worker currently serves only a holding
page and has no `POST` endpoint at all.

When M2 adds the response endpoints under `/r/`, create the single Free-plan rule
then, matching on path rather than method:

- **Name:** `respond-throttle`
- **Match:** `http.request.uri.path contains "/r/"`
- **Rate:** 20 requests per 10 seconds, per IP
- **Action:** Block, 10-second timeout (the Free maximum)

A 10-second mitigation window is short, but it is enough to blunt a hammering
loop, and the response endpoints are idempotent so a blocked retry costs the
player nothing.

### `join-throttle` (M6a, TR-37) — not yet applied

`POST /j/:token` (§4.5 of the M6a design) is the second unauthenticated
endpoint that both writes a row and sends an email, the same class as `/r/`. A
WAF rate-limit rule is a supplement here too, not the control — the quota
wrapper around the notifier (`MAX_EMAILS_PER_DAY`) is what actually bounds the
cost, and everything in `src/routes/join.ts` must hold with this rule switched
off, exactly as `respond-throttle` must.

Same shape as `respond-throttle`, matching on path:

- **Name:** `join-throttle`
- **Match:** `http.request.uri.path contains "/j/"`
- **Rate:** 20 requests per 10 seconds, per IP
- **Action:** Block, 10-second timeout (the Free maximum)

**Not yet applied.** Must be created by hand in the dashboard, same as
`respond-throttle` and the two WAF custom rules below — the deploy token
deliberately lacks **Zone → Firewall Services → Edit**, so nothing in CI or
`wrangler.jsonc` can create it.

**Check the Free plan's rate-limiting rule count before creating this one.**
The section above calls `respond-throttle` "the single Free-plan rule", which
was written when it was the only one needed and may mean the plan permits
exactly one rate-limiting rule rather than several — that has not been
verified against current Cloudflare documentation for a *second* rule. If the
Free plan will not allow both simultaneously, `join-throttle` is not a
control this project can rely on and `docs/known-issues.md` should say so;
`/j/:token`'s actual protection would then still be the quota wrapper, the
origin check and the token's unguessability from §4.5, same as it is today.

## WAF custom rules (TR-37)

Security → WAF → Custom rules. The free plan allows five. A blocklist is always
behind the attackers; this exists to keep scanner noise out of the logs and the
request count, not as a security control.

1. **`block-scanner-paths`** — Block

   ```
   (http.request.uri.path contains "/wp-")
   or (http.request.uri.path contains "/wordpress")
   or (http.request.uri.path contains "/.env")
   or (http.request.uri.path contains "/.git")
   or (http.request.uri.path contains "/phpmyadmin")
   or (http.request.uri.path contains "/vendor/")
   or (http.request.uri.path contains "/.aws")
   or (http.request.uri.path eq "/config.json")
   ```

2. **`block-non-standard-methods`** — Block

   ```
   not http.request.method in {"GET" "HEAD" "POST"}
   ```

Leave the remaining three slots free.

There is deliberately no bot-scoring rule. The `cf.bot_management.*` fields
require a paid Bot Management subscription, which this zone (Free Website plan)
does not have, so any such rule would fail validation — do not re-add one. The
application is written to be safe with the WAF switched off entirely.

**Status:** both rules were applied in the dashboard on 10 August 2026 and
verified live.

### Verifying the rules are live

```bash
# Blocked at the edge — expect 403
for p in /wp-admin /wordpress/ /.env /.git/config /phpmyadmin \
         /vendor/autoload.php /.aws/credentials /config.json; do
  printf '%-24s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "https://makethe.team$p")"
done
curl -s -X PUT -o /dev/null -w 'PUT / -> %{http_code}\n' https://makethe.team/

# Must keep working — expect 200, 200, 404
curl -s -o /dev/null -w 'GET  /            -> %{http_code}\n' https://makethe.team/
curl -s -o /dev/null -w 'GET  /robots.txt  -> %{http_code}\n' https://makethe.team/robots.txt
curl -s -X POST -o /dev/null -w 'POST /            -> %{http_code}\n' https://makethe.team/
```

`403` means the rule is live and the request never reached the Worker. `404`
means it reached the Worker, so the rule is not applied. Either is safe — the
application does not depend on the WAF — but only `403` avoids the request being
billed as a Worker invocation.

### These rules do not collide with the application's own routes

Checked against the route shapes the next milestones introduce — response links
(`/r/<token>`), invite links (`/j/<token>`), game pages and the dashboard. All
reach the Worker rather than being blocked, **including** deliberately awkward
tokens containing `wp-`, `.env`, `config.json` and `vendor-`.

They are safe because every pattern in `block-scanner-paths` requires a literal
`/` immediately before it, and HMAC tokens are base64url or hex, neither of which
can contain a slash. `/config.json` uses `eq` rather than `contains`, so it only
matches at the root.

If a future route is ever added whose path segment could begin with `.` or could
contain one of those literals after a slash, re-run the check above with that
shape before shipping it. A WAF false positive on `/r/` would silently break the
one journey the whole product depends on.

## Bot Fight Mode must stay OFF

Security → Bots → Bot Fight Mode. **Leave it off.** It was briefly enabled on
10 August 2026 and broke the deploy pipeline within minutes.

Bot Fight Mode challenges traffic from datacenter and cloud IP ranges. GitHub
Actions runners live on Azure ranges, so every post-deploy smoke check came back
`403` and three consecutive deploys reported red — while the deploys themselves
had succeeded. The failure is confusing because the site is demonstrably fine
from any ordinary connection.

Diagnosing it took a while because the symptom points at the wrong thing. Worth
recording:

- Neither WAF custom rule can match `GET /`, so the rules were not the cause.
- User-agent is not the discriminator. `curl`, a browser string, `python-requests`
  and `GitHub-Actions` all return 200 from a normal connection. Only the source
  IP differs.
- Reading Cloudflare's firewall events would have identified it immediately, but
  that needs a token with zone analytics read, which the deploy token does not
  have by design.

The same feature would also challenge legitimate players behind corporate
proxies and some VPNs, for a site whose entire public surface is a holding page.
The real controls are the two WAF rules, the per-invocation CPU ceiling, and the
application's own authorisation — none of which care about IP reputation.

If CI ever goes red on the smoke check while the site is fine from a browser,
check this toggle first.

## Custom domain

The `makethe.team` route is declared in `wrangler.jsonc` as a custom domain, so
`wrangler deploy` manages it. Do not also create a route by hand in the
dashboard — the two will fight.

## Cron triggers

`wrangler deploy --dry-run` does **not** print cron triggers in wrangler
4.120.0, so a dry run can never confirm them. After a real deploy, confirm the
schedules registered against the API:

```bash
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/makethe-team/schedules"
```

Expected: both `0 * * * *` and `15 3 * * *`. If either is missing, no fixtures
will be materialised in production.

## Adding a staging environment later

TR-9 becomes load-bearing the moment a second environment exists. When adding
one:

1. Move `triggers.crons` out of the top level and into `env.production` only.
2. Set `NOTIFIER = "null"` for every non-production environment.
3. Create a separate D1 database. Never point staging at production data.

Two environments running the reminder sweep means duplicate emails to real
people.
