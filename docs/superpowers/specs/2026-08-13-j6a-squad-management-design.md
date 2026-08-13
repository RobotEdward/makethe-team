# J6a — Squad Management: removal, roles and the removal email

**Date:** 13 August 2026
**Milestone:** M6, sub-project J6a (the first half of J6)
**Predecessor:** [M6a — game setup and invites](2026-08-12-m6a-game-setup-and-invites-design.md)
**Parent spec:** [Make The Team](2026-08-10-make-the-team-design.md)

## 1. Scope

M6's second journey (J6) is five features: owner overrides of a player's
response, one-off guests, squad-member removal (BR-3), owner promotion, and
BR-8's over-capacity override. They split cleanly in two, and this spec covers
the first half.

**In scope (J6a):**

- Removing a squad member, with BR-3's full consequence pass across every open
  fixture of the game.
- Promoting a player to owner, and demoting an owner back to player.
- N-7, a new notification telling the removed player they were removed.
- Two corrections carried on the way past: new audit actions for both
  operations (BR-27), and a fix to the actor recorded for invite-link joins.

**Out of scope, deferred to J6b:** owner overrides of a response, one-off
guests, and BR-8's over-capacity override. Those three share a page that does
not exist yet (an owner fixture-detail view) and a mechanism (further
`FixtureCapacity` entry points), and they are a coherent project of their own.

**Why this half first.** Removal is the remedy that
`docs/known-issues.md` row 25 is waiting on. Someone holding a leaked
`/j/:token` link can attach a *real* person's existing account to a squad they
never asked to join; that person then receives the welcome email, sees the game
on their dashboard, and gets a reminder before every fixture — and today
neither they nor the owner can undo it. Nothing else in J6 is load-bearing in
that way.

## 2. Surface

Everything lands on the existing owner page `/g/:id`, which already renders the
squad list. No new entry in any navigation; two controls per squad row.

| Route | Method | Purpose |
| --- | --- | --- |
| `/g/:id/squad/:playerId/role` | POST | Promote to owner, or demote to player. |
| `/g/:id/squad/:playerId/remove` | GET | Confirmation page, stating consequences. |
| `/g/:id/squad/:playerId/remove` | POST | Perform the removal. |

All three sit under `GAMES_PREFIX`, so they inherit the session mount and the
`private, no-store` header `src/app.ts` already applies there.

**Removal is GET-then-POST**, matching `/cancel/:token`'s existing shape rather
than inventing a new one. It is destructive, it is not undoable by the owner
(only the removed player can rejoin, via the invite link), and it must work
with JavaScript disabled — so the confirmation is a served page, not a
`confirm()` dialog. The page states consequences in specifics computed from
live rows, not in general terms: *"Sam holds a confirmed place in 2 upcoming
fixtures. Removing them frees both, and the next person on each waiting list
takes the place."* A member with no open fixtures is told that too, rather than
shown a sentence that quietly does not apply.

**Role change is a single POST** with the target role in the form body. One
handler serves promotion and demotion so the two cannot drift apart; the
button's label and its target value are both derived from the row's current
role.

### 2.1 Entitlement

TR-18 in full, on every one of the three routes:

1. `findGameForOwner(db, gameId, actorPlayerId)` — **404** if it returns null.
   Not 403: a 403 confirms the game exists, which lets ids be probed.
2. A second check that the `:playerId` membership exists, is active, and
   belongs to **that** game — **404** otherwise, for the same reason. Without
   this, `:playerId` reads as a global identifier and one owner could act on
   another squad's membership.

The middleware establishes *who*; each handler re-checks *whether* against the
row it is about. That is the project's standing rule and it is restated here
because two ids in one path is the shape most likely to get it wrong.

## 3. BR-3: what removal does

> **BR-3** When a player leaves or is deactivated, for every `open` fixture of
> that Game: a `pending` response row is deleted; an `in` response becomes
> `withdrawn`, freeing the slot and triggering promotion per BR-7; a
> `waitlisted` response is deleted and the remaining waitlist closes up.
> `scheduled` fixtures have no response rows and need no action. A leaver is
> never recorded as `out`.

