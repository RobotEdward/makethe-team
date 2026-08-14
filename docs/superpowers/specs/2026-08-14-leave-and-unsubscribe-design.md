# Leave and unsubscribe (BR-22) — design

**Date:** 14 August 2026
**Status:** approved
**Milestone:** M7a — the first of four independent pieces M7's build-order row
names in one sentence. The others (delete-my-data, `/privacy`, and the
empty-states/error-pages/accessibility sweep) get their own specs.

## 1. What this is

A player can take themselves out of a squad, from the link every reminder
already carries.

**This closes BR-22, which the product currently fails.** Every reminder and
promotion email carries a `/leave/:token` link, and that page says:

> You can't remove yourself from a Game here yet — that isn't self-service yet.

So the product ships a link, in real email, advertising a capability it does
not have. It is honest about it, which is why it was accepted at the time, but
it is a stated business rule going unmet.

## 2. Why this needs a new token

`/leave/:token` reuses the **fixture-scoped** response token. That is why the
welcome email (N-6) carries **no leave link at all**: N-6 is sent when someone
joins a squad, and at that moment no fixture may exist to scope a token to.
`docs/known-issues.md` records this and names it as design surface M7 would
have to cover.

So this milestone introduces a **game-scoped** token:

```ts
export interface LeaveTokenPayload {
  gameId: string;
  playerId: string;
  expiresAt: number;
}
```

### 2.1 Signed with `RESPONSE_TOKEN_SECRET`, not a third secret

`src/domain/token.ts` already carries a `TokenKind` discriminator **inside the
signed bytes**, checked immediately after the signature and before any
type-specific shape. Adding `"leave"` to that union is additive: existing
response and cancel tokens keep verifying unchanged, so this is not the
versioned-token-format break `known-issues.md` warns about.

`CANCEL_TOKEN_SECRET` is separate from `RESPONSE_TOKEN_SECRET` because a
leaked response key must not be able to call a fixture off for an entire
squad. **That argument does not extend to leaving.** A response token already
grants access to the leave page today, so a leaked response key confers no new
power under this design, and the `kind` discriminator prevents presenting a
response token where a leave token is expected. A third secret would add a
binding, a Worker secret, an `env.ts` field, a `browser.env` entry and a CI
variable to protect against a threat that does not exist.

### 2.2 Expiry

Ninety days from minting, via a `leaveTokenExpiry(now)` alongside the existing
`responseTokenExpiry` and `cancelTokenExpiry`.

Not tied to a kickoff, because a leave link is not about a fixture. Long
enough that someone unsubscribing three weeks after they stopped playing is
not told their link is broken — which would be the single most annoying
possible failure of an unsubscribe link — and short enough to bound a
forwarded email.

## 3. `GET` confirms, `POST` acts

**This is a hard requirement, not a preference.**

`GET /leave/:token` renders a confirmation page and **writes nothing**.
`POST /leave/:token` performs the leave.

Corporate mail scanners, link-preview bots and prefetchers issue a `GET` on
every URL in an incoming message. A `GET` that removed someone from their
squad would unsubscribe people who never clicked anything, before they had
even opened the email. The codebase already states this reasoning for
`POST /sign-out`, which deliberately has no `GET` alias.

## 4. The action already exists

`removeMember` (`src/domain/remove-member.ts`, J6a) does exactly what leaving
requires: deactivates the membership, demotes the role to `player`, writes the
`membership.removed` audit row, walks every open fixture withdrawing the
player, and promotes the longest-waiting replacement on each.

Self-leave is that same call with `actorPlayerId` set to the leaver. Three
things follow, all of them wanted:

- **The audit trail distinguishes itself.** A `membership.removed` row whose
  actor equals its subject reads unambiguously as "they left"; one where they
  differ reads as "an organiser removed them". No new action value is needed.
- **Waitlist promotions still fire**, so whoever takes the freed place gets
  their N-2 exactly as they would have.
