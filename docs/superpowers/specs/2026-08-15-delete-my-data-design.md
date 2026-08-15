# Delete my data (BR-34) — design

**Date:** 15 August 2026
**Status:** approved
**Milestone:** M7b — the second of M7's four pieces. M7a (leave and unsubscribe)
shipped 15 August. The remaining two — `/privacy` and the
empty-states/error-pages/accessibility sweep — get their own specs.

## 1. What this is

A signed-in player can erase themselves from Make The Team. The request is
scheduled two days out, visible to them the whole time, and cancellable until
it runs.

This is the second half of the master spec's GDPR row (§Decisions, item 7:
"Deletion and leave paths built in M7"). M7a built the leave path. This builds
the deletion one.

## 2. Erasure is scheduled, and the window is inert

`POST /app/delete` sets `players.erases_at` to 48 hours from now. It removes
nothing, ends no membership, revokes no session, and frees no fixture slot.

The erasure itself runs from the existing hourly sweep (`0 * * * *`,
`CRON_SWEEP` in `src/cron/handler.ts`), in a new module
`src/sweep/erasures.ts` alongside `open-and-remind.ts`. Hourly rather than the
daily 03:15 materialisation cron because that one would turn "two days" into
anywhere from 41 to 65 hours depending on the hour of the request, which the
confirmation page has just promised a date for.

**The window has to be inert, and that is not a simplification — it is the
only coherent design.** Erasure ends every membership through `removeMember`,
which frees each open fixture's slot and promotes the longest-waiting
replacement. Those promotions send N-2 emails and cannot be taken back. If
requesting erasure removed the player immediately, "cancel" would not be a
cancel: it would be a rebuild, re-adding them to squads whose freed places
another player has already been told they now hold.

So nothing observable changes for two days except what the player is shown.
Reminders keep arriving, because they have not left anything yet, and each one
still carries its M7a leave link.

`POST /app/delete/cancel` clears `erases_at`. Available for the whole window.

### 2.1 Two columns, three states

Two nullable timestamp columns on `players`, added by one migration:

| `erases_at` | `erased_at` | Meaning |
|---|---|---|
| `NULL` | `NULL` | An ordinary player. |
| set | `NULL` | Erasure pending; the value is when it runs. |
| set | set | Erased. `erases_at` is kept as the record of what was promised. |

`erased_at` is what makes "is this row still a person?" answerable in one
column, from any query, without pattern-matching a name.

## 3. What erasure does to each table

One domain function, `erasePlayer(db, playerId, now)`, in its own module at
`src/domain/erase-player.ts`. It
anonymises in place rather than deleting rows, so that past fixtures keep an
accurate count of who played and every foreign key stays intact.

- **`players`** — `name` set to the placeholder (§4), `email` to `NULL`,
  `auth_user_id` to `NULL`, `email_verified_at` to `NULL`, `erased_at` to
  `now`. Nulling `email` is load-bearing beyond the erasure itself:
  `src/auth/link-player.ts` claims an existing player row *by email* on first
  sign-in, so a row with no address can never be re-attached to a future
  account.
- **`memberships`** — every game the player is active in, through M7a's
  `removeMember` with `actorPlayerId` set to the player. Erasure is *leave
  every game, then anonymise*, so waitlist promotions, audit attribution and
  freed slots all behave exactly as they already do for a single-game leave.
  Nothing new is written for the membership half.
- **Better Auth** — `session`, `account` and `passkey` rows for that
  `auth_user_id` are hard-deleted, then the `user` row. Also every
  `verification` row for the player's address: those hold live magic-link
  tokens, and leaving one behind would leave a working way back into an
  account that no longer exists.
- **`notification_log`** — rows are kept, because they are the delivery record
  and `player_id` is the only identifier in them. One exception: `error` is set
  to `NULL` for that player's rows. On a non-2xx from the provider,
  `src/notify/resend-notifier.ts` stores up to 500 characters of the response
  body in that column, and a provider's validation errors routinely quote the
  address they rejected. This is the only place in the schema where an email
  address can appear outside `players.email`.
- **`audit_log`** — untouched, and deliberately so. Every call site that
  carries a `before`/`after` payload was checked: they store ids, roles,
  statuses and lifecycle values, never names or addresses. The two exceptions
  are the guest-add and guest-remove actions (`src/routes/games.ts`), which
  embed a guest's name — and a guest can never reach this page, having neither
  an address nor an account (§8).
- **`responses`** — untouched, including `set_by_player_id`. This is what keeps
  a past fixture honest: a fixture that was ten-a-side still reads as
  ten-a-side.

### 3.1 What remains, and why that is still erasure

After this runs, the player's rows are keyed by a random id that is no longer
connected to a name, an address, or any means of signing in. The audit and
delivery records that survive are pseudonymous. The alternative — cascading
hard deletes through `responses` and `audit_log` — would silently rewrite other
people's fixture history and destroy the records BR-27 exists to keep.

