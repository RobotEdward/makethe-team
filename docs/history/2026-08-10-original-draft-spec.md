# Availability Coordinator — Product & Technical Specification

**Status:** Draft v1 — ready for implementation
**Audience:** A coding agent implementing this from scratch, plus human reviewers
**Working name:** `kickabout` (placeholder — see Open Questions)

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

- Players get one message the day before, tap once, and are done.
- Everyone can see the current squad at any time without asking.
- The organiser finds out the game is short *in time to do something about it*, not at kickoff.
- Dropouts are backfilled automatically from a waitlist.
- Setting up a new game takes minutes and then runs itself indefinitely.

## 1.3 Success criteria

These are the measurable targets the implementation should be judged against.

| ID | Criterion | Target |
|---|---|---|
| SC-1 | Time for a player to respond, from opening the reminder email | Under 10 seconds, no login, no app install |
| SC-2 | Share of invited players who respond before kickoff | > 80% |
| SC-3 | Manual chase messages sent by the organiser in a typical week | 0 |
| SC-4 | Notice given to the organiser when a fixture is below minimum | At least 12 hours before kickoff |
| SC-5 | Time to create a new recurring game from scratch | Under 3 minutes |
| SC-6 | Unplanned organiser intervention needed per fixture | 0 in the common case |

## 1.4 Design principles

1. **The reminder is the product.** Everything else is supporting cast. If the day-before message and its one-tap response don't work flawlessly on a phone, nothing else matters.
2. **No login on the critical path.** Auth exists for owners and for people who want a dashboard. It must never stand between a player and answering yes or no.
3. **The organiser is a user, not an admin.** Owner tools are for a friend who plays football, not an operations team.
4. **Silence is not consent.** No-response is a distinct state from declined, and is surfaced as such.
5. **Never spam.** These are real people's inboxes and a group of friends. Message volume is a hard constraint, not an afterthought.
6. **Boring and cheap.** This runs for years on a hobbyist budget. Prefer the option with fewer moving parts.

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
| **Owner** | A player who also administers a game (one or more per game) | Everything a Player can do, plus: create/edit the game, manage fixtures, override any player's response, add/remove squad members, cancel fixtures, promote another player to Owner |
| **Visitor** | Someone holding an invite link who is not yet a member | View a limited public fixture summary, join the squad |

There is no system administrator role in v1. Owners are the highest authority for their own game.

## 1.7 Vocabulary

Use these terms consistently in code, database, UI copy, and tests.

- **Game** — a recurring football fixture as a standing arrangement. Has a name, venue, day, time, duration, recurrence rule, and min/max player counts. Example: "Thursday 7-a-side at Oxford Sports Park".
- **Fixture** — a single dated instance of a Game. Example: "Thursday 14 August, 19:00". This is the thing players respond to.
- **Player** — a person. Exists once globally, may belong to many Games.
- **Membership** — the link between a Player and a Game. Carries their role (player or owner) and whether they are currently active.
- **Squad** — the set of active Memberships for a Game. Informal term; not a database table.
- **Response** — a Player's answer for a specific Fixture. One of the states in §1.8.
- **Reminder** — the scheduled message that opens a Fixture for responses.

Avoid: "event", "match", "team" (reserved for the future team-picker), "user" (say Player), "RSVP" in user-facing copy (say "response").

## 1.8 State machines

### Fixture

```
scheduled ──▶ open ──▶ confirmed ──▶ played
    │           │          │
    │           │          └──▶ cancelled
    │           └──▶ short ──▶ cancelled
    │                  └──▶ confirmed
    └──▶ cancelled
```

| State | Meaning | Entered when |
|---|---|---|
| `scheduled` | Exists on the calendar, not yet asking anyone | Created by materialisation (§2.3) |
| `open` | Accepting responses | Reminder sent, or an Owner opens it early |
| `short` | Open, but below minimum with kickoff approaching | Automated check at the warning threshold |
| `confirmed` | Minimum met; the game is on | Accepted count reaches the minimum |
| `cancelled` | Not happening | Owner cancels, at any point |
| `played` | Kickoff time has passed and it wasn't cancelled | Automatically, at kickoff + duration |

A fixture may move between `open`, `short`, and `confirmed` freely as responses change. `cancelled` and `played` are terminal.

### Response

