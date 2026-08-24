# M34 — Gated invites

**Status:** design, approved in brainstorming 24 August 2026.
Amends `docs/superpowers/specs/2026-08-10-make-the-team-design.md`.

## The problem

Every Fixture asks the whole squad at once. A Game with eighteen members and a
`max_players` of ten therefore runs a race: the eight fastest thumbs get in, and
the people the organiser actually built the Game around end up on a waitlist
behind whoever happened to be holding their phone. Organisers work around it by
not adding the fringe to the squad at all, which costs them the fringe on the
week they need it.

Gated invites let an owner say who is asked first, and asks the rest only as
places genuinely come free.

## What it is

Optional, per Game, **off by default**. When on:

- The owner orders the squad into a **core group** and then a sequence of
  further tiers — each tier either a named group or a single player.
- At the reminder instant, only the core group is invited.
- Each decline releases **the next tier in full**, provided the Fixture still
  needs players.
- An owner-configurable **fallback** releases further tiers as kickoff nears if
  the Fixture is still short of `min_players`, which covers a squad that goes
  quiet rather than declining.
- The owner can release the next tier by hand at any time.

## Business rules

- **BR-38.** A Game may declare an invite order: zero or more ordered Invite
  Tiers, plus an implicit final tier holding every active member not assigned to
  one. A member belongs to at most one Tier of one Game.
- **BR-39.** When `games.gated_invites_enabled` is off, every active member is
  invited at the reminder instant, exactly as before this milestone. This is the
  default and the behaviour of every Game that existed before it.
- **BR-40.** Gating governs **who is notified, and when**. It never governs who
  may respond. A member whose Tier has not been released may still open the
  Fixture and say they are in, taking a slot immediately (BR-4/BR-5 apply
  unchanged). The eligible set is still fixed at open by BR-1, with BR-2′'s
  single sanctioned late addition.
- **BR-41.** A Tier is released by stamping `responses.invited_at` on the live
  Response rows of its members. Nothing ever clears the stamp: releasing is
  one-way, and `invited_at` is the durable record of what has gone out.
- **BR-42.** A released player receives the N-1 invitation — the same message,
  under the same dedupe key, that the core group received. There is no separate
  "you're needed" notification.
- **BR-43.** A release is vetoed while the Fixture does not need players:
  `potential >= max_players`, where `potential` is every live `in` or
  `waitlisted` response — guests and early volunteers included — plus every
  released member still `pending`. A vetoed release is not lost; it happens on
  the next reconcile after `potential` drops.
- **BR-44.** After a Game's fallback instant (`kicks_off_at` minus
  `gated_fallback_hours_before`), Tiers are released until `potential >=
  min_players` or the Tiers run out, regardless of whether anyone declined. A
  null `gated_fallback_hours_before` means never.
- **BR-45.** While a gated Fixture still holds an unreleased Tier and its
  fallback instant has not passed, the N-4 attention warning is suppressed. A
  gated Fixture is *supposed* to look short early; warning the owner about the
  thing they asked for is how a useful alert becomes one people ignore.

## Data model

Four schema changes. Migration generated with `npx drizzle-kit generate`
(next file is `migrations/0023_*.sql`).

### `invite_tiers` (new)

| column | type | notes |
|---|---|---|
| `id` | text PK | |
| `game_id` | text NOT NULL → `games.id` | |
| `name` | text NOT NULL | owner-supplied; a one-player tier is usually named for them |
| `position` | integer NOT NULL | ascending = asked earlier |
| `created_at` | integer NOT NULL | tie-break for equal `position` |

Index on `(game_id, position)`. **Deliberately not unique.** Reordering rewrites
every row's position in one `db.batch()`, and SQLite checks a unique index per
statement, so a batch that swaps positions 1 and 2 would fail on its first
statement with no way to defer the check. Order is therefore
`ORDER BY position, created_at`, and a duplicated position is a display-order
tie rather than a write that cannot happen.

### `memberships.invite_tier_id` (new column)

