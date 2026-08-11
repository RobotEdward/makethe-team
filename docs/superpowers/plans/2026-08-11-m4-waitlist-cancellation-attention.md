# Make The Team — M4: Waitlist Promotion, Cancellation and Owner Attention

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When someone drops out, the next player in the queue is let in and told. When a game is off, everyone affected finds out. When a game needs the organiser's attention, they hear about it in time to do something.

**Architecture:** Waitlist promotion happens inside the Durable Object's existing critical section, in the same `db.batch()` as the dropout — but the resulting email is sent *outside* the lock, because an HTTP call inside it would serialise every other tap on that fixture behind a provider round-trip. Cancellation is authorised by a signed token delivered to the owner's verified address, the same mechanism as response tokens, because there is no session until M5.

**Tech Stack:** Unchanged. TypeScript strict, Hono, Cloudflare Workers, D1, Durable Objects, Drizzle, Resend.

**Spec:** `docs/superpowers/specs/2026-08-10-make-the-team-design.md`.

**Runs in parallel with:** `2026-08-11-m5-auth-and-dashboard.md`. See "Working in parallel" below — the two plans were scoped to avoid collisions, and the seams are listed explicitly.

## Working in parallel with M5

Both plans run in separate git worktrees off `main` and merge independently. Use superpowers:using-git-worktrees to create yours.

**Files this plan owns and M5 must not touch:** `src/capacity/*`, `src/sweep/*`, `src/notify/templates/*`, `src/routes/cancel.ts`, and the `audit_log`, `responses` and `fixtures` areas of `src/db/schema.ts`.

**Files M5 owns and this plan must not touch:** `src/auth/*`, `src/routes/signin.ts`, `src/routes/dashboard.ts`, and the Better Auth tables in the schema.

**Three shared files will collide. Handle them deliberately:**
- `src/db/schema.ts` — both add tables. Append only, never reorder. M4 takes migration `0003`; **M5 takes `0004` and must rebase onto merged M4 before generating it**, because drizzle-kit numbers sequentially and two `0003`s cannot both apply.
- `src/env.ts` — both add bindings. Append only.
- `src/app.ts` — both mount routes. Append only, one `app.route` line each.

Whichever merges second rebases and re-runs the full suite before merging. Do not merge on a red suite to "fix it after".

## What exists already

Read `docs/superpowers/plans/2026-08-10-m2-m3-responses-and-email.md` first, especially its "Post-implementation corrections" section — it records dependency APIs that differ from their documentation and will save you a wasted task.

| Module | What you will use |
|---|---|
| `src/capacity/fixture-capacity.ts` | `FixtureCapacity` Durable Object. `setResponse` runs inside `ctx.blockConcurrencyWhile`. Derives its fixture id from `this.ctx.id.name`. |
| `src/capacity/types.ts` | `SetResponseInput`, `SetResponseOutcome` — a closed union you will extend. |
| `src/domain/token.ts` | `signResponseToken`, `verifyResponseToken`, `responseTokenExpiry`. Canonical base64url, constant-time compare, fails closed. |
| `src/domain/fixture-view.ts` | `fixtureView(facts, now)` → status, flags, `needsOwnerAttention`. Already computes exactly the condition N-4 fires on. |
| `src/notify/*` | `Notifier`, `createNotifier(env)` (quota-wrapped, includes the `resend` branch), `Message`, `SendResult`. |
| `src/notify/dedupe-key.ts` | `reminderKey`, `promotionKey`, `cancellationKey`, `attentionKey`, `welcomeKey`. **All five already exist** — N-2, N-3 and N-4's keys are written and tested. |
| `src/notify/templates/reminder.ts` | The pattern to copy for new templates: typed payload in, `{subject, html, text}` out, pure. |
| `src/sweep/open-and-remind.ts` | Steps 1 and 2, per-fixture failure isolation, insert-before-send, the retryable/ambiguous asymmetry. |
| `src/sweep/retire.ts` | Step 4. |
| `src/db/chunk.ts` | `chunk`, `INSERT_CHUNK_SIZE` (8). |
| `test/support/factories.ts` | `gameRow`, `insertGame(db, overrides)` — **`db` first** — `resetDatabase()`, `testDb()`. |

## Global Constraints

