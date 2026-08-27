# M39 — Confirm to join

**Status:** approved 27 August 2026 (plan: docs/superpowers/plans/2026-08-27-m39-confirm-to-join.md). M39, not M38 — M38 is the invite-page viewer banner already in `src/routes/join.ts`.
Amends `docs/superpowers/specs/2026-08-10-make-the-team-design.md` §4 (the invite flow).

## The problem

`POST /j/:token` takes a name and an email address from an anonymous visitor and, on the
strength of nothing but the typing, creates a person and seats them in the squad. Two
things go wrong with that, and both have now happened or been recorded:

1. **A typo makes a second person.** On 25 August a member who had joined on the 20th as
   `…@gmail.com` followed the invite link again and typed `…@gmial.com`. `joinSquad`
   matches on the exact address, found nothing, and minted a second "Jack Hart" with its own
   membership and its own `pending` row on the open fixture. The squad had two Jacks, one of
   whom could never respond, and the welcome and reminder for the typo — fixture details,
   response link, invite link — were delivered to whoever owns `gmial.com`, which is a
   typo-squat domain, not a bounce. Cleaning it up needed an operator writing `erases_at` by
   hand in D1.
2. **Anyone holding the link can enrol anyone.** `docs/known-issues.md` row 25 has carried
   this since M6a: a leaked `/j/:token` lets a stranger type a colleague's real address and
   attach that person to a squad they never asked for. J6a shortened the cleanup; nothing
   has ever prevented the join. It has had "no milestone trigger yet" for two weeks.

Both are the same defect: **an address that has never proved it reaches anyone gets a seat
anyway.** The fix is the same for both.

## What it is

A join from an address the product has not verified does not create anything. It sends one
email to that address; clicking through creates the player and the membership. A mistyped
address never confirms, so nothing exists to remove; a stranger typing someone else's
address puts one polite email in that person's inbox and nothing on their dashboard.

Addresses the product *has* verified keep today's one-click join, so a member rejoining
from a new phone is not made to check their inbox.

## Business rules

- **BR-47.** `POST /j/:token` creates a player or a membership only for an address that is
  already verified — one with a non-null `players.email_verified_at` — or for a signed-in
  viewer whose session identifies them. For any other address it writes no `players`,
  `memberships`, `responses` or `audit_log` row: it sends a confirmation email and renders a
  "check your inbox" page.
- **BR-48.** A confirmation link is a signed, stateless token carrying `(gameId,
  inviteToken, email, name, expiresAt)`. Confirming performs exactly the join that
  `POST /j/:token` would have performed for a verified address, and additionally stamps
  `email_verified_at` on the player row it creates or reuses. A join by confirmation is the
  second way, after signing in, that an address becomes verified.
- **BR-49.** A confirmation link dies with the invite link it was minted from. Confirming
  against a game whose `invite_token` no longer equals the one in the token is a 404, so
  rotating the link — the owner's existing remedy for a leak — also voids every
  confirmation still in flight from it.
- **BR-50.** Confirming is a `POST`. The `GET` renders "Join *Game* as *Name*?" with a button
  and writes nothing, because mail scanners and link previewers follow `GET`s.
- **BR-51.** The confirmation email names the game and the name typed, and nothing else: no
  fixture details, no response link, no invite link, no squad list. It is the one message the
  product sends to an address it does not trust yet, and its content is chosen so that
  delivering it to the wrong person costs nothing.
- **BR-52.** Confirmation is required to *join*, never to *stay*. Every membership that
  exists when M39 deploys is untouched, verified or not. The owner's squad page marks members
  with a null `email_verified_at` as **unconfirmed**, beside the existing Remove control, so
  legacy rows can be tidied by hand; nothing removes them automatically.
- **BR-53.** The confirmation email is notification type **N-14**, administrator scope
  (M37 §2: masked by the admin switch, no owner switch), email only. It goes through the
  quota-wrapped notifier like every other send an anonymous visitor can trigger (TR-31), and
  its dedupe key is `(gameId, email, calendar day)` so one address cannot be made to receive
  more than one confirmation per game per day however often the form is submitted.

## Flow

```
POST /j/:token
  ├─ token unknown                       → 404, nothing written (as today)
  ├─ name empty / email implausible      → 422 with the form back (as today)
  ├─ viewer signed in                    → joinSquad as today (session is the proof)
  ├─ address matches a verified player   → joinSquad as today, N-6 + late N-1 as today
  └─ otherwise                           → N-14 to the address; "Check your inbox" page

GET  /join/:jtoken          → verify; 404 if bad/expired/invite rotated; else "Join X as Name?" page
POST /join/:jtoken         → verify again; joinSquad with { emailVerifiedAt: now };
                            backfill + N-6 + late N-1 exactly as the direct join does;
                            renders the existing join-outcome page
```

"Matches a verified player" is the exact-address lookup `attemptJoin` already does, with
`email_verified_at IS NOT NULL` added. An address that matches an *unverified* row — the
real Jack from the 20th, for instance — takes the confirmation path, and confirming stamps
that row, so a legacy member's next rejoin is what verifies them.

The "check your inbox" page is rendered whether or not the address was known, because the
invite page already lists the squad by name (`listSquad`), so there is nothing here to hide.

## Token