## 4. The placeholder is deliberately not a plausible name

`players.name` is set to the exact string `[erased player]` — square brackets
included — rather than something like "Former player".

Renderers must branch on `erased_at` and show their own label; the stored name
is a fallback that should never reach a screen. Making it conspicuous means a
renderer that forgets the check produces something visibly wrong the first time
it is looked at, instead of a plausible fake name that survives review.

`redactName` (`src/domain/redact-name.ts`, BR-26) is the specific hazard: it
reduces "Edward Cooper" to "Edward C." and returns a single-word name
unchanged. A two-word placeholder would render as a redacted surname of a
person who does not exist.

## 5. Reaching it: the player's own session, both directions

`GET /app/delete` confirms and writes nothing. `POST /app/delete` requests, and
`POST /app/delete/cancel` cancels. All three are session-gated, under the
existing `AUTHENTICATED_PREFIX` mount, which already carries
`Cache-Control: private, no-store`.

**Both actions act on the session's own player id.** No player id in the path,
none in the body, nothing an organiser can aim at somebody else. This is a
construction, not a check: there is no parameter to get wrong, so the whole
class of "acted on the wrong player" bug cannot occur here. The J6a review
found exactly that class of bug once already.

It follows that an organiser cannot request erasure for a member, and cannot
cancel one — and the page says so, because an organiser who wants to help
someone will otherwise look for the control and not find it.

The `GET`/`POST` split is M7a's, for M7a's reason: a `GET` that scheduled an
erasure would be tripped by mail scanners and link prefetchers.

### 5.1 Consequence of session-only: reachability during the trial

`SIGNIN_ALLOWLIST` (TR-35) fails closed — an address not on the list is sent no
magic link at all, so it cannot reach a session, so it cannot reach this page.
During the trial, a player who is not allowlisted has no self-service route to
erasure and must ask the author directly.

That is acceptable and normal, but it is a real limit and `/privacy` must state
it rather than imply erasure is always self-service. It disappears when the
allowlist is deleted at launch.

## 6. The sole-organiser refusal, checked twice

The confirmation page counts active organisers on every game the player owns
before rendering anything. Where the player is the last active organiser of any
of them, it renders **no delete button** — it names those games, explains that a
game may never be left without an organiser, and links each one to its squad
page so they can hand over first.

`countActiveOwners` (`src/db/queries.ts`) and `isLastActiveOwner`
(`src/domain/last-owner.ts`) both already exist. This is the same shape M7a's
leave page uses, and `known-issues.md` records the opposite pattern — learning
the rule by hitting a refusal after clicking — as a defect in the self-demotion
flow.

**The check runs again at execution.** A player can pass it on Monday and be
the last organiser by Wednesday because a co-owner left in between. If the
sweep finds a blocking game, `removeMember`'s own `isLastActiveOwner` refusal
is the backstop: the erasure does not half-complete. It stays pending, retries
on the next sweep, writes an audit row, and surfaces on the player's dashboard
as a banner naming the game that is holding it up.

This means an erasure can sit unfulfilled indefinitely. That is the correct
trade against silently destroying a squad, but it is a real outcome and
`/privacy` must describe it.

## 7. What the player sees, and N-8

**The dashboard carries the banner**, not just the delete page: the date the
erasure runs, and the cancel button. A pending erasure that is only visible
where it was requested is invisible to the person who did not request it.

**N-8, sent once on request.** "Your data will be erased on <date>. If this
wasn't you, sign in and cancel." It is the only thing that reaches someone
whose account was misused within the window, since the banner requires them to
happen to sign in.

- Dedupe key `n8:<playerId>:<erasesAt>`, so cancelling and requesting again
  sends a second, correct email rather than being suppressed as a duplicate.
- Sent at request time, while the address still exists. There is no ordering
  hazard, which is exactly why there is no completion email: that one would
  have to be captured before the sweep nulls the address, making the sweep's
  internal ordering load-bearing for a courtesy.
- **It carries no leave link**, and its template must say why, as N-7's does.
  BR-22 is about game membership; N-8 is not about a game, and its recipient is
  in the middle of leaving all of them.
- The cancel instruction points at sign-in, never a token link. A token would
  make cancellation reachable from a forwarded email, which is the opposite of
  §5.

Three new audit actions under a new `player` entity type:
`player.erasure_requested`, `player.erasure_cancelled`, `player.erased`. Both
arrays are TypeScript-only narrowings, so neither needs a migration.

## 8. What this does not reach

- **Guests.** A guest has no address and no account, so no session and no way
  to ask. Their removal stays the organiser's action, through the flow J6b
  built. This is also why §3's audit-log finding holds.
- **Free text somebody else wrote.** A fixture's `notes`, a `venue_override`,
  or a game's name can mention a person, and nothing can find those
  automatically. `/privacy` says so plainly rather than the code pretending
  otherwise.
- **Games they co-own.** Erasure ends their ownership; the game and its other
  organisers are unaffected.

