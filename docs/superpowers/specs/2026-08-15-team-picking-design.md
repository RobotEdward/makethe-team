# Team picking (BR-35) — design

**Date:** 15 August 2026
**Status:** approved
**Milestone:** M9. The master spec (§649) defers "team picking, score recording,
and the funding page" to separate specs after M1–M7; this is the first of the
three. M8 is squad visibility, so this is M9.

## 1. What this is

An organiser splits a fixture's confirmed players into two sides, names them
whatever the game calls them, and publishes the result. Everyone playing is
emailed and can see which side they are on.

The master spec anticipated it (§308): "split accepted players into two sides,
manually via drag-and-drop, later algorithmically. Implies a `team` concept
attached to a fixture, and eventually a per-player rating. **This is where the
`uneven` flag pays off.**"

Not in this: per-player ratings, algorithmic balancing, and score recording.
§308's "later algorithmically" stays later.

## 2. Where a team assignment lives

A nullable `team` column on `responses`, values `'a'` and `'b'`.

`responses` is already exactly the (fixture, player) pair the assignment needs
to hang off, and it already covers guests — `addGuest` writes a response row —
so a guest can be put on a side like anyone else. An assignment dies with the
response row it lives on. No new table, and no join to add to the squad query.

Team **names** go on `games`: `team_a_name` and `team_b_name`, defaulting to
`Team A` and `Team B`, edited on the existing game form beside
`prefers_even_numbers` and `squad_visible_to_players`.

Game-level rather than per-fixture: a game that plays Bibs against Skins plays
it every week, and a per-fixture override is a field nobody would use twice.

Two teams, not N. The master spec says two sides; nothing in the product wants
a third, and `'a' | 'b'` makes an invalid state unrepresentable in a way
`team_number INTEGER` would not.

## 3. Published, and stale

One column on `fixtures`: `teams_published_at`, nullable.

- **Saving assignments clears it.** The organiser has changed the teams and not
  told anyone, and the data says so directly rather than leaving it to be
  inferred.
- **Publishing sets it**, and sends N-9.

### 3.1 Roster churn is derived, never stored

Teams need another look when either of these is true of the fixture's response
rows:

1. someone is `in` with `team IS NULL` — a waitlist promotion or a new guest
   has arrived since the pick; or
2. someone has a non-null `team` but is no longer `in` — they dropped out.

**A departed player's `team` is deliberately not cleared.** The orphaned value
*is* condition 2. Clearing it would destroy the only signal that the published
teams no longer match the squad, and it buys a free property: a player who
drops out and comes back is back on their old side, with no special case.

Nothing about team picking writes to `FixtureCapacity`, `removeMember`,
`setResponse` or `withdrawMember`. That is the main thing this design is
buying: the paths J6b, M7a and M7b were built around are untouched, and a
fixture's capacity accounting cannot be affected by a team assignment.

### 3.2 Nothing rebalances itself

No machine ever moves a player who has already been told their side, and
nothing publishes without an organiser saying so. A late drop-out surfaces as
"these teams need another look" on the organiser's page; whether that is worth
another email to nine people is a judgement only they can make.

## 4. The screen

On the existing owner fixture page (`/g/:id/f/:fixtureId`), below the squad.

Two columns of names plus an unassigned bucket, and one Save button. **Every
row is a radio group inside a single form** — that is the entire feature with
JavaScript switched off, and it is what the JS-off browser journey exercises.

**Only `in` players appear.** A waitlisted player has no place in the fixture
yet, and putting them on a side would promise one; if they are promoted later,
they arrive unassigned and trip §3.1's first condition, which is exactly the
prompt the organiser needs.

**Saving a partial pick is allowed; publishing one is not.** An organiser
interrupted halfway must be able to keep what they have done, so unassigned
players save fine. But publishing while anyone `in` has no side would email
that person a message that says nothing about where they are playing, so it is
refused — with the unassigned names listed, on the page, rather than as a bare
error.

The script upgrades the columns to drop zones and updates the underlying radio
state as names are dragged, so the form remains the source of truth and Save
behaves identically whether or not the script ran. It joins
`PAGE_SCRIPT_BLOCKS` in `src/views/scripts.ts`, which gets it a CSP hash
computed from source automatically, and the existing tripwire fails the build
if it is added in one place and not the other.