- **A retry is already safe.** `removeMember` called on an inactive membership
  skips the batch and the audit row and re-runs only the fixture loop. So an
  already-departed player following an old link sees "you're already out of
  this squad" rather than an error.

**No N-7.** The removal email exists to tell someone something happened *to*
them; a self-leaver did it deliberately and is looking at the confirmation
page. Suppressing it for self-leave is a behaviour choice within the existing
notification catalogue, not a new type — §1.11 stays closed.

## 5. The sole organiser never meets a dead button

The confirmation page counts active organisers before rendering anything.
Where the leaver is the only one, it renders **no leave button at all** — it
explains that the squad needs an organiser and offers a sign-in link to the
game page, where they can promote someone and then leave.

`countActiveOwners` already exists (`src/db/queries.ts`), and
`isLastActiveOwner` already enforces the invariant in `removeMember`, so the
refusal remains correct even if the page is bypassed. The page exists so it
never has to fire.

`known-issues.md` records the opposite pattern — a sole organiser learning the
rule only by hitting a refusal after clicking — as a defect in the
self-demotion flow. This is the corrected version of the same situation.

## 6. Other games, gated by a session

Leaving the emailed game always works from the token alone, with no sign-in.
That is the whole point of an unsubscribe link.

Below it, **only when a session exists and its player is the same person the
token names**, the page lists that player's other active squads with a leave
control for each. Those controls post to a session-authenticated route, never
the token route.

**The identity match is load-bearing.** A leave token names one player and one
game. Without the match, a different signed-in person opening a forwarded
leave link would be shown a list of somebody else's squads — and a leaked link
would become a multi-game capability, which is precisely the line BR-25 draws.
With the match, a leaked link still only ever affects the one game it was
minted for.

With no session, the page offers a sign-in link rather than the list.

## 7. What the emails say

- **Reminder and promotion** swap `leaveUrl` to the new token and change their
  copy from "See how to leave this Game" to **"Leave this game"** — which will
  finally be true.
- **The welcome email (N-6) gains a leave link for the first time**, which is
  the gap §2 exists to close.
- **The removal email (N-7) keeps none.** Its template documents why: by the
  time it sends, the recipient is already out and there is nothing to leave.

## 8. Testing

**Server** — `leaveTokenExpiry` and the new `kind` round-trip, including that a
response token presented at the leave verifier fails as `malformed` and vice
versa; the `GET` writing nothing (assert the membership is untouched after a
`GET`, which is the prefetcher guarantee); the `POST` performing the leave and
its promotions; the sole-organiser page rendering no button; the already-left
path; and the other-games list appearing only on an exact identity match.

**Browser** — a catalogue entry for the confirmation page, and one journey: a
player follows the link from an email and leaves, run once with JavaScript
disabled, because an unsubscribe that needs JavaScript is not an unsubscribe.

**The guide** — chapter 04 covers dropping out and must now describe leaving
for good; chapter 03's description of the reminder email mentions its links.

## 9. Not in this

- **Delete-my-data**, **`/privacy`**, and the **empty-states / error-pages /
  accessibility sweep** — M7's other three pieces, each its own spec.
- **A global unsubscribe.** Leaving is per-game by §6's decision.
- **Rejoining.** A departed player holding a valid invite link can already
  rejoin through `/j/:token`, and `joinSquad` forces `role: "player"` on
  reactivation. Unchanged here.
- **Leaving on someone else's behalf.** That is the organiser's removal flow,
  which already exists.

## 10. Definition of done

1. A player can leave a squad from the link in a reminder, promotion or
   welcome email, with no session and no JavaScript.
2. A `GET` of that link changes nothing.
3. The sole organiser of a game is told why they cannot leave before being
   offered the choice, not after.
4. A signed-in player is offered their other squads on the same page; a
   visitor without a session, or signed in as someone else, is not.
5. BR-22 is satisfied, and the master spec's rule text says so rather than
   describing the placeholder.