Nullable text → `invite_tiers.id`. **Null is the implicit final tier**, which is
what makes a new joiner reachable on the day they join with no owner action —
the alternative, where unplaced members are never invited, silently benches
people who have no way to notice.

A membership carries the tier rather than a join table because
`UNIQUE (game_id, player_id)` on `memberships` already enforces "one tier per
player per Game" for free. Deleting a Tier nulls the column, dropping its members
to the implicit tier rather than orphaning them.

SQLite cannot cheaply express "the referenced Tier belongs to this Game"; the
write path scopes every Tier lookup by `game_id`, and a test pins it.

### `games` (two new columns)

- `gated_invites_enabled` integer NOT NULL DEFAULT 0.
- `gated_fallback_hours_before` integer NULL — null means never. The form
  offers 12 when gating is switched on, matching `short_warning_offset_hours`'
  default.

Both read **live, never snapshotted onto `fixtures`**, following the M26 switches
for the reason their comment gives: a switch is not history.

### `responses.invited_at` (new column)

Nullable `timestamp_ms`. Null means "not yet invited". For a non-gated Game it
stays null forever and is never read.

Nothing is added to `fixtures`: which Tiers have been released is derivable from
`invited_at` joined through `memberships.invite_tier_id`, and a cached copy is a
second source of truth to be got wrong.

## The release rule

Level-based — derived entirely from current state, never from an event log — so
it is idempotent under retry, safe under concurrent calls, and self-correcting
after any failure.

```
tiers      = invite_tiers for the game, by (position, created_at),
             then the implicit tier
released   = tiers where any member holds a non-null invited_at

# capacity-facing: how many slots are spoken for
potential  = every live response that is `in` or `waitlisted`   # guests and
             + released members still `pending`                 # volunteers too

# owed-facing: released people who will not be filling a slot
shortfall  = released members whose response is `out`, `withdrawn`,
             or absent entirely
owed       = 1 + shortfall            # tier 1, plus one per member lost
target     = max(|released|, min(owed, |tiers|))

repeat until nothing is released:
    if |released| < target and potential < max_players:
        release the next tier
    else if now >= fallback instant and potential < min_players and tiers remain:
        release the next tier
    recompute

finally: stamp invited_at on every uninvited live response row
         belonging to a released tier
```

The two quantities are defined separately on purpose. `potential` has to count
an early volunteer (BR-40) and an owner-added guest, because both really do take
a slot; `shortfall` must not, because neither is a released member who went
missing. Folding the two into one number — `expected - potential` — gets the
volunteer case wrong in both directions at once.

A `waitlisted` member counts towards `potential` and never towards `shortfall`,
for a related reason: they want the next free slot and BR-7 will hand it to them,
so treating them as missing would release a tier on behalf of somebody keen.

`shortfall` counts from the **membership** side, not by counting declines. That
matters: `withdrawMember` *deletes* the row of a `pending`, `out` or `waitlisted`
player rather than marking it, so a rule that counted `out` rows would silently
fail to release a tier when an owner removed an invited player who had not yet
answered. A member with no live row is missing from `potential` and so lands in
`shortfall` regardless of how they went.

The final stamping step is also what handles a BR-2′ joiner who lands in a tier
that is already released: they are a member of a released tier, so they are
invited, with no special case.

Worked through. Squad of 14, `max_players` 10, `min_players` 8; core of 5 (Ali,
Ben, Cara, Dev, Ess), then Regulars (Fin, Gus, Hana), then Ida, then the implicit
tier of 5. Each row is the state *after* the previous row's release was stamped.

| Moment | shortfall | potential | owed | target | Action |
|---|---|---|---|---|---|
| Reminder instant | 0 | 0 | 1 | 1 | release core; recompute gives target 1 again — stop |
| Ess is muted, so is `out` from the moment it opened (M28) | 1 | 4 | 2 | 2 | release Regulars, in the same pass |
| Ben declines | 2 | 6 | 3 | 3 | release Ida |
| Fin, a sub in Regulars, declines | 3 | 6 | 4 | 4 | release the implicit tier — subs releasing subs falls out free |
| Owner presses "invite next group" | — | — | — | — | stamps directly; `\|released\|` rises, and the loop only ever adds |