This is not the product's first script on an ordinary page — `COPY_INVITE_JS`
already sits on the game overview — so the pattern is established rather than
novel. §332 permits "a small client island" for the picker specifically.

### 4.1 Where the `uneven` flag pays off

The picker shows each side's count and says plainly when they are uneven. The
game's existing `prefers_even_numbers` setting decides whether that reads as a
warning or as a neutral statement, reusing `fixtureView`'s `uneven` flag rather
than recomputing parity.

### 4.2 When it is available

Gated on the existing `takingChanges` predicate, exactly as the mark-in/mark-out
controls and the guest form already are: `open` only. A `scheduled` fixture is
not yet asking anyone anything, and a `played` or `cancelled` one is history —
both render the teams read-only.

## 5. What players see

**A player's own side is always visible to them**, on the fixture page and in
the email.

The full team lists follow BR-33's squad-visibility setting: a game that hides
the squad from its players hides the other side's names too. But it never hides
which side *you* are on — that would make the page contradict the email, and
the email cannot be un-sent.

This is a refinement of BR-33, not an exception to it: BR-33 governs seeing
*other people*, and your own assignment is not somebody else's data. The
existing `squadForViewer` decision point (`src/domain/squad-visibility.ts`)
stays the single place that answers the other-people question.

## 6. N-9

Sent on publish, to everyone `in` with a usable address. Never to guests
(BR-32) — an organiser who adds a guest still tells them personally, as they
already do for everything else.

- Dedupe key `n9:<fixtureId>:<playerId>:<publishedAt>`. The timestamp is
  load-bearing: re-publishing after a late change must genuinely re-send, and a
  key without it would be swallowed by the unique index on
  `notification_log.dedupe_key`. This is the same reasoning N-2 and N-8 already
  use for the same reason.
- It carries a leave link like every other game-scoped message (BR-22), minted
  the way M7a mints them.
- It states the recipient's own side first, then both line-ups subject to §5.
- Publishing goes through the same queued-row-then-send-then-apply ordering as
  every other sender, so a daily-ceiling refusal deletes the row and a later
  publish can retry, while a provider error stays `failed` and is never retried.

## 7. Audit

Two new actions under the existing `fixture` entity type:
`fixture.teams_saved` and `fixture.teams_published`. Organiser actions on a
fixture are audited (BR-27), and "who put me on this side" is exactly the
question an audit trail exists to answer.

## 8. Testing

**Server** — the two staleness conditions of §3.1, each independently and
together; saving clearing `teams_published_at`; publishing setting it; a
departed player's team surviving their departure (the property §3.1 depends
on); assignment refused on a `scheduled`, `played` or `cancelled` fixture; a
partial pick saving but refusing to publish, naming who is unassigned; a
waitlisted player never appearing in the picker; the
N-9 dedupe key changing across two publishes; guests never receiving N-9;
`team_a_name`/`team_b_name` round-tripping through the game form including the
defaults; and §5's split visibility — a player in a squad-hidden game seeing
their own side and not the other names.

**Browser** — a catalogue entry for the picker, and two journeys: assigning and
publishing **with JavaScript disabled**, through the radio form, which is the
guarantee that matters; and one with JavaScript on that drags a name between
columns and checks the underlying radio state followed it. The JS-on journey is
the only one of its kind in the suite, and its own comment should say why it
exists.

**The guide** — a new section for organisers on picking teams, and a mention in
the players' chapter of what the email tells them.

## 9. Not in this

- **Per-player ratings and algorithmic balancing.** §308 puts them later, and a
  rating system is its own product decision.
- **Score recording.** Separately deferred by §649.
- **More than two teams.**
- **Per-fixture team names.** §2's reasoning.
- **Auto-publishing or auto-rebalancing.** §3.2.
- **Telling guests.** §6, following BR-32 as everything else does.

## 10. Definition of done

1. An organiser can split an open fixture's confirmed players into two named
   sides and save it, with JavaScript off.
2. With JavaScript on, the same screen supports dragging, and the saved result
   is identical.
3. Publishing emails everyone playing, and re-publishing after a change emails
   them again.
4. A late drop-out or promotion never moves anyone automatically and never
   sends anything, but is visible to the organiser as teams needing another
   look.
5. Every player can see their own side; the other side's names follow BR-33.
6. BR-35 is added to the master spec, and N-9 to the notification catalogue and
   the dedupe-key table.
