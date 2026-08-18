# Quick message to players (BR-36) — design

**Date:** 18 August 2026
**Status:** approved
**Milestone:** M15. M14 (PWA and web push,
`docs/superpowers/specs/2026-08-17-pwa-and-push-design.md`) is delivered, and
this is the first notification written by a person rather than by the product.

## 1. What this is

An organiser types a short message and sends it to their players, either to
everyone in a game or to a chosen slice of one fixture's squad. It goes out by
email, by push, or both, at the organiser's choice.

It is the answer to everything the notification catalogue does not cover:
"pitch has flooded, we're on the astro", "bring dark shirts", "anyone got a
spare set of keys". Today an organiser leaves the product entirely to say those
things.

**Not in this:** replies, threads, per-player direct messages, attachments,
scheduled sends, drafts, templates, and any player-visible archive of what was
sent. A broadcast is a notification, not a message board — see §3.

## 2. Who may send, and to whom

**Organisers only.** Both compose routes and both send routes resolve the game
through `findGameForOwner` (`src/db/queries.ts`) and 404 on refusal, matching
every other write under `/g/:id` and TR-18's rule that a refusal is a 404 rather
than a 403.

**Two scopes.** A game-scoped broadcast reaches everyone; a fixture-scoped one
reaches a chosen slice of that fixture's squad. The audiences:

| Scope | Audience | Selects |
|---|---|---|
| Game | `everyone` | every active membership of the game |
| Fixture | `playing` **(default)** | `responses.status = 'in'` |
| Fixture | `waitlisted` | `responses.status = 'waitlisted'` |
| Fixture | `pending` | `responses.status = 'pending'` |
| Fixture | `unavailable` | `responses.status IN ('out', 'withdrawn')` |

`waitlisted` is its own choice rather than being folded into `playing`. A
waitlisted player is in a genuinely different situation from an `in` one —
they are the person an organiser chases when someone drops — and an organiser
who wants both can send twice. Folding them together would make "your side is
Reds"-shaped messages reach people who have no slot.

`unavailable` pairs `out` with `withdrawn` deliberately. The two differ in how
the slot was released (BR-3), which matters to capacity and to nothing an
organiser writes; both are "not playing this week" to a human.

### 2.1 Who is excluded from every audience

Three exclusions, applied in one place (§4) rather than per audience:

- **Guests** (`players.is_guest`). BR-32: a guest has no address, and no device
  either. They are counted and reported, never messaged.
- **Anyone with a blank email *and* no registered device.** The `.trim()` is
  load-bearing exactly as it is in `send-teams.ts` and `send-welcome.ts`: an
  email of `" "` is truthy, and letting it through mints a `queued` row and a
  `no-recipient` result that `applySendResult` records as `failed` forever.
- **A `responses.status` this build cannot name.** That column is `text NOT
  NULL` with no CHECK constraint, so a row can hold a value the TypeScript union
  does not list. An unrecognised status resolves to *excluded from every
  audience* rather than throwing or falling into a default bucket, and it joins
  `test/stored-lookups.test.ts` with the rest of them.

A player selected by the audience but with an address and no device gets email
only, whatever the channel checkboxes say; the reverse holds for a device and
no address. The channel checkboxes are a ceiling on what is attempted, not a
promise about what exists.

## 3. Fire-and-forget

A broadcast leaves **no player-visible trace**. There is no message table, no
`/g/:id/messages` page, no notice rendered on the fixture page. What persists
is what persists for every other notification: `notification_log` rows, and one
`audit_log` row per send (§6).

The alternative — storing the message and rendering the latest one on the
fixture page — was considered and rejected for this milestone. It turns one
feature into four: storage, an expiry or supersession rule, a visibility rule
interacting with BR-33's squad visibility, and a rendering surface on the
busiest page in the product. A player who misses the notification has missed
it, which is exactly the contract every other notification already has.

The consequence to be honest about: an organiser cannot see what they sent
last week, and a player cannot re-read it. If that turns out to matter, the
audit rows in §6 are the seed of a history page, and adding one later breaks
nothing here.

## 4. Audience selection lives in a pure module

`src/domain/broadcast-audience.ts`. It holds the `BroadcastAudience` union, the
status mapping in §2's table, and the exclusion predicate in §2.1 — as pure
functions over rows, with no database and no clock (TR-20).

This is the milestone's global invariant, so per the milestone workflow's rule
1 its enumerating test is **task zero**, before any feature work: every
audience value, against every `responses.status` value including an
unrecognised one, against guest and blank-address rows. The rule this protects
is "no audience can ever select a guest or an unaddressable player", and it is
the kind of rule that is otherwise rediscovered once per calling site.

## 5. The compose page

One view module, `src/views/broadcast.ts`, serving both scopes; the fixture
variant additionally renders the audience radios.