| State | Meaning |
|---|---|
| `pending` | Invited, has not answered. The default for every active member when a fixture opens. |
| `in` | Playing. Occupies a squad slot. |
| `out` | Not playing. |
| `waitlisted` | Wants to play but the fixture was full. Holds an ordered position. |

Transitions are unrestricted except: a player may only enter `in` if a slot is free, otherwise they enter `waitlisted` (§1.10).

## 1.9 Core journeys

### J1 — Organiser sets up a game

An organiser signs in, creates a Game (name, venue, day of week, kickoff time, duration, min 10 / max 14), and gets a shareable invite link and QR code. They share it in their existing WhatsApp group. Players tap through, give a name and email, and are in the squad. No further action needed — fixtures generate themselves.

### J2 — Player responds to a reminder *(the critical path)*

At 09:00 the day before kickoff, every active member gets one email: when, where, who's already in, how many spots are left. It contains two large buttons: **I'm in** and **Can't make it**.

Tapping either lands on a confirmation page that has already recorded the answer — no login, no confirmation dialog, no second tap. That page shows the live squad list and lets them change their mind. If it's a phone, this is the entire interaction.

### J3 — Fixture fills up

The 12th player accepts and the fixture hits its minimum of 10 — it becomes `confirmed`. The 15th accepts and the fixture is at max — they're told they're on the waitlist at position 1, and they stay on the fixture page.

### J4 — Someone drops out

A confirmed player taps "Can't make it" at 6pm on the day. The system immediately moves the top waitlisted player to `in` and emails only that person: "You're in for tonight." Nobody else is notified.

### J5 — Fixture is short

At the warning threshold before kickoff the fixture is on 8 of a minimum 10. The system emails the Owners only, with the current squad, the list of non-responders, and a one-tap link to cancel. It does not chase players automatically, and it does not cancel automatically.

### J6 — Owner intervenes

An Owner opens the fixture page and sees the squad plus everyone's state. They mark a player as `in` on their behalf (someone texted them), add a one-off guest, or cancel the fixture with a reason — which emails everyone who was `in` or `waitlisted`.

### J7 — Player checks their status unprompted

A player who is signed in visits the site and sees their upcoming fixtures across all their games with current status, and can change any response.

## 1.10 Business rules

Numbered so tests can reference them.

**Squad and eligibility**

- **BR-1** Eligible players for a fixture are all Memberships on that Game where `active = true` at the moment the fixture opens.
- **BR-2** A player added to a squad after a fixture opens is not retroactively invited to it, but is invited to all subsequent fixtures.
- **BR-3** A player who leaves or is deactivated is immediately set to `out` on all future fixtures and removed from any waitlist.

**Capacity**

- **BR-4** A fixture is full when the count of `in` responses equals `max_players`.
- **BR-5** A player choosing "I'm in" on a full fixture is placed `waitlisted`, appended to the end of the waitlist. They must be clearly told this — never silently.
- **BR-6** Waitlist position is strictly by the time the player joined the waitlist. No priority, seniority, or reordering in v1.
- **BR-7** When an `in` player becomes `out`, the longest-waiting `waitlisted` player is immediately promoted to `in` and notified. This must be atomic — see TR-9.
- **BR-8** An Owner may exceed `max_players` via an explicit override. The UI must show the fixture as over capacity when this happens.
- **BR-9** Simultaneous acceptances for a single remaining slot must resolve deterministically: exactly one player gets `in`, the other gets `waitlisted`. No double-booking, ever.

**Fixture lifecycle**

- **BR-10** Fixtures are materialised from the Game's recurrence rule, at least 4 weeks ahead, in `scheduled` state.
- **BR-11** A fixture opens automatically when its reminder is sent. An Owner may open it earlier.
- **BR-12** A fixture becomes `confirmed` the moment `in` count reaches `min_players`, and reverts to `open` or `short` if it drops below again.
- **BR-13** A fixture transitions to `played` automatically once kickoff plus duration has passed, unless cancelled.
- **BR-14** Cancelling a fixture is always manual, always by an Owner, and always requires the fixture to be in a non-terminal state.
- **BR-15** Responses are locked once a fixture reaches `played`. Owners may still edit for record-keeping.
- **BR-16** An Owner may cancel a single fixture without affecting the recurring Game, or skip a date in advance.

**Notifications**