Fourth `kind` in `src/domain/token.ts`, alongside `response`, `cancel` and `leave`, signed
with `RESPONSE_TOKEN_SECRET`; the `kind` inside the signed bytes is what stops one being
presented as another. Payload `{ gameId, inviteToken, email, name, expiresAt }`. Lifetime
**seven days**: long enough that someone who reads the email on Friday for a link they clicked
on Tuesday is not told it is broken, and bounded anyway by BR-49. `name` travels in the token
so the product stores nothing about a person until they confirm; it is HTML-escaped at every
render like every other interpolation.

Nothing about the *join* is written to D1 at mint time. There is no pending-joins table to
sweep, expire or erase. The one trace a request that never confirms leaves is the dedupe row
described under "Implementation notes", which holds the address for two calendar days.

## Implementation notes (27 August 2026, from reading the source before planning)

- **Path is `/join/:jtoken`, not `/j/confirm/:jtoken`.** `tokenRateLimit`
  (`src/security/rate-limit.ts`) keys on the first two path segments, so `/j/confirm/<t>`
  would put every confirmation on the site into one `j:confirm` bucket of ten per minute.
  `/join/*` gets its own limiter mount and the same `private, no-store` header as `/j/*`.
- **N-14 writes no `notification_log` row.** `notification_log.player_id` is `NOT NULL` with
  a foreign key to `players`, and N-14's whole point is that no player row exists yet. The
  precedent is N-5, the sign-in link (`src/auth/factory.ts`, `sendSignInLink`): quota-wrapped
  notifier, no log row, a fresh-UUID `dedupeKey` for the provider. BR-53's once-per-day rule is
  therefore kept by a table of its own, `join_confirmations (game_id, email, day)` with that
  composite primary key: the row is inserted *before* the send, a conflict means "already sent
  today", and every insert also deletes rows older than yesterday, so the table holds at most
  two days of stranger-typed addresses — the `signin_refusals` ring-buffer argument, keyed on
  time instead of count. The admin switch (`notify.n14.email` in `app_settings`) still masks
  it, read through `loadAdminNotificationSwitches` like every other admin cell.
- **`n14` joins `NOTIFICATION_TYPES`.** `NOTIFICATION_CONTROLS`, the admin page's `NAMES` and
  the invariants suite's driver map are `Record`s over the union, so the compiler and
  `test/notify/notification-invariants.test.ts` both refuse a catalogue entry nobody has
  described. Scope `admin`, channels `["email"]`.
- **The admin sign-in doctor's `explainSignIn` is untouched**; confirming a join is not a
  sign-in and grants no session.

## What is not changed

- The owner-side join paths (`/app/admin` tools, owner-added guests) — none take an address
  from a stranger.
- `joinSquad` itself, beyond accepting an optional `emailVerifiedAt` to stamp on create and
  on reuse (`coalesce`, as `link-player.ts` does: an earlier verification is never moved
  forward).
- Sign-in linking (`src/auth/link-player.ts`), which already treats a provider-verified
  address as verified and will link a confirmed row exactly as it links any other.
- The N-6 welcome. It still sends on the confirmed join, because it is the message that
  carries the leave link and the first fixture; N-14 deliberately carries neither.

## Out of scope

- Typo heuristics (`gmial` → "did you mean gmail?"). They catch one spelling and miss the
  next; BR-47 catches all of them.
- Re-verifying already-verified addresses, or expiring verification.
- Automatic removal of legacy unconfirmed members (BR-52 says why).
- A pending-join table. The stateless token is the design; if a reason to record pending
  joins appears, it is a different spec.

## Invariants to pin as task zero (CLAUDE.md rule 1)

1. For every distinct outcome of `POST /j/:token` with an unverified address, the row counts
   of `players`, `memberships`, `responses` and `audit_log` are unchanged.
2. A `join` token presented to `/r/`, `/leave/` or `/cancel/` verifies as invalid, and vice
   versa (extends the existing kind-separation test).
3. Rotating the invite link 404s a confirmation minted before the rotation.
4. The rendered N-14 body contains no `/r/`, `/j/`, `/leave/` link and no fixture date.
5. `GET /join/:jtoken` writes nothing.
6. N-14 is in `NOTIFICATION_TYPES`, `NOTIFICATION_CONTROLS` (scope admin, email only) and
   `test/stored-lookups.test.ts`; the M37 invariants suite gains its cell.
7. `test/routes/signin.test.ts`'s TR-16 sweep knows the two new public routes.

## Tests and docs

- Route tests for each branch of the flow above, including the signed-in viewer and the
  verified-address fast path staying one-click.
- Browser capture of the confirm page and the inbox page (rule 3); guide chapter 2 ("Joining
  a game") gains the confirmation step. `guide:capture` is still broken by TR-37's limiter —
  per-page `--grep "@capture <id>"` for the two new pages, and the full regeneration stays
  the separate follow-up already recorded in memory.
- `docs/known-issues.md` row 25 closes: the join is prevented, not merely cleaned up.

## Open questions for the maintainer

1. **Confirmation copy and sender.** Proposed subject: "Confirm you want to join *Game*".
   Body: who invited (the game name only — organiser names are not on the invite page and
   should not start being leaked here), one button, "If you didn't ask for this, ignore it."
2. **Should the daily email ceiling (80, TR-31) treat N-14 differently?** Proposed no: an
   N-14 replaces the N-6 that would otherwise have been sent for the same join, so the
   typical cost per real joiner is unchanged, and the ceiling is exactly the cap that a
   leaked link's junk submissions should hit.