The veto needs a Fixture that is actually full, so it takes its own example: same
Game, but a core of 12 against the same `max_players` of 10.

| Moment | shortfall | potential | owed | target | Action |
|---|---|---|---|---|---|
| Core released, nobody has answered | 0 | 12 | 1 | 1 | nothing owed |
| One core member declines | 1 | 11 | 2 | 2 | owed a tier, but `potential` 11 ≥ 10 — **vetoed by BR-43** |
| Two more decline | 3 | 9 | 4 | 4 | `potential` 9 < 10, so the release held back above happens now |

The loop terminates because each iteration releases at least one tier and the
tier list is finite. `max(|released|, ...)` is what lets the manual button and
the fallback compose with the decline rule: `invited_at` cannot be un-stamped, so
every path moves the line in one direction only.

## Where the work happens

**Claim in the Durable Object, send outside it.**

`FixtureCapacity` already serialises every write that changes `in` and `pending`
counts, which are exactly the numbers the rule reads. A new method —
`claimInviteReleases({ now, force? })` — runs the rule inside the existing
`blockConcurrencyWhile` critical section, stamps `invited_at`, and returns the
player ids it stamped. **No I/O moves into the object**: sending an email from
inside the lock would freeze the Fixture for the whole squad behind one slow
Resend call, which is the reasoning `WaitlistPromotion` already documents for
N-2.

Three callers, all addressing the object with `getByName(fixtureId)`:

1. **The respond route**, after a decline, in a `waitUntil` — for latency.
2. **The sweep**, every tick, for every open gated Fixture — the guaranteed path
   and the fallback's trigger.
3. **The owner's manual button**, with `force: true`, releasing exactly one tier
   and ignoring BR-43's veto.

Sending reuses `buildReminderMessages` and `insertQueuedLogRows` with the `n1`
key verbatim, exactly as `sendLateInvitations` does for BR-2′ joiners.

**The failure mode is already handled.** If the claim succeeds and the send then
fails, `invited_at` is stamped but no email went out. The next sweep tick finds
that player invited, finds no `n1` row for them in `existingReminderLog`, and
sends it. The request-path send is therefore purely a latency optimisation and
the sweep is the guarantee — no compensating machinery, no cleanup pass.

## Notification wiring

- `NOTIFICATION_TYPES` is **unchanged**. N-1 is reused; no N-14.
- `eligiblePlayers` (`src/sweep/open-and-remind.ts`) gains, for gated Games only,
  `invited_at IS NOT NULL`. Non-gated Games take the existing path untouched.
- `sendLateInvitations` gains the same filter, so a BR-2′ joiner who lands in an
  unreleased tier is backfilled a row but not mailed.
- `reminderKey(fixtureId, playerId)` needs no timestamp: a player is invited once
  per Fixture, and the existing UNIQUE on `dedupe_key` is what stops the
  request-path send and the sweep from both mailing them.
- The N-4 attention sweep gains BR-45's suppression.
- Broadcast audiences (`src/domain/broadcast-audience.ts`) are **unchanged**. A
  broadcast is the owner speaking to the squad, not an invitation.
- N-3 cancellation is unchanged: its recipients are `in` or `waitlisted`, which
  gating cannot affect.

## Screens

### Owner — invite order (`GET/POST /g/:id/invites`)

Option C from the mockup: a **core group box**, then a numbered list of what
happens after. Two interactions, deliberately — "who is asked first" is a
different question from "in what order does everyone else follow", and one
drag-everything list makes the core group just another row.

```
Core group — asked when the game opens
  [Ali] [Ben] [Cara] [Dev] [Ess]  [+ add]

Then, as spots come free
  1  Regulars — Fin, Gus, Hana        ⠿
  2  Ida                              ⠿
  3  Everyone else — Jo, Kit, Lena…   (pinned, cannot be moved or deleted)

  [ + Add a group ]
```

The implicit tier is rendered dimmed and pinned last, with its members listed so
the owner can see who it actually contains.

