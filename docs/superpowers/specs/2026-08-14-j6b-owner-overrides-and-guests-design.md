# J6b — owner overrides, guests and over-capacity — design

**Date:** 14 August 2026
**Status:** approved

## 1. What this is

The unbuilt half of M6. M6a shipped J1 (game setup and invites); J6a shipped
squad removal, roles and invite rotation. What remains of the master spec's
**J6 — Owner intervenes** (`docs/superpowers/specs/2026-08-10-make-the-team-design.md`
§1.9) is:

- an Owner marking any squad member `in` or `out` on their behalf, attributed
  (BR-27);
- adding a one-off **guest** who occupies a slot and is never emailed;
- **BR-8** — an Owner may exceed `max_players` by explicit override, and the
  UI must show the fixture as over capacity when they do.

Cancellation, the third thing J6's paragraph describes, shipped in M4. When
this lands, M6 is complete and the build order moves to M7.

## 2. The structural gap this starts from

**There is no owner-facing fixture page.** The only page that renders a fixture
and its squad is `GET /r/:token` — scoped to one player by a signed token,
reached from an email. `/g/:id` lists upcoming fixtures as inert text
(`Thursday 19:00 — open, 6 in`), not links.

So J6's "an Owner opens the fixture page and sees the squad plus everyone's
state" has nowhere to happen. That page is the container for all three
features, and building it is most of this work.

What is *already* in place, laid deliberately by earlier milestones:

| Foundation | Where | State |
|---|---|---|
| `responses.set_by_player_id` | `src/db/schema.ts:124` | Exists, written on every Durable Object call, never read |
| `responses.source` (`token`/`owner`/`system`) | `src/domain/response-status.ts` | Written; `owner` produced only by `withdrawMember` today |
| `players.is_guest`, nullable `players.email` | `src/db/schema.ts:21` | Exists; nothing creates a guest |
| `over_capacity` flag | `src/domain/fixture-view.ts:64` | Computed since M2, displayed nowhere |
| Guest filtering on every send path | `send-welcome`, `send-promotion`, `send-removed`, `open-and-remind`, `attention`, `cancel-fixture` | Complete — BR-32 is already satisfied for guests that do not yet exist |
| Owner entitlement check | `findGameForOwner`, `src/db/queries.ts` | Reused unchanged |

This milestone is wiring, not foundations. Nothing here needs a migration.

## 3. The owner fixture page

`GET /g/:id/f/:fixtureId`, behind `requirePlayer` and `findGameForOwner`, with
the fixture verified to belong to that game. **404 for every failure** — no
such game, not a member, a member but not an owner, a demoted owner, a fixture
belonging to someone else's game — matching the shape every other `/g/:id`
route uses (TR-18). A fixture id must not be probeable for existence.

New view: `src/views/owner-fixture.ts`. New path helpers in
`src/auth/paths.ts` beside `memberRolePath` and `memberRemovePath`, following
the same convention (player id in the path, never a membership or response id;
the handler scopes every lookup by game id as well).

The page renders:

- the fixture's date and time in the game's zone, the venue, and its lifecycle;
- the counts and the flags from `fixture-view.ts` — including `over_capacity`,
  which gets its first display since it was written in M2;
- the squad, in the display order `getFixtureWithSquad` already produces: `in`,
  then `waitlisted` by rank, then `pending`, then `out`. `withdrawn` is
  filtered out by that query and stays filtered.

Each row shows the player's name, their state, an attribution line where one
applies (§6), and controls: **Mark in** and **Mark out** for a squad member,
and **Remove** alone for a guest — a guest is `in` from the moment they are
added and there is no meaningful `out` state for someone who was never
invited. Plain forms posting to their own
endpoints — every control works with JavaScript off, as everything in this
project does.

A `scheduled` fixture holds no response rows at all (BR-1 writes them when the
fixture opens), and `cancelled` and `played` are terminal. The page renders for
any lifecycle so an owner can look at any fixture, but the controls appear only
on an `open` one; the Durable Object refuses the others regardless
(`fixture-not-open`), so the page's restraint is a courtesy and the guarantee
is underneath it.

`/g/:id`'s fixture list becomes links to this page. That is the only change to
the game overview.

## 4. Overrides

`POST /g/:id/f/:fixtureId/response/:playerId`, form field `intent=in|out`,
optional `override=1`. It calls the existing `setResponse` with
`actorPlayerId` set to the acting owner and `source: "owner"` — both columns
already exist and are already written.

### 4.1 `whenFull`

`SetResponseInput` gains one field:

```ts
/**
 * What to do when the fixture is already at `max_players` and this response
 * would take a slot. A player's own tap waitlists (BR-5). An owner's mark-in
 * refuses, so BR-8's override is a second, explicit act rather than a silent
 * consequence of the first — and `exceed` is that second act.
 */
whenFull: "waitlist" | "refuse" | "exceed";
```

