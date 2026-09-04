# Make The Team — screen inventory for design review

*Current to M52 (3 September 2026). Before this it had not been touched since M33 and was
missing seventeen milestones' worth of screens; if it is stale again, `test/browser/catalogue.ts`
is the machine-checked list of every page and is the right place to start.*

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
  While a request is in flight the primary button is disabled and reads `Sending your link…`
  (JS-only; a second press while the first POST is running is what sent one player two magic
  links in August 2026). A back-navigation restores it, and with scripting off the button
  behaves exactly as it always did.
- **Success screen:** `Check your inbox` — "If that address can sign in, a link is on its
  way. It works once, and it expires after a few minutes." Plus a spam-folder / try-again line.
  Deliberately does not disclose whether the address exists.
- **Inside the installed app the page reorders itself (M40).** An iOS home-screen app has its
  own cookie jar, so an emailed magic link signs Safari in and leaves the app signed out —
  nothing on the link's side can fix that. Where `display-mode: standalone` (or
  `navigator.standalone`) holds, script moves the passkey block **above** the form, retitles the
  intro to say the emailed link opens in the browser, and makes the passkey button primary. A
  browser tab is untouched: there, the thing that always works comes first. Sessions also last
  30 days with a daily sliding refresh (Better Auth's default was 7), so the wall is hit less
  often. Conditional mediation (`autocomplete="email webauthn"` plus a background
  `credentials.get`) offers a stored passkey without a click where the browser supports it.

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
- **Throttle (M51):** this is the one token deliberately handed to a whole squad, so it has its
  own rate-limit budget (`SHARED_TOKEN_LIMITER`, 200/60) rather than the 10/60 sized for a
  single player's personal link. Under the old shared budget the sixth person to tap the link
  inside a minute got the too-many-requests page — exactly what a group-chat paste or a QR code
  held up at training produces.

### 1.4a Confirm a join — `GET/POST /join/:jtoken` (M39)
Since M39 the invite form does **not** seat a first-time address (BR-47). Submitting it sends
one email and shows **`Check your inbox`** — which names the game and the name typed and
nothing else: no fixture details, no squad list, no second link, because it is the only
message the app sends to an address before it knows the address reaches anyone. That page has
no screenshot anywhere: it is reachable only by POST, and both capture harnesses are
GET-driven.
- **The link's page:** `Join the squad as <Name>?` (h1), the game and its venue on one line,
  a single primary `Yes, join the squad` button, and "Not you? Just close this page — nothing
  happens unless you press the button."
- **Logic:** the GET writes nothing (BR-50); the POST is what creates the membership and
  stamps `email_verified_at` — the click on the emailed link *is* the proof of address.
- **Only once per address.** Anyone who has confirmed a join before — for this game or any
  other — or who has ever signed in, skips the inbox step: the invite page seats them
  immediately, as it always did.
- **Design note:** the page centres its content vertically, so on a phone it is a short block
  floating in a large empty field. Deliberate or not, it is the least conventional layout in
  the product.

### 1.5 Respond to a fixture — `GET/POST /r/:token`
**The single most-used screen in the product.** Reached by tapping either button in the
reminder email; the tap *on this page* is what saves the answer.
- **Contents, in order (M20):** game name (h1); venue; kickoff date/time; the **answer
  block** — one state-tinted card carrying the viewer headline (h2), the two response
  buttons (or the read-only sentence), and the pre-tap full-warning; below it the fixture's
  own facts — status badge + capacity bar, nudge, over-capacity notice; optional push offer;
  published teams; `Squad` (h2). The block tints by state: plain when unanswered, amber when
  waitlisted, green-tinted when in, quiet field-grey when read-only.
- **Freshness bar (M24):** the page's last line — `Updated 3 minutes ago` on the left, a `Refresh` link on the right. See §5 for what it does.
- **Viewer headline** (the "did it work?" line): `Can you make it?` / `You're in.` /
  `You're on the waitlist.` / `You said you can't make it.` / `You're no longer in this squad.`
  A waitlisted headline is styled amber and sits *above* the confirmed badge.
- **Status badge** (fixture lifecycle, in words never database values): `Not open yet`,
  `Open for responses`, `Needs more players`, `Confirmed — the game is on`, `Cancelled`,
  `Played`, `Status unknown`.
- **Capacity bar + count:** e.g. `10 of 10 in · 2 waiting`. Replaced an older "N spots left".
- **Emphasis before any answer (M52):** with no answer recorded, `I'm in` carries an accent
  *outline* and `Can't make it` stays plain. Deliberately not `.button.primary`, which is the
  same solid accent fill as `chosen-in` — that would render "you have not answered" identically
  to "you said yes", which is exactly what M10 §3.1 removed from these two pages. Three
  treatments (outline, accent fill plus tick, grey fill) keep the states tellable apart with
  colour ignored entirely. Once answered the emphasis drops; the chosen state carries it.
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
- **Auto-decline panel (M28):** below the squad, and **only when the page is not read-only** —
  a finished, cancelled or not-yet-open fixture offers nothing to submit, and a reader who is
  no longer on the squad is offered nothing at all. See §2.5 for the panel itself; the actions
  post to `/r/:token/mute` and `/r/:token/unmute`, so no session is needed.

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
- **Other states:** `<game> is cancelled` (done — carries the `Post to WhatsApp` card, M22,
  with "<game> on <date/time> is cancelled." plus the reason, see 3.5), `<game> is already
  cancelled`, `<game> can't be cancelled`.
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
  to the game page; kickoff, itself a **link** to the fixture (the owner fixture page for an
  owner, the game page for a member — who is not entitled to the owner page); venue; status badge + capacity bar + count; the viewer's own
  headline; `I'm in` / `Can't make it` buttons; full-warning. Copy is imported from the
  response page so the two can never disagree.
- **Empty state:** "You've nothing coming up. When your next game opens for responses, it'll
  show up here."
- **Auto-decline panel (M58):** the same shared panel §2.5 describes, directly under the
  fixture list — under the empty state's sentence when there is nothing coming up, which is
  the case it exists for. Until M58 the switch was reachable only from a squad page or an
  emailed fixture link, so deciding to be away for a fortnight meant waiting for an invitation
  to say so on. Here it names the squad it acts on — "stop sending you anything about Tuesday
  Fives" — because this page is about all of them and an unqualified "this squad" would name
  nothing; the panel's own `Do this for my other squads too` checkbox is what covers the rest.
  The squad is the first non-archived one in `Your squads` order, and the panel is absent for a
  player in no squads. Both forms return here rather than to the squad page.
- **`Results needed` (h2, M25):** every played fixture the viewer is entitled to see that is
  still writable and that they have not yet filed a claim on — a genuine to-do, since the
  dashboard is a to-do list. One card per fixture: game name (linking to the game), kickoff
  (linking to the fixture, §2.6). A plain link, never a form — filing happens on the fixture
  page. Omitted entirely, heading included, when the list is empty.
- **`Recently played` (h2, M27):** the newest played fixture the viewer was in that is *not*
  already in `Results needed` above — one card: game name (linking to the game), kickoff
  (linking to the fixture, §2.6), venue, and the result once the fixture's window has locked.
  A tally still inside its 48 hours shows no result line at all, so nothing here reads as
  settled while the panel on the fixture page still shows it as a contested claim. Omitted
  entirely, heading included, when there is none. Its place in the page is the requirement:
  fixtures the viewer can still act on first, then anything waiting on their own claim, then
  this.
- **`Your squads` (h2, M20):** every membership, each game name a link to its game page,
  owned games marked `· you own this`; then a `Set up a game` link. The section is omitted
  entire — heading included — when the player has no squads (the link stays). This gives a
  non-organiser a route to their game page that exists even when no fixture is open.
- **`Your record` (h2, M48/M48a):** a table of the viewer's own playing record — one row per
  game they have ever played in, linked to that game, plus an `All games` total row (omitted
  for a single game, where it would be that row printed twice under a different label).
  Columns are `P`/`W`/`L`/`D` as `<abbr>`s rather than words: spelled out, the five headers set
  the columns wide enough that a long game name had only a few characters left and wrapped to
  four lines at 390px. A fifth column `NR` appears **only when the number is non-zero anywhere
  in the table** — a column that shows for some rows and not others is not a column — with the
  caption "NR counts the games you played where nobody agreed a result, or where sides were
  never picked". `played` is an upper bound on `won + lost + drawn`; NR is how the row is made
  to add up rather than quietly failing to. The whole section is absent when nothing has been
  played, matching the results-needed and squads sections.
- **"Get set up" onboarding card:** shown for a player's first fortnight (from first
  sign-in) until dismissed. Up to three hints, each a plain link to a flow that exists
  elsewhere: `Add a passkey to sign in faster` → passkeys page; `Install the app on this
  device` and `Turn on notifications` → account page. The passkey and notifications hints
  self-retire once done (server-side checks); the install hint is hidden by a
  `display-mode: standalone` media query inside the installed app, since only the client
  knows. A `Dismiss` button removes the card permanently.
