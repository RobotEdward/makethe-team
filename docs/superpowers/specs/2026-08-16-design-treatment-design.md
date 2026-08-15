# Design treatment (M10) — design

**Date:** 16 August 2026
**Status:** approved
**Milestone:** M10. Not anticipated by the master spec, which has never had a
visual design section; this is the first pass at one.

## 1. What this is

An external design review of the running product, delivered as a Claude Design
project, found eight issues and drew six screens showing the fixes. This
milestone implements them.

**No new features. No changed data model. No new routes.** Every finding is
about presentation: what a control looks like, what it is called, and where it
sits. The one behavioural change is finding 1, and it changes what the page
*renders* about state the server already knows, not what the server records.

The review's own summary is worth keeping, because it is the standard this
milestone is held to:

> The product logic is sound — one link, one email, two taps. What holds it
> back is presentation: the interface says everything in the same voice, so the
> one thing that matters on each screen has to compete with everything else.

## 2. The system

Three primitives, applied everywhere. They are the reason this is one milestone
rather than eight unrelated patches: six of the eight findings are consequences
of not having them.

### 2.1 Colour means one thing

| Token | Means | Where |
| --- | --- | --- |
| `--accent` (green) | You are in. Settled. | Confirmed status, the chosen "I'm in", your own chip |
| `--warn` (amber) | Waiting. Not settled yet. | Waitlist, uneven sides, over capacity, nudges |
| `--danger` (red) | Irreversible. **Nowhere else.** | Call off, remove, leave, delete |
| `--line`/`--mut` (grey) | Out, no reply, inert | Everything else |

`--danger` is new. Today `--warn` does double duty as both "unsettled" and
"destructive" — `.button.danger` in `CANCEL_STYLES_CSS` is amber — while the
three genuinely irreversible actions in the product are not styled as dangerous
at all. They are `button primary`, the same solid green as "Join the squad":

- `src/views/delete-account.ts:79` — "Delete my data"
- `src/views/leave.ts:54` — "Leave this game"
- `src/views/remove-member.ts:71` — "Remove <name>"

This is the review's finding 2 and the most serious thing it found. Green is
the colour a player taps without reading, twice a week, to say they are coming.
Training that reflex and then putting it on erasure is a defect, not a taste
note.

**Green never destroys.** After this milestone, the only green filled buttons
are ones that confirm, create, or join.

### 2.2 Four type sizes

`2rem` screen title, `1.25rem` question, `1rem` body and buttons, `0.875rem`
support — and nothing smaller than the last. Today the stylesheets carry
fourteen distinct `font-size` values between `0.85rem` and `2rem`, most of them
differing from a neighbour by half a step, which is why the review says the
interface "says everything in the same voice".

The scale is expressed as tokens (`--t-title`, `--t-lead`, `--t-body`,
`--t-support`) so a future block cannot quietly add a fifteenth size without it
being visible in the diff.

### 2.3 One left edge

`STYLES` currently sets `text-align: center` on `main`, and `FORM_CSS`
overrides it back to left for the pages that could not live with it. The result
is that the response, cancel, sign-in and passkey pages centre everything while
the game, edit and fixture pages do not — the same product in two alignments,
which the review calls out as finding 6.

**The default flips.** `main` becomes left-aligned; centring is opt-in via a
`.centred` class, used only for genuinely empty or single-sentence states (the
holding page, "check your inbox", the already-cancelled pages). `FORM_CSS`'s
override disappears, because there is nothing left to override.

This is the change with the widest blast radius in the milestone and the reason
§7 insists on the browser suite rather than string assertions.

### 2.4 Typeface

Instrument Sans for text, IBM Plex Mono for counts and labels, from Google
Fonts, exactly as the review specifies.

This was raised as a conflict and decided deliberately. It is the first
external dependency any page has:

- `style-src` gains `https://fonts.googleapis.com`; `font-src`
  `https://fonts.gstatic.com` — the first holes in a CSP that is otherwise
  `default-src 'none'` with everything else allowed by hash. Hashes and host
  sources coexist: the inline blocks stay hash-allowed, the external stylesheet
  is allowed by host, and nothing else is.
- **Every page load now tells Google the visitor's IP address.** `/privacy` is
  the next milestone and must disclose it. Recorded in
  `docs/known-issues.md` beside the three admissions erasure already owes,
  because that list is read off rather than rediscovered.

`<link rel="preconnect">` for both hosts, and `display=swap`, so a phone on a
bad connection at the side of a pitch renders text in the fallback immediately
rather than staring at nothing. The fallback stack is the one the product uses
today, so a blocked or failed font request degrades to exactly the current
appearance.

## 3. The eight findings

Ordered as the review orders them, by cost.

### 3.1 Answering leaves no trace on the button you pressed *(High)*

Both response buttons look identical before and after answering. The only
confirmation is the sentence above them, and it changes *wording* rather than
*appearance*, so at a glance the page looks unchanged.

**The chosen button becomes the filled state, with a tick.**

