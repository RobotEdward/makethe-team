# Make The Team — Product & Technical Specification

**Status:** v2 — approved for implementation
**Supersedes:** `docs/history/2026-08-10-original-draft-spec.md` (Draft v1, working name `kickabout`; formerly `spec.md` at the repository root)
**Domain:** `makethe.team`
**Audience:** A coding agent implementing this from scratch, plus human reviewers

---

## Changelog from Draft v1

This document is the single source of truth. The draft is retained at `docs/history/2026-08-10-original-draft-spec.md` for history only; the root `spec.md` is now a stub pointing here.

**Conflicts resolved**

| # | Conflict in v1 | Resolution |
|---|---|---|
| 1 | TR-15 (auto-submit POST) vs TR-4 (must work without JS) | No auto-submit. The email link opens a page with two explicit buttons that POST. Identical for every player. SC-1 restated as two taps. |
| 2 | BR-17 ("09:00 day before") vs schema (`reminder_offset_hours`) | Wall-clock wins. `reminder_days_before` + `reminder_local_time`, resolved against the game's IANA timezone. `reminder_offset_hours` dropped. |
| 3 | Fixture state diagram missing `confirmed → open/short`; `short`/`confirmed` are derived, not stored | `fixtures.lifecycle` stores only lifecycle facts. `short`, `confirmed` and `uneven` are computed by one pure function (§2.11). |
| 4 | TR-12 makes the Durable Object a second writer of record, able to diverge from D1 | The Durable Object holds no state. It serialises only; D1 is the sole source of truth. |
| 5 | BR-18 ("one unsolicited message") vs N-4 (owner warning) | N-4 is explicitly exempt from BR-18 and separately capped at one per fixture. |
| 6 | BR-3 sets leavers to `out`, conflating "left the squad" with "declined" | New `withdrawn` response state. Leaving never reads as declining. |
| 7 | BR-25 (squad list needs a session) vs J2 (confirmation page shows the squad, no login) | A valid response token authorises viewing that one fixture's squad. BR-25 governs cross-fixture and cross-game views. |

**Gaps closed**

| # | Gap | Resolution |
|---|---|---|
| 8 | No stated relationship between Better Auth's user table and `players` | Separate tables, nullable `players.auth_user_id`. Better Auth keeps its own schema. |
| 9 | Guests (open Q2 = yes) have no home in a schema where `email` is required | Guests are `players` rows with a null email and `is_guest = true`. |
| 10 | Recurrence: library or hand-rolled? | RRULE string stored; hand-rolled parser and expander for `FREQ=WEEKLY` only. |
| 11 | `audit_log.actor_player_id` non-nullable, but cron has no actor | Nullable. |
| 12 | No access control during build / friends-only trial | §2.13. |
| 13 | Odd player counts need owner attention, same as short | New `uneven` advisory flag. BR-28 to BR-30. |

**Open questions from v1, now settled**

| Q | Decision |
|---|---|
| 1. Product name | **Make The Team**, `makethe.team`, repo `makethe-team`, sender `no-reply@makethe.team` |
| 2. Guests and ringers | Yes — named `players` row, no email, occupies a slot |
| 3. Short-warning threshold | 12 hours before kickoff, configurable per game |
| 4. Chase non-responders | No automated chase in v1. Revisit with real data. |
| 5. Recurrence complexity | Store RRULE; implement weekly and N-weekly only |
| 6. Visitor visibility | Counts, plus **first name and surname initial** ("Edward C.") |
| 7. GDPR | Both paths built in M7 — leaving a game in M7a (BR-22), erasing your own data in M7b (BR-34); privacy-policy copy written by the author before public use |
| 8. Phone numbers | Not collected. Column dropped. |

---

# Part 1 — Product

## 1.1 The problem

A regular casual football game lives or dies on one question: *are there enough players this week?* Today that question is answered by an organiser manually messaging a WhatsApp group, counting thumbs-up emoji, chasing non-responders, and panicking on Friday night when the count is at eight.

The failure modes are consistent:

- The organiser carries all the coordination load, every single week, forever.
- Responses are buried in group chat and get miscounted.
- Nobody knows whether they're actually playing until the last minute.
- When someone drops out, nobody knows there's now a free spot.
- The organiser can't take a holiday without the game collapsing.

## 1.2 The outcome we want

**A regular game consistently fields the right number of players, with the organiser doing almost nothing.**

Concretely, when this works:

- Players get one message the day before, tap twice, and are done.
- Everyone can see the current squad at any time without asking.
- The organiser finds out the game is short — or has odd numbers — *in time to do something about it*, not at kickoff.
- Dropouts are backfilled automatically from a waitlist.
- Setting up a new game takes minutes and then runs itself indefinitely.

## 1.3 Success criteria

| ID | Criterion | Target |
|---|---|---|
| SC-1 | Time for a player to respond, from opening the reminder email | Under 10 seconds and no more than two taps, with no login, no app install, and no JavaScript |
| SC-2 | Share of invited players who respond before kickoff | > 80% |
| SC-3 | Manual chase messages sent by the organiser in a typical week | 0 |
| SC-4 | Notice given to the organiser when a fixture needs attention | At least 12 hours before kickoff |
| SC-5 | Time to create a new recurring game from scratch | Under 3 minutes |
| SC-6 | Unplanned organiser intervention needed per fixture | 0 in the common case |

SC-1 was "one tap" in v1. That was only achievable with a JavaScript auto-submit, which contradicts TR-4 and degrades to a broken-feeling page for anyone without JS. Two explicit buttons are honest, identical for everyone, and still comfortably inside ten seconds.

## 1.4 Design principles

1. **The reminder is the product.** Everything else is supporting cast. If the day-before message and its response page don't work flawlessly on a phone, nothing else matters.
2. **No login on the critical path.** Auth exists for owners and for people who want a dashboard. It must never stand between a player and answering yes or no.
3. **The organiser is a user, not an admin.** Owner tools are for a friend who plays football, not an operations team.
4. **Silence is not consent.** No-response is a distinct state from declined, and is surfaced as such.
5. **Never spam.** These are real people's inboxes and a group of friends. Message volume is a hard constraint, not an afterthought.
6. **Boring and cheap.** This runs for years on a hobbyist budget. Prefer the option with fewer moving parts.
7. **Store facts, derive judgements.** Anything computable from stored facts and the current time is computed, never persisted. Persisted judgements go stale silently.

## 1.5 Non-goals for v1

Explicitly out of scope. Do not build these, and do not add abstractions in anticipation of them beyond what is noted in the data model.

- Collecting money, subs, or pitch fees
- Booking pitches or venues
- Leagues, tables, seasons, or long-run player statistics
- In-app chat or messaging between players
- Native mobile apps
- Sports other than football (the model should not actively prevent it, but no work goes into it)
- Player skill ratings or rankings
- Multi-tenant organisations, clubs, or hierarchies above a single game

## 1.6 Users and roles

| Role | Description | Capabilities |
|---|---|---|
| **Player** | A member of a game's squad | Respond to fixtures, view fixture status, view own upcoming games, manage own contact details, leave a game |
| **Owner** | A player who also administers a game (one or more per game) | Everything a Player can do, plus: create/edit the game, manage fixtures, override any player's response, add/remove squad members, add guests, cancel fixtures, promote another player to Owner |
| **Visitor** | Someone holding an invite link who is not yet a member | View a limited public fixture summary, join the squad |

