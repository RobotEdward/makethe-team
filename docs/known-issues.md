# Known issues and deferred findings

Findings raised during the M0–M1 reviews that were deliberately **not** fixed, each
with the reason. Recorded here so the next milestone's plan can triage them rather
than rediscover them. Nothing in this list is a correctness bug in shipped behaviour.

Anything that *was* fixed lives in the git history, not here.

## Fix before a specific milestone

| Item | Where | Fix before |
|---|---|---|
| An invalid or out-of-range `LocalParts` silently rolls over (`hour: 25` → next day, `month: 0` → previous December, `hour: NaN` → `RangeError`). Only reachable if a caller builds `LocalParts` without going through `parseLocalTime`. | `src/domain/time/zone.ts` | M6, which puts a kickoff-time field on a form |
| A rejected time zone re-attempts `Intl.DateTimeFormat` construction on every call — nothing is negative-cached. Harmless until a user-supplied zone arrives at volume. | `src/domain/time/zone.ts` | M6, which adds a timezone picker |
| A game configured with an odd `max_players` while preferring even numbers, once full, is permanently both `full` and `uneven` with no possible remediation. Faithful to the advisory-only parity rule, but the configuration should be discouraged at creation time. See spec Part 3, open item 6. | `src/domain/fixture-view.ts` | M6, as a soft warning on the game form |
| The `production` GitHub environment was auto-created with no protection rules, and the deploy secrets are repo-level rather than environment-scoped, so `environment: production` currently gates nothing. | `.github/workflows/deploy.yml` | M3, when a bad deploy starts sending email |
| `scripts/seed.sql` opens with four unguarded `DELETE FROM` statements. It is local-only and only ever invoked with `--local`, but it is one mistyped flag from wiping production. | `scripts/seed.sql` | Before anyone else has commit access |

## Deferred indefinitely — theoretical or negligible

| Item | Why it can wait |
|---|---|
| `npm audit` reports 4 moderate advisories in the `drizzle-kit` dependency tree. | Dev-only. `npm audit --omit=dev` reports 0. Nothing ships to the Worker. |
| Years 0–99 map to 1900 + year through `Date.UTC` legacy behaviour. | No football game is scheduled in the year 47. |
| A 23:00–23:59 kickoff falling in a spring-forward gap that crosses midnight can land on the wrong local weekday. Affects three zones in 2026 (America/Nuuk, Godthab, Scoresbysund), none in the UK. | Originates in `toUtc`'s documented gap rule. Requires a near-midnight kickoff in a Greenland time zone. |
| `db.select().from(games)` loads every active game with no pagination. | A growth cliff years away, for a cron serving one game. |
| The deploy smoke check's `curl … \|\| echo 000` double-appends on a total connection failure, logging `status=000000`. | Cosmetic. Verified not to cause a false pass — the loop still exits non-zero. |
| `actions/checkout@v4` and `setup-node@v4` target the deprecated Node 20 runtime. | A non-blocking CI annotation. Bump opportunistically. |
| `formatterCacheSize()` is a test-only export widening the production surface. | Needed by the cache-canonicalisation regression test. A size-only read-only accessor. |
| `nodejs_compat` is enabled in `wrangler.jsonc` with no Node builtin used in `src/`. | Harmless, and likely needed by later milestones. |
| No CSP or `frame-ancestors` headers. | The only page is a static holding page with no forms and no scripts. Revisit when M2 adds forms. |
| `test/index.test.ts` asserts the schema-derived fixture count in two places, so changing the materialisation horizon needs edits across four test files. | A shared expected-count constant in `test/support/` would localise it. |

## Edge configuration — applied

The two WAF custom rules in `docs/runbooks/cloudflare.md` (TR-37) were applied by hand
in the dashboard on 10 August 2026 and verified live. Scanner paths and non-standard
methods now return 403 from the edge rather than reaching the Worker at all, which
matters for cost as much as for noise: WAF-blocked requests are never billed as Worker
invocations.

Editing them via the API would need a token with **Zone → Firewall Services → Edit**,
which the deploy token deliberately does not have. Keep it that way — the deploy token
lives both on the build machine and in GitHub Actions secrets.

The rate-limiting rule is **deferred to M2**: the Free plan cannot express the rule as
originally written, and there is no `POST` endpoint to protect yet. See the runbook for
the constraints and the replacement.

## Carry-forward for the next milestone

Two structural notes that are not defects but will shape M2:

1. **Nothing in the codebase can currently produce an `open` fixture.** Materialisation
   writes `scheduled`, and the `scheduled → open` transition belongs to M3's reminder
   sweep. But `fixtureView`'s entire body is gated on `lifecycle === "open"`, so M2's
   fixture page, response tokens and capacity logic have no reachable state to exercise.
   M2 must own that transition, or it cannot be tested end to end.

2. **`triggers.crons` sits at the top level of `wrangler.jsonc`**, which is correct while
   production is the only environment — but it is inherited, so adding a staging
   environment would silently give it both cron schedules. TR-9 exists precisely to stop
   two environments running the reminder sweep against real people. The runbook documents
   the required move; the configuration does not yet enforce it.
