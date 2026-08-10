# Cloudflare edge configuration

Everything here is dashboard or API configuration, not code. It supplements the
application's own access controls (§2.13) — the app is written to be safe with
all of it switched off.

## Deployment ownership

GitHub Actions is the only thing that deploys this Worker (§2.9). If the repo is
ever connected to Cloudflare Workers Builds, **disable automatic deployments
there**. Two systems deploying one Worker is a failure mode.

## Rate limiting (TR-37)

Security → WAF → Rate limiting rules. One rule:

- **Name:** `post-throttle`
- **Match:** `http.request.method eq "POST"`
- **Rate:** 20 requests per 10 seconds, per IP
- **Action:** Block, 60-second timeout

Response endpoints are `POST` only, so this caps both accidental double-taps and
deliberate hammering without touching page loads.

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

3. **`challenge-known-bad-bots`** — Managed Challenge

   ```
   cf.client.bot_management.score lt 5 and not cf.client.bot_management.verified_bot
   ```

Leave two slots free.

### Verifying the rules are live

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://makethe.team/wp-admin
```

`403` means `block-scanner-paths` is live. `404` means the request reached the
Worker and the rules have not been applied yet. Either is safe.

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