- TypeScript, `strict: true` with `noUncheckedIndexedAccess`. No `any` outside a documented type-guard boundary.
- Every page must be fully usable with scripting disabled. JavaScript is permitted as progressive enhancement but nothing may require it. **`GET` must never mutate and there is no auto-submit anywhere** — link prefetchers follow every URL in an email and some execute JavaScript.
- **The word "team" is brand-only** — never in a table, column, type, function or variable name.
- **Vocabulary is fixed** and binds user-facing copy: Game, Fixture, Player, Membership, Squad, Response, Reminder, Lifecycle, Display status, Short, Uneven. Never "event", "match", "user", or "RSVP".
- **`lifecycle` is stored; `short`, `confirmed` and `uneven` are derived** and never persisted.
- **Pure domain modules take `now: Date` as a parameter.** No `Date.now()` or zero-argument `new Date()` under `src/domain/`.
- **Timezone conversion and date formatting happen only in `src/domain/time/zone.ts`.** No other file may construct an `Intl.DateTimeFormat`.
- **Chunk every multi-row insert at 8 rows** using `src/db/chunk.ts`.
- **Every capacity-affecting write goes through the Durable Object; reads never do.**
- **Never send email from inside `ctx.blockConcurrencyWhile`.** See Task 3.
- Migrations are expand-only and forward-only, generated by drizzle-kit, never hand-edited.
- Tests run in workerd against real bindings. Never mock D1 or the Durable Object.
- No secrets in the repo. It is public with push protection.
- Commit with a conventional prefix, and **watch the actual CI run to completion** with `gh run watch` before reporting a task done. Local green is not CI green.

## Spec amendments this plan makes

1. **TR-17 gains an exception for a single scoped owner action.** It currently says sessions are required for *every* owner action. J5 promises the owner attention email carries a one-tap cancel link, and there is no session until M5. Cancellation is therefore authorised by an HMAC token scoped to one owner, one fixture, and the single action of cancelling — delivered only to an address already verified by the fact that the owner receives mail there. This is the same trust model as BR-23's response tokens, narrowed further. Sessions remain required for every *other* owner action and for all cross-fixture views.
2. **`SetResponseOutcome` gains a promotion field.** The Durable Object must tell its caller that a promotion happened so the caller can send N-2 after the lock releases.
3. **`audit_log` is created here**, not in M6. BR-27 requires owner actions and lifecycle changes to be recorded, and cancellation is the first of both.

---

## Task 1: `audit_log`

**Files:** modify `src/db/schema.ts`; create `src/db/audit.ts`, `test/db/audit.test.ts`; generated `migrations/0003_*.sql`; modify `test/support/factories.ts`.

**Produces:** an `auditLog` table and `recordAudit(db, entry)`.

Per spec §2.8: `id`, **nullable** `actor_player_id` (cron and system actions have no actor), `entity_type`, `entity_id`, `action`, `before_json`, `after_json`, `created_at`.

- [ ] **Step 1** — Add the table. Index on `(entity_type, entity_id)` and on `created_at`; audit rows are read by entity far more often than scanned.
- [ ] **Step 2** — `npm run db:generate`. Read `migrations/0003_*.sql` and confirm it contains only `CREATE TABLE` and indexes — no `DROP`, no `ALTER` of an existing table. Quote it in your report.
- [ ] **Step 3** — Write `recordAudit(db, {actorPlayerId, entityType, entityId, action, before, after, now})`. It serialises `before`/`after` to JSON. Keep it a single small function; every later task calls it rather than inserting directly.
- [ ] **Step 4** — Extend `resetDatabase()` to clear `audit_log`, in the correct child-first position. **Add a test asserting the reset actually empties it** — a leak here produces confusing failures in later tasks, and this exact mistake has already happened once in this project.
- [ ] **Step 5** — Tests: a null actor is accepted; `before`/`after` round-trip through JSON; two entries for the same entity are both retained (this is a log, not a state table, so no unique constraint).
- [ ] **Step 6** — `npm test`, `npm run typecheck`, `npm run lint`, `npm run db:migrate:local`. Commit `feat: audit log table (BR-27)`. Watch CI.

---

## Task 2: Owner cancellation tokens

**Files:** modify `src/domain/token.ts`; modify `test/domain/token.test.ts`.

**Produces:** `signCancelToken(payload, secret)`, `verifyCancelToken(token, secret, now)`, `cancelTokenExpiry(kicksOffAt)`, and a `CancelTokenPayload` of `{ ownerPlayerId, fixtureId, expiresAt }`.

**Do not copy-paste the response token implementation.** Extract what is shared — base64url with the canonical round-trip check, the HMAC key derivation, the constant-time comparison, the fail-closed expiry — and have both token types use it. Two hand-maintained copies of a signing routine is how one of them quietly stops matching the other.

**A cancel token must not be usable as a response token, or vice versa.** Include a type discriminator inside the *signed* payload, so a token minted for one purpose fails verification for the other rather than merely failing a shape check afterwards. Test this explicitly in both directions — it is the whole reason this task is separate from Task 7.

