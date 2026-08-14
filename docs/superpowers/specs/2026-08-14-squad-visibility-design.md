# Squad visibility — design

**Date:** 14 August 2026
**Status:** approved
**Milestone:** M8. The master spec's build order (§2.14) ends at M7, so this adds
a milestone rather than filling one; §2.14 needs a row for it.

## 1. What this is

An organiser can decide whether the players in their squad may see **who else is
playing** each fixture. When they may — the default, and today's behaviour — a
player sees every squad member and their answer. When they may not, a player
sees the counts and their own answer, and no names.

It also gives players a **game view** for the first time. Today `/g/:id` is
owner-only and 404s for everyone else, so a player has no page for a game at
all — only the dashboard, which is deliberately per-fixture and shows only
their own commitments.

## 2. What already exists, and what is actually new

**Half of this already ships.** `/r/:token` — the page a player reaches from
their reminder email — has listed the whole squad with every member's state
since M2: "In", "Waitlisted (2nd)", "Not yet responded", "Can't make it", under
full names. BR-25 authorises it explicitly.

So the new work is three things:

| | State today |
|---|---|
| The squad list on `/r/:token` | **Exists**, unconditional. Becomes conditional. |
| An owner control over it | **Does not exist.** |
| A player's game view | **Does not exist.** `/g/:id` 404s for a non-owner. |

Names stay **full**, as they are today. These are people who play football
together weekly and know each other's names; BR-26's redaction ("James S")
governs the *public invite page*, which a stranger can reach, and does not
apply here. Two players called James would be indistinguishable on the one page
that exists to say who is playing.

## 3. The data and the rule

One column on `games`:

```
squadVisibleToPlayers: integer("squad_visible_to_players", { mode: "boolean" })
  .notNull().default(true)
```

**This needs a migration** — the first in several milestones, and named here so
nobody assumes the recent run of migration-free work continues.

Default `true`, for new and existing games alike. Off-by-default would silently
strip a capability players have had since M2 and would falsify the guide
chapter that documents it.

### 3.1 One decision point

The policy lives in one domain module, `src/domain/squad-visibility.ts`, not in
a boolean tested at three call sites:

```ts
/**
 * The squad this viewer may see, or `null` for "counts only".
 *
 * An Owner always sees the full list — they are managing the fixture. A player
 * sees it when their game allows it. This is the *only* place that decides, so
 * the pages carry no policy: they render a list or they render counts.
 */
export function squadForViewer(
  game: { squadVisibleToPlayers: boolean },
  squad: readonly SquadMember[],
  viewer: { isOwner: boolean },
): readonly SquadMember[] | null;
```

A viewer always sees **their own** state regardless — that is rendered from
their own row, not from this list, so it is unaffected by a `null`.

### 3.2 The business rules change

**BR-25** currently reads, unconditionally, that a valid response token
authorises viewing that single fixture's squad. This narrows it. The rule text
must be amended in the master spec, or the code and the spec disagree from the
day this ships. A new rule states the control:

> **BR-33** A Game carries a squad-visibility setting, default on. When off,
> players see fixture counts and their own response but not other players'
> names or responses. Owners are unaffected.

## 4. The player's game view

`GET /g/:id` gains a second audience:

- an active **owner** → today's page, unchanged;
- an active **member** → the new player page;
- everyone else — not a member, a *removed* member, an unknown game — → **404**,
  matching the entitlement shape every `/g/*` route already uses (TR-18).

### 4.1 A separate renderer, not conditionals

The player page is its own module, `src/views/player-game.ts`. It does not
share a template with the owner's page and does not take an `isOwner` flag.

This is the design's most load-bearing decision. **The owner page carries the
invite link and its QR code, and that link is a capability**: anyone holding it
can add themselves, or someone else, to the squad. A forgotten conditional in a
shared template leaks that capability to every member of the squad. A separate
renderer makes the leak impossible to write by accident rather than merely
unlikely to be written.

### 4.2 What it shows

- The **open** fixture's squad with every member's state — or, with visibility
  off, the counts alone.
- Below it, upcoming fixtures as a plain list of dates.

When no fixture is open, it says so plainly and shows the dates. **It does not
show a roster in that case.** A `scheduled` fixture holds no response rows at
all — BR-1 writes them when a fixture opens — so there is nothing to show, and
listing the membership instead would create a second surface with its own
visibility question. Names appear alongside a fixture's states, or not at all.

## 5. The fixture response page

`/r/:token` renders its squad through `squadForViewer`. Visibility on, it is
byte-identical to today. Visibility off, the squad section becomes the counts
the page already shows — "8 in, 2 spots left" — plus the viewer's own answer,
which they always see.

**Guests** appear in that list today marked "(guest)" and will be visible to
players under the same flag. Correct, and stated so it is not a surprise.

**Withdrawn** members are already filtered out by `getFixtureWithSquad` and stay
filtered.

## 6. The organiser's control

A checkbox on the game form, beside "prefers even numbers", worded for an
organiser rather than as a setting name: **"Let players see who else is
playing"**. It flows through `parseGameForm` and `updateGame` like every other
field, and `game.updated` already records changed columns, so the change is
attributed in the audit log for free.

### 6.1 The checkbox trap, already solved once

`src/views/game-form.ts` documents at length why a checkbox needs a companion
hidden marker field (`PREFERS_EVEN_SUBMITTED`): an unchecked checkbox is simply
**absent** from the POST body, so "the owner unchecked it" and "this form was
never submitted" arrive as the same `undefined`. Without the marker, an owner
who unchecks the box, mistypes the kickoff time and corrects it silently saves
the value back to `true` against their intent — the redisplay re-checks the box
and they have no reason to look again.

**The new checkbox needs exactly the same treatment.** Follow the existing
pattern rather than rediscovering the bug: a hidden marker, read only by the
view, with the checkbox remaining the only thing that decides the value.

## 7. What this does not touch

**The dashboard.** `src/views/dashboard.ts` carries a comment stating that no
other player appears there by design, and `DashboardFixture` is typed with
nowhere to put a roster. That wall was deliberate; the game view is the new
home for this. Add a door, do not knock the wall down.

Also out of scope: any change to the public invite page or BR-26's redaction;
per-player or per-fixture visibility (this is one game-wide setting); and
showing a player anything about a game they are not a member of.

## 8. Testing

The established three tiers.

**Server** — `squadForViewer` as a pure unit across both flag states and both
viewer roles; the `/g/:id` entitlement branch for all four audiences, including
a **removed** member getting 404; `/r/:token` under both flag states; the form
round-trip, specifically that unchecking the box and triggering a 422 redisplay
preserves the unchecked state (§6.1's bug, pinned).

**Browser** — a catalogue entry for the player game view, which puts it under
the console-error and CSP gate automatically. One journey: a player views a game
with visibility on and sees the squad, the organiser turns it off, the player
reloads and sees counts without names.

**The guide** — chapter 03 currently tells players they can see the squad. That
stops being unconditionally true, so the chapter changes in the same milestone,
and chapter 05 gains the organiser's control.

## 9. Definition of done

1. An organiser can turn squad visibility off and on from the game form, and the
   change is recorded in the audit log.
2. With it on, a player sees the full squad and everyone's answer on both the
   fixture response page and their game view.
3. With it off, the same player sees the counts and their own answer, and no
   other names, on both pages.
4. A player has a game view at all, and a removed member cannot reach it.
5. An owner's view is unchanged in either state.