- **Freshness bar (M24):** the page's last line — `Updated 3 minutes ago` on the left, a `Refresh` link on the right. See §5 for what it does.
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
  with the game name as a link **to the fixture, not the game (M25)** — this is where "what
  happened in March?" is answered — and, once its result has locked, the result underneath it
  ("Reds won 3–2"), from the same shared words the fixture's own panel shows. Games left are
  excluded, and so is any fixture the viewer has since lost standing in
  (`selectEntitledFixtures` filters on `memberships.active`).
- **`Install the app` (h2, M21):** the heading sits *outside* its card, at the same level as
  `Your fixtures` (M20's merged "This device" panel is split back in two, without the intro
  sentence). The card holds the install instructions/button.
- **`Manage notifications` (h2, M21):** the second card, same outside-heading treatment —
  an outcome notice when returning from an action
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
- Game name (h1); venue; address.
- **Last result (M25):** a line naming the most recent played fixture's locked result — "Reds
  won 3–2" — linking to that fixture's own page (§2.6), directly under the address and above
  the open fixture. Absent until a fixture has locked; the same words a fixture's own result
  panel shows, from one shared function, so the two can never disagree.
- The open fixture (kickoff, status badge, capacity bar, published teams, `Squad`) or "Nothing
  open yet — you'll get an email the day before the next game."; `Coming up` (h2) — a list of
  dates each with its status in words.
- **Auto-decline panel (M28):** between the open fixture and `Coming up`. Switched off it is a
  single quiet `<details>` line — `Can't play for a while?` — opening to a short explanation, a
  five-way radio (`1 week` (M57) / `2 weeks` / `4 weeks` / `8 weeks` / `Indefinitely`, four
  weeks selected by default),
  an optional `Do this for my other squads too` checkbox (hidden when the player is in only one
  squad, and captioned with how many there are), and `Turn on auto-decline`. Switched on it is
  always open — never behind a disclosure — as a card with an amber left edge:
  "You're auto-declining this squad until Saturday 19 September. You can still say yes to any
  game." plus `Turn auto-decline off`. The expiry is shown as a **date with no clock time**: it
  is four weeks from whenever the button was tapped, and a time of day would read as chosen.
  While it is on, every fixture that opens records the player as `out` at the moment it opens,
  and this squad sends them nothing at all — reminder, teams, cancellation, organiser broadcast
  and result prompt alike. **Accepting one fixture never switches it off**, which is why the
  copy promises that in both states.
