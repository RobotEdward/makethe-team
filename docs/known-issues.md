# Known issues and deferred findings

Findings raised during the M0–M1 and M2–M3 reviews that were deliberately **not** fixed,
each with the reason. Recorded here so the next milestone's plan can triage them rather
than rediscover them. Nothing in this list is a correctness bug in shipped behaviour.

Anything that *was* fixed lives in the git history, not here.

## Fix before a specific milestone

| Item | Where | Fix before |
|---|---|---|
| An invalid or out-of-range `LocalParts` silently rolls over (`hour: 25` → next day, `month: 0` → previous December, `hour: NaN` → `RangeError`). Only reachable if a caller builds `LocalParts` without going through `parseLocalTime`. | `src/domain/time/zone.ts` | M6, which puts a kickoff-time field on a form |
| A rejected time zone re-attempts `Intl.DateTimeFormat` construction on every call — nothing is negative-cached. Harmless until a user-supplied zone arrives at volume. | `src/domain/time/zone.ts` | M6, which adds a timezone picker |
| A game configured with an odd `max_players` while preferring even numbers, once full, is permanently both `full` and `uneven` with no possible remediation. Faithful to the advisory-only parity rule, but the configuration should be discouraged at creation time. See spec Part 3, open item 6. | `src/domain/fixture-view.ts` | M6, as a soft warning on the game form |
| The `production` GitHub environment was auto-created with no protection rules, and the deploy secrets are repo-level rather than environment-scoped, so `environment: production` currently gates nothing. Now overdue: M3 makes this the gate in front of real email sends. | `.github/workflows/deploy.yml` | M3 deploy (task 17) |
| The `respond-throttle` rate-limiting rule for `/r/*` was deliberately deferred in the runbook pending M2 shipping a `POST` endpoint to protect. M2 shipped `POST /r/:token` and the rule still has not been created. | `docs/runbooks/cloudflare.md` | M3 deploy, before production traffic is real |
| No CSP or `frame-ancestors` headers. Deferred pending M2 adding forms — M2 has now shipped `POST /r/:token`, so the trigger condition has occurred. | Worker response headers (not yet implemented anywhere) | M4, alongside the next page that takes user input |
| TR-31's "owner-visible warning" on reaching the daily send ceiling is not implemented anywhere — only a code comment marks the gap. Combined with the deliberate fail-closed-to-0 behaviour on missing config, a `MAX_EMAILS_PER_DAY` config typo would silently stop all email with nothing but a `console.error` in Workers Logs. | `src/cron/handler.ts`, `src/notify/quota.ts` | M4, when N-4 (owner attention email) gives this a natural delivery channel |
| **BR-22 is not yet satisfied.** Every reminder carries a `GET /leave/:token` link so no message 404s, but the route only renders a page explaining that leaving is not self-service yet — it performs no write and is not a leave mechanism. | `src/routes/respond.ts` (`renderLeavePage`) | M7 ("unsubscribe and leave-game flows" in the spec's build order) |

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
| `test/index.test.ts` asserts the schema-derived fixture count in two places, so changing the materialisation horizon needs edits across four test files. | A shared expected-count constant in `test/support/` would localise it. |
| A `withdrawn` player presenting a still-valid response token could flip back to `in`: the Durable Object's lookup of the player's existing response row does not exclude `withdrawn`. | Unreachable today — nothing in the codebase writes `withdrawn` yet (that's BR-3, membership leaving). Revisit whichever milestone implements it. |
| A waitlisted viewer on a fixture with an odd `max_players` can see "0 spots left" alongside "one more would even it up" simultaneously. | Same root cause as the odd-`max_players` item above (Part 3, open item 6). |
| `src/routes/respond.ts` re-derives "not eligible" / "not open" from lifecycle and squad membership independently of the Durable Object's own rejection reason. The two agree today, but nothing pins them together. | No observed drift; would benefit from a shared invariant or a mapping test if the two ever diverge. |
| `notification_log.dedupe_key` builders have no structural defence against a colon-containing or empty id. | Unreachable — every id in the system is `crypto.randomUUID()`. |
| `ResendNotifier`'s batch `Idempotency-Key` is derived by joining dedupe keys with `\n`, so `["a\nb","c"]` and `["a","b\nc"]` would collide. | Unreachable — every dedupe key is colon-delimited UUIDs, which never contain `\n`. The `notification_log` unique constraint is the real guarantee underneath it regardless. |
| The test-only `fetch` spy in the Resend notifier tests throws on an unexpected call, but `sendBatch` catches everything, so an unmocked call becomes a `{ok:false}` result rather than a failed test. | Detection of a forgotten mock is still imperfect, but real-network safety no longer rests on it: `vitest.config.ts` now sets an `outboundService` that answers every outbound request with a 599 naming the blocked URL, repo-wide. |
| `ResendNotifier.send` runs `Promise.all` over every chunk with unbounded concurrency. | Fine at `MAX_EMAILS_PER_DAY=50`. Revisit if the ceiling ever reaches the thousands. |
| `SITE_ORIGIN` in `src/sweep/open-and-remind.ts` is a hardcoded constant (`https://makethe.team`) rather than derived from a binding. | Correct today — there is only one environment and one custom domain. Revisit when a second environment exists (same trigger as TR-9 below). |
| The sweep's `stage: "prepare"` failure bucket (`SweepFailure`) lumps several distinct sub-steps together — enough to isolate one bad fixture, too coarse to say which sub-step failed without reading the message text. | Diagnosability nice-to-have, not a correctness gap. |
| The reminder email's "I'm in" button renders solid/filled and "Can't make it" renders as an outline, so accepting reads as the default action. | Open product question raised to the owner, not resolved: the product's value is an *accurate* count, and a visual nudge toward accepting works against that. Green-affirmative is also a defensible convention. Awaiting a decision. |
| The reminder email's claim that every text colour is paired with a background on the same element is weaker than stated — several `<p>` elements rely on the ancestor `<td>`'s background instead. | Standard email-HTML practice and normally safe, but do a real dark-mode client check before relying on it for go-live. |
| Template `href()` helpers escape interpolated values but do not scheme-validate, so a `javascript:` URL would render as a clickable link. | Unreachable today — every URL in every template is server-constructed, never attacker-supplied. Cheap defence in depth if that ever changes. |
| Task 16's "retire throws after reminders are already committed" test calls `openAndRemind` and `retirePastFixtures` directly rather than through `handleScheduled`, because `vi.mock` does not intercept a module's own internal calls under this test pool (see the M2–M3 plan's post-implementation corrections). It pins the two functions' individual behaviour, not `handleScheduled`'s call order. | A future reordering inside `handleScheduled` would not be caught by this test. |

## Edge configuration — applied

The two WAF custom rules in `docs/runbooks/cloudflare.md` (TR-37) were applied by hand
in the dashboard on 10 August 2026 and verified live. Scanner paths and non-standard
methods now return 403 from the edge rather than reaching the Worker at all, which
matters for cost as much as for noise: WAF-blocked requests are never billed as Worker
invocations.

Editing them via the API would need a token with **Zone → Firewall Services → Edit**,
which the deploy token deliberately does not have. Keep it that way — the deploy token
lives both on the build machine and in GitHub Actions secrets.

The rate-limiting rule was **deferred to M2**: the Free plan cannot express the rule as
originally written, and at the time there was no `POST` endpoint to protect. M2 has since
shipped `POST /r/:token`, so that condition has occurred, and the rule (`respond-throttle`
in the runbook) still has not been created — tracked above under "Fix before a specific
milestone" rather than here, since it is no longer merely theoretical.

## Carry-forward for the next milestone

M2's carry-forward note about nothing being able to produce an `open` fixture is resolved
— M3's hourly sweep now owns the `scheduled → open` transition — and has been removed from
this list per the rule above.

One structural note remains, not a defect but relevant to whichever milestone adds a second
environment:

1. **`triggers.crons` sits at the top level of `wrangler.jsonc`**, which is correct while
   production is the only environment — but it is inherited, so adding a staging
   environment would silently give it both cron schedules. TR-9 exists precisely to stop
   two environments running the reminder sweep against real people. The runbook documents
   the required move; the configuration does not yet enforce it.
