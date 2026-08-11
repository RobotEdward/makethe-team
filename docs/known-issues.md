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
| **Required reviewers are not enabled** on the `production` environment, so a compromised token or account can auto-deploy. Deliberately deferred: the database currently holds six plus-addressed test players, and an approval click per deploy is real friction during active development. **The trigger to enable it is the first real squad member's address going in**, not a date. Everything else on this environment is now locked down — see the note below. | GitHub → Settings → Environments → production | Before real players are added |
| ~~`respond-throttle` rate limiting for `/r/*`~~ | **Applied and verified 11 August 2026.** Measured against production: exactly 20 requests pass then 429, recovery after the mitigation window, and `/`, `/robots.txt` and `/leave/*` are unaffected. |
| No CSP or `frame-ancestors` headers. Deferred pending M2 adding forms — M2 has now shipped `POST /r/:token`, so the trigger condition has occurred. | Worker response headers (not yet implemented anywhere) | M4, alongside the next page that takes user input |
| TR-31's "owner-visible warning" on reaching the daily send ceiling is not implemented anywhere — only a code comment marks the gap. Combined with the deliberate fail-closed-to-0 behaviour on missing config, a `MAX_EMAILS_PER_DAY` config typo would silently stop all email with nothing but a `console.error` in Workers Logs. | `src/cron/handler.ts`, `src/notify/quota.ts` | M4, when N-4 (owner attention email) gives this a natural delivery channel |
| **BR-22 is not yet satisfied.** Every reminder carries a `GET /leave/:token` link so no message 404s, but the route only renders a page explaining that leaving is not self-service yet — it performs no write and is not a leave mechanism. | `src/routes/respond.ts` (`renderLeavePage`) | M7 ("unsubscribe and leave-game flows" in the spec's build order) |
| **`GET /api/auth/passkey/generate-authenticate-options` is anonymous by design** (no user identifier — that is what makes it byte-identical whether or not an account exists, M5 Task 8 review) **and writes a `verification` row plus sets a signed cookie on every call**, so an unauthenticated caller can grow that table without a session or a Player, same class as the magic-link storage-amplification footnote already recorded above `sendSignInLink` in `src/auth/factory.ts:63-71`. **What actually protects it today, quantified:** Better Auth's own rate limiter (`node_modules/better-auth/dist/context/create-context.mjs:169-174`) defaults to `enabled: isProduction, window: 10s, max: 100`, backed by **in-memory storage** (no `secondaryStorage` is configured in `src/auth/factory.ts`) — so the 100-per-10s ceiling is per Worker isolate, not per deployment: a caller spread across enough edge PoPs, or simply pacing under ~10 requests/second to any one isolate, sees no rate limiting at all. The one WAF-level control this project actually relies on for a similar unauthenticated write-generating endpoint is the `respond-throttle` custom rule (see `docs/runbooks/cloudflare.md`), applied and verified against production on 11 August 2026. | `src/auth/factory.ts` (`passkey({...})`), `node_modules/@better-auth/passkey` `/passkey/generate-authenticate-options` | Extend a WAF rate-limiting rule to this path (or add `secondaryStorage`) if `verification` growth or `passkey`-prompt spam is ever observed in practice — no observed abuse yet, and the endpoint's response is small and fixed-shape |

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
| The reminder email's "I'm in" button renders solid/filled and "Can't make it" renders as an outline, so accepting reads as the default action. | **Settled, 11 August 2026 — keep it.** Raised as a product question because the product's value is an accurate count and a visual nudge toward accepting works against that. The owner's decision: encouraging people to play is the point, and the organiser's interest and the players' are aligned here. Not an open item; do not re-raise. |
| The reminder email's claim that every text colour is paired with a background on the same element is weaker than stated — several `<p>` elements rely on the ancestor `<td>`'s background instead. | Standard email-HTML practice and normally safe, but do a real dark-mode client check before relying on it for go-live. |
| Template `href()` helpers escape interpolated values but do not scheme-validate, so a `javascript:` URL would render as a clickable link. | Unreachable today — every URL in every template is server-constructed, never attacker-supplied. Cheap defence in depth if that ever changes. |
| `POST /api/auth/sign-in/magic-link` is publicly mounted (`signIn.all(`${AUTH_API_PREFIX}/*`, …)`, `src/routes/signin.ts`), so a third party can choose a same-origin `callbackURL` on an allowlisted victim's emailed link — worst case it lands off `/sign-in/complete` so linking never runs and they meet the no-Player 403. An off-origin value is refused by Better Auth's own `originCheck`; nothing is taken over. | An annoyance with a documented exit (sign-out form + home link on the 403), not a security hole. Revisit only if a future callback target becomes sensitive (e.g. carries a one-time action). |
| An off-origin `callbackURL`/`errorCallbackURL`/`newUserCallbackURL` on the magic-link verify endpoint returns Better Auth's raw JSON 403, not one of this app's rendered pages (`src/routes/signin.ts`). | Cosmetic, and only reachable on the hostile path (a stranger has to have altered the emailed link before the intended recipient opens it). |
| A second identity signing in over an existing session cookie leaves the first `session` row alive in D1 — Better Auth's default behaviour, not anything Task 5 chose (`src/routes/signin.ts`, magic-link verify). The browser only ever holds the newest cookie, so there is no confusion from the visitor's side. | Noted so a `session` row count in a later test or metric isn't a surprise. Revisit if per-identity session limits or a "sign out other devices" feature is ever wanted. |
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

## Repository and deploy hardening — applied 11 August 2026

Recorded so nobody re-litigates it, and so the one deliberate omission is visible.

| Control | State |
|---|---|
| Deploy secrets scoped to the `production` environment, not the repository | **Applied.** Previously any workflow in the repo could read the Cloudflare token, which owns D1 and the Worker. Now only jobs declaring `environment: production` can. |
| Deployment branches restricted to `main` | **Applied.** |
| Ruleset `main-history-protection`: force-push and deletion blocked | **Applied.** Direct pushes to `main` are unaffected, which is the agreed workflow. |
| Actions restricted to GitHub-authored and verified creators | **Applied.** Only `actions/checkout` and `actions/setup-node` are used. |
| Required reviewers on `production` | **Deliberately off** — see the row above for the trigger to enable it. |
| Pull requests required to merge | **Deliberately not used.** Working directly on `main` is the agreed workflow, and `deploy.yml` already runs lint, typecheck and tests before migrations and deploy, so a broken push fails before touching production. |

**Outstanding, needs the Cloudflare dashboard:** the deploy API token carries **Workers KV Storage → Edit**, and this project has no KV binding. Drop that scope the next time the token is rotated.