- **BR-17** Reminders are sent at 09:00 in the Game's local timezone on the day before kickoff. Configurable per Game; 09:00 day-before is the default.
- **BR-18** Every player receives at most **one** unsolicited reminder per fixture. All other messages are consequences of an action (waitlist promotion, cancellation) and are exempt.
- **BR-19** Notification sending must be idempotent. A retried or duplicated cron run must not send a second copy. See TR-8.
- **BR-20** Cancellation emails go to everyone who was `in` or `waitlisted`. Not to `out` or `pending` players.
- **BR-21** The short-fixture warning goes to Owners only.
- **BR-22** Every message contains a working unsubscribe/leave-game link.

**Access and identity**

- **BR-23** Responding to a fixture requires only a valid response token (§2.6). No account, no session.
- **BR-24** A response token is scoped to exactly one player and one fixture, and expires 24 hours after that fixture's kickoff.
- **BR-25** Viewing the full squad list, viewing other games, or performing any Owner action requires an authenticated session.
- **BR-26** A visitor holding an invite link sees only: game name, venue, date, time, and counts. Never the names or contact details of members.
- **BR-27** Every Owner override is recorded with actor, timestamp, previous value, and is visibly attributed in the UI ("marked in by Edward").

## 1.11 Notification catalogue

The complete set for v1. Do not add others without a decision.

| ID | Trigger | Recipients | Channel |
|---|---|---|---|
| N-1 | Fixture reminder, 09:00 day before | All eligible players | Email |
| N-2 | Promoted from waitlist | The promoted player | Email |
| N-3 | Fixture cancelled | Players who were `in` or `waitlisted` | Email |
| N-4 | Fixture below minimum at warning threshold | Owners | Email |
| N-5 | Sign-in magic link | The requesting player | Email |
| N-6 | Welcome / squad joined | The new member | Email |

## 1.12 Future scope

Design the data model to accommodate these; build none of them now.