| Route | |
|---|---|
| `GET /g/:id/message` | game-scoped compose |
| `POST /g/:id/message` | send |
| `GET /g/:id/f/:fixtureId/message` | fixture-scoped compose |
| `POST /g/:id/f/:fixtureId/message` | send |

All four in a new `src/routes/broadcast.ts`, mounted beside `gamesRoutes`.
`src/routes/games.ts` is already past 1,200 lines; adding four routes and a
sender to it would be the wrong direction.

**The form:**

- **Subject**, required, ≤ 60 characters.
- **Message**, required, ≤ 500 characters, a textarea.
- **Send by email** / **Send by push notification**, two checkboxes, both
  checked by default. Submitting with neither is refused at 422 with the reason
  on the form — silently sending nothing is the one outcome that must not
  happen.
- **Audience**, radios (fixture scope only), `playing` selected.
- Submit reads **Send to 12 players**, the count for the selected audience.

The count is recomputed from the database at send time. The one on the button
is a display: between a page load and a submit, someone can respond, be
promoted off the waitlist, or leave.

**The subject is also the push title**, which has roughly forty characters
before Android truncates it (`TITLE_MAX_CHARS` in `src/notify/push-copy.ts`,
spec §10.5). Capping the field at forty would make email subjects worse for the
sake of the smaller channel, so the field allows sixty and the push title is
truncated with the same ellipsis helper `PUSH_COPY` already applies to game
names. The field's hint says so.

**Entry points:** a **Message players** button on `src/views/game-overview.ts`
and on `src/views/owner-fixture.ts`.

**CSS:** the target is zero new style blocks — `FORM_CSS` already covers a
labelled textarea, a checkbox row and a primary submit. If a new block does
prove necessary it must be registered in `STYLE_BLOCKS`
(`src/views/styles.ts`, hashed by `src/security/csp.ts`) or it is dropped by
the browser in production with every test still green, and it must be placed in
the `pageStyles` array with its cascade position considered. No `style="…"`
attribute anywhere: `style-src` is hash-only, and a hash cannot authorise an
attribute.

## 6. Sending

`src/notify/send-broadcast.ts`, modelled beat for beat on `send-teams.ts`,
which is the closest existing shape (one batch, many recipients, both
channels):

1. Resolve the audience (§4) and load addresses by joining `responses` (or
   `memberships`) to `players`, **not** by an `IN (...)` list of player ids —
   `MAX_PLAYERS_CEILING` allows 200 players and D1 binds at most 100
   parameters (`src/db/chunk.ts`).
2. `playersWithPushSubscriptions` once for the whole batch, so a player with no
   device never gets a `PushMessage` and never accumulates a dead
   `no-recipient` row.
3. `insertQueuedLogRows`, then send, then `applySendResult` per row —
   insert-before-send, unchanged (BR-19, §2.4).
4. `markOrphanedRowsFailed` for anything an aborted apply loop never reached.
5. Email and push counts kept **separate** in the result, exactly as
   `TeamsSendResult` keeps them: the push leg has no daily ceiling and can
   never legitimately produce a `deferred`, and folding it into the email
   counts would inflate a number reported as an email figure.

**The notification type is `n10`**, added to `NOTIFICATION_TYPES` in
`src/notify/dedupe-key.ts` — the Drizzle column enum derives from that array,
so the addition is a typecheck, not a migration.

**The dedupe key is `n10:<broadcast_id>:<player_id>`**, with `broadcast_id` a
UUID minted once per request and shared by every recipient of that send. The
push leg wraps it in the existing `pushKey`. A timestamp would not do: two
broadcasts a second apart are both genuinely new information, and `Date.now()`
is frozen between I/O inside one Worker invocation, so a second send in the
same request would collide and the unique index would silently drop it. A
per-request UUID makes every send distinct by construction, and makes a
retried request re-send rather than double-send only if the retry re-enters the
route — which is the same exposure every other POST in the product has.

**`notification_log.fixture_id`** is the fixture for a fixture-scoped
broadcast and `null` for a game-scoped one. The column has been nullable since
N-6, which is the precedent.

**Email template:** `src/notify/templates/broadcast.ts`, pure (TR-20). Escaped
subject and body — this is the first template rendering text a person typed, so
the escaping is the whole security story and it gets its own test with a
`<script>` payload in both fields. Blank lines become paragraphs; nothing else
in the body is interpreted, so no Markdown, no autolinking. The email carries
the fixture's local time and venue when fixture-scoped (via
`formatLocalDateTime`, TR-5), "Sent by *organiser name*", and the usual leave
link (BR-22).

**Push copy:** a `PUSH_COPY.n10` entry taking the same payload as the template,
title from the subject and body from the message, both truncated to the tray
budget.

