# Make The Team — screen inventory for design review

A server-rendered web app (Cloudflare Workers + Hono, HTML forms, minimal JS) that runs a
recurring casual sports fixture — a weekly kickabout. One organiser sets a game up once;
fixtures generate themselves week after week; players answer a reminder email with two taps
and never need an account.

Three distinct audiences, with almost no shared chrome:

| Audience | How they arrive | Auth |
|---|---|---|
| **Player (token)** — the default, highest-volume user | Link in a reminder email | None. A signed URL token *is* the identity. |
| **Player (signed in)** — optional, for people who look rather than wait | Emailed magic link or passkey | Session cookie |
| **Organiser** — a signed-in player who owns a game | Signed-in area | Session + per-handler ownership re-check |
| **Admin** — the operator (today, one person) | `Admin` link in the signed-in header | Session + an `is_admin` flag re-checked per handler |

Signed-in pages (`/app/*`, `/g/*`) carry a slim site header: the site name (a link to the
dashboard) plus `Games`, `Account` and — for admins only — `Admin`, with the current section
marked `aria-current`. Public and token-link pages have **no header at all**, deliberately:
their visitors often hold no session, and a "Games" link that bounces to sign-in is worse
than no link. Below the header there are no breadcrumbs; movement is links in the parent
page or in an email, and a single text back-link at the bottom of the page ("Back to your
games", "Back to the game").

---

## 1. Public / unauthenticated

### 1.1 Holding page — `GET /`
- **Contents:** `Make The Team` (h1) and nothing else — an earlier one-line slogan was
  removed, so the page is currently just a name and two links.
- **Actions:** `Sign in`, `Privacy`.
- **Logic:** Deliberately not personalised — the sign-in link never becomes "your dashboard",
  even for a signed-in visitor (`/sign-in` bounces them onward instead).
- **Note:** There is no marketing content, no explanation of the product, and no way to create
  an account except by signing in with an email address.

### 1.2 Sign in — `GET/POST /sign-in`
- **Contents:** `Sign in` (h1). "We'll email you a link that signs you in. Nothing to
  remember, nothing to set up."
- **Fields:** `Your email address` (email input).
- **Actions:** `Email me a sign-in link` (primary), `Sign in with a passkey` (secondary,
  JS-only, under the line "Already added a passkey to this account?"), `What we do with your
  email address`.
- **States:** fresh; "That sign-in link didn't work…" (expired/used); "You're signed out."
- **Success screen:** `Check your inbox` — "If that address can sign in, a link is on its
  way. It works once, and it expires after a few minutes." Plus a spam-folder / try-again line.
  Deliberately does not disclose whether the address exists.

### 1.3 Sign-in completion failure page — `GET /sign-in/complete`
One page for all four dead ends (M20): `We can't sign you in` (h1), a per-case reason line
(email already in use elsewhere / duplicate player rows / address belongs to a guest entry /
a concurrent write), a sign-out button, and "Back to Make The Team". The concurrent-write
case alone keeps a `Try again` retry link — its fix really is retrying. Status codes stay
distinct per case (409/500/500/503) for monitoring.

### 1.4 Join a game (invite link) — `GET/POST /j/:token`
The public invite page. A stranger with the link needs no account.
- **Contents:** `Join <game name>` (h1); venue name; address; cadence and kickoff ("every week
  at 19:00 for sixty minutes"); min–max players; optional `More about the venue` link;
  `Next up: <date/time>` (or "No fixture is scheduled yet — you'll be emailed when the next
  one is"). Since M21 the date can be a fixture already open for responses — a joiner is
  backfilled into it (BR-2′), so naming it is a promise the app keeps.
- **Form — `Join the squad` (h2):** `Your name` (text, required), `Your email address`
  (email, required). Reassurance line (M21): "We'll add you to the squad and email you when
  there's a game on." with a bare `Privacy` link on its own line beneath it.
- **Action:** `Join the squad` (primary).
- **Below the form — `Who's playing (N)` (h2):** first names + initial only. Deliberately
  placed *below* the form ("it's what they read while deciding, not something to scroll past
  on the way to joining"). Empty state: "Nobody has joined yet — you'd be first."
- **Success page (M21):** confirms squad membership and names the first fixture. Three
  wordings: an already-open fixture ("A game is being organised right now for <date> — and
  you're in the running. Check your email: your invitation is on its way"), a scheduled one
  ("You'll get an email a few days before"), or none ("There's no fixture scheduled yet").
  The old caveat about not being in a game already underway is gone with the rule it stated
  (BR-2′): joining while a fixture is open backfills the joiner into it and sends their
  invitation email immediately, alongside the welcome. Below that, a **`Get set up` (h2)
  CTA** — one sentence naming home-screen install, notifications and passkey, with an
  `Open your dashboard` primary button (the dashboard's onboarding card handles the rest;
  the exception is a player removed *while marked in* for an open fixture, whose withdrawn
  marker stands — they rejoin the squad but not that fixture). Re-joining an existing
  membership says "Nothing has changed".
- **Logic:** Token is rotatable by the organiser; the old link dies immediately.

### 1.5 Respond to a fixture — `GET/POST /r/:token`
**The single most-used screen in the product.** Reached by tapping either button in the
reminder email; the tap *on this page* is what saves the answer.
- **Contents, in order (M20):** game name (h1); venue; kickoff date/time; the **answer
  block** — one state-tinted card carrying the viewer headline (h2), the two response
  buttons (or the read-only sentence), and the pre-tap full-warning; below it the fixture's
  own facts — status badge + capacity bar, nudge, over-capacity notice; optional push offer;
  published teams; `Squad` (h2). The block tints by state: plain when unanswered, amber when
  waitlisted, green-tinted when in, quiet field-grey when read-only.
- **Viewer headline** (the "did it work?" line): `Can you make it?` / `You're in.` /
  `You're on the waitlist.` / `You said you can't make it.` / `You're no longer in this squad.`
  A waitlisted headline is styled amber and sits *above* the confirmed badge.
- **Status badge** (fixture lifecycle, in words never database values): `Not open yet`,
  `Open for responses`, `Needs more players`, `Confirmed — the game is on`, `Cancelled`,
  `Played`, `Status unknown`.
- **Capacity bar + count:** e.g. `10 of 10 in · 2 waiting`. Replaced an older "N spots left".
- **Actions:** `I'm in` (becomes `I'm in · waiting` in amber when waitlisted; shows a tick when
  confirmed) and `Can't make it`. Both buttons persist after answering so the answer can be
  changed any time before kickoff. `aria-pressed` carries the current answer.
- **Pre-tap warning when full:** "The squad is full — answering yes puts you 3rd on the
  waitlist." — shown *before* the tap.
- **Over-capacity notice:** "There are more players in than there are places — the organiser
  has added someone over the limit."
- **Read-only states** (buttons replaced by a sentence): played, cancelled, not open yet,
  no longer on the squad.
- **Teams section** (once published): "You're on Team A." — always the viewer's own side,
  even in a squad-hidden game; "Your side hasn't been picked yet." for a late waitlist promotion;
  both line-ups below if squad visibility is on.
- **Squad section:** two mutually exclusive renderings driven by the game's
  `Let players see who else is playing` setting —
  - **on:** chips grouped under `In`, `Waiting`, `Out`, `No reply`; waiting chips carry rank
    (`· 1st`); the viewer's own chip is filled in.
  - **off:** a bare count — "3 in so far." — plus the viewer's own answer.
- **Push offer (one-time):** `Get these on your phone` (h2) + a permission button. No device
  list here, deliberately (token auth must not disclose endpoints).

### 1.6 Leave a game — `GET/POST /leave/:token`
Linked from the footer of every reminder / promotion / cancellation / welcome email.
- **Contents:** game name (h1); "Leaving means you'll stop getting email about <game>, and
  your place in any fixture that's still open is freed for someone else."
- **Organiser warning:** "You're an organiser of <game>. Leaving takes that away too, and only
  another organiser can give it back."
- **Action:** `Leave this game` (danger).
- **Sole-organiser state:** refuses, and directs the user to promote somebody first.
- **Signed-in extra:** `Your other squads` (h2) — a list, each with its own `Leave` button.
- **Logic:** No undo. Rejoining requires the invite link again.

### 1.7 Call a fixture off — `GET/POST /cancel/:token`
Reached only from a "short of players" warning email to the organiser.
- **Contents:** `<date/time> won't be played` (h1); a headcount before committing — game,
  venue, kickoff, players in, and how many people will be emailed (larger, because it includes
  the waitlist).
- **Field:** `Why is it off? (optional — this goes in the email)` — textarea, placeholder
  "Pitch flooded".
- **Actions:** `Call it off and email N people` (danger, count in the label);
  `Keep the game on` (secondary link-as-button back to the fixture).
- **Other states:** `<game> is cancelled` (done), `<game> is already cancelled`,
  `<game> can't be cancelled`.
- **Logic:** Irreversible. Affects one fixture only; next week is untouched.

### 1.8 Utility pages
- `GET /privacy` — plain content page.
- `GET /offline` — `No connection`; served by the service worker in the installed PWA.
  Deliberately shows nothing cached, because fixture state goes stale immediately.
- Generic error page — `This link isn't working` (shared by every token failure *and* by
  unhandled 500s, so an attacker learns nothing from the difference).

---

## 2. Signed-in player

### 2.1 Your games (dashboard) — `GET/POST /app`
The signed-in home.
- **Contents:** site header; `Your games` (h1); "Signed in as <name>."; optional problem
  notice; optional account-erasure banner; optional "Get set up" onboarding card; a list of
  fixture cards (each ending in the same answer block as the response page, facts first);
  `Your squads`; footer links.
- **Fixture card** (one per upcoming fixture, nearest first): game name as an `<h2>` **link**
  to the game page; kickoff; venue; status badge + capacity bar + count; the viewer's own
  headline; `I'm in` / `Can't make it` buttons; full-warning. Copy is imported from the
  response page so the two can never disagree.
- **Empty state:** "You've nothing coming up. When your next game opens for responses, it'll
  show up here."
- **`Your squads` (h2, M20):** every membership, each game name a link to its game page,
  owned games marked `· you own this`; then a `Set up a game` link. The section is omitted
  entire — heading included — when the player has no squads (the link stays). This gives a
  non-organiser a route to their game page that exists even when no fixture is open.
- **"Get set up" onboarding card:** shown for a player's first fortnight (from first
  sign-in) until dismissed. Up to three hints, each a plain link to a flow that exists
  elsewhere: `Add a passkey to sign in faster` → passkeys page; `Install the app on this
  device` and `Turn on notifications` → account page. The passkey and notifications hints
  self-retire once done (server-side checks); the install hint is hidden by a
  `display-mode: standalone` media query inside the installed app, since only the client
  knows. A `Dismiss` button removes the card permanently.
- **Erasure banner:** appears while a deletion is pending, with a `Keep my account` button and
  a `More about this` link; a second variant names the games that are holding the erasure up.
- **No footer links (M21):** `Delete my account and data` and `Privacy` moved to the account
  page, completing M20's migration of account, passkeys and sign-out behind the header's
  Account link. The dashboard below the squads section now ends clean.
- The card-heading route to the game page is no longer load-bearing: `Your squads` links
  there always.

### 2.2 Your account — `GET/POST /app/account`
- `Your account` (h1)
- **`Your name` (h2):** `Name` field + `Save`. Changing it changes the name everywhere,
  including in emails already-sent-forward.
- **`Signing in` (h2):** the email address, read-only, with an explanation of why it can't be
  edited; `Manage your passkeys` link.
- **`Your fixtures` (h2):** the last 20 fixtures across every game, most recent first, each
  with the game name as a link. Games left are excluded.
- **`This device` (section, M20):** install and notifications merged into one panel — intro
  ("Add Make The Team to your home screen and turn on game notifications."), the install
  instructions/button, then the notifications control and device table below.
- **Inside it, the notifications half:** intro; an outcome notice when returning from an action
  ("Notifications are on for this device.", "Test sent."…); `Your devices` (h3) — a table of
  registered devices, or "No devices registered yet." Each row: a player-chosen caption
  ("Ed's phone", falling back to the browser's UA string for rows named before the field
  existed), the date enabled, a hidden `This device` badge revealed by script on the matching
  row, and per-row `Test` and `Remove` buttons. The permission control is a script-revealed
  `Name this device` field (pre-filled "<name>'s phone") plus a button whose label is
  context-aware: `Turn on notifications` (none yet), `Enable on this device`, or `Re-enable
  on this device` when this browser is already in the table.
- **Footer:** `Delete my account and data` · `Privacy`; `Back to your games`.


### 2.3 Passkeys — `GET /app/passkeys`
- `Passkeys` (h1); whether one exists yet; `Add a passkey` (primary, JS-driven WebAuthn).
- **Logic:** On its own page because this flow cannot exist at all without WebAuthn script —
  not because script is banned elsewhere (see §5).

### 2.4 Delete my data — `GET/POST /app/delete`, `POST /app/delete/cancel`
One page in four states, all under `Delete my data` (h1) + "You're signed in as <name>."
1. **offer** — what will be erased, the two-day delay, `Delete my data` (danger).
2. **pending** — names the erasure date, `Keep my account` (primary).
3. **sole-organiser** — refuses to start, names the blocking games.
4. **held-up** — the erasure date has passed but a game now has only this organiser; names
   the games.
- **Constant footer note:** "Only you can start or stop this. An organiser can't do it for
  you, and neither can we — there's no control anywhere that names somebody else."
- **Logic:** Two-day delay, nothing changes in the meantime; historic fixtures keep the
  headcount and show "a former player".

### 2.5 A game, as a player — `GET /g/:id` (non-organiser rendering)
- Game name (h1); venue; address; the open fixture (kickoff, status badge, capacity bar,
  published teams, `Squad`) or "Nothing open yet — you'll get an email the day before the next
  game."; `Coming up` (h2) — a list of dates each with its status in words.
- **No invite link, no QR, no controls, no edit link** — a separate renderer from the
  organiser's page so that capability cannot leak in by accident.

---

## 3. Organiser

### 3.1 Create / edit a game — `GET/POST /g/new`, `GET/POST /g/:id/edit`
One form serves both.
- **Fields, in order:** `Game name`; `Where you play`; `Address (optional)`;
  [`Day` (select, weekday) | `How often` (select: Every week / Every 2 weeks)];
  [`Kickoff` (time) | `Minutes` (number)];
  [`Minimum players` (number) | `Maximum players` (number)];
  toggle `Prefer even numbers` — hint "Warns you when the maximum is an odd number.";
  toggle `Let players see who else is playing` — hint "When off, players see only how many are
  in; you always see the names.";
  [`First team's name` | `Second team's name`].
- **`Advanced` (`<details>`, collapsed):** `Time zone` (select); `Venue link` (url);
  `Send the reminder this many days before` (number); `Send the reminder at` (time);
  `Warn owners this many hours before kickoff` (number).
- **Actions:** `Create the game` / `Save changes`.
- **Notices:** "Some details need another look." on validation failure; per-field inline errors;
  warnings; on edit, an affected-fixtures notice ("This will update 4 scheduled fixtures…" and
  that an already-emailed fixture is left alone).
- **Logic:** Rejected submissions come back with everything still typed in. Editing never moves
  a fixture people have already been emailed about.

### 3.2 Game overview — `GET /g/:id` (organiser rendering)
The organiser's home for one game.
- Game name (h1); venue; address; `Edit this game` link. Order after that (M20): `Coming up`
  first, `Squad` second, the invite card third, `Message everyone` last.
- **Broadcast receipt (M20):** returning from a send shows a one-line green notice — "Sent to
  11 players by email." — driven by a validated redirect flag, never echoed text.
- **`Invite people` (h2) card:** the invite URL, a `Copy` button (JS-only, hidden without it),
  a `Show the QR code` `<details>` disclosure, and `Replace this link` (a form POST that
  rotates the token and kills the old link immediately).
- **`Message everyone` action** → the game-scoped broadcast compose page.
- **`Squad (N)` (h2):** one row per member — name, `organiser` / `organiser (you)` marker, and
  a `Manage` `<details>` disclosure containing `View details`, a role button
  (`Make an organiser` / `Make an ordinary member`), and `Remove`.
- **`Coming up` (h2):** upcoming fixtures, each date a link to its own fixture page.
- **Footer:** `Back to your games`.
- **Logic:** A game always keeps at least one organiser; the last one cannot demote themselves.

### 3.3 Squad member detail — `GET /g/:id/squad/:playerId`
- Member name (h1); "In <game>."; `What we have for them` (h2) → `Email` (or "No email
  address — a guest, added for one fixture"); `In this squad` → "Organiser/Player, since <date>".
- **No edit controls at all**, by design. Back-link says where to go to change the role or
  remove them.

### 3.4 Remove a member — `GET/POST /g/:id/squad/:playerId/remove`
- `Remove <name>?` (h1); spells out exactly what happens (out of the squad, told by email,
  what happens to their upcoming fixtures), and that it is neither permanent nor a punishment —
  they can rejoin with the invite link, but the organiser cannot put them back.
- **Actions:** `Remove <name>` (danger); `No, leave the squad as it is` (secondary).

### 3.5 Fixture, as organiser — `GET /g/:id/f/:fixtureId`
The busiest organiser screen.
- Game name (h1); optional problem notice; kickoff; venue; status badge + capacity bar;
  over-capacity notice — "Over capacity — 6 in, 4 places."
- **`Squad` (h2)** — one row per person:
  - **Member:** name, an `In` / `Out` segmented control that both shows and sets the current
    answer, and (waitlist only) a label naming their place in line.
  - **Marked-by attribution:** "marked in by jamie" under the name; visible to the player too.
  - **Guest:** no In/Out control — their status in words plus a `Remove` button (no
    confirmation page; there is no membership to undo).
- **Over-limit interstitial:** marking someone in or adding a guest past the maximum stops and
  asks — `Add them anyway` / `No, leave it`.
- **`Teams` (h2)** — see 3.6.
- **`Add a guest` (h2):** `Their name` (text) + `Add guest`.
- **`Message players` action** → the fixture-scoped broadcast compose page.
- **Footer:** `Back to the game`.

### 3.6 Team picker (a section of 3.5)
- Two side columns headed with the team names (default `Team A` / `Team B`), each with a count.
- Below, one `<fieldset>` per player who is **In** (waitlisted players are excluded on purpose;
  guests are included), with radios: `Not picked yet` | Team A | Team B.
- **Drag-and-drop** into a column is a progressive enhancement that ticks the same radio.
- **Actions:** `Save teams`; `Publish teams` (appears once a pick is saved), which becomes
  `Publish again` permanently after the first publish.
- **Copy:** "Only players who are in can be given a side. Nobody is told anything until you
  publish."
- **Refusals / notes:** "Everyone who's in needs a side before you can publish. Still to pick:
  Freya Lindqvist."; "The sides are uneven at the moment. That's fine if you meant it." (a note,
  not a refusal); "The teams have changed since they were last sent out. Send them again?"
- **Logic:** Saving updates every player's page immediately; publishing is what sends email.
  Nobody is reshuffled automatically when someone drops out. After the fixture is played or
  cancelled the pick stays as a record and the controls disappear.

### 3.7 Message the squad (broadcast) — `GET/POST /g/:id/message` and `/g/:id/f/:fixtureId/message`
One renderer, two scopes.
- **Heading:** `Message everyone in <game>` (game scope) or `Message the squad for <game> on
  <date/time>` (fixture scope).
- **Audience — fixture scope only** — `Who gets this message?` (fieldset of radios, each with
  a live count): `Playing (N)`, `On the waitlist (N)`, `Not answered yet (N)`, `Can't play (N)`.
  Default `Playing`.
  **Game scope shows no control at all**, just the sentence "This goes to everyone in the squad."
- **Fields:** `Subject` (text, max length); `Message` (textarea, max length).
- **Channels:** two toggles — `Email` ("Send by email.") and `Push notification` ("Send as a
  push notification, to anyone with a device registered.").
- **Action:** `Send to N players` — the count is the selected audience narrowed by the ticked
  channels, and it degrades to `Nobody to send to` at zero (the button stays enabled so the
  server's refusal can explain why).
- **Errors:** "Give the message a subject."; "Write a message."; "Pick at least one way to send
  this — email, push, or both."; "Pick who this message goes to."
- **Whole-page refusals:** "Nobody matches this audience, so there is nobody to send this
  message to."; "This game has already sent N messages today. Try again tomorrow." (daily cap).
- **On success:** a 303 redirect back to the game or fixture page, which now (M20) shows the
  one-line receipt ("Sent to N players by email/push/both"). Still no delivery report: the
  count is recipients at send time, and push failures remain invisible to the organiser.
- **Logic:** The page runs no script, so unticking a channel does not update the button count
  until the server answers.

---

## 4. Admin

A signed-in player whose `is_admin` flag is set. The flag only draws the header link; every
admin handler re-checks it per request, and a non-admin gets a 404, not a 403.

### 4.1 Admin index — `GET /app/admin`
- `Admin` (h1); a plain list of three tool links, each with a one-line note underneath
  ("Who can create an account without an invite." / "Check whether an address can sign in,
  and see recent refused attempts." / "Today's send count against the daily ceiling, and
  recent notification outcomes.").
- Deliberately a menu rather than a dashboard of live numbers — each tool page carries its
  own data, so this page has nothing to go stale.

### 4.2 Sign-up allow list — `GET /app/admin/allowlist` + add/remove POSTs
- Opens by scoping itself: the list only lets someone in *ahead of* their first invite;
  anyone already invited to a squad can sign in regardless.
- One list, two provenances: entries from a server-config secret are labelled "from server
  config" and have no remove button (the screen cannot write a Cloudflare secret, and hiding
  them would leave the list disagreeing with who can actually sign in); table entries each
  carry `Remove`.
- Empty state: "Nobody is on the allow list. Only invited players can sign in."
- Add form: email field + `Add`; invalid input re-renders at 422 with an inline error.

### 4.3 Sign-in doctor — `GET /app/admin/sign-in` (+ check POST)
- A check form: enter an address, get a verdict ("Can sign in." / "Cannot sign in — every
  door is closed.") plus a per-door breakdown: server config allow list, sign-up allow list,
  invited player with an active squad place.
- `Link requests in the last few minutes` (h2): pending magic-link requests, each with what
  the gate would say *now*; entries disappear as the links expire, so this is "what just
  happened", not history.
- `Recently refused` (h2): addresses the gate turned away — each saw the normal "check your
  inbox" page and no email was sent.
- All timestamps are UTC and say so.

### 4.4 Email delivery — `GET /app/admin/delivery`
- "Sent today (UTC): N of M." against the daily ceiling, plus which notifier this deployment
  uses. Once the ceiling is reached, further email quietly waits for tomorrow.
- `Recent notifications` (h2): a when/type/channel/status/error table, newest first, max 20.
  Sign-in link emails count against the ceiling but are not logged here — deliberately two
  facts, not one.

---

## 5. Cross-cutting behaviour worth a designer's attention

Split into two lists on purpose. The first are requirements — designs that undo them will be
rejected, so treat them as fixed. The second are the product's current choices: defensible,
but opinions, and a design review is welcome to challenge any of them.

### Hard constraints

- **The email button must not record the answer.** Mail scanners and prefetchers follow links,
  so the tap in the email opens the response page and a second tap there is what saves. (How
  the page communicates "did it work?" — currently one headline sentence — is a choice, not a
  constraint.)
- **Anti-enumeration.** The sign-in success page never discloses whether an address exists;
  every token failure and every unhandled error shares one generic "This link isn't working"
  page; an entitlement refusal is a 404, not a 403.
- **Token pages never disclose push endpoints or device lists.** The signed-in account page is
  the only place a registered device is ever shown.
- **Organiser and player views of a game are separate renderers** so organiser capability
  cannot leak into the player page by accident. A design can restyle either, but not merge
  them into one template with conditionals.
- **Squad visibility off means no names, anywhere a player can see** — bare counts only.
  Organisers always see names.
- **Server-rendered core.** Every core flow works with scripting off; the exceptions are
  passkeys and push, whose platform APIs are JS-only and which live on pages/sections that
  degrade to nothing rather than to a broken control.
- **Emails are a first-class surface**, not a notification layer: the reminder, the promotion,
  the teams-are-up message, the short-of-players warning (which carries the only route to the
  cancel page), the cancellation, and the welcome mail all carry the app's primary actions.
  A design that treats email as secondary misses most of the product's actual usage.

### Current choices — open to challenge

- **Light SSR, JS as sugar.** The requirement is "mostly server-rendered, not a SPA" — it is
  *not* a JS ban. Current script is deliberately small (copy button, QR disclosure,
  drag-and-drop team picking, install prompt, push, passkeys, the update overlay), but a
  design may propose more client-side interaction freely, so long as the non-JS baseline of
  core flows survives.
- **Navigation is minimal.** Signed-in pages have the header; token pages have none; there are
  no breadcrumbs, and every page ends in exactly one text back-link. Depth is three or four
  levels (dashboard → game → fixture → message/teams).
- **The holding page is bare** — a name and two links, no marketing, and the sign-in link never
  personalises to "your dashboard" (kept session-free for performance; `/sign-in` bounces a
  signed-in visitor onward anyway).
- **The join page puts the squad list below the form** — the theory being it's what a person
  reads while deciding, not something to scroll past.
- **Waitlist promotion is silent and automatic.** The promoted player is emailed; nobody else
  is told; the organiser does nothing.
- **Guests exist for one fixture only.** No invite link, no email, no membership — the
  organiser has to tell them the details personally.
- **Capacity can be exceeded deliberately,** and the app then labels the fixture as over
  capacity for everybody rather than hiding it.
- **Almost every destructive action has its own confirmation page** with the consequence
  spelled out in prose (remove member, leave, delete account, cancel fixture) — except
  removing a guest, which is immediate.
- **Broadcasts get a receipt but no delivery report** — the organiser sees "Sent to N
  players…" (recipients at send time); push failures are still invisible to them.
- **In the installed app only, a new deploy raises a bottom overlay** — "A new version is
  available." plus a `Refresh` button — because an installed PWA can sit open for days with no
  reload control of its own; a browser tab gets fresh pages on every navigation and never
  sees it.
- **The palette (M20):** warm cream ground, terracotta accent, Caprasimo display headings,
  Figtree body; green is reserved for success/confirmed, amber for the waitlist, red for
  irreversible actions. A WCAG contrast guard test pins every declared token pairing in both
  light and dark themes.
