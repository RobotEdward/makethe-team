# Cloudflare edge configuration

Everything here is dashboard or API configuration, not code. It supplements the
application's own access controls (§2.13) — the app is written to be safe with
all of it switched off.

## Deployment ownership

GitHub Actions is the only thing that deploys this Worker (§2.9). If the repo is
ever connected to Cloudflare Workers Builds, **disable automatic deployments
there**. Two systems deploying one Worker is a failure mode.

## Worker secrets

Four, all set with `wrangler secret put` and never present in
`wrangler.jsonc` (which is committed):

| Secret | What it signs or opens | Rotation blast radius |
| --- | --- | --- |
| `RESPONSE_TOKEN_SECRET` | `/r/:token` and `/leave/:token` links (TR-13) | Every outstanding response link in every inbox stops working |
| `CANCEL_TOKEN_SECRET` | `/cancel/:token` owner cancellation links | Outstanding cancel links only — few, and they expire at kickoff |
| `RESEND_API_KEY` | The Resend API (see `email.md`) | No links affected |
| `VAPID_PRIVATE_KEY` | Web push notifications (M14) | **Every existing subscription, permanently, and cannot be fixed remotely** |

The first two are deliberately **separate keys**, not one shared key with a
purpose marker: see `CANCEL_TOKEN_SECRET`'s doc comment in `src/env.ts` for
the reasoning. Never reuse one value for both — the point is that a leak of
the widely-minted response key cannot forge a cancellation, and that the
higher-value key can be rotated without breaking every player's link.

### `VAPID_PRIVATE_KEY` — web push (M14)

**This is the one secret on this page that cannot be regenerated without
real, unavoidable cost.** The other three can be rotated by generating a new
random string and setting it; every consequence is contained to this side
(some links stop working, players get a fresh cancel link, Resend issues a
new API key). `VAPID_PRIVATE_KEY` is different in kind: its public half is
baked into every device's push subscription by the browser at the moment
`PushManager.subscribe()` runs, on Cloudflare's infrastructure and on every
subscribing device, with no copy kept anywhere this project controls.
Replace the private key and the public key it must match changes too, so
every subscription created against the old public key is instantly and
permanently invalid — there is no "resync" for it.

**Generating it.** Run, locally, once:

```bash
node scripts/generate-vapid-keys.mjs
```

This prints a fresh P-256 keypair to the terminal and writes nothing to
disk. Read the whole output before doing anything else — it repeats the
custody warning below. `wrangler secret put` is write-only (Cloudflare
cannot show you a secret's value once set), so **the moment this command's
output scrolls off your terminal, that is the only copy of the private key
that will ever exist.** Store it in a long-term secret manager (password
manager, vault, etc.) *before* setting it as a Worker secret — not after,
and not "I'll do it in a minute".

**Setting it**, without ever printing the value into shell history or a log:

```bash
echo -n "<private key>" | npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret list   # names only; never echoes a value
```

**Turning push on**, once the key is stored and set (see `PUSH_NOTIFIER` in
`wrangler.jsonc`, which documents the same two-line change):

1. In `wrangler.jsonc`'s `vars`, change `"PUSH_NOTIFIER"` from `"null"` to
   `"webpush"`, and add `"VAPID_PUBLIC_KEY"` (the public key the same script
   printed) and `"VAPID_SUBJECT": "mailto:ops@makethe.team"`.
2. `echo -n "<private key>" | npx wrangler secret put VAPID_PRIVATE_KEY`, as
   above, then deploy.

Until both are done, `createNotifier` builds a `NullNotifier` for the push
leg and never reads either VAPID binding — a deploy cannot send a push or
leak a key while `PUSH_NOTIFIER` stays `"null"`.

**This order matters, and it is not merely a push-leg risk.** `requireBinding`
runs synchronously at construction for all three VAPID bindings, and
`createNotifier` is called from eight sites, including the cron handler — so
a deploy that ships `wrangler.jsonc`'s `vars` (step 1: `PUSH_NOTIFIER` flipped
to `"webpush"`, plus `VAPID_PUBLIC_KEY`/`VAPID_SUBJECT`) *before*
`VAPID_PRIVATE_KEY` exists as a secret makes `createNotifier` throw at
construction for every caller — cancel, publish-teams, remove-member, join,
erasure scheduling, and the entire cron sweep, so no reminder emails go out
at all, not just push. Before deploying the `wrangler.jsonc` vars, run
`npx wrangler secret list` and confirm `VAPID_PRIVATE_KEY` is already there.

**If the private key is lost anyway** — deleted, an operator's machine
wiped before it was stored, whatever the cause — there is no support ticket
or API call that recovers it. Cloudflare secrets are write-only by design,
and there is no back door. The recovery procedure is a full reset, not a
fix:

