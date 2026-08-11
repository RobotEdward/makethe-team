# Make The Team — M5: Auth and the Player Dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A player can sign in with a link in their inbox — or a passkey, if their browser has one — and see every upcoming fixture across all their games in one place, changing any response from there.

**Architecture:** Better Auth, self-hosted, over the D1 database we already have. It is instantiated per request because D1 bindings only exist inside the handler, and it shares the one Drizzle instance rather than creating a second wrapper round the same binding. Better Auth keeps its own tables under its own schema; `players` stays the domain record and is linked by a nullable column, because most players will never sign in.

**Tech Stack:** Adds `better-auth@1.6.26`, `@better-auth/drizzle-adapter`, `@better-auth/passkey`. Everything else unchanged.

**Spec:** `docs/superpowers/specs/2026-08-10-make-the-team-design.md`.

**Runs in parallel with:** `2026-08-11-m4-waitlist-cancellation-attention.md`. See "Working in parallel" below.

## Working in parallel with M4

Both plans run in separate git worktrees off `main`. Use superpowers:using-git-worktrees.

**Files this plan owns:** `src/auth/*`, `src/routes/signin.ts`, `src/routes/dashboard.ts`, `src/views/dashboard.ts`, and the Better Auth tables in the schema.

**Files M4 owns and this plan must not touch:** `src/capacity/*`, `src/sweep/*`, `src/notify/templates/*` except the one you add, `src/routes/cancel.ts`, and the `audit_log`/`responses`/`fixtures` areas of the schema.

**Three shared files will collide:**
- `src/db/schema.ts` — append only, never reorder. **M4 takes migration `0003`. You take `0004`, and you must rebase onto merged M4 before running `db:generate`** — drizzle-kit numbers sequentially and two `0003`s cannot both apply. If you generate before rebasing you will have to regenerate.
- `src/env.ts` — append only.
- `src/app.ts` — append only, one `app.route` per plan. **You also add middleware here**, which M4 does not; keep it in its own clearly-commented block.

Whichever merges second rebases and re-runs the full suite before merging.

## Dependency research already done — read this before installing anything

This was verified against the actual published packages on 11 August 2026, because the spec committed to Better Auth without checking and two search results turned out to be wrong.

- **`better-auth@1.6.26`.** Its peer dependencies name `drizzle-orm ^0.45.2` and `drizzle-kit >=0.31.4` — exactly what this project has installed. No version fight.
- **Three packages, not one.** `better-auth`'s `./adapters/drizzle` export is a bare re-export of a separate package, `@better-auth/drizzle-adapter`. The passkey plugin is **not in core at all** — it is `@better-auth/passkey`. Both are version-locked to 1.6.26.
- **There is no native D1 support.** A search result claimed 1.5 added it; inspecting the package showed those matches were Cloudflare *Turnstile captcha* strings. Go through the Drizzle adapter.
- **`./plugins/magic-link` exists in core**, exporting `magicLink(options)`.

**The hazard to design around.** Creating a *second* Drizzle wrapper around the same D1 binding — one for the app, one for Better Auth — causes SQLite write-ahead-log contention under Miniflare. A magic-link verification writing a session while middleware reads has been reported blocking for thirty seconds and more. **Pass the existing `getDb(env.DB)` instance to the adapter; do not construct a new one.** This also happens to be what TR-1's per-request factory rule pushes you toward.

## What exists already

Read `docs/superpowers/plans/2026-08-10-m2-m3-responses-and-email.md`'s "Post-implementation corrections" section first — it records testing-tool APIs that differ from their documentation.