Expiry: at kickoff. Cancelling after the game has started is meaningless, and a shorter life is a smaller window.

- [ ] Write the failing cross-use tests first: a valid response token rejected by `verifyCancelToken`, and a valid cancel token rejected by `verifyResponseToken`, both as `bad-signature` or a dedicated reason — never as a successful parse.
- [ ] Re-run the existing response-token suite unchanged. If any assertion needs editing, the refactor changed behaviour and is wrong.
- [ ] Carry over every hardening already in place: canonical encoding on both halves, `typeof` guard, empty-secret asymmetry, expiry failing closed on a non-finite `now`.
- [ ] Commit `feat: owner cancellation tokens sharing the signing core`.

---

## Task 3: Waitlist promotion inside the lock, notification outside it

**Files:** modify `src/capacity/fixture-capacity.ts`, `src/capacity/types.ts`; modify `test/capacity/set-response.test.ts`.

This is the correctness core of M4 and implements BR-7.

**What happens inside the lock:** when a player leaves `in` — going `out` or `withdrawn` — the longest-waiting waitlisted player is promoted to `in`. "Longest waiting" is the **lowest live `waitlist_position`**. Positions are permanent and gappy; the next joiner takes the highest live position plus one, so a departed top position is reused and numbering restarts at 1 on an empty waitlist. The property that holds, and that this task depends on, is that the lowest live position is the earliest arrival.

The promotion must be in the **same `db.batch()`** as the dropout. If they were separate writes, a failure between them would free a slot without filling it, or fill one that was never freed.

**What must happen outside the lock:** the N-2 email. `setResponse` runs wholly inside `ctx.blockConcurrencyWhile`, and an HTTP call to a mail provider inside that section serialises every other tap on that fixture behind it — a Resend timeout would freeze the fixture for everyone. Return the promotion in the outcome and let the caller send.

- [ ] **Step 1** — Extend `SetResponseOutcome`. The `recorded` variant gains an optional promotion carrying at least the promoted player's id and their previous waitlist position. Document why it is there.
- [ ] **Step 2** — Write the failing tests before touching the object:
  - A dropout from a full fixture promotes exactly one player, and it is the one with the lowest live position — not the lowest id, not the most recent.
  - The promoted player's row becomes `in` with a null `waitlist_position`; the cached counts are correct afterwards.
  - Nobody is promoted when the waitlist is empty, or when the fixture was not full.
  - An `out` from a player who was already `out` promotes nobody.
  - **Concurrency:** many simultaneous dropouts on a fixture with a long waitlist promote exactly as many players as there were dropouts, with no player promoted twice and no slot left unfilled. Assert `in_count` equals `COUNT(*)` afterwards.
  - **No network call happens inside the object.** Assert it directly — grep the module for `fetch` and assert the absence, and confirm the outcome carries the promotion rather than the object sending anything.
- [ ] **Step 3** — Implement. Read all responses once at the top as the existing code does, decide in memory, write one batch.
- [ ] **Step 4** — **Prove the lock still matters.** Temporarily remove `blockConcurrencyWhile` and confirm the concurrency test fails; restore and confirm green. Quote both outputs. This has caught a real double-booking before and the promotion path is new exposure.
- [ ] **Step 5** — Commit `feat: waitlist promotion inside the capacity lock (BR-7)`.

---

## Task 4: N-2, the promotion email

**Files:** create `src/notify/templates/promotion.ts`, `test/notify/templates/promotion.test.ts`; modify `src/routes/respond.ts`.

**Produces:** `renderPromotionEmail(payload)` → `{subject, html, text}`, and the wiring that sends it after the Durable Object returns.

Copy the structure of `src/notify/templates/reminder.ts`: pure, typed payload, both renditions mandatory, everything escaped, a working leave link, no date formatting inside the template.

**Only the promoted player is notified** (N-2, J4). Nobody else hears anything — not the person who dropped out, not the rest of the squad.

**The dedupe key already exists:** `promotionKey(fixtureId, playerId, promotedAt)`. Note it includes a timestamp, deliberately, so a player promoted twice is told twice — unlike N-4, which fires once ever. Do not "make them consistent".

The send happens in `POST /r/:token` after `setResponse` returns, using the same insert-before-send ordering the reminder sweep uses: write the `notification_log` row first, then send, then record the outcome. Reuse the sweep's helper rather than writing a second copy — if it is not currently exported in a usable shape, extract it, and say so in your report.

