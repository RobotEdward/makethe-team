# Known issues and deferred findings

Findings raised during the M0–M1 and M2–M3 reviews that were deliberately **not** fixed,
each with the reason. Recorded here so the next milestone's plan can triage them rather
than rediscover them. Nothing in this list is a correctness bug in shipped behaviour.

Anything that *was* fixed lives in the git history, not here.

## Fix before a specific milestone

| Item | Where | Fix before |
|---|---|---|
| ~~An invalid or out-of-range `LocalParts` silently rolls over (`hour: 25` → next day, `month: 0` → previous December, `hour: NaN` → `RangeError`). Only reachable if a caller builds `LocalParts` without going through `parseLocalTime`.~~ | **Closed by M6a task 3, 12 August 2026.** `src/domain/time/zone.ts` itself is unchanged — the module still trusts its caller. What changed is that every form-supplied kickoff time now goes through `parseLocalTime` before it reaches `LocalParts`, so the bad state described here is unreachable from the game form. **Do not "fix" `zone.ts` believing this row means it is unguarded** — the guard lives at the form boundary, not in the module. |
| ~~A rejected time zone re-attempts `Intl.DateTimeFormat` construction on every call — nothing is negative-cached. Harmless until a user-supplied zone arrives at volume.~~ | **Closed by M6a task 3, 12 August 2026, on the same basis as the row above.** The game form's timezone picker and `game-form.ts`'s validator share exactly one list — `Intl.supportedValuesOf('timeZone')` — so a zone the validator would reject was never offered to pick in the first place, and a rejected zone cannot be submitted at volume or otherwise. `src/domain/time/zone.ts` still re-attempts construction on every call; nothing downstream negative-caches. This is closed by making the rejected state unreachable, not by changing the module. |
| ~~A game configured with an odd `max_players` while preferring even numbers, once full, is permanently both `full` and `uneven` with no possible remediation.~~ | **Closed by M6a task 3, 12 August 2026, as a soft warning, per spec Part 3 item 6; the delivery was completed by M6a's whole-branch review fix wave, which found the warning was computed and then thrown away by every caller.** The nudge now appears in two places when `max_players` is odd and `prefers_even_numbers` is set: on the game form's 422 redisplay (`parseGameForm` returns it on the failure variant too, so it is there while the owner is still editing), and on the game overview page `/g/:id`, re-derived from the *saved* row — which is where both create and edit land on their 303, so an owner meets it immediately after saving, and it keeps showing for as long as the configuration is still odd rather than flashing once. Both call `oddMaxWarning` in `src/domain/game-form.ts`, so there is one wording. BR-29 makes parity advisory only, so this is a nudge, not validation, and an owner may still save the configuration. `src/domain/fixture-view.ts`'s behaviour once such a fixture fills is unchanged and still correct for the advisory rule; only the discouragement at configuration time is new. |
| **Required reviewers are not enabled** on the `production` environment, so a compromised token or account can auto-deploy. Deliberately deferred: the database currently holds six plus-addressed test players, and an approval click per deploy is real friction during active development. **The trigger to enable it is the first real squad member's address going in**, not a date. Everything else on this environment is now locked down — see the note below. | GitHub → Settings → Environments → production | Before real players are added |
| ~~`respond-throttle` rate limiting for `/r/*`~~ | **Applied and verified 11 August 2026.** Measured against production: exactly 20 requests pass then 429, recovery after the mitigation window, and `/`, `/robots.txt` and `/leave/*` are unaffected. |
| ~~No CSP or `frame-ancestors` headers.~~ | **Applied, M4 task 9; amended twice since — the description below is current as of 12 August 2026.** `src/security/csp.ts` adds a `Content-Security-Policy` header alongside the three the middleware already set: `default-src 'none'`, `form-action 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, plus `style-src` and `script-src` as **hashes computed from `STYLE_BLOCKS` and `SCRIPT_BLOCKS` rather than pasted**, so they cannot silently go stale, and `connect-src 'self'`. M4's original `script-src 'none'` ("the site has no client JavaScript at all") stopped being true when M5 added the two passkey scripts; the merge tripwire in `src/views/scripts.ts` forced that correction. Scoped to `src/app.ts`'s response middleware only — email HTML in `src/notify/templates/*` is unaffected. Verified against every page the app renders. **See the `connect-src` post-mortem section below for the bug the second amendment fixed** — it is the one lesson from this header worth carrying forward. |
| ~~`cancelFixture`'s entitlement check depends on `memberships.active` being cleared when an owner is removed from a squad, but no code in `src/` writes `memberships.active` or `left_at` at all~~ | **Closed by J6a.** `removeMember` (`src/domain/remove-member.ts`) writes both `active: false` and `leftAt` in the same batch that also demotes `role` to `player`, so the convention `cancelFixture`'s entitlement check always relied on now has a real writer. No change was needed in `cancelFixture` itself — it already read the field this row worried nothing would set. | `src/domain/cancel-fixture.ts:92`, `src/domain/remove-member.ts` | Closed |
| ~~TR-31's "owner-visible warning" on reaching the daily send ceiling~~ | **Closed by M4 task 8, in two halves rather than one.** The owner-visible half is a line in the N-4 attention email, shown when the ceiling is biting (`handleScheduled` decides that from this run's deferred reminders **or** a `MAX_EMAILS_PER_DAY` that failed closed to zero, which is the config-typo case this row named). That half is best-effort by construction — a warning delivered by email is refused by the very condition it warns about — so the half an operator is expected to act on is durable: every ceiling refusal that costs a real message now writes an `audit_log` row (`fixture.promotion_email_deferred`, `fixture.cancellation_email_deferred`, `fixture.attention_email_deferred`) naming the fixture and every player who was not told, alongside a `console.error`. See `src/notify/ceiling-audit.ts`. |
| **The passkey scripts' `.catch()` blocks discard the error entirely** — no `console.error`, no distinction between "options request failed", "the authenticator refused" and "verification failed". On the public `/sign-in` page that is deliberate and should stay (a WebAuthn error can name a credential id, and the page is reachable by anyone). On `/app/passkeys`, which is already behind `requirePlayer`, the reasoning is much weaker, and the cost is real: diagnosing the `connect-src` bug below needed a `wrangler tail` against production to establish something a one-line message would have named immediately. | `src/views/scripts.ts` (`PASSKEY_REGISTER_JS`) | M6 |
| **A failed passkey *registration* returns 500, not 400.** Observed while mutation-testing the new end-to-end registration test: a bad `clientDataJSON.origin` produces a server error, where the *authentication* path correctly returns 400 for the same class of fault. The verification is working — it is the status mapping that is wrong — so this is a diagnosability and correctness-of-contract issue, not a hole. | `src/auth/factory.ts` / `@better-auth/passkey` `verify-registration` | M6 |
| ~~**BR-22 is not yet satisfied.** Every reminder carries a `GET /leave/:token` link so no message 404s, but the route only renders a page explaining that leaving is not self-service yet — it performs no write and is not a leave mechanism. **Amended, M6a task 10's review:** N-6 (the welcome email, M6a) carries no leave/unsubscribe link at all — not even the inert `/leave/:token` placeholder every other notification email has — because at send time no fixture may yet exist to scope a token to (`/leave/:token`'s token is fixture-scoped). M7's self-service leave work will therefore need a token scoped to `(gameId, playerId)` rather than `(fixtureId, playerId)` to give N-6 a link at all — additional design surface beyond what this row previously described. **Amended by J6a task 11:** N-7 (the removal email, J6a) also carries no leave/unsubscribe link, and that is not a third instance of this gap — by the time N-7 sends, `removeMember` has already deactivated the membership, and there is nothing left for a leave link to do: the recipient is already out. `src/notify/templates/removed.ts` records the same reasoning inline.~~ | **Closed by M7a, 15 August 2026.** Task 1 added the `(gameId, playerId)`-scoped leave token this row anticipated; tasks 2–3 made `/leave/:token` confirm on `GET` and actually leave on `POST`, reusing `removeMember`; task 5 pointed every notification that carries a leave link — N-1, N-2, N-3, and now N-6 too — at a freshly minted leave token, and changed the reminder and promotion emails' link text from "See how to leave this Game" to "Leave this game", which is now true. **The N-7 amendment above is unaffected and still correct**, and needed no further change: N-7 still carries no leave link, for the same reason it never has. | `src/domain/token.ts`, `src/views/leave.ts`, `src/routes/respond.ts`, `src/notify/send-welcome.ts`, `src/notify/send-promotion.ts`, `src/notify/send-cancellation.ts`, `src/sweep/open-and-remind.ts` | Closed |
| ~~No `Cache-Control` on `/r/:token` or `/leave/:token`.~~ | **Closed, 14 August 2026.** `/r/*`, `/leave/*` and `/cancel/*` each now carry their own `app.use` mount in `src/app.ts` applying `private, no-store` — a per-route mount for each, not a global one, matching the shape `/j/*` already used. **`/cancel/:token` was found and fixed alongside the two the row named** — it was never in this row's text, but the same argument (and, for `/cancel/`, the strongest version of it: presenting the page calls the fixture off) applies just as directly, so the sweep covered it too. Guarded going forward by `test/routes/cache-control.test.ts`, which derives its route list from `createApp().routes` rather than restating it, so a future token route missing the header fails automatically instead of needing to be remembered. |
| ~~**Leaked-invite-link abuse (M6a, spec §4.5).** Someone holding a leaked `/j/:token` link can add junk squad members, each costing one N-6 welcome email up to the daily ceiling. The owner's remedy is to rotate the invite link (stopping new junk joins) and remove the junk members (stopping them being emailed again and cleaning up the squad) — but member removal is J6's control, which does not exist yet. **Until J6 ships, the remedy is rotation plus a manual database fix.** Accepted for now: the service's only games belong to the author during this trial. **Amended by M6a's whole-branch review: junk members are the mild case, and the qualitatively worse one is not junk at all.** `joinSquad` reuses any existing `players` row matching the submitted address, so someone holding a leaked link can type a *real, known* address — a colleague's, an ex's — and attach that person's existing account to a squad they never asked to be in. The consequences are not cosmetic: they receive the N-6 "You're in the squad for X" welcome, the game appears on their dashboard, and they are emailed a reminder before every fixture from then on. Nothing distinguishes this from a genuine join, and there is no self-service removal until J6, so the victim cannot get out and the owner cannot take them out. Worse for anyone reading the trail afterwards, `audit_log`'s `membership.joined` row records `actor_player_id` as the *victim's* player id — the joiner is anonymous and has no id of their own — so the audit trail positively asserts that the person added themselves. Do not read that column as evidence of who acted for any join that arrived via `/j/:token`. The fix belongs to J6 alongside removal (and wants, at minimum, an audit shape that can express "an anonymous holder of invite token T added player P"). **Amended by J6a — not closed.** J6a ships the owner's remedy this row named as missing: rotate the invite link (`POST /g/:id/invite/rotate` mints a new `invite_token`, so a leaked link stops admitting new joins) and then remove the unwanted member (`POST /g/:id/squad/:playerId/remove`), so recovering from a leaked-link join no longer needs a manual database fix. **The order used to matter and no longer does.** As J6a first shipped it, removal wrote only `active = false` and left `memberships.role` alone, while `joinSquad`'s reactivation path never touched `role` — so removing an *organiser* and not rotating the link first was no remedy at all: anyone still holding the link could submit that person's address and reactivate the stale `owner` row, coming back able to edit the game, rotate the invite link and remove the remaining organiser. J6a's whole-branch review fix wave closed that in both halves, because they guard different things: `removeMember` now demotes to `player` in the same batch as `active = false` (and names the role change on both sides of its `membership.removed` audit row, BR-27), and `joinSquad` now forces `role: "player"` on reactivation unconditionally — a public, unauthenticated link must never confer ownership, whatever a stale row says. Rotation is still the right first move against further junk joins; it is no longer load-bearing for the ownership question. It also corrects the audit record going forward — `joinSquad` now writes `actor_player_id: null` and `after.via: "invite_link"` on both `membership.joined` and `membership.rejoined` rows (`src/domain/join-squad.ts`), rather than naming the joining player as actor. **What J6a does not do is prevent the join**: a leaked link still lets a stranger, or a stranger typing someone else's real address, attach an account to a squad uninvited on the first click — J6a shortens the cleanup, it does not close the door. And the correction is not retroactive: **every `membership.joined`/`membership.rejoined` row written before J6a still carries the joining player as `actor_player_id`, and must not be read as evidence of who acted** — that was already false for an invite-link join before this amendment, and nothing here rewrites history. **Amended by J6b — also not closed.** J6b's scope was owner mark-in/mark-out overrides, one-off guests and BR-8's deliberate over-capacity, none of which touch `/j/:token` or `joinSquad`; it neither adds to this gap nor narrows it. With J6b shipped, J6 as a whole (J6a and J6b) is complete, and the trigger this row named — "J6" — has now fully landed without closing it: preventing the join itself was never in either half's scope, only removal was. There is no milestone currently scoped to fix it.~~ | **Closed by M39, 27 August 2026, for a never-before-seen address.** M39 (`docs/superpowers/specs/2026-08-26-confirm-to-join-design.md`) closes half of what J6a and J6b left open. `POST /j/:token` now creates a `players`, `memberships`, `responses` or `audit_log` row only for an address with a non-null `players.email_verified_at` (BR-47) — every other address gets one confirmation email (N-14, BR-51) and a "check your inbox" page, and writes nothing. (There is no separate signed-in-viewer branch: signing in itself stamps `email_verified_at` — `src/auth/link-player.ts` — so a signed-in player's address already reads as verified through the one column BR-47 tests.) Confirming (`GET`/`POST /join/:jtoken`) is the second way an address becomes verified (BR-48), and 404s if the invite link it was minted from has since been rotated (BR-49), so J6a's existing remedy also voids every confirmation in flight. Every membership seated before M39 is untouched (BR-52): a legacy row with a null `email_verified_at` is marked **Unconfirmed** on the owner's squad page instead, tidied by hand with the existing Remove control. **What is not closed, and is BR-47's deliberate trade-off rather than an oversight: once an address has ever signed in or ever confirmed a join, it is verified for good**, so a leaked link still seats that person — a real colleague's address included — in one click, no confirmation step, exactly as before M39. Only a first-touch address gets the new protection; the residual is recorded as out of scope in the spec. | `src/routes/join.ts`, `src/domain/join-squad.ts`, `src/domain/token.ts`, `src/notify/send-join-confirmation.ts`, `src/notify/templates/join-confirmation.ts`, `src/views/join.ts`, `src/views/game-overview.ts` | Closed |
| **A removal that fails partway through its per-fixture loop keeps emailing the person it removed.** `removeMember` deactivates the membership first, in its own `db.batch()`, so a later failure cannot leave a player half-in (§3.3) — but the fixtures it then walks are each a separate Durable Object call with no cross-object transaction, so a failure (a timeout, a thrown error) after the second of three `withdraw()` calls leaves the third fixture's response row exactly as it was. **The harm is not a slot nobody can see — it is continued email to an ex-member, which is what BR-3 exists to prevent.** `getFixtureWithSquad` and `eligiblePlayers` (`src/db/queries.ts`, `src/sweep/open-and-remind.ts`) both filter on `responses.status != 'withdrawn'` and *neither* filters on `memberships.active`, so on the unreached fixture the removed player is still listed by name on `/r/:token`, and their still-`pending`-or-`in` row still earns them the N-1 reminder before kickoff. If that row is `in` (or `waitlisted`), `isCancellationRecipient` (`src/domain/response-status.ts`) also still sends them N-3 if the fixture is called off — minutes or days after N-7 told them "You'll get no more email about this game". **What J6a's review fix wave changed:** the retry the design always claimed is now real. `removeMember` called again on an inactive membership skips the batch and the audit row, re-runs only the fixture loop, and returns `resumed`; `POST /g/:id/squad/:playerId/remove` accepts that outcome, so a browser re-submitting the failed POST is a genuine recovery path and no longer needs a hand edit of D1. N-7 is not re-sent on a resume — the dedupe key carries the *original* `left_at`, so the second attempt returns `already-logged` (pinned by "does not email the removed player twice…" in `test/routes/squad.test.ts`). **What is still not fixed:** recovery is manual and depends on somebody noticing. The owner has no affordance to retry from — an inactive member has already vanished from `/g/:id`'s squad list (`listSquad` filters `active = true`), so the only route back is re-submitting the POST or retyping the URL, and nothing tells the owner the loop failed. No background sweep walks memberships for this. The durable fix is the same shape the ghost-fixture row below wants: a reconciliation pass over `(gameId, playerId)` pairs with `memberships.active = false` and still-occupied response rows on open fixtures, rather than trusting a request-time loop to finish. | `src/domain/remove-member.ts`, `src/routes/games.ts`, `src/db/queries.ts`, `src/sweep/open-and-remind.ts` | Before a second owner exists |
| **A cron run overlapping an owner's edit can leave one game with fixtures under two different schedules.** `materialiseFixtures` snapshots every active game row once and then loops, inserting per game; `updateGame` deletes that game's future `scheduled` fixtures and inserts the new pattern atomically. If the cron read a game's row *before* an edit commits and inserts *after* it, its inserts carry the OLD recurrence and therefore land on different `kicks_off_at` values — so they sail straight past `onConflictDoNothing`, which only defends the exact-instant collision. The game is left holding both schedules, every row `scheduled` and indistinguishable from a real one. The ghosts then open on schedule and email the entire squad about a game that is not happening, and there is no fixture-delete UI to clean them up. Not fixed in M6a's review fix wave: the window today is one game and single-digit milliseconds wide, and the durable fix is a behaviour change to materialisation rather than a patch. **The durable fix is to make materialisation reconcile rather than only insert** — for each game, compute the expected `scheduled` set from the row it is acting on and delete the `scheduled` rows within the horizon that are not in it, so a stale writer's output is removed by the next run instead of accumulating. **The trigger is before a second owner exists**: the window scales with the number of games, and today the only person who can be emailed about a ghost fixture is the author. | `src/domain/materialise.ts`, `src/domain/update-game.ts`, `src/cron/handler.ts` | Before a second owner exists |
| **`MAX_EMAILS_PER_DAY` bounds the cost of abuse, not the availability of the service.** The ceiling is enforced by a single GLOBAL counter (`email_quota`, keyed on day — `src/notify/factory.ts`), not per-game or per-recipient. So an anonymous party with one leaked invite link can drive enough N-6 sends to exhaust the whole application's daily email budget, and every real squad's fixture reminders (N-1), promotions (N-2) and cancellations (N-3) for the rest of that day are silently deferred alongside them (see the ceiling-audit row above — the deferral is at least audited, but not prevented). Inherited from `/r/:token`'s shape rather than introduced by M6a: the counter has always been global, `/j/:token` is simply the second unauthenticated write-and-send endpoint to share it. The known-issues claim elsewhere that "the quota bounds the cost of abuse" is true about money and not about availability, and this row exists so that distinction is not lost. | `src/notify/factory.ts`, `src/routes/join.ts` | No milestone trigger yet — revisit if quota exhaustion from `/j/*` or `/r/*` is ever observed in practice, with a per-source or per-game sub-limit as the likely fix |
| **M6a's manual browser verification was only partly carried out.** Every agent in M6a's build had a headless machine and no browser, so the five-point walkthrough the plan's final task specifies was never completed: the game and invite pages were loaded in a real browser and looked right, but **the devtools console was not checked for CSP violations, the QR code was not scanned, the copy-invite button was not clicked, and the JavaScript-disabled degradation path was not exercised.** The owner reviewed what he could and elected to merge on that basis, which is recorded here rather than left implicit. This matters more for this milestone than it would for most: the `connect-src` post-mortem below is precisely the case of a feature broken in every browser while the whole server suite stayed green, and M6a adds four new pages, the project's first inline SVG, and its first convenience-only script. The automated substitutes that *do* exist are real — `test/security/csp.test.ts` renders all four new pages under the production policy and hashes every style and script block from source, and the copy script's `getElementById` targets are derived from the script text and asserted against the rendered HTML — but none of them proves a browser executed anything. | `/g/new`, `/g/:id`, `/g/:id/edit`, `/j/:token` | Next time production is opened in a browser for any reason; certainly before the first real squad member is invited | **Substantially closed, 13 August 2026, by the browser suite** (`test/browser/`, `docs/runbooks/browser-testing.md`). Every page the app renders is now loaded in a real Chromium and fails on any console error or `securitypolicyviolation`, with the detector proved to fire on a deliberately injected style; the passkey register and sign-in ceremonies run against a CDP virtual authenticator; and the critical journeys run twice, once in a `javaScriptEnabled: false` context. All of it passes, which is the first evidence any of these pages has executed in a browser. **What is still not covered, and cannot be by this suite:** the QR code being *scanned* by a phone camera, the clipboard actually receiving the invite text (Playwright grants clipboard permission rather than proving the OS clipboard), and anything needing a real authenticator or a real device — the virtual authenticator proves the ceremony's shape, not that a particular phone's platform passkey works.
| **The squad rows wrap inconsistently at phone width.** Found by the browser suite's first visual capture run at 390px, on the game overview (`/g/:id`). Each squad `<li>` holds three things — the member's name, a role form, and a Remove link — and they reflow against the name's length, so two rows with identical markup land differently: a longer name takes a line of its own with the button and link beneath it, while a shorter one pulls the button up alongside and pushes Remove down alone. The result is ragged rather than broken; every control is present and works, including with JavaScript off. Invisible to every string assertion, which is exactly the case the visual tier exists for. Wants a deliberate layout for the row (a grid with fixed columns, or the controls on their own line unconditionally) rather than whatever flex wrapping produces. **Fixed the same day.** `.squad li` is now a grid rather than a flex container, so the columns are fixed and every row has the same shape whatever the name; below 30rem the name spans the full width and the two controls sit together beneath it. Desktop keeps its single line. Pinned by `test/browser/layout.spec.ts`, which compares each row's control offsets relative to its own box and fails if they differ — proved to fire by reverting the CSS, where it reports `buttonX:0` on one row against `buttonX:173` on the other. | `src/views/styles.ts`, `test/browser/layout.spec.ts` | Closed 13 August 2026 |
| **`GET /api/auth/passkey/generate-authenticate-options` is anonymous by design** (no user identifier — that is what makes it byte-identical whether or not an account exists, M5 Task 8 review) **and writes a `verification` row plus sets a signed cookie on every call**, so an unauthenticated caller can grow that table without a session or a Player, same class as the magic-link storage-amplification footnote that was recorded above `sendSignInLink` in `src/auth/factory.ts` until M62 (5 September 2026) capped the address at `MAX_EMAIL_LENGTH` in front of the handler. **What actually protects it today, quantified:** Better Auth's own rate limiter (`node_modules/better-auth/dist/context/create-context.mjs:169-174`) defaults to `enabled: isProduction, window: 10s, max: 100`, backed by **in-memory storage** (no `secondaryStorage` is configured in `src/auth/factory.ts`) — so the 100-per-10s ceiling is per Worker isolate, not per deployment: a caller spread across enough edge PoPs, or simply pacing under ~10 requests/second to any one isolate, sees no rate limiting at all. The one WAF-level control this project actually relies on for a similar unauthenticated write-generating endpoint is the `respond-throttle` custom rule (see `docs/runbooks/cloudflare.md`), applied and verified against production on 11 August 2026. | `src/auth/factory.ts` (`passkey({...})`), `node_modules/@better-auth/passkey` `/passkey/generate-authenticate-options` | Extend a WAF rate-limiting rule to this path (or add `secondaryStorage`) if `verification` growth or `passkey`-prompt spam is ever observed in practice — no observed abuse yet, and the endpoint's response is small and fixed-shape. **M40 (27 August 2026) widened the trigger:** `PASSKEY_SIGN_IN_JS` now also calls this endpoint once per `/sign-in` page view on any browser that reports `isConditionalMediationAvailable()`, to offer a saved passkey in the email field's autofill — so the write happens per capable page load, not only per button click. Same mitigation applies. |
| **The product guide's prose is not machine-checked against the screens it describes.** The four checks in `test/browser/guide-references.spec.ts` — every chapter named in the shot list exists, every image a chapter references exists on disk, every captured image is referenced by some chapter, and the manifest matches the shot list — run in the ordinary browser suite and in CI, and they do their job: a broken image path or an orphaned screenshot cannot survive. None of them, and nothing else in the repository, can detect a sentence that has quietly stopped being true of the screen beside it — a chapter can drift wrong and every one of the four checks stays green. The mitigation is procedural, not mechanical: `docs/runbooks/browser-testing.md`'s "The product guide" section states the obligation plainly — when a page's behaviour changes, its chapter changes in the same commit and `npm run guide:capture` is re-run — and its only enforcement is a person remembering to do it. | `docs/guide/*.md`, `test/browser/guide-references.spec.ts`, `docs/runbooks/browser-testing.md` | No milestone trigger — this is a structural limit of the approach, not a defect. Revisit only if stale guide prose is actually observed. |
| **Three product findings surfaced while writing the guide** — describing a screen in plain language to a stranger is exactly how these tend to surface. None of the three is fixed here; all are out of scope for the guide work and recorded so they aren't rediscovered. (1) ~~`/leave/:token`'s copy (`renderLeavePage`, `src/routes/respond.ts`) reads "You can't remove yourself from a Game here yet — that isn't self-service yet." — capitalising "a Game" mid-sentence and using "yet" twice in one sentence; the page correctly refuses to self-serve a leave and correctly points the reader at their organiser, so this is a copy defect, not a behaviour one.~~ **Moot as of M7a:** `renderLeavePage` no longer refuses anything — `/leave/:token` now actually leaves — so the sentence this finding was about does not exist any more. Recorded rather than deleted, so the copy that replaced it is not mistaken for having dodged the same defect by luck. (2) The cancellation confirmation page (`renderCancelConfirmPage`, `src/views/cancel.ts`) shows "N players are in" (from `inCount`) directly above "M people will be emailed" (from `recipientCount - unreachableCount`), and `M` routinely exceeds `N` because `recipientCount` also counts waitlisted players, who are correctly emailed too — both numbers are right, but nothing on the page says why they differ, and a reader has to work it out unaided. (3) The sole-organiser self-demotion refusal (`isLastActiveOwner`, `src/domain/change-role.ts`, wired through `POST /g/:id/squad/:playerId/role` in `src/routes/games.ts`) is correct — a game may never be left with no active organiser — but the "Make an ordinary member" button (`src/views/game-overview.ts`) is a plain form that submits directly, with no confirmation step and no explanatory copy, unlike the dedicated confirmation page removal already gets; a sole organiser only learns the rule exists by hitting the refusal after clicking. | `src/routes/respond.ts`, `src/views/cancel.ts`, `src/domain/change-role.ts`, `src/routes/games.ts`, `src/views/game-overview.ts` | No milestone trigger yet — product/copy decisions, not correctness bugs. Revisit whenever `/leave/:token`, the cancellation page, or the squad role-change UI is next touched. |

## Post-mortem: the missing `connect-src` (12 August 2026)

Not an open item — fixed in `eaa84b8` — but recorded because of *how long it survived* and
what that says about where this project's tests are blind. M6 adds more client-side
surface than any milestone so far, so this is the failure mode most likely to recur.

**The bug.** The CSP named `script-src` but never `connect-src`. An absent directive falls
back to `default-src`, which here is `'none'`, so every `fetch()` the two passkey scripts
make was refused by the browser before it left the device. Both passkey buttons — register
*and* sign-in — were completely broken in every browser from the moment M4's CSP met M5's
scripts.

**Why nothing caught it.**

- Every server-side test passed, and could only ever have passed: **no request reached the
  server to fail.** The end-to-end registration test written the same day
  (`test/auth/passkey.test.ts`) passes both before and after the fix.
- The merge tripwire worked exactly as designed and still let this through. It forced
  `script-src 'none'` into hashes, so the scripts *ran* and the buttons *appeared* — which
  is precisely what disguised the problem. **Making a script run is not the same as
  letting it work**, and only the first half had a mechanism.
- The CSP tests asserted the directives that were present. Nothing asserted the absence of
  a directive that needed to be there, which is the harder property and the one that
  mattered.

**How it was found.** `wrangler tail` against production recorded the page load and then no
API request at all. That gap — handler demonstrably running, server seeing nothing — is what
localised it to browser policy rather than to any code either side.

**What now guards it.** `expectFetchTargetsAllowed` in `test/security/csp.test.ts` reads the
`fetch()` targets out of `SCRIPT_BLOCKS` rather than restating them, asserts each is a
same-origin absolute path, and pins `connect-src` to exactly `'self'`. It runs on all nine
pages via `expectFixedDirectives` and fails on all nine without the fix.

**The generalisation for M6.** Tests in this project stop at the Worker boundary. Any
requirement that lives in the browser — a CSP directive, a form's `enctype`, a cookie
attribute, a redirect a browser follows differently from `app.fetch` — has no mechanism
behind it and will be found by a person on a phone, if at all. When M6 adds client-side
behaviour, ask what a passing test suite would look like if the feature were entirely
broken, and if the answer is "exactly like this", add the assertion that would differ.

**Applied to M13.** The installable shell is exactly the shape of surface this
post-mortem warns about — a service worker that must register, a manifest that must be
fetched and parsed rather than refused, an offline fallback the browser decides to take
without asking the Worker — so `test/browser/pwa.spec.ts` (M13 task 7) asks the same
question of it directly: it registers the service worker and fails on any console message
naming a CSP violation, fetches `/manifest.webmanifest` through the browser and parses it
rather than asserting against the Worker's own response, and drives an actual
`context.setOffline(true)` navigation to prove the fallback fires client-side rather than
asserting the offline page merely renders when requested directly. `/offline` and five
other M13 routes (the manifest, both icon sizes, the apple-touch icon and `/sw.js`) were
also missing from `test/browser/catalogue.ts`, so nothing was CSP-checking any of them
until this task added them.

## Accepted breaking changes

| Item | Why accepted |
|---|---|
| **M4's owner-cancellation task added a `kind` discriminator inside the signed body of every response token** (`src/domain/token.ts`), so that a response token and a cancel token cannot be swapped for one another. A token minted before this change carries no `kind` and is now rejected as `malformed` by the new verifier — there is no dual-accept or version fallback. Tokens are not persisted (see `src/sweep/open-and-remind.ts`); they exist only inside already-delivered emails, so this invalidates any availability link still sitting in a recipient's inbox at deploy time. **Accepted** because production's only recipients at the time of this change were the project's own plus-addressed test addresses, and the next hourly sweep re-mints every link regardless. **A future change to the token format, once real players exist, would need a versioned or dual-accept verification path** rather than repeating this break — the trigger is the same one already tracked above for enabling required reviewers: the first real squad member's address going in. | Task 2, M4 |

## Deferred indefinitely — theoretical or negligible

| Item | Why it can wait |
|---|---|
| `npm audit` reports 4 moderate advisories in the `drizzle-kit` dependency tree. | Dev-only. `npm audit --omit=dev` reports 0. Nothing ships to the Worker. |
| Years 0–99 map to 1900 + year through `Date.UTC` legacy behaviour. | No football game is scheduled in the year 47. |
| A 23:00–23:59 kickoff falling in a spring-forward gap that crosses midnight can land on the wrong local weekday. Affects three zones in 2026 (America/Nuuk, Godthab, Scoresbysund), none in the UK. | Originates in `toUtc`'s documented gap rule. Requires a near-midnight kickoff in a Greenland time zone. |
| `db.select().from(games)` loads every active game with no pagination. | A growth cliff years away, for a cron serving one game. |
| The deploy smoke check's `curl … \|\| echo 000` double-appends on a total connection failure, logging `status=000000`. | Cosmetic. Verified not to cause a false pass — the loop still exits non-zero. |
| ~~`actions/checkout@v4` and `setup-node@v4` target the deprecated Node 20 runtime.~~ | **Done, 12 August 2026.** Both actions are now `@v7` in **both** `deploy.yml` and `pr.yml`. Dependabot's own PR (#3) bumped only `pr.yml`, so taking it at face value would have left the deploy workflow on the deprecated runtime while the annotation disappeared from PR checks — the misleading half-fix. Both actions remain GitHub-authored, so the "Actions restricted to GitHub-authored and verified creators" control is unaffected. |
| **TypeScript 7 cannot be adopted yet** (Dependabot PR #4, left open deliberately). `typescript-eslint` declares `peer typescript ">=4.8.4 <6.1.0"` as of its latest release, 8.67.0, so `npm ci` fails to resolve — this is a real upstream constraint, not a lockfile artefact, and the PR's CI failure is that resolution error rather than any type error in this codebase. The available workarounds are all worse than waiting: `--legacy-peer-deps` accepts a resolution upstream says is broken, and dropping `typescript-eslint` would remove the type-aware lint rules from the CI gate. | Recheck when `typescript-eslint` publishes a release whose `typescript` peer range admits 7.x. Nothing in this project needs a TypeScript 7 feature; the bump is hygiene. |
| `formatterCacheSize()` is a test-only export widening the production surface. | Needed by the cache-canonicalisation regression test. A size-only read-only accessor. |
| `nodejs_compat` is enabled in `wrangler.jsonc` with no Node builtin used in `src/`. | Harmless, and likely needed by later milestones. |
| `test/index.test.ts` asserts the schema-derived fixture count in two places, so changing the materialisation horizon needs edits across four test files. | A shared expected-count constant in `test/support/` would localise it. |
| ~~A `withdrawn` player presenting a still-valid response token could flip back to `in`: the Durable Object's lookup of the player's existing response row does not exclude `withdrawn`.~~ | **Closed by J6b's whole-branch review fix wave, 14 August 2026.** `setResponse`'s existing-row lookup now skips a `withdrawn` row (`src/capacity/fixture-capacity.ts`), so a removed player is answered with `not-eligible` — which is exactly what that reason means — and their row stays `withdrawn`. Both doors are shut by the one change: the old response link still sitting in the removed player's inbox, and J6b's new owner-override route, neither of which checks membership itself. Pinned by "a withdrawn player" in `test/capacity/set-response.test.ts` and "an override for a removed player" in `test/routes/owner-fixture.test.ts`. The note's second ask — a promotion pass for BR-3 — was already met by `withdrawMember`, which frees the slot and promotes in its own batch rather than inheriting `setResponse`'s. **The history below is kept because the defect was live in production from 13 August, when J6a's removal began writing `withdrawn`, until this fix.** _Original note:_ No longer unreachable — found while writing J6b's guide chapter, not fixed here (see this file's own rule about not smuggling code changes into a docs task). J6a shipped BR-3: `removeMember` → `withdrawMember` (`src/capacity/fixture-capacity.ts`) now writes `status: "withdrawn"` on every open fixture a removed player held a slot on. `setResponse`'s existing-row lookup (`src/capacity/fixture-capacity.ts:85`, `const existing = all.find((r) => r.playerId === input.playerId)`) still matches that row regardless of status, and `POST /r/:token` (`src/routes/respond.ts`) calls `setResponse` directly with no squad-membership check of its own — `not-eligible` only fires when *no* row exists at all. So a player removed after their reminder was sent, but before their response token expires, can still tap **I'm in** on the email they already have and be recorded `in` again, on a fixture the owner believed they were taken off. This is exactly the gap the original note named; what changed is that the code path making it real now exists. Still needs: exclude `withdrawn` from the existing-row lookup, and (per the original note) a promotion pass of its own, since BR-3 writes `withdrawn` outside `setResponse` and does not inherit BR-7's. |
| A waitlisted viewer on a fixture with an odd `max_players` can see a full capacity bar — "11 of 11 in · 2 waiting" — alongside "The squad has an odd number of players in — one more would even it up" simultaneously. **Wording corrected 17 August 2026 (M12 Task 11); the defect itself is unchanged and still open.** The symptom used to be written in terms of "0 spots left", which M12 §3.1 replaced with the bar (`renderStatusLine`, `src/views/fixture.ts`); that string is now absent from `src/` entirely, so the old sentence named something the app cannot emit and would read to anybody grepping for it as though the issue had gone. It has not: `renderNudge` still fires on the `uneven` flag alone, with no reference to whether the fixture is full. | Same root cause as the odd-`max_players` item above (Part 3, open item 6). |
| The organiser's fixture page can render two filled `.button.primary` at once — `renderConfirm`'s "Add them anyway" (`src/views/owner-fixture.ts:169`) and the team picker's "Publish teams" — against M12 §2.2, "one primary action per screen". | **Left deliberately, 17 August 2026, author's call.** The two gates are independent with no mutual exclusion: `renderConfirm` fires on `params.confirm !== undefined`; `renderPublish` on `takingChanges(view)` **and** (`published`, or `needsAnotherLook`, or any member already has a team). Both hit when an organiser over-fills a fixture that is still taking changes and already has a started pick. **Both buttons are `--accent`; neither is `--danger`**, so §0.8's colour-safety rule — the one that keeps a deuteranope from having to read the label instead of the colour — is not implicated. This is hierarchy only, the milder of the two failures. M12 improved the state from three fills to two by demoting "Save teams". It went no further because the properly correct answer is conditional — Publish demotes *while* a confirm is pending — which is behaviour rather than presentation, and so barred by that milestone's own constraint against feature changes; while demoting "Add them anyway" instead would make the question the screen is actively asking quieter than a background action. Needs a product decision, not a CSS class. |
| `src/routes/respond.ts` re-derives "not eligible" / "not open" from lifecycle and squad membership independently of the Durable Object's own rejection reason. The two agree today, but nothing pins them together. | No observed drift; would benefit from a shared invariant or a mapping test if the two ever diverge. |
| `notification_log.dedupe_key` builders have no structural defence against a colon-containing or empty id. | Unreachable — every id in the system is `crypto.randomUUID()`. |
| `ResendNotifier`'s batch `Idempotency-Key` is derived by joining dedupe keys with `\n`, so `["a\nb","c"]` and `["a","b\nc"]` would collide. | Unreachable — every dedupe key is colon-delimited UUIDs, which never contain `\n`. The `notification_log` unique constraint is the real guarantee underneath it regardless. |
| The test-only `fetch` spy in the Resend notifier tests throws on an unexpected call, but `sendBatch` catches everything, so an unmocked call becomes a `{ok:false}` result rather than a failed test. | Detection of a forgotten mock is still imperfect, but real-network safety no longer rests on it: `vitest.config.ts` now sets an `outboundService` that answers every outbound request with a 599 naming the blocked URL, repo-wide. |
| `ResendNotifier.send` runs `Promise.all` over every chunk with unbounded concurrency. | Fine at `MAX_EMAILS_PER_DAY=80`. Revisit if the ceiling ever reaches the thousands. |
| `SITE_ORIGIN` is a hardcoded constant (`https://makethe.team`) rather than derived from a binding. Lives in `src/notify/delivery.ts` (moved there when the N-2 promotion email became its second caller, ahead of M4's cancellation and attention emails becoming its third and fourth) and is imported everywhere it is needed. | Correct today — there is only one environment and one custom domain. Revisit when a second environment exists (same trigger as TR-9 below). |
| The sweep's `stage: "prepare"` failure bucket (`SweepFailure`) lumps several distinct sub-steps together — enough to isolate one bad fixture, too coarse to say which sub-step failed without reading the message text. | Diagnosability nice-to-have, not a correctness gap. |
| The reminder email's "I'm in" button renders solid/filled and "Can't make it" renders as an outline, so accepting reads as the default action. | **Settled, 11 August 2026 — keep it.** Raised as a product question because the product's value is an accurate count and a visual nudge toward accepting works against that. The owner's decision: encouraging people to play is the point, and the organiser's interest and the players' are aligned here. Not an open item; do not re-raise. |
| The reminder **and promotion** emails' claim that every text colour is paired with a background on the same element is weaker than stated — several `<p>` elements rely on the ancestor `<td>`'s background instead. Confirmed in `src/notify/templates/reminder.ts` and, since M4, `src/notify/templates/promotion.ts:111,114,115,117,132,136`. | Standard email-HTML practice and normally safe, but do a real dark-mode client check — Gmail, Apple Mail and Outlook — before relying on it for go-live. This now matters more than when it was first raised: `NOTIFIER` is `resend` as of 11 August 2026, so these templates reach real inboxes. |
| Template `href()` helpers escape interpolated values but do not scheme-validate, so a `javascript:` URL would render as a clickable link. | Unreachable today — every URL in every template is server-constructed, never attacker-supplied. Cheap defence in depth if that ever changes. |
| `POST /api/auth/sign-in/magic-link` is publicly mounted (`signIn.all(`${AUTH_API_PREFIX}/*`, …)`, `src/routes/signin.ts`), so a third party can choose a same-origin `callbackURL` on an allowlisted victim's emailed link — worst case it lands off `/sign-in/complete` so linking never runs and they meet the no-Player 403. An off-origin value is refused by Better Auth's own `originCheck`; nothing is taken over. | An annoyance with a documented exit (sign-out form + home link on the 403), not a security hole. Revisit only if a future callback target becomes sensitive (e.g. carries a one-time action). |
| An off-origin `callbackURL`/`errorCallbackURL`/`newUserCallbackURL` on the magic-link verify endpoint returns Better Auth's raw JSON 403, not one of this app's rendered pages (`src/routes/signin.ts`). | Cosmetic, and only reachable on the hostile path (a stranger has to have altered the emailed link before the intended recipient opens it). |
| A second identity signing in over an existing session cookie leaves the first `session` row alive in D1 — Better Auth's default behaviour, not anything Task 5 chose (`src/routes/signin.ts`, magic-link verify). The browser only ever holds the newest cookie, so there is no confusion from the visitor's side. | Noted so a `session` row count in a later test or metric isn't a surprise. Revisit if per-identity session limits or a "sign out other devices" feature is ever wanted. |
| Task 16's "retire throws after reminders are already committed" test calls `openAndRemind` and `retirePastFixtures` directly rather than through `handleScheduled`, because `vi.mock` does not intercept a module's own internal calls under this test pool (see the M2–M3 plan's post-implementation corrections). It pins the two functions' individual behaviour, not `handleScheduled`'s call order. | A future reordering inside `handleScheduled` would not be caught by this test. |
| `POST /g/:id/message` and `POST /g/:id/f/:fixtureId/message` (M15, BR-36) read `countBroadcastsSince` and then write the `game.broadcast_sent` audit row that count is taken against, as two separate statements rather than one atomic operation. Two concurrent submissions from the same game can both read a count below `MAX_BROADCASTS_PER_GAME_PER_DAY` and both pass, sending a fourth (or more) message in the same day. Writing the audit row *before* handing the send to `waitUntil` (rather than after) already shrinks the race window from "the whole send" down to the read-then-write pair itself — the narrowest it can be made without an atomic increment, which D1 has no primitive for. | An organiser would have to double-submit the compose form, or open it in two tabs, inside the same narrow window, to see one extra message beyond the cap of three a day — mild even at its worst, and there is no interactive transaction in D1 (`db.batch()` is the only atomicity primitive, and a read cannot join it) to close it with. Revisit only if the cap itself is raised to a place where being off by one matters, or if D1 gains a compare-and-increment primitive. |

## Parked by decision: squad above the join form (20 August 2026)

The M20 design review's change #8 proposed moving the invite page's roster
above the join form (a one-line count above, names below), and itself labelled
the idea "worth testing rather than asserting". The maintainer parked it while
approving the other seven changes (spec:
`docs/superpowers/specs/2026-08-20-design-refresh-design.md` §8). The current
below-the-form placement is therefore a decision twice over, not an oversight.
Revisit only with evidence, such as observed join-rate differences.

## Capacity-bar fill contrast has no tripwire (20 August 2026)

The light theme's capacity-bar fill (`--ok` on `--line`, ≈1.7:1) was accepted
by the M20 visual pass as-is and has no contrast tripwire pinning it — a
future palette nudge should re-check it by eye before assuming it still
reads. (The other M20 carve-out recorded here, the email templates keeping
the old green, was closed the same day: `src/notify/templates/*` now use the
M20 palette.)

## BR-2′ backfill can miss a fixture opening in the same instant (20 August 2026)

M21 changed BR-2: a player who joins while a fixture is `open` is backfilled into it
(`src/domain/backfill-open-responses.ts`) and invited immediately. One race is accepted
rather than closed: a join committing in the same sub-second window as the hourly sweep
opening a fixture can be missed by both sides — the sweep's eligible-set read runs before
the membership commits, and the join's open-fixtures read runs before the lifecycle write
lands. The window is one cron tick racing one form submit, D1 has no cross-statement
transaction to close it with, and the failure mode is the pre-M21 behaviour for that one
player (they are simply not in that fixture, and their dashboard says so). Not worth a
reconciliation pass; revisit only if a real report ever lands.

## Past fixtures show fifty rows and no way to older ones (22 August 2026)

M27's `/g/:id/fixtures` lists the fifty most recent fixtures and stops, with no "older"
link and nothing on the page saying it stopped. The bound is not cosmetic: each row's
result is derived through a batched claims read, and D1 refuses an `inArray` past 100 bound
parameters — the same ceiling that 500'd the dashboard before `listResultsNeededCandidates`
grew its own limit (TR-38). Fifty is a year of a weekly game, so nobody reaches it yet, and
the honest fix is paging rather than a bigger number. Deliberately not a silent truncation
plus a lie: the page says nothing about the cut because there is nothing yet to say, and
the first game to pass fifty fixtures is the trigger to add paging.

## The install marker can only ever say "not yet seen" (23 August 2026)

M33's squad markers report a member as **App not installed** whenever
`players.last_standalone_at` is null, and that column is only ever written forwards. Two
consequences, both accepted:

- A player who installed the app before the column existed, and has not opened it since,
  reads as not installed until they next do. It corrects itself on their next visit.
- **An uninstall is never observed at all.** Nothing tells a server that an app was removed,
  and there is no expiry on the stamp, so a player who installs and then deletes the app
  reads as installed forever.

Both are deliberate rather than unnoticed. The alternatives are worse: expiring the stamp
after some window would make an occasional user's row flicker between the two states with no
event behind either, and there is no browser signal for a removal to listen to. What the
marker honestly means is "we have never seen this person in the installed app", which is what
the organiser needs it for — deciding whether to suggest installing it — and the label is
worded as an absence for that reason. The trigger to revisit is a real complaint that a row
is wrong, not a milestone.

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

One note remains, relevant to whichever milestone adds a second environment. The second,
below, was resolved by M25 rather than deleted, so nobody re-litigates what it asked for.

**Notes 2 and 4 have been discharged, not deleted.** They existed to be read off onto
`/privacy`, and M7c wrote that page — the three things erasure cannot reach are now under
"What deleting your data does not reach", and the Google Fonts disclosure is under "Who
else sees it". The *limits themselves are unchanged*: a last active organiser still cannot
be erased, the trial allowlist still fails closed, free text another person wrote still
cannot be searched, and every page load still tells Google the visitor's IP. What changed
is that a person is now told before they rely on any of it. Kept here as a pointer rather
than a list, because the failure mode this section guards against has inverted: it is no
longer "somebody forgets to write it down" but "somebody changes one of these and leaves
the page saying the old thing". `test/routes/privacy.test.ts` pins each admission, so that
change fails a test rather than shipping quietly.

**M14 adds a fourth processor to the same disclosure, on the same page.** Turning push
notifications on hands an endpoint — the subscription record in `push_subscriptions`
(spec §9.1) — to whichever of Google, Apple or Mozilla runs the push service on the
player's own device. That choice is the device's, made by the browser or OS at the moment
push is turned on; this product neither picks it nor can change it. The endpoint lets this
app wake that specific device with a notification, and the endpoint's mere existence is
itself a persistent identifier for it, held by a company that is neither us nor the player.
Adopted over the same kind of objection recorded for Google Fonts above: unlike the fonts
disclosure, which is imposed on every visitor regardless of what they want, this one is
opted into and per-player — but it is more personal while it lasts, since it is tied to a
specific person's device rather than an anonymous page load, and it persists until that
device is removed. It is disclosed under "Who else sees it" on `/privacy`, and it is
removed the moment it should be: `erasePlayer` (`src/domain/erase-player.ts`) deletes every
`push_subscriptions` row for a player before anything else in the erasure sequence that
could fail, so a run that stops half-done still cannot leave a live endpoint behind — see
that function's comments, and `test/domain/erase-player.test.ts`'s zero-rows-survive
assertion. What would remove this disclosure entirely: nothing short of dropping push
notifications as a feature, since the third-party dependency is inherent to the Web Push
standard, not an implementation choice made here.

1. **`triggers.crons` sits at the top level of `wrangler.jsonc`**, which is correct while
   production is the only environment — but it is inherited, so adding a staging
   environment would silently give it both cron schedules. TR-9 exists precisely to stop
   two environments running the reminder sweep against real people. The runbook documents
   the required move; the configuration does not yet enforce it.

2. ~~`responses.team` (BR-35, M9) records the teams as *published*, not as *played* —
   which matters to results recording and to anything trained on it.~~

   **Closed by M25, and not in the way this note expected.** It asked for a flag stored on
   the result, computed once and read back later. No column was needed: every input to the
   judgement — `teams_saved_at`, `teams_published_at`, and every `responses.status` /
   `responses.team` — is frozen once a fixture is `played`. The picker and publish routes
   both refuse a non-`open` fixture, and responses lock under BR-15, so
   `announcementOutstanding` (`src/domain/teams.ts`) — already a pure, clock-free predicate
   over exactly those four columns — answers the teams-accuracy question forever from rows
   the database already has, evaluated at read time rather than pinned at write time.

   `test/played-fixture-freeze.test.ts` is what makes that true rather than assumed: it
   enumerates every write path this codebase has and asserts none of them can mutate those
   four columns on a `played` fixture. **If it ever fails, this note comes back and the
   column with it** — a result's teams-accuracy figure would then be a claim about rows
   that can still move underneath it, exactly the silent-noise failure this note originally
   raised.

   `fixture_results.teams_accurate` (BR-37 §5) does exist as a stored column, but it caches
   the predicate's answer at lock — a snapshot, so a later change to the predicate cannot
   rewrite last season's results — rather than storing a fact that could not otherwise be
   derived. Nothing reads it to decide anything; every page and every refusal reads the live
   derivation, never this column.

## Ratings and erasure — decided, not deferred (21 August 2026)

M25 ("recording the result", BR-37) attaches every claim about what happened in a fixture to
the `players` row of whoever filed it, and that row survives `erasePlayer` — a played
fixture's participants are deliberately kept (`src/db/queries.ts`), because a squad's history
should still count the people who were there. A future ratings model fitted on this data
would therefore attach a derived judgement about a person's play to a row that outlives their
account.

**Decided, not deferred: this is accepted**, on the maintainer's own reasoning — "reasonably
comfortable that it's not a problem due to the anonymisation already in place." By the time
any such model could be fitted, the row it attaches to has had its name replaced with a
placeholder and its `email`, `auth_user_id` and `email_verified_at` all set to null (BR-34):
a pseudonym, not a person. `test/domain/erase-player.test.ts` already asserts that zero rows
survive erasure that identify anyone, which is the guarantee this position rests on. Recorded
here, as this file is for, so that the milestone which does fit a ratings model finds the
question already answered rather than answering it in passing.

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

## N-4 is not suppressed for a gated fixture — decided 24 August 2026

M34 shipped with **BR-45**: while a gated fixture still held an unreleased tier and
its fallback instant had not passed, the N-4 attention warning was suppressed. The
reasoning was that such a fixture is short *on purpose*, and warning an organiser
about the thing they configured is how a useful alert becomes one people ignore.

**Reverted the same day, by the maintainer's decision.** An organiser wants to know
their numbers are short whether or not the invite order explains why. A warning they
can reason about beats one the product withholds on their behalf — and the invite
progress panel on the fixture page already tells them exactly which tiers are still
held, so the two together are more informative than the warning's absence.

The suppression, its helper `holdsUnreleasedTier`, and the two `games` columns it
selected are gone; `src/sweep/attention.ts` is byte-identical to its pre-BR-45 state.
`test/sweep/attention.test.ts` keeps three tests pinning the *current* behaviour —
a gated fixture with tiers held back warns exactly as an ungated one does — so a
future milestone cannot reintroduce the suppression without a test turning red and
this entry being found.

BR-45 is struck from the M34 spec rather than deleted, so a reader of that document
is not left wondering why the numbering skips.

## Owner notification switches are edit-only (M37, 26 August 2026)

Owner notification switches cannot be set on the create form; the matrix appears on
edit only, as the Advanced block always has.

## Six switch columns on `games` remain until a follow-up deploy (M37, 26 August 2026)

`reminder_enabled`, `short_warning_enabled`, `group_nudge_enabled`, `result_prompt_enabled`,
`teams_published_email_enabled` and `team_picker_email_enabled` are unread since M37 — every
reader moved to `game_notification_settings` in migration `0024`. The migration that drops
them (originally shipped as `0025` in this branch) was reverted before merge: `deploy.yml`
applies D1 migrations before `wrangler deploy`, so dropping the columns in the same release as
the code that stops reading them would 500 the still-running old worker, which selects them by
name, in the gap between the two steps.

The six columns and their doc comments are back on `src/db/schema.ts`, dead but harmless — they
are never read or written. A follow-up migration drops them once the M37 worker is confirmed
live everywhere. Not deferred as an oversight; deferred because the two-step deploy pipeline
makes doing it in the same release actively dangerous.

## `guide:capture` was broken for four reasons, not two — FIXED (M51, 2 September 2026)

Kept as a record because the shape of it matters more than the fix. This row previously said
`guide:capture` was broken for two independent reasons and named both. It was broken for four,
and each one was invisible until the one in front of it was cleared:

1. **A production defect, not a test one.** `/j/:token` sat behind `TOKEN_LIMITER`'s 10-per-60s
   per-token budget, sized for a link belonging to one player. An invite link belongs to a whole
   squad — the game page says "share this link in your group chat" — so at two requests a join the
   sixth person to tap it inside a minute got the too-many-requests page. Real organisers, not
   just the harness. Fixed by `SHARED_TOKEN_LIMITER` (200/60), a separate budget for `/j/*` and
   `/join/*`.
2. **M39's confirm-to-join gate**, as this row already described: a first-time address gets
   "Check your inbox" and no seat (BR-47). Fixed by one `joinSquadMember` helper that does the
   real two-step join. All four guide worlds had their own copy of the one-step loop, which is
   why M39 broke four things at once; there is now one copy.
3. **A shot selector made ambiguous by a later feature.** `.notify-group` matched one fieldset
   when the shot was written and two once M44 added "Invites", and Playwright's strict mode
   refuses that.
4. **The per-IP limiter, which this codebase believed was inert locally.** `src/security/rate-limit.ts`
   stated that `CF-Connecting-IP` "is absent under `wrangler dev`". It is not: `wrangler dev`
   passes the client's header straight through, so the entire harness shared one 60-per-minute
   bucket. Measured 2 September 2026 — 60 requests on one value, then 429s, while 40 distinct
   values all passed against that same exhausted bucket. Each joiner context now carries its own
   address, the way thirteen people on thirteen phones would.

The lesson worth keeping: this run is not in CI (`npm test` only), so four defects — one of them
customer-facing — accumulated behind a command nobody ran for ten days. The first fix made the
second visible, and so on. Anything that only breaks when a rarely-run command runs will be found
in a batch, and the batch will contain something real.

## The guide's demo world cannot illustrate standings or a playing record (M51, 2 September 2026)

M48's "Your record" and M49's "Standings" have guide prose (chapter 07) and no screenshot. Both
were captured and both were thrown away: every number in them was nought.

`buildResultDemo` files a 3–1 result, but a fixture only contributes a won/lost/drawn to either
table once the result has **settled** and the organiser has **picked sides** — without a side
there is nothing to attribute the result to. No guide world picks teams at all (the
`team-picker` shot deliberately photographs an unpicked picker), so the tables render honestly
as P=1, W/L/D=0, NR=1, Win% "—". A screenshot has to illustrate the thing it sits under, and a
grid of zeroes under prose about wins, points and goal difference does the opposite.

Fixing it means teaching `buildResultDemo` to pick and announce sides before the fixture
retires, and to have the second player agree the score so it settles. That is not free: it
changes the world `result-panel` and `team-picker` are photographed in, and both would need
re-reading. Worth doing the next time the guide is worked on properly; not worth bolting onto
a capture fix.

## Cloudflare's monthly email allowance is guarded by a daily cap, not a monthly counter (M42, 29 August 2026)

`MAX_EMAILS_PER_DAY_CLOUDFLARE` is set to 100. Cloudflare Email Service includes 3,000 sends a
month and bills $0.35/1,000 beyond that, so 100 a day lands at 3,000 in a 30-day month and 3,100
in a 31-day one. The spill leg can therefore run about 100 emails past the free allowance in
seven months of the year, costing roughly 3.5p each time.

A second counter keyed on `(month, provider)` would close it exactly. It is not worth having:
it doubles the reserve path's write, adds a second failure mode to the one control that stands
between a bug and a bill, and buys back an amount of money that rounds to nothing. The daily cap
already bounds the worst case to a known, tiny figure, which is the property that matters.

Revisit if `MAX_EMAILS_PER_DAY_CLOUDFLARE` is ever raised much above 100 — the overshoot scales
with the cap, and at, say, 500 a day the same gap is £5-ish a year rather than pennies.

## The Cloudflare spill leg has no idempotency key (M42, 29 August 2026)

`ResendNotifier` derives an `Idempotency-Key` from each batch's `dedupeKey`s, so a retried
request is recognised by Resend rather than resent. Cloudflare Email Service documents no
equivalent, so `CloudflareEmailNotifier` sends without one.

This is not closed because it cannot be, and it is survivable because it is not the layer the
at-most-once guarantee rests on: `notification_log`'s UNIQUE constraint is (§2.8), and
`applySendResult` already declines to retry an ambiguous provider error. What is lost is
Resend's second, independent layer beneath that.

Two decisions follow from it and should not be quietly reversed. Cloudflare is the *spill* leg
rather than the primary, so it carries the smaller share of traffic; and `SpilloverNotifier`
spills only on an exact `DAILY_CEILING_REASON` match, never on a provider error — spilling an
ambiguous failure would be this codebase's first mechanism able to double-send.