| Module | What you will use |
|---|---|
| `src/db/client.ts` | `getDb(d1)` → the one Drizzle instance. Give this to Better Auth. |
| `src/db/schema.ts` | `players` already has a nullable `auth_user_id` waiting for you (TR-30). |
| `src/env.ts` | `Bindings`. You add auth bindings. `AppEnv` currently has no `Variables` slot — you add one for the session. |
| `src/app.ts` | `createApp()`, security-header middleware, `notFound`, `onError`. |
| `src/notify/*` | `createNotifier(env)` returns a quota-wrapped notifier. **Send the magic link through it**, so the daily ceiling applies and no non-production environment can email a real person. |
| `src/views/layout.ts` | `layout({title, body})`, `escapeHtml`, and a single shared `STYLES` block you will need to split — see Task 7. |
| `src/db/queries.ts` | `getFixtureWithSquad`. The dashboard needs a different, cross-fixture query. |
| `src/domain/fixture-view.ts` | `fixtureView(facts, now)` for each row's status. |
| `test/support/factories.ts` | `insertGame(db, overrides)` — **`db` first** — `resetDatabase()`. |

## Global Constraints

- TypeScript, `strict: true` with `noUncheckedIndexedAccess`. No `any` outside a documented type-guard boundary.
- **Pages must be fully usable with scripting disabled.** JavaScript is permitted as progressive enhancement. Magic-link sign-in must work with JavaScript off; passkeys inherently cannot, which is why they are an enhancement and never the only route in.
- **`GET` must never mutate and there is no auto-submit anywhere.**
- **No password field anywhere in the codebase** (TR-16). Magic link and passkey only.
- **Owner actions and cross-fixture views require a session** (TR-17, BR-25), re-checked server-side on every request (TR-18). M4 adds one narrow, documented exception for a single token-authorised cancel action; it does not generalise.
- **The word "team" is brand-only.** Note Better Auth's own tables use "user" — that is a third-party schema and is exempt, but never use "user" in code you write; say Player.
- **Vocabulary is fixed:** Game, Fixture, Player, Membership, Squad, Response, Reminder, Lifecycle, Display status, Short, Uneven. Never "event", "match", "user", or "RSVP".
- **Pure domain modules take `now: Date` as a parameter.** No `Date.now()` or zero-argument `new Date()` under `src/domain/`.
- **Timezone conversion and date formatting happen only in `src/domain/time/zone.ts`.**
- **Every capacity-affecting write goes through the Durable Object; reads never do.** The dashboard changes responses, so it writes through the object exactly as `POST /r/:token` does.
- Migrations are expand-only and forward-only, generated by drizzle-kit, never hand-edited.
- Tests run in workerd against real bindings. Never mock D1.
- No secrets in the repo. It is public with push protection.
- Commit with a conventional prefix and **watch the actual CI run to completion** before reporting done.

---

## Task 1: Install, wire the adapter, and prove it round-trips

**Files:** `package.json`; create `src/auth/factory.ts`, `test/auth/factory.test.ts`; modify `src/db/schema.ts`, `src/env.ts`; generated `migrations/0004_*.sql`.

- [ ] **Step 1** — Install all three packages at 1.6.26. Run `npm ls` afterwards and confirm no `invalid` or unmet peer markers; quote the output.
- [ ] **Step 2** — Add Better Auth's required tables to `src/db/schema.ts`. Use its CLI or documented schema as the source of truth for column names — **do not invent them**, because the library queries by exact name. Keep them in a clearly-marked block, separate from the domain tables, with a comment saying they are third-party-defined and must not be renamed to match project vocabulary.
- [ ] **Step 3** — `npm run db:generate` → `0004_*.sql`. Read it. Additive only. Quote it.
- [ ] **Step 4** — Write `createAuth(env)` in `src/auth/factory.ts`. **Per request, never module-level** (TR-1) — D1 bindings do not exist at module scope and a singleton fails in a way that is hard to diagnose. It takes the already-constructed `getDb(env.DB)` instance; it must not call `getDb` itself or construct a second Drizzle wrapper. Comment why, referencing the WAL contention above.
- [ ] **Step 5** — Add bindings: `BETTER_AUTH_SECRET` (a Worker secret, generated and set the same way `RESPONSE_TOKEN_SECRET` was — piped straight in, never printed) and `BETTER_AUTH_URL`. Add a test-only secret to `vitest.config.ts`'s `miniflare.bindings` — **not to `wrangler.jsonc` vars**, which would ship a fake secret to production config. This exact mistake cost a red CI earlier in the project.
- [ ] **Step 6** — Prove the adapter actually talks to D1: a test that creates a record through Better Auth's own API and reads it back with Drizzle. If that round-trip works, the integration is real; if it does not, stop here and report rather than building on it.
- [ ] Commit `feat: better auth over the existing D1 instance`.