- [ ] The player who dropped out must still get their own page rendered promptly. A slow provider call must not delay their response being confirmed — decide deliberately whether to await the send or hand it to `ctx.waitUntil`, and justify the choice in your report. Note that `waitUntil` failures are invisible unless logged, and this project has fixed that class of bug twice.
- [ ] Tests: exactly one email, to the promoted player only; nothing sent when nobody was promoted; a promoted player with no email address is skipped without error and without a log row; a send failure does not break the dropping player's page.
- [ ] Commit `feat: waitlist promotion email (N-2)`.

---

## Task 5: N-3, the cancellation email

**Files:** create `src/notify/templates/cancellation.ts`, `test/notify/templates/cancellation.test.ts`.

Per BR-20, recipients are everyone who was `in` **or** `waitlisted` — not `out`, not `pending`, not `withdrawn`, and never a guest, who has no address.

The message must lead with the fact that the game is off, carry the cancellation reason if one was given, and not read as if it might still happen. Include the leave link as every message must (BR-22).

Dedupe key: `cancellationKey(fixtureId, playerId)` — once per player per fixture.

- [ ] Tests: the recipient set is exactly right across a squad containing all five response states plus a guest; the reason appears when given and the message still reads correctly when it is absent; both renditions; escaping, including a hostile reason string.
- [ ] Commit `feat: cancellation email (N-3)`.

---

## Task 6: Cancelling a fixture

**Files:** create `src/domain/cancel-fixture.ts`, `test/domain/cancel-fixture.test.ts`.

**Produces:** `cancelFixture(db, {fixtureId, actorPlayerId, reason, now})` → a result carrying the recipients to notify.

Implements BR-14: always manual, always by an owner, always from a non-terminal lifecycle.

- Sets `lifecycle = 'cancelled'`, `cancelled_at`, `cancellation_reason`.
- Refuses a fixture already `cancelled` or `played`, returning a reason rather than throwing.
- **Verifies the actor is an active owner of that Game.** The token proves who they are; this proves they are still entitled. An owner removed from the squad after the email was sent must not be able to cancel.
- Writes an `audit_log` entry with the actor, the before and after lifecycle (BR-27).
- Returns the players who were `in` or `waitlisted` so the caller can send N-3. **This function sends nothing** — it is a pure-ish domain operation over the database, and keeping the send in the route keeps it testable.

Cancellation does **not** go through the Durable Object. It is a lifecycle change, not a capacity write, and the object's job is serialising slot arithmetic. Note in a comment that responses on a cancelled fixture are effectively frozen because `setResponse` already refuses a non-`open` fixture.

- [ ] Tests: a scheduled fixture cancels; an open one cancels; a cancelled one refuses; a played one refuses; a non-owner refuses; an inactive owner refuses; the audit row is written with the right before and after; the returned recipients are exactly the `in` and `waitlisted` players; the reason is stored verbatim including when empty.
- [ ] Commit `feat: cancel a fixture (BR-14, BR-27)`.

---

## Task 7: The cancellation route

**Files:** create `src/routes/cancel.ts`, `test/routes/cancel.test.ts`; modify `src/app.ts`.

`GET /cancel/:token` renders. `POST /cancel/:token` cancels and sends N-3.

Everything the response route learned applies here and is not optional:

- **`GET` must record nothing.** Snapshot the fixture row, every response row and the audit table before and after, and assert byte-identical. A prefetcher must leave no trace, and this endpoint destroys a game.
- **A bad token renders the same shared failure page** as the response route, with no branching on the reason. Cancelling is a higher-value target than responding; do not turn this page into an oracle.
- The `GET` page shows what will happen before it happens: the fixture, how many players are in, how many will be emailed, and a free-text reason field. Cancelling a game is not a two-tap decision made lightly — this page should feel like a confirmation, not a button.
- The `POST` requires the reason field to be present but permits it to be empty, and must be idempotent: a second POST on an already-cancelled fixture renders "this is already cancelled" and sends nothing further.
- No JavaScript. One form, one submit.

- [ ] Tests: the full happy path end to end through `SELF.fetch`; `GET` mutates nothing; expired, tampered, malformed and cross-purpose tokens all render the shared page and cancel nothing; **a response token presented at `/cancel/` is rejected**; a non-owner token is rejected; double-POST cancels once and emails once.
- [ ] Commit `feat: owner cancellation route with signed token (TR-17 amendment)`.

---

## Task 8: N-4, the owner attention email

**Files:** create `src/notify/templates/attention.ts`, `src/sweep/attention.ts`, and their tests; modify `src/cron/handler.ts`.

This is the spec's sweep step 3, and it is what makes SC-4 true — the organiser learns the game needs help in time to do something.

`fixtureView(facts, now)` already computes `needsOwnerAttention`, which is true inside the warning window when the fixture is `short` **or** flagged `uneven`. Use it; do not re-derive the condition.