### 3.1 The `out` case, which BR-3 does not cover

BR-3 names three of the four live states. A player who had already answered
**`out`** on an open fixture before being removed is unaddressed.

**Decision: delete the `out` row, exactly as `pending` is deleted.** An `out`
row holds no slot and needs no promotion, so deleting it costs nothing and it
completes the rule: after removal the player has no response row on any open
fixture except the `withdrawn` ones that record a slot being given back.
Nothing anywhere shows an ex-member as having declined, which is what §1.5's
"a leaver is never recorded as `out`" is actually asking for.

The alternative — turning every row `withdrawn` uniformly — was rejected
because it overloads the status. `withdrawn` currently means "gave up a slot",
and `occupiesSlot` and BR-7's promotion both key on that meaning.

### 3.2 `FixtureCapacity.withdrawMember`

A new Durable Object method, not a reuse of `setResponse`. `setResponse` takes
an `in`/`out` intent and rejects any player without an existing row, which is
close to the opposite of what removal needs.

TR-12 requires it to be a DO method at all: every write that can affect a
fixture's capacity enters through the object, and this one both frees a slot
and fills it.

```ts
interface WithdrawMemberInput {
  playerId: string;
  /** The owner performing the removal. Recorded on the withdrawn row (BR-27). */
  actorPlayerId: string;
  /** Passed in rather than read from the clock — domain code stays testable. */
  now: number;
}

type WithdrawMemberOutcome =
  | {
      // "removed", not "withdrawn": `withdrawn` is one of the four things this
      // can do to the row (§3.1), so naming the whole outcome after it would
      // make the deleted-row cases read as a different result than they are.
      kind: "removed";
      /** The status the row held before this call. */
      previousStatus: "pending" | "in" | "out" | "waitlisted";
      inCount: number;
      /** Present only when freeing this slot promoted someone (BR-7). */
      promoted?: WaitlistPromotion;
    }
  /** No row for this player, or the fixture is not open. Not an error. */
  | { kind: "no-op"; reason: "no-response-row" | "fixture-not-open" | "fixture-not-found" };
```

Inside `ctx.blockConcurrencyWhile`, in a single `db.batch()`:

- delete the player's row if it is `pending`, `out` or `waitlisted`;
- set it to `withdrawn` if it is `in`, with `set_by_player_id` = the owner and
  `source = "owner"`;
- promote the **lowest live `waitlist_position`** into the freed slot, if a
  slot was freed and anyone is waiting — the same rule and the same reasoning
  as `setResponse`, including leaving the promoted player's `responded_at`
  alone and setting their `source` to `"system"`;
- rewrite both cached counts from the resulting set.

It reads its fixture id from `this.ctx.id.name`, never from an argument, for
the reason `#setResponseLocked` documents at length: the lock is keyed by the
object's identity, so a mutation keyed on anything else is not covered by it.

It **sends nothing**, and carries the promotion out to the caller. Same rule as
`setResponse`, same reason: an HTTP call to a mail provider inside
`blockConcurrencyWhile` would serialise every other tap on that fixture behind
the provider's latency.

Note the promotion count. `setResponse` can free at most one slot and so
promotes at most one player *per fixture*; `withdrawMember` is the same — one
player, one fixture, one slot. What is new is that a removal touches **many**
fixtures, so a single removal can produce several promotions, one per fixture.

### 3.3 Ordering, and why it is not atomic

A removal spans one membership row and N open fixtures, each behind its own
Durable Object. D1 has no interactive transaction and no cross-object
transaction exists, so the whole operation **cannot** be made atomic. The
design chooses resumability instead, and the order is load-bearing:

1. **Deactivate the membership first** — `active = false`, `left_at = now`, and
   the `membership.removed` audit row, in one `db.batch()`.
2. **Then** load the game's `open` fixtures and call `withdrawMember` on each,
   sequentially.
