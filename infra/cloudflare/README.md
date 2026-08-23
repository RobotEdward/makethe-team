# Cloudflare edge configuration

The zone's WAF custom rules, its one rate limiting rule, and the settings that
must not drift — declared here as data and applied with a script.

```bash
source .cf-admin-token   # see "The token" below
npm run cf:plan          # what would change; changes nothing
npm run cf:apply         # make the zone match this repo
npm run cf:verify        # check the live site behaves accordingly (no token needed)
```

## Why this is not Terraform

The Rulesets API's phase entrypoint is a **full replace**: `PUT
/zones/{id}/rulesets/phases/{phase}/entrypoint` sets the entire rule list for a
phase. The API is already declarative at exactly the granularity needed, which
removes the thing Terraform is mainly for — reconciling desired state against
actual. **The zone is the state**, so there is no state file to host, secure,
back up or drift from, and no `import` dance for a zone that already has rules.

At two-to-six rules on a Free plan, a language, a binary, a provider and a
state backend would be more moving parts than the thing they manage. If this
ever grows to multiple zones, DNS, Access and Turnstile, that calculus changes
and Terraform becomes the right answer.

## Why this is not in CI

`docs/runbooks/cloudflare.md` records that the deploy token deliberately lacks
**Zone → Firewall Services → Edit**, so nothing in GitHub Actions can change
the zone's security posture. That is a property worth keeping: deployments are
frequent and automatic, and a bad merge should not be able to open the edge.

Putting the elevated token into Actions secrets would rebuild exactly the hole
that constraint exists to close. `plan` / `apply` are run by hand, from a
machine a person is sitting at.

**One exception, deliberately.** If you ever need a rule *in response to a live
attack*, add it in the dashboard first and commit it here afterwards. This repo
is public, and a commit publishes your countermeasure to the attacker while
they are still working. Getting the rule up is worth more than keeping the
declaration authoritative for an hour.

## The token

Not the deploy token in `.cf-token` — that one cannot read or write firewall
rules, and confirming this is easy: the rulesets endpoints answer
`Authentication error` for it.

Create a second token at <https://dash.cloudflare.com/profile/api-tokens>:

| Permission | Level |
| --- | --- |
| **Zone WAF** | Edit |
| Zone Settings | Edit |
| Zone | Read |

**It is `Zone WAF`, not `Firewall Services`.** They are different permission
groups and the names are misleading: `Firewall Services` grants the *legacy*
`/firewall/rules` and `/filters` endpoints, which this repo does not use, while
every Ruleset Engine endpoint — which is all this repo touches — needs
`Zone WAF`. A token with only `Firewall Services` reads `/firewall/rules`
happily and answers `10000 Authentication error` on every rulesets call, which
reads as "bad token" rather than "wrong permission".

Do not diagnose these tokens with `/user/tokens/verify`: it answers
`1000 Invalid API Token` for tokens that demonstrably work, including the
deploy token. Probe the endpoint you actually need instead.

Scoped to `makethe.team` only. Then:

```bash
echo 'export CLOUDFLARE_ADMIN_API_TOKEN=<token>' > .cf-admin-token
chmod 600 .cf-admin-token
```

`.cf-admin-token` is gitignored, alongside `.cf-token`.

## What is declared

| File | What |
| --- | --- |
| `rules/waf-custom.ts` | Scanner-path and non-standard-method blocks |
| `rules/rate-limit.ts` | The single rule the Free plan allows |
| `zone.ts` | Zone id, phases, token handling |
| `diff.ts` | What `plan` prints |

Rules are declared as **structured predicates, not expression strings**, so one
declaration drives both what is sent to Cloudflare (`renderExpression`) and
what the collision guard evaluates (`matchesRule`). They cannot drift apart.

## The rule that could break the product

A WAF false positive on `/r/` breaks the one journey the whole product depends
on, one player at a time, with nothing logged anywhere this project can see —
the request never reaches the Worker.

`test/infra/waf-collisions.test.ts` runs 200 freshly minted tokens of every
kind through the real rule matcher on every `npm test`. **This is the reason
this directory lives in the application repo** rather than a separate one: the
guard needs both the rules and `src/domain/token.ts` in the same test run.

The runbook used to argue in prose that a collision was impossible because
"HMAC tokens are base64url or hex, neither of which can contain a slash". That
does not establish the conclusion — the hazard is a token *beginning* with a
pattern, since the `/` before it is the route's own separator, and `/r/wp-…`
contains `/wp-`. What actually makes it safe is the alphabets: signed tokens
are base64url of a JSON payload so they always start with `e`, and invite
tokens are UUIDs so they are hex only. Both are incidental properties that
someone could change without knowing this rule exists, which is why they are
pinned by a test rather than a paragraph.

## Bot Fight Mode must stay OFF

`plan` checks this and complains if it is on. It challenges datacentre and
cloud IP ranges; GitHub Actions runners are on Azure, so every post-deploy
smoke check returns 403 and deploys report red while having actually
succeeded. It was enabled once, on 10 August 2026, and broke three consecutive
deploys. It is not settable through the rulesets API and has to be turned off
in the dashboard: Security → Bots → Bot Fight Mode.