**No reply-to.** The email sends from the fixed address like every other, and
the organiser is named in the body. Adding a reply-to would mean threading a
new field through `Message` and `ResendNotifier`, and would disclose the
organiser's email address to their whole squad — a privacy change that needs a
better reason than convenience.

**The send runs inside `c.executionCtx.waitUntil`**, and the route redirects
back to the fixture or game page with a notice, following `publishTeams` in
`src/routes/games.ts`. The organiser is not held on a spinner while 200
messages go out.

## 7. Rate limit

**Three broadcasts per game per UTC day.**

This is the first path in the product that lets a *person* spend the daily
email ceiling on demand. `MAX_EMAILS_PER_DAY` is global (TR-31): without a
per-game limit, one organiser with a 200-player squad and an itchy finger
starves every other game's reminders for the rest of the day.

The counter is the audit rows themselves — `entity_type = 'game'`,
`entity_id = <game_id>`, `action = 'game.broadcast_sent'`, `created_at` within
today's UTC day. No new table, and no second source of truth about what was
sent.

A fourth attempt re-renders the compose page at 422 with the message preserved
and the reason stated, matching how the publish route refuses. Three is a
starting number, not a law: it is a constant in one place with its reasoning on
it.

## 8. Audit

Two new actions on `AUDIT_ACTIONS` (`src/domain/audit.ts`); `game` is already
an `AUDIT_ENTITY_TYPE`, and both enums are TypeScript-only narrowings, so
neither needs a migration.

- **`game.broadcast_sent`** — one row per send. `after_json` carries the
  audience, the channels chosen, the recipient count, the fixture id (or
  `null`), and the **subject only**. Not the body: the audit log is an
  operational record of who did what, and copying 500 characters of
  possibly-personal prose into a second, longer-lived place is not what it is
  for. The subject is enough to identify a send when someone asks about it.
- **`game.broadcast_email_deferred`** — a daily-ceiling refusal on the email
  leg, the durable half of TR-31's warning, matching the existing
  `fixture.reminder_email_deferred` family. A ceiling refusal *deletes* its
  `notification_log` row, so without this row there is no evidence anyone was
  ever owed the message.

## 9. Privacy

`/privacy` (`src/views/privacy.ts`) gains a sentence: an organiser of a game
you belong to can send you a message by email and, if you have registered a
device, by push notification. Nothing new is collected and nothing new is
shared — but "who can cause mail to arrive in my inbox" changes from "the
product" to "the product and my organiser", and that is a disclosure.

Erasure needs no new handling: `n10` rows are ordinary `notification_log` rows
keyed on `player_id`, and erasure's handling of that table is not
notification-type-specific. **Confirmed against `src/domain/erase-player.ts`:**
its only write to `notification_log` nulls `error` on rows matched by
`eq(notificationLog.playerId, playerId)` alone — no `notification_type` appears
in the `where` clause — so an `n10` row is covered exactly as an `n1` row is,
with nothing added for this milestone.

## 10. Testing

Beyond task zero (§4):

- **Escaping.** A `<script>` payload in both subject and body, through the
  email HTML and through the push payload.
- **Channels.** Email only, push only, both; neither refused at 422. A
  recipient with an address and no device under "both". A recipient with a
  device and no address under "both".
- **Exclusions.** A guest, a blank-email player, an unrecognised
  `responses.status` — none receives anything, and the counts report them.
- **Counts.** Email and push `sent`/`failed` never folded together; a
  ceiling-refused email reported as `deferred` and writing its audit row.
- **Rate limit.** The third send succeeds, the fourth is refused, and the
  refusal preserves what was typed. Yesterday's rows do not count.
- **Authorisation.** A signed-in non-owner gets 404 on all four routes.
- **The rendered page.** A captured PNG of the compose page, read — per the
  milestone workflow's rule 3. String assertions cannot see an unstyled
  textarea or a checkbox invisible against its track.

## 11. Spec amendments

In `docs/superpowers/specs/2026-08-10-make-the-team-design.md`:

- **§2.8's catalogue table** gains N-10: *Organiser broadcast — chosen audience
  of a game or fixture — 1 per send per player — Email + Push*.
- **§2.8's dedupe-key table** gains `n10:<broadcast_id>:<player_id>`.
- **A new BR-36** stating the rule: an Owner may send a short message to a
  chosen audience of a Game or one of its Fixtures, on either channel or both,
  at most three times per Game per day; guests and unaddressable players are
  never recipients; nothing is stored for players to read later.
- **§2.14's build order** gains **M15**, done when an organiser can message
  their squad from the fixture page and a phone with a registered device
  receives it.

## 12. Delivery

A sibling worktree, `../maketheteam-m15`, with its own `npm install`, merged
fast-forward to `main`.

**Status:** delivered by docs/superpowers/plans/2026-08-18-m15-quick-message.md