The subtlety is where "chosen" comes from. Today the `primary` class is driven
by `?intent=` — the querystring the POST redirects to — with a deliberate
comment in `src/views/fixture.ts` explaining that a waitlisted viewer gets
*neither* button emphasised, because echoing the tapped intent would show a
solid green confirmation to somebody who is not in (BR-5).

That reasoning is right and survives. But `?intent=` is only present in the one
render immediately after a submit: a player opening their link on Thursday,
having answered on Tuesday, currently sees two identical buttons and has to
read a sentence to find out what they already said.

**So the source changes from `intent` to `viewer.status`:**

| `viewer.status` | Treatment |
| --- | --- |
| `in` | "I'm in" filled green, with a tick |
| `out` | "Can't make it" filled grey |
| `waitlisted` | "I'm in · waiting" outlined **amber**, never green |
| `pending` | Neither emphasised |

BR-5 is not weakened by this; it is stated more strongly. A waitlisted player
previously got the *absence* of a signal — two plain buttons — and had to infer
their state from a headline. Now they get a positive amber signal that is
unmistakably not the green one, in the control itself.

`intent` stops driving appearance entirely and is no longer read by the view.
The dashboard's cards get the identical treatment from the identical renderer,
because `renderActions` and `renderButtons` must not be able to disagree about
what "in" looks like.

### 3.2 Destructive confirmations are green *(High)*

§2.1. Four buttons move to `--danger`: the three named there plus
`.button.danger` on the cancel page, which moves off amber onto red.

`delete-account.ts` needs care beyond a class swap: it currently renders
"Delete my data" and "Keep my account" both as `button primary`, so the
destructive and the safe action are the same colour on the same flow. "Keep my
account" becomes the plain outlined button.

### 3.3 Two stacked buttons per squad member on the organiser fixture *(Medium)*

Fourteen people means twenty-eight full-width buttons, and at 390px "Mark in"
wraps to two lines.

**One segmented In/Out control per row that also shows the current answer.**
Still two `<button type="submit">` elements in one form — the no-JS guarantee
is untouched — but sized to content, sitting in a shared rounded track, with
the member's current status filling its half of the segment.

The current status is already on the row (`squadStatusLabel`); this makes the
control display it instead of repeating it beside the control. `aria-pressed`
carries the same fact to a screen reader, so the visual state is not the only
statement of it.

### 3.4 "0 spots left" is easy to misread as "you can't come" *(Medium)*

It sits beside a green confirmed badge, above two live buttons, with no
explanation of what tapping yes would do.

**State the outcome before the tap**, on the page, in the place the tap
happens: "The squad is full — answering yes puts you 3rd on the waitlist."

The rank is the position they *would* take — the current waitlist length plus
one — and it is not `viewer.waitlistRank`, which only exists once they are
already on it.

**That number is not on the page today and cannot be derived there.**
`FixtureView` has no waitlist count, and counting `waitlisted` members out of
`squad` fails exactly when the organiser has hidden the squad (BR-33), leaving
`squad === null` on the page that most needs the warning. So
`FixturePageOptions` gains a required `waitlistCount`, supplied by the route
from the same query it already runs, and sits beside `inCount`, which exists
for the identical reason: a count the page must state whether or not the names
are visible.

Required, not optional — an optional field would let a future caller omit the
warning silently, which is the failure this whole finding is about.

Shown only to
a viewer who is `pending` or `out` on a full fixture — a player already `in`
does not need warning about a waitlist they are not going to join, and one
already `waitlisted` has a headline that says exactly where they are.

### 3.5 Squad lists are fourteen visually identical rows *(Polish)*

Name left, status right, no grouping, the waitlist order implied only by
position.

**Group by answer, with a count, and render people as chips.** In / Waiting /
Out / No reply, in that order; the viewer's own chip filled in the group's
colour so they can see themselves counted.

**BR-27's attribution survives.** It was decided explicitly rather than
defaulted: a chip cannot carry "marked in by Jamie" without becoming a row
again, so attribution moves to a line beneath the group that has any —
"Nadia Okafor and Theo Marchetti were marked in by Jamie." With no email
telling a player somebody answered for them, this line is the only way they can
find out, and dropping it would be a real reduction in what BR-27 surfaces.

Guests keep their "(guest)" marker inside the chip.

### 3.6 Alignment flips between centred and left *(Polish)*

§2.3.

### 3.7 "Cancel this game" reads like cancelling the whole game *(Medium)*

The confirmation page titles the *game* and the button says "Cancel this game
and tell everyone" — for an action that affects one week.

**The page titles the date; the verb becomes "call off".** "Sunday 16 August
won't be played", and a button reading "Call it off and email 12 people" — the
count in the button, so the scale of what is about to happen is in the thing
being tapped rather than a sentence above it.

"Cancel" is kept for backing out, which is what it means everywhere else in
software, and the second button becomes "Keep the game on".

**Only user-facing copy on this page changes.** The route (`/cancel/:token`),
the lifecycle value (`cancelled`), the audit action, the notification (N-4) and
every business rule keep their names. `docs/guide/06-calling-a-fixture-off.md`
already uses this language, which is some evidence the product's own
documentation had drifted ahead of its interface.