Routes: `POST /g/:id/invites` saves the whole order and every membership
assignment in one submission; `POST /g/:id/invites/tier` adds a group;
`POST /g/:id/invites/tier/:tierId/delete` removes one, nulling its members'
`invite_tier_id`.

### Owner — invite progress, on the fixture page

Kept as a panel, not compressed to a line: it has to say **why** a tier is held,
and "next up · asked automatically at 12h before, if still short" is not
something a status word carries.

```
Core          asked Mon 09:00      4 in · 1 out (Ben)
Regulars      asked Tue 18:12      2 in · 1 waiting
Ida           next up              asked automatically at 12h before, if still short
Everyone else held                 5 players

[ Invite Ida now ]
```

`POST /g/:id/f/:fixtureId/invite/next` is the button.

### Owner — game settings

The switch, plus the fallback, on the existing edit form:

```
[on] Ask in priority order
     Off — everyone is asked at once

If we're still short of the minimum,
ask the next group  [ 12 hours before ▾ ]
Set to "never" to release only on a decline.

Edit the invite order →
```

### Player — not yet asked

```
Thursday 7pm · Powerleague          6 in · 4 spots left

You haven't been asked yet
The core group is being asked first. We'll let you know if a spot opens up.

[ I'm in anyway ]   [ No thanks ]
```

BR-40: the controls are live. The copy sets the expectation; it does not gate the
button.

### Views and CSS

New `src/views/invite-order.ts` and the progress panel in
`src/views/owner-fixture.ts`. A new `INVITE_ORDER_CSS` block — named to avoid
collision with the existing `INVITE_CSS`, which is the join-link page — **must be
added to `PAGE_STYLE_BLOCKS`** in `src/views/styles.ts`, or the CSP drops it and
every test still passes. Its position in that array is cascade order; check it
against `test/views/style-cascade.test.ts`.

## Migration and rollout

The migration adds one table and four nullable-or-defaulted columns. No backfill.

Enabling gating on a Game whose Fixture is already open degrades safely: the
reconciler sees nothing released, releases the core, and stamps — but every one
of those players already holds an `n1` row, so the UNIQUE on `dedupe_key` drops
the duplicate and nobody is mailed twice. Gating takes effect from the next
Fixture.

## Testing

Task zero, before feature work, per the milestone rules:

1. **The release rule as a pure function**, table-driven over every row of both
   worked examples above plus the degenerate cases: gating on with no tiers
   defined (behaves exactly as ungated, since tier 1 *is* the implicit tier),
   every member in the core, a squad smaller than `min_players`, and an early
   volunteer from an unreleased tier (counted by `potential`, never by
   `shortfall`).
2. **Idempotency and convergence** — running the reconciler twice changes
   nothing the second time; it terminates with tiers exhausted.
3. **The cross-Game invariant**: a `memberships.invite_tier_id` may only name a
   Tier of that membership's own Game.

Then, per feature:

- `eligiblePlayers` and `sendLateInvitations` filter on `invited_at` for gated
  Games and are byte-identical for ungated ones.
- A claimed-but-unsent player is picked up by the next sweep tick (the failure
  mode above, asserted rather than assumed).
- Two concurrent declines release one tier, not two.
- BR-45's N-4 suppression, and that it lifts once the last tier is released.
- `test/stored-lookups.test.ts` needs no new entry: `invite_tiers.name` is free
  text, not a lookup key.
- Render the invite-order page and the progress panel and **read the PNGs** —
  both are layouts whose shape depends on their content (a fifteen-member
  implicit tier, a one-player group, a tier named with a long string).

## Out of scope

- Groups reusable across Games. Tiers are per-Game; a player who plays in two
  Games is ordered separately in each.
- Per-tier message copy. BR-42 reuses N-1 deliberately.
- Suggesting a core group from attendance history. Presence data (M33) makes this
  tempting and it is a different milestone.
- Any change to how the waitlist orders itself. Gating decides who is asked;
  BR-6 still decides who gets the next free slot, strictly by arrival.