- **Team picking** — split accepted players into two sides, manually via drag-and-drop, later algorithmically. Implies a `team` concept attached to a fixture, and eventually a per-player rating.
- **Score recording** — after a fixture is `played`, any player can record the result (winning side, or a score). Implies a `result` on the fixture.
- **WhatsApp and SMS** — additional notification channels. Implies a per-player channel preference and a delivery abstraction (§2.7). Note both carry per-message cost and, for WhatsApp, template pre-approval.
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
| Concurrency | Durable Objects | One per fixture, for capacity and waitlist only |
| Auth | Better Auth (magic link + passkey plugins) | Self-hosted; no per-user cost |
| Email | Resend | Behind an abstraction; SES is the eventual migration target |
| Scheduling | Workers Cron Triggers | Hourly sweep |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` | Runs in workerd against real bindings |
| CI/CD | GitHub Actions | See §2.9 |

**Language:** TypeScript, strict mode. **No client-side SPA framework in v1** — server-rendered HTML with progressive enhancement. The team picker in a later phase may introduce a small client island; it does not justify a framework now.

## 2.2 Architecture constraints

- **TR-1** Better Auth must be instantiated per request via a factory function. D1 bindings are only available inside the request handler; a module-level singleton will fail non-obviously.
- **TR-2** All secrets come from Worker bindings. Nothing sensitive in the repo, which is public.
- **TR-3** The Worker must be stateless between requests. All state lives in D1 or a Durable Object.
- **TR-4** Every page must be usable on a phone, on a poor connection, without JavaScript. JavaScript enhances; it is never required to respond to a fixture.

## 2.3 Recurrence and fixture materialisation

- **TR-5** A Game stores a recurrence rule and a timezone (IANA identifier, e.g. `Europe/London`). Fixtures are **materialised as rows**, never computed on the fly.
- **TR-6** A daily cron materialises fixtures so that at least 4 weeks of future fixtures exist for every active Game.
- **TR-7** Editing a Game's schedule affects only future `scheduled` fixtures. Already-open fixtures are untouched.

Computing recurrence at read time makes cancellations, one-off changes, and historical accuracy intractable. This is not negotiable.

## 2.4 The scheduler

- **TR-8** A **single** cron trigger runs hourly. It does not run per game. Each run:
  1. Finds fixtures whose reminder time has passed and whose reminder has not been recorded as sent.
  2. Inserts a row into `notification_log` **before** sending, keyed uniquely on `(fixture_id, player_id, notification_type)`.
  3. Sends the email; updates the log row with the outcome.
  4. Separately, checks open fixtures within the warning window and below minimum, and sends N-4.
  5. Separately, transitions past fixtures to `played`.

  The unique constraint on the log is what makes this idempotent — a crashed or duplicated run cannot double-send.

- **TR-9 (critical)** Cron triggers are configured **per environment**. Non-production environments must have no cron triggers and must use a non-delivering email provider. Two environments running the 09:00 sweep means duplicate emails to real people.

- Timezone handling: cron fires in UTC. The reminder time is computed from the Game's IANA timezone, so "09:00" stays 09:00 across BST/GMT transitions. There must be a test for a fixture spanning a DST boundary.

## 2.5 Capacity and the waitlist

- **TR-10** Each fixture has a Durable Object instance keyed by fixture ID. All response writes that could affect capacity (`in`, `out`, waitlist promotion) go through it. Durable Objects serialise requests, which gives BR-9 and BR-7 correctness with no locking logic.
- **TR-11** Reads (fixture page, squad list) go directly to D1 and do not touch the Durable Object.
- **TR-12** The Durable Object is the writer of record for response state; it writes through to D1 so that reads and reporting stay simple.

This is the only place in the system that needs a Durable Object. Do not use them elsewhere.

## 2.6 Auth and tokens

Two entirely separate mechanisms.

**Response tokens (no account)**

- **TR-13** A response token is an HMAC-signed opaque string encoding `player_id`, `fixture_id`, and expiry, signed with a server secret.
- **TR-14** Tokens are verified in constant time. Invalid or expired tokens render a friendly page offering sign-in, never a raw error.
- **TR-15** A `GET` on a token link must not mutate state. The email buttons link to a confirmation page that auto-submits a `POST`, or the link carries an intent that the page immediately posts. Email scanners and link prefetchers will follow every `GET` in your emails — treating a bare `GET` as a response will cause phantom acceptances.

**Sessions (accounts)**

- **TR-16** Magic link and passkey only. No password field anywhere in the codebase.
- **TR-17** Sessions are required for: the player dashboard, the full squad list, and every Owner action.
- **TR-18** Owner actions must re-check ownership server-side on every request. Never rely on UI state.

## 2.7 Notification abstraction

- **TR-19** All sending goes through a `Notifier` interface with a single `send(message)` method. Implementations: `ResendNotifier`, `ConsoleNotifier` (development), `NullNotifier` (tests and non-production environments).
- **TR-20** Message content is generated by templates that take a typed payload. Templates must render both HTML and plain text.
- **TR-21** The interface must not assume email. A channel field and per-player channel preference exist in the model from day one, even though only email is implemented.

Email provider constraints worth designing around: the Resend free tier is 3,000 messages per month with a **100/day cap**, and reminders bunch into a single morning burst. Batch sending where the provider supports it, and make the provider swappable.

## 2.8 Data model

Illustrative schema. The agent may adjust naming to Drizzle conventions but not the shape.

```sql
players
  id, name, email, phone, email_verified_at, created_at

games
  id, name, venue_name, venue_address, venue_url,
  timezone,                      -- IANA, e.g. Europe/London
  recurrence_rule,               -- RRULE string
  kickoff_time, duration_minutes,
  min_players, max_players,
  reminder_offset_hours,         -- default: 09:00 day before
  short_warning_offset_hours,
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
  status,                        -- scheduled|open|short|confirmed|cancelled|played
  min_players, max_players,      -- copied from game at materialisation
  venue_override, notes,
  cancelled_at, cancellation_reason,
  opened_at, created_at
  UNIQUE (game_id, kicks_off_at)

responses
  id, fixture_id, player_id,
  status,                        -- pending|in|out|waitlisted
  waitlist_position,             -- null unless waitlisted
  responded_at,
  set_by_player_id,              -- null for self, owner id for an override
  source                         -- 'token'|'web'|'owner'
  UNIQUE (fixture_id, player_id)

notification_log
  id, fixture_id, player_id, notification_type,
  channel, status,               -- queued|sent|failed
  provider_message_id, sent_at, error
  UNIQUE (fixture_id, player_id, notification_type)

audit_log
  id, actor_player_id, entity_type, entity_id,
  action, before_json, after_json, created_at