There is no system administrator role in v1. Owners are the highest authority for their own game.

## 1.7 Vocabulary

Use these terms consistently in code, database, UI copy, and tests.

- **Game** — a recurring football fixture as a standing arrangement. Has a name, venue, day, time, duration, recurrence rule, and min/max player counts. Example: "Thursday 7-a-side at Oxford Sports Park".
- **Fixture** — a single dated instance of a Game. Example: "Thursday 14 August, 19:00". This is the thing players respond to.
- **Player** — a person. Exists once globally, may belong to many Games. A **Guest** is a Player with no contact details, added by an Owner for a single fixture.
- **Membership** — the link between a Player and a Game. Carries their role (player or owner) and whether they are currently active.
- **Squad** — the set of active Memberships for a Game. Informal term; not a database table.
- **Response** — a Player's answer for a specific Fixture. One of the states in §1.8.
- **Reminder** — the scheduled message that opens a Fixture for responses.
- **Lifecycle** — the stored state of a Fixture: `scheduled`, `open`, `cancelled` or `played`.
- **Display status** — what a Fixture looks like right now: lifecycle, plus the derived `short`, `confirmed` and `uneven` judgements. Computed, never stored.
- **Short** — a Fixture below its minimum inside the warning window.
- **Uneven** — a Fixture at or above its minimum whose accepted count is odd, where the Game prefers even numbers.

**"Team" is a brand word only.** It appears in the product name and nowhere in the domain model, database, or code identifiers. It remains reserved for the future team-picker.

Also avoid: "event", "match", "user" (say Player), "RSVP" in user-facing copy (say "response").

## 1.8 State machines

### Fixture lifecycle (stored)

```
scheduled ──▶ open ──▶ played
    │           │
    └───────────┴──▶ cancelled
```

| Lifecycle | Meaning | Entered when |
|---|---|---|
| `scheduled` | Exists on the calendar, not yet asking anyone | Created by materialisation (§2.3) |
| `open` | Accepting responses | Reminder sent, or an Owner opens it early |
| `cancelled` | Not happening | Owner cancels, at any point before `played` |
| `played` | Kickoff plus duration has passed and it wasn't cancelled | Automatically, by the hourly sweep |

`cancelled` and `played` are terminal.

### Fixture display status (derived, §2.11)

Never stored. Computed from lifecycle, cached counts, and the current time.

| Status | Condition |
|---|---|
| `scheduled` / `cancelled` / `played` | Lifecycle is one of these |
| `short` | `open`, `in_count < min_players`, and inside the warning window |
| `confirmed` | `open` and `in_count >= min_players` |
| `open` | `open` and none of the above |

Plus zero or more flags:

| Flag | Condition |
|---|---|
| `uneven` | Status is `confirmed`, `in_count` is odd, and the fixture prefers even numbers |
| `over_capacity` | `in_count > max_players` (only reachable via an Owner override, BR-8) |
| `full` | `in_count == max_players` |

A fixture moves between `open`, `short` and `confirmed` freely as responses change, with no write required — the derivation simply returns something different.

### Response

| State | Meaning |
|---|---|
| `pending` | Invited, has not answered. The default for every eligible member when a fixture opens. |
| `in` | Playing. Occupies a squad slot. |
| `out` | Declined. |
| `waitlisted` | Wants to play but the fixture was full. Holds an ordered position. |
| `withdrawn` | No longer a squad member. Frees any slot held. Never displayed as a decline. |

Transitions are unrestricted except: a player may only enter `in` if a slot is free, otherwise they enter `waitlisted` (BR-5). Only the system enters `withdrawn`, via BR-3.

## 1.9 Core journeys

### J1 — Organiser sets up a game

An organiser signs in, creates a Game (name, venue, day of week, kickoff time, duration, min 10 / max 14, prefers even numbers), and gets a shareable invite link and QR code. They share it in their existing WhatsApp group. Players tap through, give a name and email, and are in the squad. No further action needed — fixtures generate themselves.

### J2 — Player responds to a reminder *(the critical path)*

At 09:00 the day before kickoff, every eligible member gets one email: when, where, who's already in, how many spots are left. It contains two large buttons: **I'm in** and **Can't make it**.

Tapping either opens a page showing the fixture and the same two buttons, with the one they tapped visually emphasised. Tapping it records the answer and shows the live squad, where they can change their mind. No login, no JavaScript, no confirmation dialog. On a phone, this is the entire interaction.

### J3 — Fixture fills up

The 10th player accepts and the fixture reaches its minimum of 10 — it displays as confirmed. The 15th accepts and the fixture is at max — they're told clearly they're on the waitlist at position 1, and they stay on the fixture page.

### J4 — Someone drops out

A confirmed player taps "Can't make it" at 6pm on the day. The system immediately moves the top waitlisted player to `in` and emails only that person: "You're in for tonight." Nobody else is notified.

### J5 — Fixture needs attention

Inside the warning window the fixture is on 8 of a minimum 10 — or on 11, an odd number. Either way the system emails the Owners once, with the current squad, the list of non-responders, the specific problem, and a one-tap link to cancel. It does not chase players automatically, and it does not cancel automatically.

### J6 — Owner intervenes

An Owner opens the fixture page and sees the squad plus everyone's state. They mark a player as `in` on their behalf (someone texted them), add a one-off guest, or cancel the fixture with a reason — which emails everyone who was `in` or `waitlisted`.

### J7 — Player checks their status unprompted

A player who is signed in visits the site and sees their upcoming fixtures across all their games with current status, and can change any response.

## 1.10 Business rules

Numbered so tests can reference them.

**Squad and eligibility**

- **BR-1** Eligible players for a fixture are all Memberships on that Game where `active = true` at the moment the fixture opens.
- **BR-2** A player added to a squad after a fixture opens is not retroactively invited to it, but is invited to all subsequent fixtures.
- **BR-3** When a player leaves or is deactivated, for every `open` fixture of that Game: a `pending` response row is deleted; an `in` response becomes `withdrawn`, freeing the slot and triggering promotion per BR-7; a `waitlisted` response is deleted and the remaining waitlist closes up. `scheduled` fixtures have no response rows and need no action. A leaver is never recorded as `out`.

**Capacity**

- **BR-4** A fixture is full when the count of `in` responses equals `max_players`.
- **BR-5** A player choosing "I'm in" on a full fixture is placed `waitlisted`, appended to the end of the waitlist. They must be clearly told this — never silently.
- **BR-6** Waitlist position is strictly by the time the player joined the waitlist. No priority, seniority, or reordering in v1. The stored `waitlist_position` is fixed for a row once assigned and is never renumbered while that player stays waitlisted, so it develops gaps as earlier positions leave; promotion always takes the **lowest remaining position**, which holds because the lowest live position is always the longest-waiting player. The number **shown** to a player is never this stored column — it is their rank among current waitlisted responses, computed at render time (§2.8).
- **BR-7** When an `in` player becomes `out` or `withdrawn`, the longest-waiting `waitlisted` player is immediately promoted to `in` and notified. This must be atomic — see TR-10.
- **BR-8** An Owner may exceed `max_players` via an explicit override. The UI must show the fixture as over capacity when this happens.
- **BR-9** Simultaneous acceptances for a single remaining slot must resolve deterministically: exactly one player gets `in`, the other gets `waitlisted`. No double-booking, ever.