3. **Then**, every lock released, send N-2 to each promoted player and N-7 to
   the removed player.

Step 1 first means the player is out of the squad the instant that batch lands:
they stop being eligible for anything new, and no later failure can leave them
half-in. `withdrawMember` is idempotent — a second call finds no row and
returns `no-op` — so a failure partway through step 2 leaves *work a retry
finishes*, not a corrupted state. The owner sees an error and the operation is
safe to repeat.

Steps 2 and 3 are separated for the reason every send in this codebase is
separated from the write it follows: a mail failure must not roll back a
membership change, and a membership change must not be held open across a
provider call.

### 3.4 What removal deliberately does not do

**It does not send N-4.** If removal drops a fixture below `min_players`, the
owner-attention email is the cron sweep's job (`src/sweep/attention.ts`), and
BR-31 caps N-4 at one per fixture ever via `attentionKey(fixtureId, playerId)`,
which carries no state. So on a fixture the owner has *already* been warned
about, a removal that makes it worse produces no second warning. This is
existing behaviour, stated here so it is a known consequence rather than a
later surprise.

**It does not touch `scheduled` fixtures.** They have no response rows. BR-2
already handles the future correctly: eligibility is fixed when a fixture
opens, and an inactive membership is not eligible, so the removed player simply
does not get a row when the next fixture opens.

**It does not touch `cancelled` or `played` fixtures.** They are terminal
(`isTerminalLifecycle`); rewriting their rows would be rewriting history.

## 4. Roles and the one invariant

**A game always has at least one active owner.**

That single rule, evaluated against a live count inside the operation that
would break it, is the whole of the owner-safety design. It refuses exactly
three things:

- demoting the last active owner;
- removing the last active owner;
- and therefore a solo owner removing themselves.

Everything else is allowed. Roles change in both directions, and an owner may
remove a co-owner or themselves. One-way promotion was rejected: promote the
wrong person with no way back and the mistake is permanent short of a hand
edit of D1, which is precisely the kind of trap this project has been avoiding.

A refusal re-renders `/g/:id` at **422** with a plain sentence — *"A game needs
at least one organiser. Make someone else an organiser first."* — never a dead
end and never a bare error page.

An owner who removes **themselves** while a co-owner remains is redirected to
`/app`, not back to `/g/:id`: they no longer pass that page's entitlement check
and would otherwise be bounced to a 404 by their own successful action.

## 5. N-7 — "you've been removed"

A new notification type, modelled closely on N-6 (the welcome email) because it
is the same shape: game-scoped, not fixture-scoped, sent once per membership
transition.

| Field | Value |
| --- | --- |
| Type | `n7`, added to `NOTIFICATION_TYPES` |
| Recipient | The removed player |
| `fixture_id` | **null** — a removal is not fixture-scoped, like N-6 |
| Dedupe key | `n7:<membership_id>:<left_at>` |
| Trigger | A successful removal |