- **Answer block (M52):** the same headline, buttons and full-warning the dashboard card and
  `/r/:token` use, imported rather than restated so a waitlisted player cannot read as confirmed
  on one page and not another (BR-5). Until M52 this page showed an open fixture and offered no
  way to answer it — while being the target of the largest link on every dashboard card. Posts
  to `POST /g/:id/f/:fixtureId/answer`, which shares `recordWebAnswer` with `POST /app` and
  differs only in redirecting back here rather than to the dashboard.
- **`Games you've played` link (M27):** under `Coming up`, to this game's past-fixtures list
  (§2.7).
- **`Standings` (h2, M49) — the squad's league table.** One row per player in the squad, with
  `P`/`W`/`L`/`D`/`GD`/`Win%`/`Pts` as `<abbr>`s, three points for a win and one for a draw.
  The viewer's own row is **marked, never moved** — "a league table whose fourth place is
  printed at the top is no longer a league table". The player column is capped with an
  ellipsis and carries a `title`, because uncapped one long name pushed `Pts` — the number the
  table exists to report — off the right of a 390px screen behind a scroll nobody would think
  to try; the cap is inside a mobile-only media query. Goal difference is written with a real
  minus sign (U+2212), since at this size a hyphen beside a digit is close to invisible and
  "5" for "−5" is a two-place error. A caption states the scoring and warns that GD counts
  only games with an agreed score, so it covers fewer games than the rest of the row.
  **Rendered not at all — no heading, no empty table — when the viewer may not see it or there
  is nothing to show.** `standingsForViewer` decides; a heading over an empty table reads as a
  broken page, and a heading over a table the viewer is not entitled to would advertise that
  something is being kept from them. Both the player and organiser renderings call the one
  shared function, so the two roles cannot rank one squad two different ways.
- **Freshness bar (M24):** the page's last line — `Updated 3 minutes ago` on the left, a `Refresh` link on the right. See §5 for what it does.
- **No invite link, no QR, no controls, no edit link** — a separate renderer from the
  organiser's page so that capability cannot leak in by accident.

### 2.6 A fixture, as a player — `GET /g/:id/f/:fixtureId` (member rendering, M25)
The first per-fixture URL a player has ever had — until now their only stable per-fixture link
was `/r/:token` out of an email, and `/g/:id` shows only the *open* fixture, so a played
fixture's published teams vanished from a player's view the moment the sweep retired it.
- Game name (h1); optional problem notice (a 422 re-render only); venue; address; kickoff;
  status badge; then the result panel (below), then the teams and the squad.
- **Published teams, past tense:** "You were on Bibs." rather than the open-fixture page's
  present tense — a played fixture is what this page is for, and "you're on" is never true of
  one. Follows the same visibility rule as everywhere else (BR-33, BR-35): a player always sees
  their own side.
- **Picking the teams (M29):** when this member may pick this fixture's teams, a sentence and a
  `Pick the teams` button linking to §3.6b — "The organiser has asked you to pick the teams for
  this one." (named delegate) or "The teams are open for anyone in the squad to pick." A link,
  not the picker itself: the picker is a long form of radio groups and would bury a player's own
  "am I playing?" question under somebody else's job.