1. Generate a brand-new pair with `node scripts/generate-vapid-keys.mjs`.
   Store the new private key properly this time, then set it with
   `wrangler secret put VAPID_PRIVATE_KEY` as above, and put the new public
   key in `wrangler.jsonc`'s `VAPID_PUBLIC_KEY`.
2. Delete every row in the `push_subscriptions` table. They are all now
   permanently undeliverable against the new key — pointing push at the new
   public key does not "reactivate" them, it just makes every send to them
   fail with a 403 instead of succeeding silently against the old one, so
   deleting them is what stops the app from wasting sends and quota trying.
3. There is no step 3 that restores anyone automatically. Each player who
   wants push notifications has to open the app again and opt in by hand, on
   their own device, creating a brand-new subscription against the new
   public key. Nothing on the server side can do this for them or notify
   them it needs doing — push is the one channel that cannot bootstrap
   itself, since the mechanism that would tell someone "please re-subscribe"
   is the very channel that just broke. Use email (TR-13/N-4 style) to ask
   players to come back and re-enable it.

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

## Rate limiting (TR-37)

The control is **`src/security/rate-limit.ts`**, backed by the two Workers rate
limiting bindings declared in `wrangler.jsonc`. It is not a dashboard setting
and nothing here has to be applied by hand.

| Binding | Key | Limit | Bounds |
| --- | --- | --- | --- |
| `TOKEN_LIMITER` | `r:<token>`, `j:<token>`, `leave:<token>`, `cancel:<token>` | 10 / 60s | Hammering one link |
| `TOKEN_IP_LIMITER` | `ip:<CF-Connecting-IP>` | 60 / 60s | One address walking *different* tokens |

Mounted in `src/app.ts` on `/r/*`, `/leave/*`, `/cancel/*` and `/j/*` only —
never `*`. A refusal is a 429 carrying `Retry-After: 60` and
`src/views/too-many-requests.ts`, which is deliberately **not**
`renderLinkProblemPage()`: a throttled player's link is fine, and telling them
to ask their organiser for a fresh one is a dead end for them and support
burden for the organiser.

**It is a supplement and it fails open.** What actually bounds the cost of an
unauthenticated endpoint that writes a row and sends an email is the quota
wrapper (`MAX_EMAILS_PER_DAY`) and the token's unguessability. Two independent
reasons this can never be load-bearing: counting is **per machine** — not per
colo, not global — so the configured limit is a floor on what one caller can
do rather than a ceiling (see the measurement below); and a
binding fault or an absent binding serves the request rather than refusing it,
because a supplementary control that can 429 every player during a Cloudflare
blip is a worse outage than the abuse it blunts.

`LIMIT_PERIOD_SECONDS` in `src/security/rate-limit.ts` must match the `period`
on both bindings — it is what `Retry-After` promises, and nothing can read a
binding's configured period back at runtime.

### Verifying the limiter is live

**A loop of separate `curl` calls will not show you this working, and that is
not a bug.** Each new connection can land on a different machine, and each
machine keeps its own count — 23 sequential requests to one token were all
served against a 10-per-60s limit. You have to pin one connection, which curl
does when you pass several URLs to a single invocation:

```bash
T="probe-$$"
ARGS=$(for i in $(seq 1 18); do printf -- '-o /dev/null https://makethe.team/r/%s ' "$T"; done)
curl -s -w '%{http_code} ct=%header{content-type} ra=%header{retry-after}\n' $ARGS
```

Expect roughly eleven `200`s, then `429 ct=text/html ra=60`. Read the
content-type, because there are **two** different 429s on this path and only
one of them is ours:

| Response | Source |
| --- | --- |
| `429`, `text/html`, `Retry-After: 60` | This middleware |
| `429`, `text/plain`, `Retry-After: 10`, body `error code: 1015` | Cloudflare's own edge abuse protection, before the Worker runs |

The edge one appears if you fire the burst in parallel (20 at once reliably
triggers it). It carries none of the Worker's headers — no `X-Robots-Tag`, no
CSP — which is the quickest way to tell them apart.

### Why not the zone's own rate limiting rules

**The earlier version of this runbook left an open question — whether the Free
plan permits a second rate limiting rule so that `respond-throttle` and
`join-throttle` could coexist. It does not.** Free allows **exactly one** rate
limiting rule per zone, matching on **path only**, counting **per-IP** over a
fixed **10-second** window with a **10-second** mitigation timeout. The two
rules that section specified could never both have existed, and neither would
have been much of a control alone.

That is the whole reason the Workers bindings above exist: they give a 60
second window and a key that is not an IP address.