- `waitlist` — today's behaviour exactly. `POST /r/:token` passes this and
  nothing about a player's own response changes.
- `refuse` — returns a new rejection, `{ kind: "rejected", reason:
  "would-exceed-capacity" }`, and **writes nothing**.
- `exceed` — the player goes `in` regardless of `max_players`. This is BR-8.

`whenFull` is an explicit input rather than something inferred from `source`,
so the three behaviours are named at their three call sites and a fourth caller
cannot inherit one by accident.

This decision belongs **inside the lock**. A capacity pre-check in the route
would be a real TOCTOU race against a concurrent tap on the same fixture:
`blockConcurrencyWhile` is what makes the refusal atomic with the count it is
refusing against, and `src/capacity/fixture-capacity.ts` already documents at
length why that lock is load-bearing.

### 4.2 The confirmation

`would-exceed-capacity` re-renders the same page with a banner scoped to that
row — "Meadow Park Kickabout is full (10 of 10). Add Sam Whitlock anyway?" —
carrying a form that reposts the same intent with `override=1`, which becomes
`whenFull: "exceed"`.

Inline, not a separate confirmation page. Removal gets its own page because it
is destructive and irreversible; going one over capacity is neither, and an
extra navigation on a phone at 9pm is a real cost.

If the fixture empties between the refusal and the confirmation, the override
marks the player `in` normally and `over_capacity` simply is not true — the
flag is derived, never stored, so there is nothing to reconcile. If it fills
further, the override applies anyway, which is what the owner asked for.

### 4.3 What falls out

An override from `in` to `out` frees a slot, so BR-7 promotion fires exactly as
it does for a self-response, and the promoted player gets N-2 through
`notifyPromotedPlayer` — already exported from `src/routes/respond.ts` and
reused unchanged, not reimplemented. `waitUntil`, for the reasons that function
documents.

**No new notification.** §1.11's catalogue is closed ("do not add others
without a decision") and nothing here asks for that decision. The player whose
response was overridden finds out from their own response page (§6), which is
why §6 is not optional.

## 5. Guests

A new Durable Object method:

```ts
addGuest(input: {
  name: string;
  actorPlayerId: string;
  whenFull: "refuse" | "exceed";
  now: number;
}): Promise<AddGuestOutcome>;
```

It inserts the `players` row (`is_guest: true`, `email: null`) **and** the `in`
response row in the same `db.batch()`, inside the same lock. Its outcome mirrors
`SetResponseOutcome`'s shape:

```ts
type AddGuestOutcome =
  | { kind: "added"; playerId: string; inCount: number; spotsLeft: number }
  | { kind: "rejected"; reason: "would-exceed-capacity" | "fixture-not-open" | "fixture-not-found" };
```

No `promoted` variant: adding a guest only ever takes a slot, never frees one.

**Why the row creation is in the Durable Object.** It stretches the object's
"capacity only" remit, and both alternatives are worse. Creating the player in
the route first means a refused over-capacity add leaves an orphaned person in
the database. Pre-checking capacity in the route to avoid that reintroduces
exactly the race §4.1 closed. Atomic is cheaper than either, and the guest and
the slot they occupy are the same fact.

**A guest never waitlists.** An owner adds a guest because they want them
playing tonight; a guest who lands on a waitlist is a person with no email
address who will never be told they got in. So `whenFull` takes `refuse` and
then `exceed` on confirmation — the same two-step as an override, for the same
reason, through the same banner.

**Scope: one fixture.** No membership row. A guest therefore does not appear on
`/g/:id`, gets no response rows on future fixtures, and is never in the
eligible set the sweep emails — BR-32 holds without any new code, because a
guest is never a member and every send path already filters `is_guest`
regardless. This matches the master spec's "added by an Owner for a single
fixture" (§1.6).

The consequence, stated rather than papered over: **adding the same person
three weeks running creates three `players` rows.** That is what per-fixture
means. Deduplicating by name would guess that two people with the same name are
one person, which is a worse error than a duplicate row nothing joins on.

`src/views/game-overview.ts:63` renders a `(guest)` suffix in the squad list,
from `listSquad`, which reads memberships. Under this decision that branch is
unreachable — no guest ever has a membership. **It stays**, because it is
correct if the decision is ever revisited and costs nothing, and this paragraph
exists so a future reader does not mistake it for evidence that guests are
squad members.

**Removal** reuses `withdrawMember` unchanged: it frees the slot, promotes off
the waitlist (BR-7), and `getFixtureWithSquad` filters the `withdrawn` row out
of every read. The orphaned `players` row is left in place — it has no
membership, so it appears nowhere, and deleting a row an audit entry points at
would be worse than leaving it.