- **`Squad` (h2):** who was in, same as the player's game page.
- **`Result` (h2) — the result panel**, shared with the organiser's fixture page (§3.5), and
  rendered **above the teams and the squad** (M27): on a played fixture both of those are
  history, and the panel is either the thing the viewer was nudged here to fill in or the score
  they came to read. Below them it sat under two full lists, a long scroll away on a phone.
  - **Writable** (fixture played, window still open): each candidate claim with its backer
    count, an `Agree` submit per candidate, "your pick" on the viewer's own, a "What happened?"
    form (a score, or just who won, radios only), a `Withdraw my answer` button once the viewer
    has filed, and how long is left. Nothing filed yet reads "No result recorded yet." and
    offers the same form.
  - **Locked:** the outcome and the margin, each with its own confidence figure ("Result 4 of
    5", "Score 3 of 5"); "Teams weren't picked in the app for this fixture, so we don't know who
    played on which side." when the fixture was never rostered.
  - **Nothing filed, deadline passed:** still writable, and says so — the window never closes on
    an empty fixture.
- **Freshness bar (M24):** the page's last line — the sixth page to carry one, and the
  strongest case yet: this page's content is a live tally. `Updated 3 minutes ago` on the left,
  a `Refresh` link on the right. See §5 for what it does.
- **No footer back-link, no invite card, no squad-management controls** — a member-only
  rendering of the same route the organiser's page (§3.5) answers; an owner viewing their own
  fixture always gets the organiser page, never this one.
- **Refusals:** a squad member who was `out` that week can read the page but cannot file (no
  form renders); anyone not an active member of the game gets a 404; a fixture that has not
  been played gets a 404 on the write routes, distinct from the 422 a locked fixture's write
  gets.

**Auto-decline panel (M28):** below `Squad`, on an open or scheduled fixture only — a played or
cancelled one is a record of an evening, and the switch belongs where a reader is still deciding
something. Identical to §2.5's, and posting to the same two paths.

### 2.7 Past fixtures — `GET /g/:id/fixtures` (M27)
A game's fixtures that have been and gone. One route, dispatching by role exactly as `/g/:id`
does — two paths would be two entitlement checks to keep in step, and the second is the one
that gets forgotten. Reached from `Past fixtures` on the organiser's game page (§3.2) and
`Games you've played` on the player's (§2.5).
- `Past fixtures` (h1); the game name; a one-line caption saying what the list holds.
- **What each role sees:** an organiser gets **every** fixture before now, all lifecycles,
  cancelled ones included — an organiser asking what happened to a Thursday is better served
  seeing it than finding a gap. A member gets the **played** fixtures they have a response row
  for; a fixture called off is one nobody played, so it is absent, and so is one played before
  they joined.
- **Row:** kickoff as an `<h2>` link to the fixture page (§2.6 or §3.5, by role); status badge;
  headcount ("11 in"); the result, on the same lock rule as everywhere else — nothing at all
  while a tally is still inside its 48 hours.
- **Empty state:** "This game has no fixtures in the past yet." for an organiser; "You haven't
  played a game here yet. Once you have, it'll show up here." for a member.
- **Bounded at 50 rows**, newest first. There is no "older" link yet — see
  `docs/known-issues.md`.
- **Refusals:** anyone who is neither an active organiser nor an active member gets a 404, the
  same answer both refusals give, so a game id cannot be probed (TR-18).
- **Freshness bar (M24):** the page's last line.

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
- **`Notifications` (`<fieldset>`, edit only, M26):** one row per notification the game sends
  on a schedule or on publish — a switch, a hint, and the timing the switch governs:
  `Remind players before kickoff` [`Days before` (number) | `At` (time)];
  `Warn me when a fixture is short or uneven` [`Hours before kickoff` (number)];
  `Nudge me to post it to the group chat` (no timing — it rides with the reminder);
  `Ask players how it went` [`Hours after full time` (number, 0–48)];
  `Email players when I publish teams` (no timing — it is sent on publish);
  `Tell a player when I hand them the team pick` (M29, no timing — it is sent on the hand-over).
  Every switch defaults on. Each carries a hidden `<field>Submitted` marker, which the parser
  reads: without it the create form's submission, which has no section at all, is
  indistinguishable from an owner who turned every one of them off.
- **`Advanced` (`<details>`, collapsed):** `Time zone` (select); `Venue link` (url).
- **Actions:** `Create the game` / `Save changes`.
- **Notices:** "Some details need another look." on validation failure; per-field inline errors;
  warnings; on edit, an affected-fixtures notice ("This will update 4 scheduled fixtures…" and
  that an already-emailed fixture is left alone).
- **Logic:** Rejected submissions come back with everything still typed in. Editing never moves
  a fixture people have already been emailed about. The notification switches are read live from
  `games` on every send, never snapshotted onto a fixture, so turning one off silences fixtures
  that already exist; the short/uneven *offset* keeps its per-fixture snapshot. Turning reminders
  off does not stop fixtures opening — opening is not a notification, and it stays on the same
  schedule.

### 3.2 Game overview — `GET /g/:id` (organiser rendering)
The organiser's home for one game.
- Game name (h1); venue; address; `Edit this game` link. Order after that (M20): `Coming up`
  first, `Squad` second, the invite card third, `Message everyone` last.
- **Last result (M25):** a line naming the most recent played fixture's locked result — "Reds
  won 3–2" — linking to that fixture's own page (§3.5), directly under `Edit this game` and
  above `Coming up`. Absent until a fixture has locked; the same shared function the player
  game page's own last-result line (§2.5) uses, so the two can never disagree.
- **Broadcast receipt (M20):** returning from a send shows a one-line green notice — "Sent to
  11 players by email." — driven by a validated redirect flag, never echoed text.
- **`Invite people` (h2) card:** the invite URL, a `Copy` button (JS-only, hidden without it),
  a `Show the QR code` `<details>` disclosure, and `Replace this link` (a form POST that
  rotates the token and kills the old link immediately).
- **`Message everyone` action** → the game-scoped broadcast compose page.
- **`Squad (N)` (h2):** one row per member — name, `organiser` / `organiser (you)` marker, an
  `Auto-declining` pill for a member currently muted (M28), and a `Manage` `<details>`
  disclosure containing `View details`, a role button (`Make an organiser` /
  `Make an ordinary member`), and `Remove`. The pill is on this page and nowhere else: it is
  the answer to "why is this person out every single week?", and chasing them is the wrong
  response. It disappears the moment the mute expires.
- **Reachability markers (M33):** small icons after a member's name, each with a clipped text
  label a screen reader reads: **app not installed**, **no push notifications** (both muted
  grey — the ordinary state of a squad that answers by email, not a fault), **messages are
  failing** and **not seen for 14 days** (both amber — the two an organiser can act on). Shown
  only when true, never as four slots with three empty: a marker on every row is a marker
  nobody reads. A **guest carries none of them** — a guest has no address, cannot sign in and
  cannot install, so all four would be permanently true and mean nothing.
  "Seen" is the later of opening the app and answering something *in this game*, so a player
  who never signs in but replies to every fixture reads as active. "Installed" comes from a
  ping every signed-in page sends (§5); an **uninstall is never observed**, so the marker
  reports an absence of evidence rather than a removal.
- **`Coming up` (h2):** upcoming fixtures, each date a link to its own fixture page.
- **`Past fixtures` link (M27):** between `Coming up` and `Squad`, to this game's
  past-fixtures list (§2.7).
- **Footer:** `Back to your games`.
- **Freshness bar (M24):** the page's last line — `Updated 3 minutes ago` on the left, a `Refresh` link on the right. See §5 for what it does.
- **Logic:** A game always keeps at least one organiser; the last one cannot demote themselves.

#### Standings, archived state and the invite card (M41, M49)
- **`Standings` (h2, M49) — the squad's league table.** One row per player in the squad, with
  `P`/`W`/`L`/`D`/`GD`/`Win%`/`Pts` as `<abbr>`s, three points for a win and one for a draw.
  The viewer's own row is **marked, never moved** — "a league table whose fourth place is
  printed at the top is no longer a league table". The player column is capped with an
  ellipsis and carries a `title`, because uncapped one long name pushed `Pts` — the number the
  table exists to report — off the right of a 390px screen behind a scroll nobody would think
  to try; the cap is inside a mobile-only media query. Goal difference is written with a real
  minus sign (U+2212), since at this size a hyphen beside a digit is close to invisible and
  "5" for "−5" is a two-place error. A caption states the scoring and warns that GD counts
  only games with an agreed score, so it covers fewer games than the rest of the row.
  **Rendered not at all — no heading, no empty table — when the viewer may not see it or there
  is nothing to show.** `standingsForViewer` decides; a heading over an empty table reads as a
  broken page, and a heading over a table the viewer is not entitled to would advertise that
  something is being kept from them. Both the player and organiser renderings call the one
  shared function, so the two roles cannot rank one squad two different ways.
- **Archived banner (M41):** an archived game says so once, at the top, with the date and an
  unarchive form. While archived the edit link, the whole invite card and the `Message
  everyone` button are gone from the page rather than disabled — "No fixtures will be
  scheduled, the invite link is off and nothing here can be changed."
- **Invite card:** `Invite people` (h2), "Share this link in your group chat, or let people
  scan the code", a readonly input holding the URL, a `Copy` button revealed only by script, a
  `Show the QR code` `<details>`, and a `Replace this link` form. `Message everyone` sits
  *outside* that form on purpose — nested inside it, it read as one of the rotate control's
  buttons.

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
- **Freshness bar (M24):** the page's last line — `Updated 3 minutes ago` on the left, a `Refresh` link on the right. See §5 for what it does.
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
- **`Post to WhatsApp` card (M22)** — "Opens WhatsApp with this ready to send — pick the group
  chat and add your own words." One read-only textarea per prepared message, each with
  `Open in WhatsApp` (a plain `wa.me/?text=` link, secondary button, new tab) and a `Copy`
  button (script-only; hidden without JS). Messages by state: open → **Numbers** ("⚽ <game> —
  <date/time> at <venue> / N in so far — M more needed. | N in, M spots left. | N in — full,
  but you can join the waitlist. / In or out? Say so on Make The Team: <game page URL>");
  teams published → **Teams** first ("Teams: / <side>: names"), Numbers second; cancelled →
  "<game> on <date/time> is cancelled." + reason. No card for a scheduled or played fixture.
  Never a per-player link — the game page, which squad members sign in to. The N-11 push
  ("Post it to the group?") deep-links to `#whatsapp` here.
- **`Message players` action** → the fixture-scoped broadcast compose page.
- **`Result` (h2, M25) — the result panel, once the fixture is `played`:** identical to the
  player fixture page's own panel (§2.6), shared through one renderer so the organiser and every
  player read the same tally. Rendered **above `Squad` and the team picker** (M27), matching
  the player's page and for the same reason — writable with each candidate and its backers, locked with the
  outcome and its two confidence figures, or (nothing filed, deadline passed) still writable.
  Absent entirely for an `open`, `scheduled` or `cancelled` fixture — there is nothing yet to
  have a result about.
- **Footer:** `Back to the game`.

#### Owner controls added in M43/M46 (a section of 3.5)
- **`Open it now`** on a fixture still `scheduled`: "This fixture opens for answers on its own
  nearer the day", plus a consequence sentence that differs by game — an ungated game emails
  nobody yet, a gated one invites the first group straight away. Promising one wording on both
  would be a lie on half the fixtures this page renders.
- **`Invite now`** beside a member the priority order has not reached yet (gated games only,
  never a guest, only where `invitedAt` is null) — the owner asking one player out of turn.
- **`Promote`** in place of `In` on a waitlisted member's segmented control, so the jump is a
  labelled act rather than a re-answer, and it is recorded on the timeline as one.
- **M43:** a player who was never invited may still say yes; they land on the waitlist rather
  than being turned away. **M43a:** a promoted player is never asked again whether they can
  play — they already said yes.

### 3.6 Team picker (a section of 3.5)
- Two side columns headed with the team names (default `Team A` / `Team B`), each with a count.
- Below, one `<fieldset>` per player who is **In** (waitlisted players are excluded on purpose;
  guests are included), with radios: `Not picked yet` | Team A | Team B.
- **Drag-and-drop** into a column is a progressive enhancement that ticks the same radio.
- **`Randomise teams`** (script only; hidden without JavaScript): shuffles everyone onto the two
  sides, differing by at most one, through the same radios. Nothing is saved until `Save teams`.
- **Actions:** `Randomise teams` (with script); `Save teams`; `Publish teams` (appears once a pick is saved), which becomes
  `Publish again` permanently after the first publish.
- **Copy:** "Only players who are in can be given a side. Nobody is told anything until you
  publish."
- **Refusals / notes:** "Everyone who's in needs a side before you can publish. Still to pick:
  Freya Lindqvist."; "The sides are uneven at the moment. That's fine if you meant it." (a note,
  not a refusal); "The teams have changed since they were last sent out. Send them again?"
- **Logic:** Saving updates every player's page immediately; publishing is what sends email.
  Nobody is reshuffled automatically when someone drops out. After the fixture is played or
  cancelled the pick stays as a record and the controls disappear.

### 3.6a Who picks the teams? (a section of 3.5, M29)
The organiser can hand one fixture's team pick to somebody else. Per fixture, never per game:
"Ali is picking on Thursday because I'm away" is the request, and a game-level setting would
keep handing Thursday's job to Ali for the rest of the season.
- **Three choices**, as radios: `Just me` (the default, and how every fixture behaved before
  M29) | `One of the squad` with a `Hand it to` select | `Anyone in the squad`.
- The select offers active members only, minus guests (who have no way to sign in) and minus the
  organiser themselves (whose `Just me` is already the first radio).
- **Copy:** "Handed over on Saturday 22 August." when somebody holds it; "There is nobody else in
  the squad to hand this to yet." on a squad of one.
- **Refusals:** "Pick somebody who is currently in the squad and can sign in." — the squad is
  re-read on submit, so a name that left while the page was open is refused rather than saved.
- **Notification:** handing the pick to a named player sends N-13 to that player alone, gated by
  the game's `Tell a player when I hand them the team pick` switch (§3.1). **Opening the pick to
  everyone sends nothing** — a message to a whole squad asking somebody, anybody, to pick the
  teams is one no individual owns, and it doubles the mail a squad gets per fixture.
- The section disappears once the fixture stops taking changes: there is nothing to hand over on
  a game that has been played or called off.

### 3.6b Team picker as a page — `GET /g/:id/f/:fixtureId/teams` (M29)
The same picker as §3.6, on a page of its own, for whoever the organiser handed it to. The
organiser reaches it too, though their own copy stays inline on §3.5.
- Game name (h1); one line saying why this page is in front of this person; kickoff; venue;
  status line; the picker; `Back to the fixture`.
- **Copy:** "The organiser has asked you to pick the teams for this fixture." (named delegate) or
  "The organiser has left the teams for anyone in the squad to pick, so this one is going spare."
- **Nothing else is on it.** Not the squad controls, not the guest form, not the WhatsApp cards,
  not the broadcast link, not the result panel — every one of those is an owner's act. The page
  renders what a picker may do rather than hiding what they may not, so no forgotten control can
  become a capability.
- **Publishing:** a named delegate publishes exactly as the organiser does, as often as they
  like. In `Anyone in the squad` mode the **first** announcement is anybody's and every later one
  is the organiser's; saving stays open either way, so a member who spots a wrong side can still
  fix it. Copy after that point: "These teams have been sent out. A change you save here shows on
  everyone's page straight away, but only the organiser can send the squad a fresh message about
  it."
- **Entitlement** is re-read on every request from the picker's live membership, so a delegate
  who leaves or is removed simply stops passing — 404, never 403.

### 3.7 Message the squad (broadcast) — `GET/POST /g/:id/message` and `/g/:id/f/:fixtureId/message`
One renderer, two scopes.
- **Heading:** `Message everyone in <game>` (game scope) or `Message the squad for <game> on
  <date/time>` (fixture scope).
- **Audience — fixture scope only** — `Who gets this message?` (fieldset of radios, each with
  a live count): `Playing (N)`, `On the waitlist (N)`, `Not answered yet (N)`, `Can't play (N)`.
  **Since M52 the page opens on the largest audience there is somebody in**, not always
  `Playing`: the moment an organiser opens this page is the moment nobody has replied and
  kickoff is close, so the old constant preselected the one empty audience and rendered the
  primary button as `Nobody to send to` — the page opened by saying the task was impossible.
  Ties break in render order, so `Playing` still wins when level. An audience with nobody in it
  is dimmed and `disabled`, never the checked one (a disabled checked radio is a form whose
  value cannot be submitted). With every audience empty, one sentence above the choices says so
  before the organiser writes anything.
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
- **`Post to WhatsApp too` panel (M22):** below the form, script-only (hidden without JS,
  because the body is never stored and so nothing can be offered after Send) — an
  `Open in WhatsApp` link kept filled with the subject and message as typed ("before or after
  you send it").
- **Logic:** Apart from that panel the page runs no script, so unticking a channel does not
  update the button count until the server answers.

---

### 3.7a Add a guest — `GET /g/:id/f/:fixtureId/guest/add` (M52), `POST .../guest`
Its own page since M52, reached from a link beside the squad on §3.5. It was a form at the foot
of the organiser's fixture page — which the M52 capture measured at **3954px at 390px** once a
busy fixture was finally photographed — so every organiser who never adds a guest scrolled past
it to reach the footer actions, and the one who does was hunting for it at the bottom of the
longest page in the product, usually pitchside.
- **Contents:** `Add a guest` (h1); the game and kickoff; "playing just this once… they keep no
  place in the squad afterwards"; and the places left, or the over-limit warning when the fixture
  is full — stated *before* the name is typed, because going over the limit is allowed (BR-8)
  rather than refused, so the page says what will happen instead of standing in the way.
- **Actions:** `Add guest` (primary), and one text back-link to the fixture.

### 3.8 Invite order — `GET/POST /g/:id/invites` (M34, BR-38; acted on immediately since M44)
The owner's editor for *who gets asked when*, used only when `Ask in priority order` is on.
- **Two controls, not one list.** "Who is asked when the game opens" and "in what order does
  everybody else follow" are different questions; a single drag-everything list would make the
  core group look like just another row, when it is the only rung most owners will ever set.
- **Entirely scriptless** — assignment is a `<select>` per member, ordering a number per tier.
  Drag-and-drop would need a scripted fallback for this same page anyway, and the page is
  edited rarely and read never.
- **The implicit final tier** ("everyone else", BR-38) is rendered last, dimmed, with its
  members *named* and no remove control. Naming them is the point: an owner who cannot see who
  is in "everyone else" cannot tell whether a new joiner landed somewhere sensible.
- **M44:** saving the order acts on it immediately rather than at the next fixture.
- **The no-groups state (fixed M52).** `tiers` is never empty — the implicit final tier always
  exists — so with no explicit groups `tiers[0]` *is* that tier, and the page headed it "Core
  group — asked when the game opens" while every select under it correctly read "Everyone else":
  a heading asserting a membership its own controls denied. The reassurance line beneath was
  gated on `rest.length === 1`, false when `rest` is empty, so the second card rendered as a
  heading over nothing. Every game starts in that state, so it was the first thing an organiser
  ever saw here. The heading now reads "Everyone — asked together when the game opens".
- **One text back-link (M52)**, which the page had never had.

### 3.8a Replace the invite link — `GET/POST /g/:id/invite/rotate` (M52)
Reached from a `danger-link` inside the invite card, which until M52 was a full-width button
that rotated the token on one press — the one destructive action in the product with no
confirmation of its own, on a link already pasted in a group chat.
- **It cannot count the damage, and says so rather than inventing a number.** Nobody knows how
  many people hold an invite link; it has been forwarded, screenshotted and pinned where the app
  cannot see. A confident figure would describe only the people who already joined — precisely
  the group rotation does *not* affect.
- **Contents:** `Replace the invite link for <game>?` (h1); the link stops working immediately
  and cannot be brought back; who is affected (anyone holding it, named by where they hold it);
  and the one number it does know — the N already in the squad, who are not affected.
- **Actions:** `Replace the link` (danger, content-width) and `No, keep the link I have`
  (full-width) — the safe path is the bigger target, as on §3.9 and §3.4.

### 3.9 Archive a game — `GET/POST /g/:id/archive` (M41)
Reached from a `danger-link` at the foot of the edit form, not from the game page.
- A served page and a real form post, like removing a member — **not a `confirm()` dialog**,
  because the consequence is counted and a dialog cannot state it.
- **Contents:** `Archive <game>?` (h1); "No more fixtures will be scheduled, the invite link
  stops working, and nothing about the game can be changed. Everyone in the squad can still
  see its history."; then a consequence line that counts the actual damage in one of three
  wordings — no upcoming fixtures ("so nobody needs telling"), fixtures but nobody in ("nobody
  is emailed"), or "N upcoming fixtures will be called off, and M players who said they're in
  or are waiting will be emailed". "You can unarchive it later from the game page."
- **Actions:** `Archive <game>` (danger) and `No, keep it going` (a `keep-link`).

### 3.10 What has happened — `GET /g/:id/f/:fixtureId/timeline` (M46, narrowed M47)
One fixture's history, for its organiser, reached from a `What has happened` button beside
`Message players` on the fixture page. Newest first.
- **It reports what happened, not every write that happened (M47).** The vocabulary is a fixed
  set of plain-English titles — `Opened for answers`, `Next group invited`, `Invited on their
  own`, `Guest added`, `Guest removed`, `Teams saved`, `Teams announced`, `Who picks the teams
  changed`, `Called off`, `An email could not be sent`.
- **Attribution is exact, and that exactness is the feature.** An entry with no actor reads
  `Automatically` — the sweep opening a fixture and an organiser opening it early are
  otherwise the same row, and that difference is the reason the page exists. A subject with no
  actor is prefixed `to`, because without it a send read "Ed · by email", a sentence about Ed
  having sent something when Ed is who it went to.
- **The "since" note is not a trimmable disclaimer.** The page is assembled from `audit_log`
  and `notification_log`, which started recording these events when the feature shipped; no
  backfill is possible because the facts were never stored. An organiser reading an empty week
  and concluding nothing happened would be wrong in exactly the way this page exists to
  prevent.

## 4. Admin

A signed-in player whose `is_admin` flag is set. The flag only draws the header link; every
admin handler re-checks it per request, and a non-admin gets a 404, not a 403.

### 4.1 Admin index — `GET /app/admin`
- `Admin` (h1); a plain list of four tool links, each with a one-line note underneath
  ("Who can create an account without an invite, and whether the list is in effect at all." / "Check whether an address can sign in,
  and see recent refused attempts." / "Today's send count against the daily ceiling, and
  recent notification outcomes." / "How many teams, how much activity, and how close anything
  is to a limit.").
- Deliberately a menu rather than a dashboard of live numbers — each tool page carries its
  own data, so this page has nothing to go stale.

### 4.2 Sign-up allow list — `GET /app/admin/allowlist` + add/remove/mode POSTs
- `Who can sign up` card at the top (M30): the current state in a sentence ("Allow list
  only." / "Open to everyone.") and one button that sets the *other* state. Opening sign
  ups is styled as the consequential press, not closing them again. Off by default, and off
  is what an unrecognised stored value reads as — the wrong-way failure here would open a
  trial-only site to the internet silently.
- While sign ups are open the list stays on screen but says so: it is kept for when sign ups
  are restricted again, and changes nothing meanwhile.
- Opens by scoping itself: the list only lets someone in *ahead of* their first invite;
  anyone already invited to a squad can sign in regardless.
- One list, two provenances: entries from a server-config secret are labelled "from server
  config" and have no remove button (the screen cannot write a Cloudflare secret, and hiding
  them would leave the list disagreeing with who can actually sign in); table entries each
  carry `Remove`.
- Empty state: "Nobody is on the allow list." — plus "Only invited players can sign in."
  when the list is actually in effect.
- Add form: email field + `Add`; invalid input re-renders at 422 with an inline error.

### 4.3 Sign-in doctor — `GET /app/admin/sign-in` (+ check POST)
- A check form: enter an address, get a verdict ("Can sign in." / "Cannot sign in — every
  door is closed.") plus a per-door breakdown: open sign ups, server config allow list,
  sign-up allow list, invited player with an active squad place.
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

### 4.5 Usage — `GET /app/admin/usage` (M32)

Five stacked sections, every number counted live at request time — no rollup table, nothing
cached, nothing for a write path to keep up to date.

- **Scale now**: a grid of figures — games, active squad places, people (split into signed-in,
  guests and erased), push devices.
- **Activity**: a table of six measures against two columns, `7 days` and `28 days` — games
  created, fixtures created / opened / cancelled, answers given, sign-ins. "Answers given"
  counts `responses.responded_at`, not row creation: materialisation writes a row per squad
  member, so counting rows would report squad size as engagement.
- **Did it work**: over fixtures whose *kickoff* fell in the last 28 days — how many reached
  min players, got teams published, got a result filed, each with a share. A cancelled fixture
  counts in the total but in none of the three, even if it had filled before being called off.
  On a deployment where nothing kicked off, the sentence is replaced rather than dividing by
  zero.
- **Limits**: emails sent today against the ceiling, failed sends over 7 days, and a row count
  per growing table. Row counts and not a byte estimate — nothing available to a Worker
  converts one to the other, so there is no honest figure to show against D1's 5 GB ceiling.
  A warning banner appears **only** when at least one fixture reached kickoff having never
  been opened, which means the hourly sweep has stopped.
- **Per game**: name with its active owners underneath, squad size, fixtures in the window,
  share answered, last activity —
  most recently active first, capped at 25. "Last activity" is the newest answer over the
  game's whole history (not the window), so a dormant game sorts below a live one; it is
  dated to the day, since a full timestamp made the five-column table unreadable on a phone.
  The owners go under the name rather than in a sixth column, for the same width reason; a
  game whose owners have all left the squad reads "Nobody", and an erased owner reads as the
  §4 placeholder.

No chart, deliberately: three numbers in a row answer "is this going up" as well as a
sparkline, and a chart needs either a script this page does not have or an inline `style`
attribute the CSP strips.

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
- **Auto-decline means total silence for that squad, and `Accept` is never taken away** (M28).
  The two halves are deliberate and pull in opposite directions: a muted player gets nothing at
  all — not even a cancellation, which they no longer need, having been recorded `out` before
  it — yet every page still offers them a way in, and taking one game does not end the mute.
  Its cost is that an organiser writing to the whole squad by hand quietly misses them, which
  is exactly what the `Auto-declining` pill on the organiser's squad list (§3.2) exists to make
  visible. "All my games" is a snapshot of the squads held at that moment, never a standing
  preference: a squad joined next month starts unmuted, because joining is itself the act of
  saying "ask me about this one".
- **Guests exist for one fixture only.** No invite link, no email, no membership — the
  organiser has to tell them the details personally.
- **Capacity can be exceeded deliberately,** and the app then labels the fixture as over
  capacity for everybody rather than hiding it.
- **Almost every destructive action has its own confirmation page** with the consequence
  spelled out in prose (remove member, leave, delete account, cancel fixture) — except
  removing a guest, which is immediate.
- **Broadcasts get a receipt but no delivery report** — the organiser sees "Sent to N
  players…" (recipients at send time); push failures are still invisible to them.
- **Six pages carry a freshness bar (M24, M25)** — the dashboard, both game renderings, and all
  three fixture pages (`/r/:token`, the organiser's, and the player's, §2.6, added by M25): the
  ones whose facts move while they are on screen, and a page whose content is a live tally of
  claims is the strongest case for it yet. It reads
  `Updated 3 minutes ago`, counting client-side from page load, beside a `Refresh` link that
  is an ordinary GET of the page's own path (so it works with scripting off, and it is the
  whole of the feature for anyone without script). With script, coming back to a page left
  more than a minute ago re-fetches it silently — an installed app resumed after twenty
  minutes otherwise re-shows the document it already had, which is what made people navigate
  away and back to see today's answers. Touching any form on the page retires that reload for
  good, so an unsaved team pick is never destroyed. **Not the same thing as the update overlay
  below**, which is about a new deploy rather than stale data; the two are deliberately
  separate, one answering "this page is old" and the other "this app is old".
- **Every signed-in page reports the player as seen (M33).** A tiny script posts once per
  browser tab to `/app/presence`, saying whether the page is running as an installed app; the
  server writes at most once an hour per player. It is what the organiser's reachability
  markers (§3.2) read for "installed" and for half of "seen". It never runs on a public or
  token-link page — there is no session there to report — and an anonymous post is answered
  204 and recorded nowhere. **Nothing observes an uninstall**, so "installed" only ever
  becomes true, and the marker for its absence says "we have never seen them in the app"
  rather than "they removed it".
- **In the installed app only, a new deploy raises a bottom overlay** — "A new version is
  available." plus a `Refresh` button — because an installed PWA can sit open for days with no
  reload control of its own; a browser tab gets fresh pages on every navigation and never
  sees it.
- **The palette (M20):** warm cream ground, terracotta accent, Caprasimo display headings,
  Figtree body; green is reserved for success/confirmed, amber for the waitlist, red for
  irreversible actions. A WCAG contrast guard test pins every declared token pairing in both
  light and dark themes, and since M52 `test/views/status-palette.test.ts` enumerates every
  status badge with the palette family it may draw on — the rule had no guard until then, and
  `Needs more players` shipped in the success green, byte-identical to the healthy `open`
  badge, on four pages.
- **Pages with a header start at the top (M52).** `body` is a centring grid, and with a header
  its rows are `auto 1fr` — so until M52 a short page centred its content in the leftover row
  and left the header stranded above it. Roughly 250px of empty ground above the heading at
  390x844, on several pages at once. Horizontal centring is unchanged.
- **A text input carries a resting border (M52).** A select keeps the browser's own border and
  chevron whatever the stylesheet says, so a borderless input beside one reads as the disabled
  half of a pair — worst on the account page, where the editable name field sat directly above
  the read-only email printed as plain text.
- **An empty capacity track is a groove, not a bar (M52).** At `0 of 14 in` the fill has no
  width, so a track painted in the section-rule grey was the only mark on screen and read as
  full.
- **The viewer's own row in a table is marked where it falls, never moved.** A league table
  that reprints your row above the people above you is not a league table. That makes the
  *strength* of the mark the whole feature: until M52 the mark was bold text alone, because the
  rule meant to tint the row set the sticky cell's background to the value it already had. It
  is now a tinted row, restated on the sticky player cell so a scrolled row shows no seam.