The single rule the plan does allow is still worth having, for the one thing
the bindings structurally cannot do — it blocks **before the Worker is
invoked**, so it protects the bill rather than the data. It is declared in
`infra/cloudflare/rules/rate-limit.ts` and applied with `npm run cf:apply`.

**The runbook's history here was wrong.** It said rate limiting was "not
configured yet, deliberately". In fact `respond-throttle` — matching `/r/` at
20 requests per 10 seconds — had been created on the zone on **11 August
2026** and was live the whole time. The first `cf:plan` against the real zone
found it immediately, which is the argument for declaring this in code rather
than describing it in prose: a runbook cannot be out of date about something a
diff reads from the source of truth on every run.

It has been replaced by `token-endpoint-throttle`, a strict superset: same
action, rate, period and characteristics, with an expression covering `/j/` as
well as `/r/`. `/j/:token` was never covered before, and under the Free plan's
one-rule limit widening the existing rule was the only way it could be.

## WAF custom rules and rate limiting are declared in code

**Do not add, edit or remove these in the dashboard.** They live in
`infra/cloudflare/`, as data:

```bash
source .cf-admin-token
npm run cf:plan      # what would change; changes nothing
npm run cf:apply     # make the zone match the repo
npm run cf:verify    # check the live site (no token needed)
```

`infra/cloudflare/README.md` carries the full reasoning: why this is a script
against the Rulesets API rather than Terraform (the phase entrypoint is a full
replace, so the zone is the state and there is no state file), why it is
deliberately kept out of CI (the deploy token cannot touch the Rulesets API,
and that is a property worth keeping), and how to mint the elevated token —
which needs **Zone WAF → Edit**, not Firewall Services; they are different
permission groups and only the former grants the Ruleset Engine.

A dashboard edit is not forbidden by anything technical, and for a rule needed
**in response to a live attack** it is the right move — this repo is public, and
committing first publishes the countermeasure to the attacker. Add it by hand,
then commit it. Otherwise `cf:plan` will report your edit as drift and
`cf:apply` will remove it, which is the intended behaviour.

### The collision argument, corrected

An earlier version of this runbook argued that these rules could not match a
real player's link because "every pattern requires a literal `/` immediately
before it, and HMAC tokens are base64url or hex, neither of which can contain a
slash".

**That does not establish the conclusion.** The hazard is not a token
containing a slash — it is a token *beginning* with a pattern, because the `/`
before it is the route's own separator. `/r/wp-anything` contains `/wp-`, and
`wp-` is three legal base64url characters.

What actually makes it safe is the alphabets:

- `/r/`, `/leave/` and `/cancel/` carry `base64url(JSON).base64url(hmac)`. The
  payload is JSON, so the first byte is always `{` (0x7B), whose top six bits
  are 30 — **every one of these tokens starts with `e`**.
- `/j/` carries `crypto.randomUUID()`: hex and dashes, so it cannot contain
  `w`, `p`, `.` or `/`.

Both are incidental to how tokens are built. Neither was chosen for this
reason, and either could be changed by someone with no idea this rule exists —
so `test/infra/waf-collisions.test.ts` runs 200 freshly minted tokens of every
kind through the real rule matcher on every `npm test`, and pins the `e` prefix
explicitly with the reason. **This is why `infra/cloudflare/` lives in the
application repo**: the guard needs the rules and `src/domain/token.ts` in one
test run.

A false positive here would break the one journey the product depends on, one
player at a time, with nothing logged — the request never reaches the Worker.

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

**Status:** confirmed off, 23 August 2026.

### This is the one setting with no automated check — but it has a canary

`/zones/{id}/bot_management` answers `10000 Authentication error` on this Free
zone even for a token that reads every other zone setting, and the toggle
cannot be set through the Rulesets API either. So `cf:plan` can only tell you
to look, and turning it off is a dashboard action.

That matters less than it appears, because **the post-deploy smoke check in
GitHub Actions is already a detector for exactly this failure**. Actions
runners are on Azure ranges, which is precisely what Bot Fight Mode
challenges — so switching it on turns the next deploy red within minutes. That
is not a hypothetical: it is how the 10 August incident above was noticed.

So the check is not really manual. It is automated by accident, on every
deploy, and the alarm has already fired once. If CI goes red on the smoke
check while the site is fine from a browser, look here first.

## Custom domain

The `makethe.team` route is declared in `wrangler.jsonc` as a custom domain, so
`wrangler deploy` manages it. Do not also create a route by hand in the
dashboard — the two will fight.

## Database backup and restore

See `database-backup.md`: Time Travel bookmarks (printed by every deploy) and
the daily R2 dump.

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