---

## Task 2: Link a signed-in identity to a Player

**Files:** create `src/auth/link-player.ts`, `test/auth/link-player.test.ts`.

Implements TR-30. Better Auth owns its own tables; `players` is the domain record; `players.auth_user_id` is the nullable link. Most players never sign in and never get one.

`linkPlayerOnSignIn(db, {authUserId, verifiedEmail, name, now})`:
- Matches an existing `players` row **by verified email only**. An unverified address must never claim an existing Player — that would be account takeover by typing someone else's address.
- If a match exists and has no `auth_user_id`, set it.
- If a match exists with a *different* `auth_user_id`, that is a conflict. Do not silently overwrite. Decide the behaviour, implement it, and justify it in your report — consider that this is reachable if someone signs in with a second provider identity for the same address.
- If no match exists, create a Player. They are a real person who signed in; they simply are not in any squad yet.
- Never touches `is_guest` rows, which by definition have no email.

- [ ] Tests: fresh link; idempotent re-sign-in; existing Player with a different `auth_user_id`; no match creates a Player; a guest is never matched; case-insensitivity of email matching — decide whether to normalise and test whichever you choose.
- [ ] Commit `feat: link an authenticated identity to a Player (TR-30)`.

---

## Task 3: Magic link, through our Notifier, behind the allowlist

**Files:** modify `src/auth/factory.ts`; create `src/notify/templates/magic-link.ts` and tests; modify `src/env.ts`.

Two things happen here and both matter.

**The magic link goes through our `Notifier`,** not Better Auth's own transport. `createNotifier(env)` returns a quota-wrapped notifier, so the daily ceiling applies and `NullNotifier` guarantees no non-production environment can email a real person. Wire the plugin's send callback to it.

Per the spec's dedupe table, **N-5 is deliberately not written to `notification_log`** — Better Auth owns issuance and rate limiting, and a sign-in link is not a fixture notification. Do not add a dedupe key for it.

**This task also closes TR-35**, deferred all the way from M0 with the note "lands in M5 with Better Auth". During the trial, magic-link issuance is gated by a `SIGNIN_ALLOWLIST` secret — a comma-separated list of addresses.

The gate has one critical property: **a request for an address not on the list must return the same "check your inbox" page and send nothing.** It must not reveal whether an address is known, allowlisted, or a registered Player. Anything else turns the sign-in form into an account-enumeration oracle on a public site.

Removing the gate at launch must be deleting one check. Write it that way.

- [ ] Tests: an allowlisted address receives a link; a non-allowlisted one gets a byte-identical response and **no send at all** — assert the notifier was not called, not merely that no email arrived; whitespace and case in the allowlist are handled; an empty or unset allowlist fails **closed**, not open, and say why in your report; the email renders in both HTML and text and contains a working link.
- [ ] Commit `feat: magic link through the notifier, gated by the sign-in allowlist (N-5, TR-35)`.

---

## Task 4: Session middleware

**Files:** modify `src/app.ts`, `src/env.ts`; create `src/auth/session.ts`, `test/auth/session.test.ts`.