Per BR-31: the sweep evaluates on **every** run inside the window and sends the first time the condition holds — so a late dropout leaving an odd number still triggers it even though the fixture was fine at the threshold. **At most one N-4 per owner per fixture, ever**, enforced by the `attentionKey` dedupe key. A fixture that is short, then fixed, then uneven sends one email, not two.

The email carries the current squad, the non-responders, the specific problem in plain words, and the cancel link from Task 2. Distinguish the two problems in the copy: "you are two short" and "you have an odd number" are different asks.

Wire it into the hourly branch between the reminder sweep and retirement, with the same per-fixture failure isolation. A failure here must not stop retirement.

**Also close TR-31 while you are here.** The daily send ceiling has no owner-visible warning; this email is the natural channel, and the deferred item in `docs/known-issues.md` names this task. Decide how — a line in the N-4 email when the ceiling is biting, or a distinct signal — and say why in your report.

- [ ] Tests: fires for short inside the window and not outside it; fires for uneven; **does not fire for a fixture that is merely below minimum outside the window**; sends once ever across short-then-fixed-then-uneven; goes to owners only, never ordinary players; a game with two owners sends to both, once each; a failure sending to one fixture does not stop the others or block retirement.
- [ ] Commit `feat: owner attention email and sweep step 3 (N-4, BR-31)`.

---

## Task 9: Shared plumbing, before it is copy-pasted

**Files:** `src/sweep/open-and-remind.ts` and the four templates; `src/app.ts`.

The final M2–M3 review flagged two things that get worse with every template added, and this milestone adds three.

- [ ] **Extract `SITE_ORIGIN`.** It is a hardcoded constant in `open-and-remind.ts` and is about to be needed by promotion, cancellation and attention. One definition, imported. Keep it a compile-time constant rather than a binding — that was a deliberate choice and revisiting it belongs with a second environment, not here.
- [ ] **Add CSP and `frame-ancestors` headers.** `docs/known-issues.md` defers this to "M4, alongside the next page that takes user input", and Task 7 is that page. The middleware in `src/app.ts` already sets three security headers; add these beside them. Verify no page breaks — particularly that the inline `<style>` block still applies, which a naive `default-src 'self'` will kill.
- [ ] Commit `refactor: share the site origin and add CSP headers`.

---

## Task 10: Deploy and verify

- [ ] Merge to `main` (see "Working in parallel" — rebase if M5 landed first) and let CI deploy. Watch it.
- [ ] Verify against production read-only: `audit_log` exists, migration `0003` recorded, and — critically — **the existing Game, Fixtures, Responses and notification rows are untouched.** There is real test data in production now.
- [ ] Drive the whole of J4 locally: fill a fixture to capacity, waitlist two more, have an `in` player drop out, and confirm exactly one promotion, exactly one email to exactly that player, and nothing to anyone else. Capture the transcript.
- [ ] Drive J5 locally: put a fixture inside the warning window one short, confirm the N-4 email, follow its cancel link, cancel with a reason, and confirm N-3 reaches the right people and nobody else.
- [ ] Update `docs/known-issues.md`: strike what this milestone resolved — the CSP entry, the TR-31 entry — and add anything newly deferred.

---

## Done conditions

| Condition | Verified by |
|---|---|
| A dropout promotes exactly the longest-waiting player | `npm test -- test/capacity/set-response.test.ts` |
| Concurrent dropouts promote exactly once each, no slot lost | Same file |
| No email is sent from inside the Durable Object | Grep plus the outcome-carries-promotion test |
| `blockConcurrencyWhile` is still load-bearing | The removal experiment, quoted in Task 3's report |
| Only the promoted player is notified | `npm test -- test/notify/templates/promotion.test.ts` |
| `GET /cancel/:token` mutates nothing | `npm test -- test/routes/cancel.test.ts` |
| A response token cannot cancel a fixture | Same file |
| One N-4 per owner per fixture across short→fixed→uneven | `npm test -- test/sweep/attention.test.ts` |
| Cancellation emails reach exactly `in` and `waitlisted` | `npm test -- test/notify/templates/cancellation.test.ts` |
| Owner actions are audited | `npm test -- test/domain/cancel-fixture.test.ts` |

## What M6 inherits

Owner tools arrive into: `audit_log` already carrying owner actions, cancellation already implemented as a domain function that only needs a session-authorised caller, and `recordAudit` ready for overrides. The `withdrawn` bug in `docs/known-issues.md` — the Durable Object's response lookup does not exclude it — must be fixed by whichever milestone first writes that status, which is M6 or M7.