**Name validation** goes in `src/domain/guest-name.ts`, beside the other form
parsers: trimmed, non-empty, length-capped, returning a parsed value or a
message the page can render. Escaping is `escapeHtml`'s job at render time, as
everywhere else.

## 6. Attribution (BR-27)

`SquadMember` in `src/db/queries.ts` gains three fields, from a self-join on
`players` through `responses.set_by_player_id`:

```ts
setBy: { playerId: string; name: string } | null;
source: ResponseSource;
isGuest: boolean;
```

Where `source === "owner"` and `setBy` is present, both pages render
"— marked in by Jamie" (or "marked out by"). One query change feeds the owner
fixture page and `/r/:token` alike, so the two cannot drift apart.

**It shows on the player's own page, not only the owner's.** With the
notification catalogue closed, that page is the only place a player can ever
discover that somebody answered for them. Attribution visible only to
organisers would satisfy a literal reading of BR-27 and defeat its purpose: a
player who never said yes would see themselves as `in` with no explanation.

`/r/:token` also gains the `over_capacity` line, which it has never shown.

## 7. Audit

Three additions to `AUDIT_ACTIONS` in `src/domain/audit.ts`, all
`fixture.`-namespaced because all three are recorded against a fixture:

| Action | `before_json` / `after_json` |
|---|---|
| `fixture.response_overridden` | `status` before and after, plus `overCapacity: true` when `whenFull` was `exceed` — BR-27 requires the previous value |
| `fixture.guest_added` | `after`: guest name, player id, `overCapacity` |
| `fixture.guest_removed` | `before`: guest name, player id, status |

All three carry a real `actor_player_id` — an owner did each of them. These are
TypeScript-only narrowings (`text({ enum })` emits no SQL CHECK on SQLite), so
**no migration is needed**, exactly as M6a and J6a extended the same arrays.

The audit row is written by the route after the Durable Object returns, not
inside the lock — the same division every other caller uses.

## 8. Testing

Three tiers, all of them already built.

**Server tests** — one file per new path, in the established places: the
`whenFull` matrix in `test/capacity/`, the new routes in `test/routes/`,
`addGuest` including the refused case leaving no orphan row, `parseGuestName`,
the audit rows, and the entitlement 404s for all four refusal shapes.

The one test worth naming explicitly: **an override from `in` to `out` on a
full fixture must promote the longest-waiting player and send exactly one
N-2.** That is where this milestone touches M4's most intricate behaviour, and
it is the assertion that would fail if `whenFull` were threaded wrongly.

**Browser tier** — the owner fixture page joins `test/browser/catalogue.ts`,
which puts it under the console-error and CSP gate automatically. One journey
covering mark-in, the over-capacity refusal, the confirmation, and adding a
guest — run once with JavaScript on and once off, as the existing journeys are.
The `connect-src` post-mortem in `docs/known-issues.md` is why this tier is not
optional for a page with new controls.

**The guide** — chapter 05 (`docs/guide/05-running-your-squad.md`) currently
documents four controls and says nothing about overrides or guests, because
they did not exist and the guide documents only what is built. It gains the
section it has been conspicuously silent about, with shots added to
`test/browser/guide-shots.ts` and captured through the existing harness. The
guide world already has a fourteenth member who never answers — the natural
subject for a mark-in.

## 9. Not in this spec

- **Bulk actions.** No "mark everyone in", no multi-select.
- **Editing a guest.** No rename, no converting a guest into a real member.
- **Carrying a guest forward.** A guest is one fixture, by §5's decision.
- **A new notification.** §1.11's catalogue is closed.
- **Any change to what a player can do.** `/r/:token` gains two lines of text
  (attribution, over-capacity) and nothing else.
- **An owner-facing fixture list** beyond the links `/g/:id` already wants.
- **The `withdrawn`-row re-entry gap** recorded in `docs/known-issues.md` (a
  withdrawn player presenting a still-valid response token could flip back to
  `in`). It is adjacent — this milestone writes no new `withdrawn` rows and
  does not make it reachable — and closing it is BR-3 follow-up work, not this.
- **The pre-real-players punchlist** (`Cache-Control` on `/r/` and `/leave/`,
  required reviewers, the removal loop's partial-failure recovery). Tracked in
  `docs/known-issues.md` under its own trigger, and deliberately not smuggled
  in here.

## 10. Definition of done

M6's build-order row reads "J1 and J6 work end to end with no seed data". After
this milestone an owner can, from a browser, with no database access:

1. open any fixture of a game they own and see everyone's state;
2. mark a player in or out on their behalf, and see who did it named on the
   page — as can that player, on their own;
3. add a guest who occupies a slot and is never emailed;
4. put the fixture over capacity by an explicit second click, and see it said
   so.

At which point M6 is complete and `§2.14`'s status note should say so.