**Fixture lifecycle**

- **BR-10** Fixtures are materialised from the Game's recurrence rule, at least 4 weeks ahead, in `scheduled` lifecycle.
- **BR-11** A fixture opens automatically when its reminder is sent. An Owner may open it earlier.
- **BR-12** `confirmed` and `short` are derived per §2.11 and never stored. No write is required for a fixture to change display status.
- **BR-13** A fixture transitions to `played` automatically once kickoff plus duration has passed, unless cancelled.
- **BR-14** Cancelling a fixture is always manual, always by an Owner, and always requires a non-terminal lifecycle.
- **BR-15** Responses are locked once a fixture reaches `played`. Owners may still edit for record-keeping.
- **BR-16** An Owner may cancel a single fixture without affecting the recurring Game, or skip a future date in advance — which is the same operation applied to a `scheduled` fixture.

**Numbers and parity**

- **BR-28** A Game declares whether it prefers even numbers (`prefers_even_numbers`, default true). The value is copied to each Fixture at materialisation, so changing the Game later does not rewrite history.
- **BR-29** A fixture at or above its minimum whose `in` count is odd, where the fixture prefers even numbers, carries the `uneven` flag. This is advisory: it never blocks `confirmed`, never blocks a response, and never triggers automatic action.
- **BR-30** Parity is only meaningful at or above the minimum. A fixture below its minimum is `short`; it is never also flagged `uneven`.

**Notifications**

- **BR-17** Reminders are sent at 09:00 in the Game's local timezone on the day before kickoff. Both the time and the number of days are configurable per Game; 09:00, one day before, is the default.
- **BR-18** Every player receives at most **one** unsolicited reminder (N-1) per fixture. Waitlist promotion (N-2), cancellation (N-3) and the owner attention email (N-4) are exempt: the first two are consequences of an action, and N-4 is separately capped at one per fixture by BR-31.
- **BR-19** Notification sending must be idempotent. A retried or duplicated cron run must not send a second copy. See TR-8.
- **BR-20** Cancellation emails go to everyone who was `in` or `waitlisted`. Not to `out`, `pending` or `withdrawn` players, and never to guests (who have no address).
- **BR-21** *(superseded by BR-31, number retired to avoid stale references.)*
- **BR-31** The owner attention email (N-4) goes to Owners only. The hourly sweep evaluates the condition on every run inside the warning window and sends the first time it holds — so a late dropout that leaves an odd number still triggers it. At most one N-4 is ever sent per owner per fixture, enforced by the `notification_log` dedupe key.
- **BR-22** Every message contains a working unsubscribe/leave-game link. **Satisfied as of M7a** ("leave and unsubscribe", the plan at `.superpowers/sdd/2026-08-14-leave-and-unsubscribe/`). `GET /leave/:token` confirms what leaving will do; `POST /leave/:token` actually leaves, reusing `removeMember` so it frees any open fixture's slot the same way an Owner's removal does. Every notification that carries a leave link — the reminder (N-1), waitlist promotion (N-2), cancellation (N-3), and now the welcome email (N-6) too — mints a leave token scoped to `(gameId, playerId)` rather than to a fixture, so the link keeps working long after any one fixture's response token would have expired, and N-6 has one at all despite there being no fixture yet to scope a response token to. N-7 (the removal email) deliberately still carries no leave link: by the time it sends, the recipient is already out, and there is nothing left for a leave link to do.
- **BR-32** No message is ever sent to a player with a null email. Guest filtering is the **caller's** responsibility (the sweep, or whatever builds a batch of `Message`s), not the `Notifier`'s: `Message.to` is typed `string` while `players.email` is nullable, so under strict TypeScript a caller cannot construct a `Message` for a guest without first narrowing the null away — it is a compile-time impossibility rather than a runtime obligation every `Notifier` implementation must remember to honour. A guest is skipped before a `Message` exists at all, and is not recorded in `notification_log` as a failure.

**Access and identity**

- **BR-23** Responding to a fixture requires only a valid response token (§2.6). No account, no session.
- **BR-24** A response token is scoped to exactly one player and one fixture, and expires 24 hours after that fixture's kickoff. A token presented for a `played` or `cancelled` fixture renders a read-only page explaining why, never an error.
- **BR-25** A valid response token authorises viewing that single fixture's squad, subject to the game's squad-visibility setting (BR-33). Viewing any other fixture, any other game, the player dashboard, or performing any Owner action requires an authenticated session.
- **BR-26** A visitor holding an invite link sees only: game name, venue, date, time, counts, and members rendered as first name plus surname initial ("Edward C."). Never email addresses, never full surnames.
- **BR-27** Every Owner override is recorded in `audit_log` with actor, timestamp and previous value, and is visibly attributed in the UI ("marked in by Edward").
- **BR-33** A Game carries a squad-visibility setting, default on. When it is off, players see a fixture's counts and their own response but not other players' names or responses. Owners are unaffected.
- **BR-34** A player may erase their own data from a signed-in session of their own. **Satisfied as of M7b** ("delete my data", the plan at `.superpowers/sdd/2026-08-15-delete-my-data/`). `GET /app/delete` states what erasure does; `POST /app/delete` schedules it 48 hours out and does nothing else, and `POST /app/delete/cancel` clears it. The request is cancellable for the whole of that window — from the page itself and from a banner on the dashboard — and nothing is undone by cancelling, because nothing was done: the wait exists so that a mis-tap costs nothing. When the window closes the hourly sweep leaves every squad (promoting and notifying whoever was waitlisted into each freed slot), hard-deletes the authentication rows, and **anonymises the `players` row in place** rather than deleting it, so a past fixture still counts the people who were there without naming this one. It is refused while the player is the last active organiser of any game — checked when the page renders, again when the request is made, and once more before the sweep acts, because a co-organiser can leave in between. A refusal at that last check leaves the erasure pending and visible rather than silent: it writes one `player.erasure_blocked` audit row per transition into the blocked state, names the blocking game on the delete page *and* on the dashboard banner with a link to hand over, and names the stuck player in the sweep's log. The page never goes on promising a date that has passed — once the deadline is behind it, both surfaces say it is held up and why. Erasure is not atomic (D1 has no interactive transaction spanning Durable Object calls), so a run that stops part-way is recorded in `players.erasure_started_at`, and from that point cancelling is refused with an explanation: the squads left and the waitlist promotions already emailed cannot be restored, and clearing the request would strand the account half-erased with nothing left to finish it. Every renderer an erased player can reach branches on `players.erased_at` and shows "a former player" rather than the stored placeholder, in a squad list and in BR-27's "marked in by" line alike — `listSquad`'s renderers and the N-4 attention email do not branch, and do not need to: erasure deactivates every membership before anonymising, so neither one is ever reached by an erased player's row. Neither the request nor the cancellation can be performed by anyone else: both routes act on the session's own player and take no player id from a path, a query string or a form body, so there is no control anywhere that names somebody else.
- **BR-35** An Owner may assign each `in` player of an `open` fixture to one of two sides. **Satisfied as of M9** ("team picking", the spec at `docs/superpowers/specs/2026-08-15-team-picking-design.md`). The sides are named per **Game** — `games.team_a_name` / `team_b_name`, defaulting to `Team A` and `Team B`, edited on the game form, blank falling back to the default — and an assignment is a nullable `responses.team` (`'a'`/`'b'`), which is already the (fixture, player) pair the assignment hangs off and so covers guests and dies with the response row. Only `in` players are offered a side: a waitlisted player has no place in the fixture yet, and the save route ignores any assignment naming one. **Saving and publishing are separate acts.** `POST /g/:id/f/:fixtureId/teams` writes the sides, clears `fixtures.teams_published_at` unconditionally, and tells nobody — a partial pick saves, because an Owner interrupted halfway must keep their work. `POST /g/:id/f/:fixtureId/teams/publish` sets `teams_published_at` and sends N-9; it is refused, as the fixture page at 422 with the unassigned **named**, while anyone `in` has no side, and refused when nobody is `in` at all. Both routes are refused unless the fixture is still taking changes (the `takingChanges` predicate the row controls and the guest form already use), and both write `audit_log` rows (`fixture.teams_saved`, `fixture.teams_published`) per BR-27. The picker is a form of one radio group per player — three choices, the third being "not picked yet" — so it works with scripting off; the drag-and-drop enhancement only sets those same radios and never becomes required. **A player always sees their own side**, on `/r/:token`, on the player's game page and in the email, read from their own response row and never through `squadForViewer`; the other side's names follow BR-33, and a Game that hides its squad renders no line-ups rather than empty ones. **Nothing rebalances or re-sends itself.** `responses.team` is never cleared when a player stops being `in`, so the orphaned value is the signal that the published sides no longer match the squad: a late drop-out or a waitlist promotion moves nobody, sends nothing, and surfaces to the Owner as teams needing another look, which only a further publish acts on. Per-player ratings and algorithmic balancing remain future work (§308).