## 9. Testing

**Server** — the three states of §2.1 round-tripping; `POST /app/delete`
changing no membership, response or fixture count (the inertness guarantee, and
the one most likely to be broken by a later refactor); cancel clearing the
flag; the sweep erasing only rows whose time has passed; each table's
post-condition from §3 asserted individually, including the nulled
`notification_log.error` and the deleted `verification` rows; a pending
erasure blocked at execution by sole ownership staying pending rather than
half-completing; and both routes refusing to act on any player but the
session's own.

**Browser** — a catalogue entry for the confirmation page and one journey:
request, see the banner, cancel, see it gone.

**The guide** — chapter 04 covers leaving; erasure belongs beside it.

## 10. Not in this

- **`/privacy`** and the **empty-states / error-pages / accessibility sweep** —
  M7's remaining two pieces, each its own spec. This spec names three things
  `/privacy` must state (§5.1, §6, §8); it does not write them.
- **An organiser erasing a guest.** Named in §8 as out of reach, not as a
  deliverable.
- **A data export.** Erasure is what the GDPR row asks for in M7. Portability
  is a separate feature nobody has asked for.
- **Changing the allowlist.** §5.1's limit is a trial condition, and removing
  TR-35 is a launch decision, not a deletion one.

## 11. Definition of done

1. A signed-in player can request erasure, sees exactly what will be erased and
   what will survive, and is told the date.
2. Nothing about their memberships, responses or fixtures changes until that
   date.
3. They can cancel at any point before it, from the dashboard as well as the
   delete page.
4. Neither action can be aimed at any player but the one signed in.
5. The last organiser of a game is told why they cannot yet erase, before being
   offered the choice rather than after.
6. After erasure, no name, address, session, passkey or magic-link token for
   that person remains anywhere in the schema, and past fixtures still show the
   right number of players.
7. BR-34 is added to the master spec and the GDPR decision row records that M7
   built both paths.

---

## 12. Amendment — what the final whole-branch review changed (15 August 2026)

Recorded here rather than edited into the sections above, so the design as
approved and the design as built are both readable.

**§2.1 gains two columns, so the table there is four columns and five states.**
`players.erasure_started_at` and `players.erasure_blocked_at`, both nullable
timestamps, one migration (`0009`).

- `erasure_started_at` is set immediately before the first destructive write.
  Erasure is not atomic — D1 has no interactive transaction spanning Durable
  Object calls and several `db.batch()`es — so a run can stop part-way, at the
  late `blocked` return or at any throw inside the removal loop. In that state
  `erased_at` is still null, which the approved design left indistinguishable
  from an untouched pending request. The consequences were both real: the
  pending page went on saying "you're still in your squads" to somebody whose
  place had already been given to a waitlisted player and emailed about, and
  `POST /app/delete/cancel` cleared `erases_at` unconditionally, stranding an
  account out of its squads with nothing pending and no retry. Cancel now
  refuses in exactly that case, on the page at 422, with the reason.
- `erasure_blocked_at` exists to make §6's audit row a record of a *transition*
  rather than one row an hour, forever, for as long as nobody hands the game
  over. It is a separate column from the one above because cancel treats the
  two oppositely: a blocked erasure has written nothing and its owner must
  still be able to cancel, a started one has and must not. It is cleared by any
  run that gets past the pre-check, so a genuine re-block is recorded again.

**§6's three clauses are all implemented.** The approved text asked for three
things on an execution-time refusal — stays pending, writes an audit row,
surfaces on the dashboard naming the blocking game — and the branch as first
built did only the first. Now: `player.erasure_blocked` (a fourth `player.`
audit action, `after_json` carrying `{ gameIds }`), and a fourth state on
`/app/delete` with a matching dashboard banner. Both are selected on the
deadline having passed rather than on the blocked marker, deliberately: the
`pending` copy asserts a future instant and "nothing has changed", and the
instant passing is what makes it false whatever the cause. `runDueErasures`
also returns `blockedPlayers` and the cron logs one line per stuck player, so
an operator does not need an ad-hoc D1 query to find out who.

**§4's renderer branch is implemented.** It was specified and then not built:
`erased_at` was read only by the idempotency check and the sweep's filter, so
the conspicuous `[erased player]` placeholder reached a played fixture's squad
list and BR-27's "marked in by" line. `getFixtureWithSquad` now carries
`erased_at` for the member and for the setter, and `displayName`
(`src/domain/display-name.ts`, beside `redactName`) turns it into "a former
player". `listSquad` deliberately does not need it: erasure ends every
membership before it anonymises, so an erased player is never an active member.

**N-8's outcome is inspected rather than discarded** (§7). A daily-ceiling
refusal deletes the `notification_log` row so a retry stays possible, and
nothing retries this one — so `deferred` and `failed` are now logged
distinctly. A retry, or a `player.erasure_email_deferred` audit action beside
the four the ceiling already has, is left to the milestone that builds the
owner-visible ceiling UI.