**Why `left_at` is in the key.** `UNIQUE (game_id, player_id)` on `memberships`
forces a rejoin to reactivate the existing row, so the membership id alone is
the same string across a join → remove → rejoin → remove cycle, and the unique
index on `dedupe_key` would silently drop the second removal email. This is the
identical trap N-6 hit and the identical fix (`welcomeKey`'s `joinedAt`).

**BR-32.** A guest, or any player with a null email, is skipped before a
`Message` exists at all and is not recorded as a send failure. `Message.to` is
typed `string` while `players.email` is nullable, so this is a compile-time
obligation on the caller rather than something each `Notifier` must remember.

**Content.** Which game, that they have been removed, and that they will get no
further email about it. It carries **no leave link**, because there is nothing
left to leave — this is the one notification in the system for which BR-22's
requirement is satisfied by the message's own subject matter. `docs/known-issues.md`'s
BR-22 row should say so, rather than leaving N-7 looking like a second omission
alongside N-6's.

## 6. Two corrections carried on the way past

### 6.1 New audit actions (BR-27)

`membership.removed` and `membership.role_changed` join `AUDIT_ACTIONS`, each
with `before_json` / `after_json` naming the changed values (`active`/`left_at`
for the first, `role` for the second). Both carry the acting owner as
`actor_player_id`. No migration is needed: Drizzle's `text({ enum })` emits no
SQL `CHECK` on SQLite, which is how M6a added five actions without one.

### 6.2 The invite-join audit lie

Today `src/domain/join-squad.ts` writes `actor_player_id` = the *joining
player* for `membership.joined`, and `src/domain/audit.ts` documents that
choice ("nobody else acted"). For a join that arrived through a leaked
`/j/:token` link, that is false in the way that matters: the audit trail
positively asserts that the victim added themselves.

Since J6a is what finally makes such a join removable, it should also stop the
record lying about it. Invite-link joins record `actor_player_id` as **null**.
The actor genuinely is anonymous, and the column is already nullable for
exactly this case — its schema comment reads "cron and other system actions
have no actor". `after_json` gains `"via": "invite_link"` so a null actor here
is distinguishable from a system action.

**The invite token is never written to the audit log.** It is a live capability
— possession of it is the entire authorisation — and an audit log is a durable,
widely-read, long-retained store. `via: "invite_link"` says how, without
handing a log reader the key.

The comment in `src/domain/audit.ts` must change with the behaviour; leaving it
asserting the old rule would be worse than the original bug.

## 7. Errors and edge cases

| Case | Response |
| --- | --- |
| Game not found, or actor is not an active owner of it | 404 |
| `:playerId` not an active member of *that* game | 404 |
| Would leave the game with no active owner | 422, `/g/:id` re-rendered with the reason |
| Cross-site POST | Rejected by the existing origin check `/g/*` already applies |
| Removed player has no email (guest) | Removal proceeds; no N-7; not a send failure (BR-32) |
| Member has no open fixtures | Removal proceeds; confirmation page says so; no N-2 |
| `withdrawMember` fails partway through the fixture loop | Membership is already inactive; error shown; retry completes the rest (§3.3) |
| Removed player's dashboard | The game disappears — every dashboard query already filters `memberships.active`; §8 pins it with a test |

## 8. Testing

Route tests drive through `SELF.fetch` per TR-29, never the Hono test client.

**Durable object** — one test per starting state (`pending`, `in`, `out`,
`waitlisted`, no row); the promotion an `in` withdrawal triggers, asserting the
*lowest live position* is the one promoted; idempotence on a second call; both
cached counts recomputed correctly; a `no-op` on a `scheduled` and on a
`cancelled` fixture.

**Scoping** — a two-game test in which the removed player belongs to both, and
only the target game's fixtures change. M6a's task 8 found exactly this class
of bug (a delete that had lost its `gameId` filter) only because a test existed
that could fail on it; the equivalent test is written here first.

**The invariant** — all three refusals (demote last owner, remove last owner,
solo owner removes self), and the three corresponding *permitted* cases with a
co-owner present.

**Entitlement** — 404 (not 403) for a game you do not own, and for a
`:playerId` belonging to a different game's squad, on all three routes.

**N-7** — dedupe key shape; a join → remove → rejoin → remove cycle sends
twice; a null-email player produces no `notification_log` row at all.

**Audit** — both new actions written with the right actor and before/after; and
an invite-link join now records a null actor with `via: "invite_link"`.

**CSP** — the new confirmation page rendered under the production policy, like
every other page.

**Dashboard** — a removed player no longer sees the game.

## 9. Not in this spec

- Owner overrides of a response, one-off guests, BR-8's over-capacity override
  — J6b.
- Self-service leaving (BR-22) — M7. J6a gives an *owner* a removal control;
  it does not give a player a way out on their own.
- The leaked-invite abuse itself. J6a supplies the remedy (rotate the link,
  then remove the junk or unwanted member) and fixes the audit record. It does
  not prevent the join, and `docs/known-issues.md` row 25 should be amended to
  say exactly that rather than closed.