## 1.11 Notification catalogue

The complete set for v1. Do not add others without a decision.

| ID | Trigger | Recipients | Cap | Channel |
|---|---|---|---|---|
| N-1 | Fixture reminder, 09:00 day before | All eligible players | 1 per fixture per player | Email |
| N-2 | Promoted from waitlist | The promoted player | Per promotion | Email |
| N-3 | Fixture cancelled | Players who were `in` or `waitlisted` | 1 per fixture per player | Email |
| N-4 | Fixture short **or** uneven inside the warning window | Owners | 1 per fixture per owner, ever | Email |
| N-5 | Sign-in magic link | The requesting player | Per request, rate-limited | Email |
| N-6 | Welcome / squad joined | The new member | 1 per membership | Email |
| N-7 | Removed from a squad | The removed member | 1 per spell in the squad | Email |
| N-8 | Erasure scheduled | The requesting player | 1 per request | Email |
| N-9 | Teams published | Players who are `in`, never guests (BR-32) | 1 per player per publish | Email |

**Amended, M9.** N-9 is added by BR-35 — the decision this table asks for
before anything joins it. Nothing but the publish button sends it: no sweep
evaluates it and no roster change triggers it, so an Owner who wants the squad
told again after a late drop-out publishes again, and each publish is a
separate send (see the dedupe key in §2.8).

**Amended, M7b.** N-7 shipped in M7a and was described in BR-22 but never
added to this table, which calls itself the complete set — so the table said
one thing and the code another for a milestone. It is listed above now,
alongside N-8.

## 1.12 Future scope

Design the data model to accommodate these; build none of them now. The first
of them has since been built — team picking, in M9 — and its entry below now
records what shipped rather than what was imagined. The rest stand.

- **Team picking** — **built in M9** (BR-35; `docs/superpowers/specs/2026-08-15-team-picking-design.md`). An Owner splits an `open` fixture's `in` players across two Game-named sides, saves privately, and publishes to send N-9. What shipped, against what this entry anticipated: the `team` concept landed as a nullable `responses.team` rather than anything attached to the fixture, since `responses` is already the (fixture, player) pair; the manual pick is a radio group per player that works with scripting off, with drag-and-drop as an enhancement over those same radios rather than the mechanism; and the `uneven` flag does pay off, reused to say when the two sides are lopsided in a game that prefers even numbers. **Deliberately left:** per-player ratings and algorithmic balancing — "later algorithmically" stays later, and a rating system is its own product decision — along with more than two sides, per-fixture names, and any form of auto-rebalancing or auto-publishing.
- **Score recording** — after a fixture is `played`, any player can record the result. Implies a `result` on the fixture.
- **WhatsApp and SMS** — additional notification channels. Implies a per-player channel preference (present from day one) and a delivery abstraction (§2.7). Both carry per-message cost and, for WhatsApp, template pre-approval. A `phone` column is added then, not now.
- **Community funding** — public cost transparency page and a contribution mechanism.

---

# Part 2 — Technical