- [ ] Add a `Variables` slot to `AppEnv` carrying the current session and the resolved Player. It has none today; M4 does not touch this file's types, so the collision is limited to import lines.
- [ ] Middleware resolves the session on every request and puts it on the context. It must be **cheap and non-fatal for anonymous traffic** — the holding page and `/r/:token` are hit by strangers and prefetchers, and neither should pay for a session lookup that will not exist. Decide whether to scope the middleware to authenticated routes only, and justify it.
- [ ] A `requireSession` helper for routes that need one, redirecting to sign-in rather than erroring.
- [ ] A `requirePlayer` helper resolving the domain Player, since a session without a linked Player is possible.
- [ ] **TR-18 is not satisfied by middleware alone.** Ownership must be re-checked server-side in the handler for every owner action. Middleware establishes *who*; it never establishes *entitled*. Write that in a comment where someone adding an owner route will read it.
- [ ] Tests: anonymous requests are unaffected and still fast; a valid session resolves; an expired or tampered session cookie is treated as anonymous, never as an error; `requireSession` redirects rather than 500s.
- [ ] Commit `feat: session middleware and route guards`.

---

## Task 5: Sign in and sign out

**Files:** create `src/routes/signin.ts`, `src/views/signin.ts`, `test/routes/signin.test.ts`; modify `src/app.ts`.

- `GET /signin` renders a single email field and a submit button. No password field, ever (TR-16).
- `POST /signin` requests a magic link and renders "check your inbox" — the same page whatever the outcome, per Task 3.
- `GET /signin/verify` (or whatever path the plugin uses — read it, do not guess) completes sign-in, links the Player via Task 2, and redirects to the dashboard.
- `POST /signout` ends the session. **`POST`, not `GET`** — a `GET` sign-out can be triggered by any image tag or prefetcher on a page.

Must work entirely without JavaScript. Reuse `layout()` and the existing token-based styles rather than inventing a second visual language.

- [ ] Tests through `SELF.fetch`: the full happy path; a reused verification link is rejected; an expired one is rejected; sign-out actually ends the session; `GET /signout` does not sign out; there is no `type="password"` anywhere in any rendered page — assert it across every page the app can render.
- [ ] Commit `feat: sign-in and sign-out without JavaScript`.

---

## Task 6: The player dashboard

**Files:** create `src/routes/dashboard.ts`, `src/views/dashboard.ts`, `src/db/dashboard-queries.ts`, and tests; modify `src/app.ts`.

Implements J7 and BR-25: a signed-in player sees their upcoming fixtures **across all their games**, with current status, and can change any response.

- Requires a session. Anonymous access redirects to sign-in — it must not leak whether a given player exists.
- Shows only fixtures for games where the viewer has an **active** membership, and only non-terminal ones by default. Past fixtures are not in scope for this milestone.
- Each row shows the game, when and where, the display status from `fixtureView`, and the viewer's own response.
- Changing a response **goes through the Durable Object**, exactly as `POST /r/:token` does, with `source: "web"` rather than `"token"` — the source column exists to tell them apart. Reuse the existing render helper rather than writing a second one.
- Responses on a `played` fixture are locked (BR-15).

**Do not show other players' names here.** BR-25 authorises a cross-fixture view of the viewer's own commitments; the full squad list belongs to the fixture page.

- [ ] Tests: only the viewer's active games appear; a game they left does not; ordering is by kickoff ascending; changing a response updates it and goes through the object — assert capacity is respected by making the change hit a full fixture and confirming a waitlist placement; a `played` fixture offers no action; anonymous access redirects.
- [ ] Commit `feat: player dashboard across games (J7, BR-25)`.

---

## Task 7: Split the shared stylesheet

**Files:** `src/views/layout.ts` and every view.

`layout()` inlines **one** `STYLES` block into every page. The M2–M3 review flagged that the fixture page's CSS already leaks onto the holding page, which costs bytes on a poor connection and once forced a domain concept to be renamed to dodge a test assertion. The dashboard makes it worse.