```

Notes:

- `fixtures` copies `min_players`/`max_players` from the Game at materialisation, so changing the Game later doesn't rewrite history.
- `responses` rows are created lazily — a `pending` row is written for every eligible player when the fixture opens (BR-1), which fixes the eligible set at that moment.
- `audit_log` covers BR-27 and is written for all Owner overrides and fixture state changes.

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

Environments: production only to begin with. A staging Worker and second D1 database get added when there are users beyond the author's own circle — at which point TR-9 (no cron outside production) becomes load-bearing.

## 2.10 Testing

- **TR-27** Vitest with `@cloudflare/vitest-pool-workers`, running in workerd against real D1 and Durable Object bindings. Do not mock the database.
- **TR-28** The test database is built by applying the real migrations via `readD1Migrations` / `applyD1Migrations`, so a broken migration fails CI rather than production.
- **TR-29** Route tests use the Hono test client.

Required test coverage, at minimum:

| Area | Must prove |
|---|---|
| Capacity | BR-9 — two simultaneous acceptances for one slot produce exactly one `in` and one `waitlisted` |
| Waitlist | BR-7 — a dropout promotes exactly the longest-waiting player, and notifies only them |
| Idempotency | BR-19 — running the cron sweep twice sends one email |
| Timezone | A fixture whose reminder crosses a BST/GMT boundary is sent at 09:00 local |
| Tokens | Expired, tampered, and cross-fixture tokens are all rejected |
| Prefetch safety | TR-15 — a `GET` on a response link records nothing |
| Authorisation | A non-owner cannot perform any Owner action, by direct request |
| Eligibility | BR-2, BR-3 — late joiners and leavers are handled correctly |

## 2.11 Build order

Each milestone should be independently deployable and demonstrable.

| M | Scope | Done when |
|---|---|---|
| **M0** | Repo skeleton, Hono + D1 + Drizzle wired, CI green, deploys to production | An empty page is live and CI blocks a failing test |
| **M1** | Games, fixtures, memberships, materialisation cron. No notifications. | An owner can create a game via seed data and see 4 weeks of fixtures |
| **M2** | Response tokens, the fixture page, in/out. Durable Object capacity. | A player with a token link can respond and see the squad; BR-9 test passes |
| **M3** | Email, reminder sweep, notification log. | A fixture reminder arrives at 09:00 local and a second sweep sends nothing |
| **M4** | Waitlist and promotion; cancellation; short warning. | J4 and J5 work end to end |
| **M5** | Better Auth — magic link, then passkeys. Player dashboard. | A player can sign in and see all their upcoming fixtures |
| **M6** | Owner UI — create/edit game, manage squad, overrides, invite link and QR. | J1 and J6 work end to end with no seed data |
| **M7** | Polish — empty states, error pages, accessibility pass, unsubscribe flows | Usable by a stranger with no explanation |

M1–M4 are the product. M5–M7 make it shareable. Team picking, score recording, and the funding page come after, as separate specs.

---

# Part 3 — Open questions

These need a human decision before or during implementation. The agent should implement the stated default and flag it rather than block.

1. **Product name.** `kickabout` is a placeholder. Affects the domain, the repo name, and email sender identity.
2. **Guests and ringers.** Can an Owner add a one-off player who isn't a squad member? *Default: yes, as a named entry with no contact details, occupying a slot.*
3. **Short-warning threshold.** SC-4 says at least 12 hours. *Default: 12 hours before kickoff, configurable per game.*
4. **Should non-responders be chased?** A second reminder would improve SC-2 but conflicts with BR-18. *Default: no automated chase in v1. Revisit with real data.*
5. **Recurrence complexity.** Full RRULE or just "every N weeks on day X"? *Default: store an RRULE string but only support weekly and fortnightly in the UI.*
6. **Fixture visibility for visitors.** BR-26 hides member names. Is that right for a group of friends, or unnecessary friction? *Default: hide until they join.*
7. **Data retention and GDPR.** A public service holding friends' emails needs a privacy policy, a deletion path, and a stated retention period. Not in the milestones above — needs adding before the service is offered beyond the author's own circle.
8. **Phone numbers.** The model has the column. Recommend not collecting until WhatsApp/SMS actually ships — less data to protect, one fewer field at signup.