## 2.1 Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Cloudflare Workers | Scale to zero, no infrastructure to maintain |
| Framework | Hono | Web-standards routing and SSR; server-rendered HTML |
| Database | Cloudflare D1 (SQLite) | Accessed via binding, not a connection pool |
| ORM / migrations | Drizzle ORM + drizzle-kit | Required anyway by the auth layer |
| Concurrency | Durable Objects | One per fixture, as a serialiser only |
| Auth | Better Auth (magic link + passkey plugins) | Self-hosted; no per-user cost |
| Email | Resend | Behind an abstraction; SES is the eventual migration target |
| Scheduling | Workers Cron Triggers | Hourly sweep, plus a daily materialisation |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` | Runs in workerd against real bindings |
| CI/CD | GitHub Actions | See §2.9 |

**Language:** TypeScript, strict mode. **No client-side SPA framework in v1** — server-rendered HTML, progressively enhanced. The team picker in a later phase may introduce a small client island; it does not justify a framework now.

**Plan note:** Durable Objects may require the Workers Paid plan (a flat $5/month). Verify against current Cloudflare documentation before starting M2. If they do, that is an accepted fixed cost — the alternative (atomic conditional `UPDATE` against D1) was considered and rejected as harder to get right for waitlist promotion.

## 2.2 Architecture constraints

- **TR-1** Better Auth must be instantiated per request via a factory function. D1 bindings are only available inside the request handler; a module-level singleton will fail non-obviously.
- **TR-2** All secrets come from Worker bindings. Nothing sensitive in the repo, which is public.
- **TR-3** The Worker must be stateless between requests. All state lives in D1.
- **TR-4** Every page must be usable on a phone, on a poor connection, **without JavaScript**. JavaScript enhances; nothing on the response path requires it. There is no auto-submit anywhere.

  **Owner ruling, 11 August 2026: the no-JavaScript rule is relaxed from an absolute to a guideline.** JavaScript is now permitted as progressive enhancement. Two things are unaffected by this and remain absolute: TR-4 itself as stated above — every page still works fully with scripting disabled — and TR-15's `GET`-must-not-mutate / no-auto-submit rule, which stands **independently** of this relaxation. TR-15's justification was never "no JavaScript exists"; it is that link prefetchers and scanners follow every URL in an email, and some of them execute JavaScript, so a mutating `GET` or an auto-submitting form is unsafe regardless of how much scripting a page is allowed to carry.

## 2.3 Recurrence and fixture materialisation

- **TR-5** A Game stores a recurrence rule and a timezone (IANA identifier, e.g. `Europe/London`). Fixtures are **materialised as rows**, never computed on the fly.
- **TR-6** A daily cron materialises fixtures so that at least 4 weeks of future fixtures exist for every active Game.
- **TR-7** Editing a Game's schedule affects only future `scheduled` fixtures. Already-open fixtures are untouched.

Computing recurrence at read time makes cancellations, one-off changes, and historical accuracy intractable. This is not negotiable.

**Recurrence implementation.** `games.recurrence_rule` holds an RFC 5545 RRULE string for forward compatibility, but only `FREQ=WEEKLY` with optional `INTERVAL` and a single `BYDAY` is supported. The parser rejects anything else at write time with a clear error — it does not silently ignore unsupported parts. Expansion is hand-rolled against the timezone module (§2.12); no RRULE library is used, because the common ones are `Date`-based and timezone-naive.

```
FREQ=WEEKLY;INTERVAL=1;BYDAY=TH     weekly, Thursdays
FREQ=WEEKLY;INTERVAL=2;BYDAY=SU     fortnightly, Sundays
```

An `INTERVAL` above 8 weeks is rejected. A casual game that meets less often than
once every two months is not the thing this product schedules, and the cap keeps
expansion cheap: the materialisation horizon is a matter of weeks, so a very large
interval would make every daily run walk a long way for no occurrences.

## 2.4 The scheduler

- **TR-8** Two cron triggers. An **hourly sweep** and a **daily materialisation**. Neither runs per game.

  The hourly sweep, in order:
  1. **Open.** For each `scheduled` fixture whose reminder time has passed: write a `pending` response row for every eligible member (BR-1), set lifecycle to `open`, set `opened_at`.
  2. **Remind.** For each `open` fixture whose reminder time has passed, find eligible players with no N-1 `notification_log` row. Insert the log row **before** sending; send N-1; update the row with the outcome.
  3. **Attention.** Evaluate `open` fixtures inside the warning window; send N-4 to owners where `needsOwnerAttention` holds, subject to BR-31.
  4. **Retire.** Transition fixtures past kickoff-plus-duration to `played`.

  Steps 1 and 2 are deliberately separate. An Owner opening a fixture early (BR-11) sets lifecycle to `open` without sending anything; the reminder still goes at the scheduled time, because step 2 keys off the reminder instant rather than off the opening. Coupling them would mean an early-opened fixture never gets its reminder at all.

  The dedupe key on the log is what makes this idempotent — a crashed or duplicated run cannot double-send.

- **TR-39 — Reminder retryability is asymmetric, deliberately.** A reminder that was refused for a reason that **provably** means it never left the building — the daily send ceiling was already reached, or there was no usable recipient — has its `notification_log` row **removed** rather than left `failed`, so the next sweep run retries it as if it had never been attempted. A reminder that failed for any other reason (a provider error, a rejected batch, a network failure) is **ambiguous** — it may or may not have sent — and is left `failed` and is never retried automatically. The asymmetry is the point: a duplicate reminder is worse than a missed one, so the system only ever retries a send it can prove did not happen.

- **TR-40 — The sweep must skip fixtures that have already ended.** Before step 2 computes a reminder instant for an `open` fixture, and before step 1 opens a `scheduled` one, the sweep checks `kicks_off_at + duration_minutes` against the current time and skips any fixture already past it — such a fixture is retired directly (step 4) rather than opened or reminded. Without this, a cron gap of more than about a day (a missed run, a redeploy) makes the recovery sweep email players a "tomorrow" reminder about a fixture that finished last week. Because of this, `retirePastFixtures` (step 4) covers `scheduled` fixtures as well as `open` ones — a fixture skipped by steps 1–2 for having already ended must still be retired by step 4, or it is left orphaned in `scheduled` forever.

- **TR-9 (critical)** Cron triggers are configured **per environment**. Non-production environments must have no cron triggers and must use `NullNotifier`. Two environments running the 09:00 sweep means duplicate emails to real people.

- **Timezone handling.** Cron fires in UTC. Reminder times are computed from the Game's IANA timezone so "09:00" stays 09:00 across BST/GMT transitions. There must be a test for a reminder spanning a DST boundary.

- **Hourly granularity.** An hourly sweep sends reminders at the top of the hour at or after the target instant. For whole-hour UTC offsets this is exact. For half-hour-offset zones (e.g. `Asia/Kolkata`) a 09:00 local target sends at 09:30 local. Accepted for v1; documented rather than fixed.

## 2.5 Capacity and the waitlist

- **TR-10** Each fixture has a Durable Object instance keyed by fixture ID. **The Durable Object holds no state of its own.** It exists solely to serialise requests: inside its handler it reads current counts from D1, decides the outcome, and writes the response row and updated cached counts back to D1 in a single `batch()`. D1 remains the sole source of truth, so the two can never disagree.

  **This does not happen automatically, and BR-9 depends on the distinction.** A Durable Object's input gating only covers its own *storage* operations; it does not serialise across an `await` on an external call. This object's critical section awaits **D1**, an external call the event loop yields across, so the whole section is wrapped in `ctx.blockConcurrencyWhile()`. Without it, two concurrent responses can both read the same `in_count` before either writes, and both take the last slot — the exact double-booking BR-9 forbids. This was measured, not assumed: removing the block produced **20 of 20 players accepted for 6 slots** in `test/capacity/set-response.test.ts` ("survives a burst of simultaneous acceptances"), which is also the test that proves the block is load-bearing.

  The object is addressed through **RPC**, not `fetch()`: `env.FIXTURE_CAPACITY.getByName(fixtureId)` returns a stub with typed methods (`setResponse(input)`), called directly. It also derives the fixture id it operates on from **its own identity** (`this.ctx.id.name`, the name passed to `getByName`) rather than accepting it as an argument. An earlier version took `fixtureId` on the input and used that for every D1 read and write, while the lock was keyed by the object's identity — the two could disagree, and a test proved it: addressing one fixture through two different object names produced a real double-booking, 7 accepted for a maximum of 6. Deriving the id from identity removes the second source of truth, so there is nothing left for the lock and the mutation to disagree about.
- **TR-11** Reads (fixture page, squad list, dashboard) go directly to D1 and never touch the Durable Object.
- **TR-12** Every write that can affect capacity must enter through the Durable Object. That is: a player self-responding, an Owner override, adding a guest, waitlist promotion, and membership withdrawal (BR-3). A write path that bypasses it is a bug, and BR-9 will eventually fail because of it.

This is the only place in the system that needs a Durable Object. Do not use them elsewhere.

## 2.6 Auth and tokens

Two entirely separate mechanisms.

**Response tokens (no account)**

- **TR-13** A response token is an HMAC-signed opaque string encoding `player_id`, `fixture_id`, and expiry, signed with a server secret.
- **TR-14** Tokens are verified in constant time, using `crypto.subtle.timingSafeEqual` — a workerd built-in — to compare the decoded signature, never `===`. Invalid or expired tokens render a friendly page offering sign-in, never a raw error.
- **TR-15** A `GET` on a token link must never mutate state. The email buttons are ordinary links to a page; that page carries the tapped intent only as visual emphasis on one of two `POST` buttons. Email scanners and link prefetchers follow every `GET` in your emails, and **some execute JavaScript** — treating a bare `GET` as a response causes phantom acceptances. There is no auto-submit fallback, so this holds unconditionally, and independently of TR-4's relaxation to a guideline: this rule is not "no JavaScript exists on the page", it is "a `GET` must be safe even against a client that runs whatever JavaScript it likes".

**Sessions (accounts)**

- **TR-16** Magic link and passkey only. No password field anywhere in the codebase.
- **TR-17** Sessions are required for: the player dashboard, any cross-fixture view, and every Owner action.
- **TR-18** Owner actions must re-check ownership server-side on every request. Never rely on UI state.
- **TR-30** Better Auth owns its own tables under its own schema and migrations. `players` is the domain record. `players.auth_user_id` is a nullable link, populated on first sign-in by matching the verified email; if no `players` row matches, one is created. Most players never sign in and never get a link.

## 2.7 Notification abstraction

- **TR-19** All sending goes through a `Notifier` interface with a single `send(message)` method. Implementations: `ResendNotifier`, `ConsoleNotifier` (development), `NullNotifier` (tests and non-production environments). Selected by the `NOTIFIER` binding.

  Resend's batch endpoint accepts an `Idempotency-Key` request header, which the provider itself retains for 24 hours; a retried request carrying the same key is deduplicated at Resend rather than resent. `ResendNotifier` derives this key from the batch's own `notification_log.dedupe_key`s, giving a second layer of protection beneath the `dedupe_key` unique constraint (§2.8) — the constraint stops a duplicate row from ever being written, and the idempotency key stops a duplicate HTTP retry of an already-accepted batch from sending twice even before that row is read back.
- **TR-20** Message content is generated by templates taking a typed payload. Templates render both HTML and plain text.
- **TR-21** The interface must not assume email. A channel field and per-player channel preference exist in the model from day one, even though only email is implemented.
- **TR-31** The `Notifier` enforces a hard daily send ceiling (`MAX_EMAILS_PER_DAY`) against a counter in D1. On reaching it, sends are logged as `failed` with a distinct reason and an owner-visible warning; nothing is silently dropped. This is the primary defence against a runaway cost or reputation incident, whatever the cause.
- **TR-32** Recipients with a null email are skipped before the send attempt, by the caller building the batch, and are not written to `notification_log` as failures (BR-32).

Provider constraints worth designing around: the Resend free tier is 3,000 messages per month with a **100/day cap**, and reminders bunch into a single morning burst. Batch where the provider supports it, and keep the provider swappable.

## 2.8 Data model

Illustrative schema. Naming may be adjusted to Drizzle conventions; the shape may not.

```sql
players
  id, name,
  email,                         -- NULLABLE (guests have none)
  is_guest,                      -- boolean, default false
  auth_user_id,                  -- NULLABLE, links to Better Auth's user table
  notification_channel,          -- 'email' for now; exists for future channels
  email_verified_at, created_at
  UNIQUE (email) WHERE email IS NOT NULL