- [ ] Give `layout()` an optional per-page style parameter. Shared primitives — tokens, body, typography, buttons — stay global; page-specific rules move to their page.
- [ ] Confirm the holding page no longer carries fixture or dashboard CSS.
- [ ] **Restore the domain vocabulary.** The CSS class `.roster` was renamed from `.squad` purely to dodge the holding page's forbidden-word assertion. With the leak fixed, rename it back — "Squad" is the sanctioned term and "roster" is an unsanctioned synonym that exists only as a workaround.
- [ ] Confirm the holding page's forbidden-word test still passes, and that it now passes for the right reason.
- [ ] Commit `refactor: split page styles so each page ships only its own`.

---

## Task 8: Passkeys, as an enhancement

**Files:** modify `src/auth/factory.ts`, `src/routes/signin.ts`, `src/views/signin.ts`; add a small client script; tests.

Add `@better-auth/passkey`. This introduces the **first JavaScript in the codebase**, so it needs care.

- WebAuthn is a browser API and cannot work without JavaScript. That is why passkeys are an enhancement and magic link is the baseline.
- **With JavaScript disabled, the sign-in page must be exactly as usable as before** — the passkey affordance simply is not there. Test with scripting off and assert the magic-link path is complete and unbroken.
- The script must be inline or same-origin; a strict CSP is in place from M4's Task 9, so verify it does not block you and adjust deliberately rather than by loosening the policy to `unsafe-inline` without thought.
- Registration belongs behind an existing session — a player signs in by magic link first, then adds a passkey. Do not build a passkey-only registration path; it would leave someone locked out if their authenticator is lost.
- No password field appears anywhere, still.

- [ ] Tests: the plugin is configured; a session is required to register; the page is fully functional with scripting disabled; the JavaScript is not required for any other page.
- [ ] Commit `feat: passkeys as a progressive enhancement`.

---

## Task 9: Deploy and verify

- [ ] Rebase onto `main` if M4 landed first, regenerate the migration if its number now clashes, and re-run the full suite before merging.
- [ ] Set `BETTER_AUTH_SECRET` and `SIGNIN_ALLOWLIST` as Worker secrets — piped in, never printed, never committed.
- [ ] Merge and let CI deploy. Watch it.
- [ ] Verify against production read-only: migration `0004` recorded, Better Auth tables present, and **the existing Game, Fixtures, Responses and notification rows untouched.**
- [ ] Sign in end to end in production with an allowlisted address. Confirm the link arrives, works once, and is rejected on reuse. Confirm a non-allowlisted address gets the identical page and no email.
- [ ] Confirm `/dashboard` redirects when anonymous and renders when signed in.
- [ ] Update `docs/known-issues.md`: strike TR-35 as closed, strike the `.roster` naming entry, and record anything newly deferred.

---

## Done conditions

| Condition | Verified by |
|---|---|
| Sign-in works with JavaScript disabled | `npm test -- test/routes/signin.test.ts` plus a manual check |
| No password field exists anywhere | An assertion across every rendered page |
| A non-allowlisted address is indistinguishable from an allowlisted one | `npm test -- test/auth/` — assert the notifier was never called |
| An unallowlisted or empty allowlist fails closed | Same |
| Better Auth shares the one Drizzle instance | Code review plus the round-trip test from Task 1 |
| A verified email links to an existing Player; an unverified one never does | `npm test -- test/auth/link-player.test.ts` |
| Dashboard shows only the viewer's active games | `npm test -- test/routes/dashboard.test.ts` |
| A dashboard response change respects capacity | Same — assert a waitlist placement on a full fixture |
| The holding page carries no dashboard or fixture CSS | `npm test -- test/routes/access.test.ts` |

## What M6 inherits

Owner tools arrive into a working session layer with `requireSession` and `requirePlayer` helpers, a `Variables` slot on the context, and — from M4 — `audit_log` and a `cancelFixture` domain function that only needs a session-authorised caller. TR-18 remains the thing M6 must not forget: middleware says who, the handler must still check entitled, on every request.