The cancellation *email* is out of scope: it is read in a mail client with no
surrounding context, where "cancelled" is unambiguous and "called off" is not.

### 3.8 Every member row carries a "Make an organiser" button *(Polish)*

Fourteen rows of an action most organisers use twice a year outweigh the squad
itself on the game page.

**Role and removal move behind a per-member `<details>` disclosure.** The row
becomes the name, its markers, and a "Manage" summary; opening it reveals the
role form and the Remove link.

`<details>` rather than a script or a new route: it is the designed shape — the
controls are behind a per-member action — and it needs no JavaScript at all, so
there is nothing to degrade. A new `/g/:id/squad/:playerId` page would give the
same result for a new route, catalogue entry, browser journey and guide
screenshot; the disclosure gets there for none of them.

## 4. What is not redesigned

The review covers six screens. The product has fourteen catalogued pages. The
rest inherit §2 — tokens, scale, alignment — and nothing more:

- **The team picker (M9).** It is a week old, was designed against the
  product's existing language, and the review predates it. It gets the new
  tokens and the type scale; its layout is untouched.
- **Sign-in, passkeys, join, the game form, the erasure flows.** Same.
- **Email templates.** `src/notify/templates/*` render for mail clients that
  never see this CSS, have no CSP, and need inline styles. Out of scope
  entirely, and `src/security/csp.ts`'s header comment already says why.
- **The holding page.** It receives `STYLES` alone and none of the
  page-specific blocks, deliberately; that stays true.

## 5. Where the CSS lives

Unchanged, and this is load-bearing. `STYLES` in `src/views/layout.ts` holds
the shared primitives; every page-specific block is a named export in
`src/views/styles.ts` and a member of `PAGE_STYLE_BLOCKS`; `src/security/csp.ts`
hashes `STYLE_BLOCKS` at runtime.

A block added in one place and not the other does not compile, and if it
somehow did, the browser would silently drop it. Nothing in this milestone
loosens that. The new `--danger` and `--t-*` tokens go in `STYLES` beside the
existing ones, in both the light and dark blocks — **the dark theme is not
optional and the review, being light-only, says nothing about it.** Every
colour this milestone introduces needs a dark counterpart chosen at the same
time, not retrofitted.

## 6. Not in this

- **Any change to what the server records.** Finding 1 changes rendering only.
- **New routes, new tables, new columns, new notifications.**
- **The cancellation email's wording.** §3.7.
- **A redesign of the team picker.** §4.
- **Removing dark mode**, or shipping any token without a dark value.
- **`/privacy` itself.** Still M7's, still blocked on copy and a retention
  period. This milestone adds one admission to the list it must make.

## 7. Testing

**Server.** Every existing test that asserts on rendered copy is in scope, and
the ones that break are the point rather than an obstacle: "Cancel this game
and tell everyone" appears in tests because it appeared on the page.

New assertions: the four `--danger` buttons carry the danger class and not
`primary`; "Keep my account" does not carry `primary`; the response buttons'
emphasis follows `viewer.status` and not `intent`, including that a
`waitlisted` viewer's "I'm in" is never the green filled state (BR-5, and the
one assertion in this milestone that protects a business rule rather than an
appearance); the full-squad warning appears for a `pending` viewer on a full
fixture and not for an `in` one; squad grouping puts each status in its own
group with a correct count; attribution appears beneath a group when any member
was owner-set and not otherwise.

**CSP.** `test/security/csp.test.ts` gains the two font hosts, asserted as
exactly those two and no wider — a `font-src` that grew to `https:` would pass
a naive "fonts work" check.

**Browser.** This milestone changes CSS that every page depends on, and no
string assertion can see a layout break. The existing capture suite runs over
the whole catalogue at 390px and is the real gate. Two additions: the console
gate must stay silent (a blocked font request would surface there, which is
how we find out if the CSP directives are wrong rather than merely present),
and the organiser fixture's segmented control must be provably operable — mark
a member in through it, with JavaScript off, and see the segment reflect it.

**The guide.** Screenshots regenerate from `guide-capture.spec.ts`, so they
follow automatically. The prose does not: any sentence naming a button by a
label this milestone changes needs the new label, and
`guide-references.spec.ts` is what will say so.

## 8. Definition of done

1. No irreversible action anywhere in the product is green; every one is red.
2. A player opening their response link sees which answer they already gave in
   the button itself, on any render, not only the one after submitting — and a
   waitlisted player never sees the green confirmed state.
3. A full fixture tells a player what answering yes will do, before they do it.
4. Every page shares one left edge, one type scale, and one meaning per colour,
   in light and dark.
5. The organiser's squad rows fit without wrapping at 390px and show each
   member's current answer in the control that changes it.
6. Player-facing squad lists are grouped by answer with counts, and BR-27's
   attribution is still visible.
7. The cancel confirmation names the date, not the game, and its verb is "call
   off".
8. Role and removal sit behind a per-member disclosure on the game page.
9. `/privacy`'s outstanding-admissions list in `docs/known-issues.md` includes
   the Google Fonts request.