games
  id, name, venue_name, venue_address, venue_url,
  timezone,                      -- IANA, e.g. Europe/London
  recurrence_rule,               -- RRULE string, FREQ=WEEKLY only
  recurrence_start_date,         -- local YYYY-MM-DD anchor for INTERVAL
  kickoff_time, duration_minutes,
  min_players, max_players,
  prefers_even_numbers,          -- boolean, default true
  reminder_days_before,          -- default 1
  reminder_local_time,           -- default '09:00'
  short_warning_offset_hours,    -- default 12
  invite_token,                  -- for the shareable link/QR
  active, created_at

memberships
  id, game_id, player_id,
  role,                          -- 'player' | 'owner'
  active, joined_at, left_at
  UNIQUE (game_id, player_id)

fixtures
  id, game_id,
  kicks_off_at,                  -- UTC instant
  lifecycle,                     -- scheduled|open|cancelled|played
  min_players, max_players,      -- copied from game at materialisation
  prefers_even_numbers,          -- copied from game at materialisation
  short_warning_offset_hours,    -- copied from game at materialisation
  duration_minutes,              -- copied from game at materialisation
  in_count, waitlist_count,      -- cached; maintained only by the Durable Object
  venue_override, notes,
  cancelled_at, cancellation_reason,
  opened_at, created_at
  UNIQUE (game_id, kicks_off_at)

responses
  id, fixture_id, player_id,
  status,                        -- pending|in|out|waitlisted|withdrawn
  waitlist_position,             -- null unless waitlisted
  responded_at,
  set_by_player_id,              -- null for self, owner id for an override
  source                         -- 'token'|'web'|'owner'|'system'
  UNIQUE (fixture_id, player_id)

notification_log
  id,
  dedupe_key,                    -- see below; UNIQUE
  notification_type,
  fixture_id,                    -- NULLABLE (N-5, N-6 are not fixture-scoped)
  player_id,
  channel, status,               -- queued|sent|failed
  provider_message_id, sent_at, error
  UNIQUE (dedupe_key)

email_quota
  day,                           -- UTC date, PK
  sent_count

audit_log
  id,
  actor_player_id,               -- NULLABLE: null for system/cron actions
  entity_type, entity_id,
  action, before_json, after_json, created_at
```

Notes:

- `recurrence_start_date` anchors the recurrence. Occurrences are the first `BYDAY` on or after it, then every `INTERVAL` weeks. Without an anchor, "every other Thursday" is undefined — there is no way to know which Thursday the fortnight counts from.
- `fixtures` copies `min_players`, `max_players`, `prefers_even_numbers`, `short_warning_offset_hours` and `duration_minutes` from the Game at materialisation, so changing the Game later doesn't rewrite history.
- A `pending` response row is written **eagerly for every eligible player at the moment the fixture opens** (BR-1). This fixes the eligible set at that instant. (v1 called this "lazily", which was a wording error.)
- **TR-38 — D1's bound-parameter limit.** A single D1 statement rejects more than 100 bound parameters, failing with `D1_ERROR: too many SQL variables ... SQLITE_ERROR`. This was measured directly: inserting `fixtures` rows at 9 per statement worked, 10 failed. The effective row ceiling depends on the column count of the table being written, and Drizzle may bind more parameters per row than the table has declared columns — so a chunk size must be a conservative constant, not something computed from the column count. Fixture materialisation chunks its inserts at 8 rows per statement and is the reference implementation (`src/domain/materialise.ts`, `INSERT_CHUNK_SIZE`). Any code inserting one row per squad member must chunk the same way — this explicitly includes writing the `pending` response rows required above when a fixture opens, since a squad of twenty is twenty rows in one insert. Chunking means a mid-way failure can leave earlier chunks written and later ones missing; this is safe here only because these operations are idempotent (materialisation via the `(game_id, kicks_off_at)` unique index; opening a fixture must be written the same way), and any caller relying on chunked writes must keep them idempotent.
- `in_count` and `waitlist_count` are a cache, written only inside the Durable Object's critical section alongside the response row, in the same `batch()`. A test asserts they match a `COUNT(*)` after a randomised sequence of operations.
- `responses.waitlist_position` is **permanent but gappy, not "never reused"** — an earlier draft of this spec claimed positions are never reused, which is wrong. A newly-waitlisted player takes the **highest live** waitlisted position plus one; a departed top position is therefore reused by whoever joins next, and numbering restarts at 1 once the waitlist is empty. What is true, and what BR-7's promotion depends on, is narrower: the position stored for a given row never changes while that row stays waitlisted, so gaps open up as earlier positions leave, and the **lowest live position is always the longest-waiting player**. Promotion (M4) takes that lowest remaining position. The number **shown to a player** is never `waitlist_position` itself — it is that player's rank among currently-waitlisted responses for the fixture, computed at render time from the live set, never persisted (BR-6).
- `audit_log` covers BR-27 and is written for all Owner overrides and all lifecycle changes.
- `notification_log.dedupe_key` replaces v1's `(fixture_id, player_id, notification_type)` constraint, which could not express the notifications that aren't fixture-scoped. One unique text column handles every case:

  | Type | Dedupe key | Effect |
  |---|---|---|
  | N-1 reminder | `n1:<fixture_id>:<player_id>` | Once per player per fixture (BR-18) |
  | N-2 promotion | `n2:<fixture_id>:<player_id>:<promoted_at>` | Once per promotion; a player promoted twice is told twice |
  | N-3 cancellation | `n3:<fixture_id>:<player_id>` | Once per player per fixture |
  | N-4 attention | `n4:<fixture_id>:<player_id>` | Once per owner per fixture, ever (BR-31) |
  | N-5 magic link | not logged | Better Auth owns issuance and rate limiting |
  | N-6 welcome | `n6:<membership_id>:<joined_at>` | Once per membership; rejoining sends again |
  | N-7 removal | `n7:<membership_id>:<left_at>` | Once per spell in the squad; a rejoin and a second removal sends again |
  | N-8 erasure scheduled | `n8:<player_id>:<erases_at>` | Once per request; a re-request moves the deadline, so its key differs and it is told again |
  | N-9 teams published | `n9:<fixture_id>:<player_id>:<published_at>` | Once per publish per player; re-publishing after a late change mints a new key and genuinely tells everyone again |

  **Amended, M6a.** The table above originally gave N-6's key as
  `n6:<membership_id>` alone, which contradicts its own "rejoining sends
  again": `UNIQUE (game_id, player_id)` on `memberships` means a rejoin
  reuses the existing row rather than inserting a second one, so the
  membership id alone is the same string on both the original join and the
  rejoin, and the `dedupe_key` unique constraint would silently drop the
  second welcome. `joined_at` (reset on every reactivation) is what
  distinguishes them; see `welcomeKey` in `src/notify/dedupe-key.ts`.

## 2.9 CI/CD

**Two workflows. GitHub Actions, not Workers Builds.** If the repo is ever connected to Cloudflare directly, automatic deployments must be disabled — two systems deploying one Worker is a failure mode.

```
on: pull_request     → install → lint → typecheck → test → wrangler deploy --dry-run
on: push to main     → test → d1 migrations apply --remote → wrangler deploy → smoke check
```

- **TR-22** The `pull_request` workflow must not require secrets. Pull requests from forks do not receive them. **Never use `pull_request_target`** — it runs the base branch's workflow with full secret access against untrusted code.
- **TR-23** Migrations run **before** deploy. D1 migrations are forward-only with no rollback.
- **TR-24** Migrations must be expand-only. Add a nullable column and ship code tolerating both shapes; drop the old column in a later release. Never combine a destructive schema change with the deploy that depends on it.
- **TR-25** Enable GitHub secret scanning with push protection. The repo is public and will hold no credentials, but the guard matters.
- **TR-26** Dependabot on a weekly schedule.

Environments: production only to begin with. A staging Worker and second D1 database get added when there are users beyond the author's own circle — at which point TR-9 becomes load-bearing.

## 2.10 Testing

- **TR-27** Vitest with `@cloudflare/vitest-pool-workers`, running in workerd against real D1 and Durable Object bindings. Do not mock the database.
- **TR-28** The test database is built by applying the real migrations via `readD1Migrations` / `applyD1Migrations`, so a broken migration fails CI rather than production.
- **TR-29** Route tests drive the Worker through `SELF.fetch` from `cloudflare:test` rather than the Hono test client. `SELF` dispatches through the deployed module's default export, so a test exercises the real entry point — middleware, route registration and the `fetch` handler wiring included. The Hono test client would call the app object directly and skip all of that, which is exactly the layer a route test should be proving.

Required test coverage, at minimum:

| Area | Must prove |
|---|---|
| Capacity | BR-9 — two simultaneous acceptances for one slot produce exactly one `in` and one `waitlisted` |
| Waitlist | BR-7 — a dropout promotes exactly the longest-waiting player, and notifies only them |
| Count cache | `in_count` and `waitlist_count` match `COUNT(*)` after a randomised operation sequence |
| Idempotency | BR-19 — running the hourly sweep twice sends one email |
| Timezone | A reminder crossing the BST/GMT boundary is sent at 09:00 local |
| Recurrence | The RRULE parser rejects every unsupported form rather than ignoring it |
| Derived status | §2.11 is a pure function, unit-tested exhaustively across counts, minima, parity preference and time-to-kickoff |
| Parity | BR-29, BR-30 — 9 is short not uneven, 10 confirmed, 11 confirmed+uneven, 12 confirmed |
| Owner alert | BR-31 — one N-4 per fixture even when the fixture is short, then fixed, then uneven |
| Tokens | Expired, tampered, and cross-fixture tokens are all rejected |
| Prefetch safety | TR-15 — a `GET` on any response link records nothing |
| No-JS path | The full response journey completes with scripting disabled |
| Authorisation | A non-owner cannot perform any Owner action, by direct request |
| Eligibility | BR-2, BR-3 — late joiners and leavers are handled, and a leaver is never recorded as `out` |
| Guests | A guest occupies a slot, is never emailed, and is never a send failure |
| Email ceiling | TR-31 — sends stop at the daily cap and are logged, not silently dropped |

## 2.11 Derived fixture status

One pure function, in its own module, with no I/O and no clock access of its own. Every renderer, the owner-alert sweep, and the tests all use it. This is the mechanism by which BR-12, BR-29 and BR-30 cannot drift.

```ts
type FixtureStatus =
  | 'scheduled' | 'open' | 'short' | 'confirmed' | 'cancelled' | 'played'

type FixtureFlag = 'uneven' | 'full' | 'over_capacity'

interface FixtureView {
  status: FixtureStatus
  flags: FixtureFlag[]
  spotsLeft: number        // clamped at 0
  needsOwnerAttention: boolean
}

function fixtureView(f: FixtureFacts, now: Date): FixtureView
```

Rules, in order:

1. Lifecycle `cancelled`, `played` or `scheduled` returns that status with no flags.
2. Otherwise lifecycle is `open`. Compute `inWindow = now >= kicksOffAt - shortWarningOffsetHours`.
3. `in_count < min_players` → status is `short` if `inWindow`, else `open`.
4. `in_count >= min_players` → status is `confirmed`. If `prefers_even_numbers` and `in_count` is odd, add the `uneven` flag.
5. Add `full` if `in_count == max_players`; `over_capacity` if greater.
6. `needsOwnerAttention` is true when `inWindow` and (status is `short` or flags include `uneven`).

## 2.12 Timezone module

A single module wrapping `Intl.DateTimeFormat` with IANA time zones. It is the only place in the codebase permitted to convert between local wall-clock time and UTC instants. Two operations:

- `toUtc(localDate, localTime, timezone) → Date` — used by materialisation to place a kickoff, and by the sweep to resolve a reminder instant.
- `toLocalParts(instant, timezone) → { year, month, day, hour, minute, weekday }` — used by rendering.

Ambiguous and non-existent local times (the DST spring-forward gap and autumn overlap) must have defined behaviour: a time inside the spring-forward gap is shifted forward by the length of the gap, so 01:30 during a 01:00→02:00 transition yields 02:30 local — matching Luxon and `date-fns-tz` — and the overlap resolves to the first occurrence. Both are tested. A 19:00 kickoff never silently becomes 18:00 or 20:00.

## 2.13 Access control during build and trial

The site is public infrastructure from M0. Until it is deliberately launched, access is layered. None of these layers is load-bearing on its own — every endpoint authorises properly regardless.

- **TR-33** `GET /` serves a static holding page containing the product name and nothing else. `robots.txt` disallows everything and every response carries `X-Robots-Tag: noindex, nofollow`. There is no sitemap and no directory listing.
- **TR-34** Real entry points are unguessable or authenticated: `/r/<hmac-token>` (respond), `/j/<invite-token>` (join), `/dashboard` and `/g/*` (session required). Any unmatched route returns a bare 404 with no hint that the path space is interesting.
- **TR-35** During the trial, magic-link issuance is gated by a `SIGNIN_ALLOWLIST` secret (comma-separated emails). A request for an address not on the list returns the same "check your inbox" page and sends nothing — it must not reveal whether an address is known. Removing the gate at launch is deleting one check.
- **TR-36** `MAX_EMAILS_PER_DAY` (TR-31) is the real cost ceiling. Set it low during the trial.
- **TR-37** Cloudflare edge configuration — a rate-limiting rule on `POST /*` and a basic WAF ruleset blocking common scanner paths — is documented in `docs/runbooks/cloudflare.md` and applied by hand or by scoped API token. It is a supplement, not a control: the application is written to be safe with it switched off.

Deliberately rejected: Cloudflare Access over the whole site. It would require bypass policies for `/r/*` and `/j/*` — precisely the no-login paths that carry the risk — leaving the critical path unprotected while adding a login wall to everything else.

## 2.14 Build order

Each milestone is independently deployable and demonstrable.

| M | Scope | Done when |
|---|---|---|
| **M0** | Repo skeleton, Hono + D1 + Drizzle wired, holding page, access lock (§2.13), CI green, deploys to production | `https://makethe.team` serves the holding page, an unmatched path 404s, and CI blocks a failing test |
| **M1** | Games, fixtures, memberships, recurrence parser, timezone module, materialisation cron | An owner can create a game via seed data and see 4 weeks of correct fixtures, including across a DST boundary |
| **M2** | Response tokens, the fixture page, in/out, Durable Object capacity, derived status (§2.11) | A player with a token link can respond with no JS and see the squad; the BR-9 and parity tests pass |
| **M3** | Notifier abstraction, email templates, reminder sweep, notification log, daily ceiling | A fixture reminder arrives at 09:00 local and a second sweep sends nothing |
| **M4** | Waitlist and promotion; cancellation; owner attention email | J4 and J5 work end to end, including the short-then-uneven case |
| **M5** | Better Auth — magic link, then passkeys. Player dashboard. Allowlist gate. | A player can sign in and see all their upcoming fixtures across games |
| **M6** | Owner UI — create/edit game, manage squad, overrides, guests, invite link and QR | J1 and J6 work end to end with no seed data |
| **M7** | Polish — empty states, error pages, accessibility pass, unsubscribe and leave-game flows, delete-my-data, `/privacy` stub | Usable by a stranger with no explanation, and a player can remove themselves and their data |
| **M8** | Squad visibility — an owner-controlled setting, and a player's view of a game | A player can see who else is playing, and an owner can turn that off |
| **M9** | Team picking (BR-35) — two named sides per game, a picker on the owner's fixture page, and N-9 | An owner can split an open fixture's players into two sides with JavaScript off, publish them, and everyone playing is emailed their side |

M1–M4 are the product. M5–M7 make it shareable. Score recording and the funding page come after, as separate specs — as team picking did, delivered as M9.

**Status:** M0 and M1 delivered by `docs/superpowers/plans/2026-08-10-m0-m1-foundation.md`. M2 and M3 delivered by `docs/superpowers/plans/2026-08-10-m2-m3-responses-and-email.md`. M4 delivered by `docs/superpowers/plans/2026-08-11-m4-waitlist-cancellation-attention.md`. M5 delivered by `docs/superpowers/plans/2026-08-11-m5-auth-and-dashboard.md`.

**M6 is complete.** It split into two independent sub-projects (see
`docs/superpowers/specs/2026-08-12-m6a-game-setup-and-invites-design.md` §1):
**M6a (J1 — game setup and invites)** is delivered by
`docs/superpowers/plans/2026-08-12-m6a-game-setup-and-invites.md`. **J6 (owner
overrides, guests, squad removal / BR-3)** is delivered by two further plans:
`docs/superpowers/plans/2026-08-13-j6a-squad-management.md` (squad removal)
and `docs/superpowers/plans/2026-08-14-j6b-owner-overrides-and-guests.md`
(mark-in/out overrides, one-off guests, and BR-8's deliberate over-capacity).

---

# Part 3 — Remaining open items

Not blocking implementation. Flagged for a human decision at the point noted.

1. **Durable Objects plan requirement.** Verify before M2 whether DOs need the Workers Paid plan. Accepted either way; noted so the bill isn't a surprise.
2. **Resend account and domain verification.** Needed before M3 can send a real message. Until then, `ConsoleNotifier`.
3. **Privacy policy copy.** The `/privacy` page ships as a stub in M7. The author writes the content, and a retention period must be stated, before the service is offered beyond his own circle.
4. **Chasing non-responders.** Still no automated chase (open Q4). Revisit once SC-2 has real data.
5. **Half-hour timezone offsets.** Reminders land up to 30 minutes late in zones like `Asia/Kolkata` (§2.4). Only worth fixing if such a game ever exists.
6. **Odd min/max ranges.** A game configured min 11 / max 11 with `prefers_even_numbers` can never satisfy parity. M6 should show a soft warning at game creation, not a hard validation error.
