# Installable app and push notifications — design

**Date:** 17 August 2026
**Status:** approved
**Milestones:** M13 (the installable shell) and M14 (web push). Two rows in the
master spec's build order (§2.14), not one — see §2.

## 1. What this is

Make The Team becomes an app you can keep on a phone's home screen, and a
player who wants it can be told about a fixture on that phone instead of only
in their inbox.

Two milestones, in order:

- **M13 — the installable shell.** A web app manifest, a home-screen icon, a
  service worker, an offline page, the Content-Security-Policy directives all
  of that needs, and the affordance that offers installation. No notifications
  anywhere in it. Shipped alone it is already useful: the product stops being
  a bookmark.
- **M14 — web push.** A VAPID keypair, a table of device subscriptions, an
  RFC 8291 payload encryptor, a `PushNotifier` beside `ResendNotifier`,
  per-notification push copy, the permission flow, and the privacy disclosure
  that comes with it.

Push is **additional to email, never instead of it**. A player who enables it
gets both, for every notification. Nothing about a player's email delivery
changes when they turn push on, and nothing about it changes when their phone
is lost, wiped, or has been in a drawer for a month.

## 2. Why two milestones and not one

Because iOS makes it a dependency, and because the two carry different risks.

Safari exposes web push **only to a web app installed on the Home Screen**.
Before installation, `Notification.requestPermission` is not merely refused —
on iPhone the API is not there to call. So on the platform half your players
are holding, M13 is not a nice preliminary to M14; it is the precondition.

They also fail differently. M13's risk is the Content-Security-Policy: three
directives that currently deny by default have to be opened, on a header that
governs every page the Worker serves, in a codebase where exactly this class
of mistake has already reached production once (§7). M14's risk is
cryptography that fails silently and remotely. A whole-branch review can hold
one of those at a time properly. It cannot hold both.

## 3. What already exists

More than you would expect, because the notification layer was built for this.

`src/notify/notifier.ts` says, in the module comment that has been there since
M2:

> `channel` stays on `Message` even though `"email"` is the only value that
> exists yet: a per-player channel preference already exists in the data model,
> and a later milestone adds a channel that isn't email. Nothing here may
> assume `channel === "email"`.

This is that milestone. Concretely, already in place:

- `Notifier`, the single interface every notification in the product goes
  through, with its one-`SendResult`-per-`Message`-in-order contract.
- `Message.channel`, and `players.notification_channel`, and
  `notification_log.channel` — all three typed `["email"]`, all three waiting
  to be widened.
- `QuotaNotifier`, the daily send ceiling, wrapped in `createNotifier` so no
  caller can bypass it.
- `insertQueuedLogRows` in `src/notify/delivery.ts`, the insert-before-send
  idempotency machinery, and `dedupe-key.ts`, the catalogue of nine
  notification types and their keys.
- `SITE_ORIGIN`, the one place absolute links are built from.
- Better Auth with passkeys, so a signed-in player exists; and response tokens,
  so a player who has never signed in is still identified by the link they
  arrived on.
- A strict `default-src 'none'` CSP that hashes its own inline styles and
  scripts, in `src/security/csp.ts`.
- A route catalogue enforced by the test suite, and a guide screenshot set.
  Both will flag new routes as gaps; both are updated as part of the work, not
  after it.

What does **not** exist: any static asset whatsoever. No favicon, no `assets`
binding in `wrangler.jsonc`, no `public/` directory. Every byte this Worker has
ever served came out of a Hono route.

## 4. Who can turn push on

**Anyone who can prove they are a player** — which in this product means two
different things, and both count:

1. A **signed-in** player, on `/app/account`.
2. A player holding a **valid response token**, on the fixture page that token
   opens. This is the majority: most players never sign in, they follow the
   link in the email.

The second is a deliberate widening and it should be recorded as such. A
response token already authorises setting that player's availability — the
thing the product exists to do. Treating it as sufficient to register a device
is consistent with that, and refusing it would confine push to the small
minority who have signed in, which is most of the reason not to build it at
all.

The cost, stated plainly: **response tokens get forwarded.** A player who
forwards their email to a friend has handed that friend the ability to register
their own phone against the original player's notifications. The existing
exposure is that the friend can set the player's availability; this adds that
the friend can receive their fixture notices. That is a real widening of a real
risk, accepted here because the alternative is a feature nobody uses, and
because the notifications in question say what time football is.

Two consequences follow and are not optional:

- `/app/account` lists every registered device with a way to remove it, so a
  player can see and revoke a subscription they did not make.
- Guests never get push. A guest has no email, so no token link ever reaches
  them, so no path to subscribe exists. This is not enforced by a check; it
  falls out of there being no way in.

## 5. The icon

One mark, used at every size, described here so it can be rebuilt from the spec
alone.

Five dots arranged along a checkmark: four filled, the fifth an outline — a
five-a-side squad with one spot left, which is the number the whole product
exists to move. Large, it reads as a group of people; small, the gaps close and
it resolves into a plain tick. Cream `#fbfaf8` on accent green `#1f6f4a`, full
bleed, the two colours already in `STYLES`.

Geometry, on a 512 canvas: the vertex is a dot, and the others are spaced
outward from it — one before, three after, equal gaps of 86.5 units. Anchoring
on the vertex is the whole trick. Spacing by arc length along the path instead
puts **no dot on the corner**, which leaves the turn described by a gap and the
elbow visibly slipped down and left; that version was drawn, looked wrong, and
was rejected. Short arm 45° down, long arm 55° up — the asymmetry is what
separates a tick from a V. Filled dots at r36; the hollow one at r30 with an
11-unit stroke at 0.8 opacity. The vertex dot is nudged 7 units further into
the corner along the outer bisector, because at a turn the eye follows the
outside of the bend and a dot centred on the true vertex reads as having fallen
inside it.

Centres: `(151,301)`, `(213,369)` — the vertex, nudged — `(262,291)`,
`(311,221)`, and the hollow one at `(361,150)`. Every dot sits inside the
maskable safe zone (the circle of radius 204.8 about the centre), because
Android launchers crop maskable icons to whatever shape they like.

The master is an SVG in `src/views/icon.ts`. `scripts/build-icons.mjs`
rasterises it to `icon-192.png`, `icon-512.png` and `apple-touch-icon-180.png`
and emits a TypeScript module of base64 bytes, which is **committed**. The
script shells out to a local rasteriser; CI never runs it, because its output
is in the repo. This is why no rasteriser joins a dependency list that
currently has six entries in it.

Serving PNG bytes from a TS module, rather than adding an `assets` binding to
`wrangler.jsonc`, is deliberate: an assets binding changes request routing for
every path in the application in order to serve three files of a few kilobytes
each.

## 6. New routes

| Route | Milestone | What it serves |
| --- | --- | --- |
| `GET /manifest.webmanifest` | M13 | Name, `display: "standalone"`, theme colour, icon list |
| `GET /sw.js` | M13 | The service worker |
| `GET /offline` | M13 | The one page that is cached |
| `GET /icon-192.png`, `/icon-512.png`, `/apple-touch-icon.png` | M13 | The mark |
| `POST /app/push/subscribe` | M14 | Register a device |
| `POST /app/push/unsubscribe` | M14 | Remove one |

All eight go in the route catalogue the test suite enforces.

## 7. The Content-Security-Policy

The most likely way M13 breaks something that currently works.

`src/security/csp.ts` sets `default-src 'none'` and then names every directive
it needs. Directives it does not name do not fall back to something permissive;
they fall back to `default-src`, which is `'none'`. Three have to be added, and
a fourth is listed only to record that it was checked and needs nothing:

- **`manifest-src 'self'`** — the manifest is fetched under its own directive.
  Without this the browser refuses it and the app is not installable, with no
  error on any page.
- **`worker-src 'self'`** — service workers fall back through `child-src` to
  `script-src`, which here is a list of SHA-256 hashes and nothing else.
  Registration fails.
- **`img-src 'self'`** — needed as soon as an icon is rendered in a page.
- **`connect-src 'self'`** — already present, and already covers
  `POST /app/push/subscribe`. No change.

The registration script is inline, so it joins `SCRIPT_BLOCKS` and is hashed by
the existing machinery — the same path the two passkey scripts took, and the
reason no new hashing code is needed. `/sw.js` is a separate document and
serves its own CSP header rather than inheriting a page's.

Each new directive gets the same treatment in that file's comment as every
existing one: what it allows, and why it does not fall back. That file already
records that omitting `connect-src` is what broke both passkey buttons in
production **while every server-side test passed**, because the browser refused
the request before it left the device and the Worker logged nothing. This
change is that same failure mode with four fresh chances to hit it, which is
why browser verification of installability is a task and not a checkbox.

## 8. The service worker

**M13.** Three handlers:

- `install` — caches `/offline` and its icon. Nothing else, ever.
- `activate` — deletes caches whose name does not match the current version.
- `fetch` — pass-through for everything, falling back to the cached `/offline`
  only when a **navigation** request throws.

Chrome requires a `fetch` handler to consider an app installable. It does not
require that handler to cache anything, and it will not get more than this.
Caching a fixture page would cache a squad list and a capacity count, and a
player who is shown a stale "you're in" is worse off than one who is shown
nothing. The product is server-rendered and stays that way; offline means
offline.

The cache name carries a version. That version is **derived from a hash of the
cached content**, not hand-maintained, for the same reason the CSP hashes its
own stylesheets rather than carrying pasted values: a constant somebody has to
remember to bump is a constant that eventually is not bumped, and the symptom
is an installed player pinned to an old offline page forever with nothing
locally to show it.

**M14** adds two more:

- `push` — parse the JSON payload, `showNotification` with its title, body,
  icon, tag and URL.
- `notificationclick` — focus an existing client already on that URL if there
  is one, otherwise open it.

## 9. Data model

### 9.1 `push_subscriptions`

| Column | Notes |
| --- | --- |
| `id` | text, primary key |
| `player_id` | → `players.id`, indexed |
| `endpoint` | text, **unique** |
| `p256dh` | the device's public key, base64url |
| `auth` | the shared auth secret, base64url |
| `user_agent` | nullable; only so a player can tell one device from another in a list |
| `created_at`, `last_success_at`, `last_failure_at` | timestamps |

`endpoint` is unique because a device that re-subscribes produces the same
endpoint. Registration is therefore an upsert, and a player who taps the button
twice ends up with one row rather than two — and, more importantly, does not
end up receiving every notification twice.

One player may have many rows. That is the point: phone and tablet.

### 9.2 Widenings

- `players.notification_channel`: `["email"]` → `["email","push"]`.
- `notification_log.channel`: same.
- `players.push_offered_at`, new and nullable, so the one-time contextual offer
  (§11) is asked once and never again.

### 9.3 Dedupe keys — do not do the obvious thing

`notification_log.dedupe_key` carries a UNIQUE index, and that index — not any
caller's key-building — is the product's entire guarantee against sending the
same notification twice.

With both channels firing for every notification, `n1:<fixture>:<player>` would
be claimed by whichever channel inserted first, and the other channel's row
would be silently dropped by `onConflictDoNothing`. The player would get one of
their two notifications, at random, forever.

The obvious fix is to put the channel in every key. **That fix is wrong here**,
and would cause an incident on deploy: it changes the key of every notification
already sent in production, so the next sweep would look for
`n1:email:<fixture>:<player>`, find nothing, and re-send an N-1 reminder to
every player who had already received one.

Instead: **email keys stay byte-for-byte as they are**, and push gets its own
namespace by prefix — `push:n1:<fixture>:<player>`, and so on for all nine
types. Nothing already in the table can collide with anything new, and no
existing key changes.

One log row per player per notification **per channel** — not per device. A
player with a phone and a tablet gets one `push` row; the fan-out happens
inside `PushNotifier` (§10.4).

`insertQueuedLogRows` currently hardcodes `channel: "email" as const` on every
row it writes. That is a concrete edit, not a widening that comes for free.

## 10. The send path

### 10.1 `Message` becomes a discriminated union

`to`, `dedupeKey` and `channel` stay shared. Email keeps `subject`, `html` and
`text`. Push gets `title`, `body`, `url` and `tag`.

Every existing caller already writes `channel: "email"`, so every existing
caller still compiles untouched. The gain is that the typechecker now forces
each `Notifier` implementation to say what it does with a push message, rather
than letting one quietly treat it as mail.

`to` means "the address for this channel": an email address for email, a
**player id** for push. `QuotaNotifier`'s existing guard — empty `to` means no
recipient — keeps working unchanged, and never sees a push message anyway
(§10.2).

### 10.2 Where the quota wrapper goes

Today `createNotifier` returns `QuotaNotifier(selectNotifier(env))`, with a
comment explaining that the wrap lives outside `selectNotifier` so that no
future branch can forget it.

The instinct is to teach `QuotaNotifier` to skip push messages. **Don't.** Put
the channel router on the outside and wrap the quota around the email leg only:

```
Router
 ├── email → QuotaNotifier(Resend | Console | Null)
 └── push  → PushNotifier(WebPush | Console | Null)
```

This leaves the project's most safety-critical class completely untouched: no
new branch inside it, no chance a later edit miscounts, and its
one-result-per-input-in-order property preserved trivially because it still
sees a dense array of email messages and nothing else. `createNotifier` keeps
its guarantee that no branch can forget the quota; it applies it one level in.

Push must not consume email quota. It costs nothing to send and the ceiling
exists to cap spend.

The cost lands on the router, which splits a mixed array in two, sends each
leg, and merges the results back onto their original indices. **This is the one
genuinely order-sensitive piece of new code in M14.** The sweep maps results
onto `notification_log` rows by index, so a merge bug attributes one player's
failure to a different player. It gets a property test over arbitrary mixed
sequences asserting same length, same order, each result belonging to its own
message — the same property `notifier.ts` already demands of everyone.

### 10.3 Bindings

- `PUSH_NOTIFIER` — `"webpush" | "console" | "null"`, joining `NOTIFIER`, and
  throwing on anything unrecognised exactly as `selectNotifier` already does. A
  typo must not quietly disable notifications.
- `VAPID_PUBLIC_KEY` — a var, not a secret. It ships to every browser; that is
  its job.
- `VAPID_SUBJECT` — a var, the `mailto:` the push services contact on abuse.
- `VAPID_PRIVATE_KEY` — a Worker secret, and given the same `requireBinding`
  treatment as `RESEND_API_KEY`. An unset secret arrives as `undefined` and
  would otherwise sign every JWT with it and fail opaquely at the push service.

Plus a **startup consistency check**: derive the public key from the private
key and compare it against `VAPID_PUBLIC_KEY`, throwing on mismatch. Rotating
one and forgetting the other produces a `403` on every send with no local
symptom at all. This is the same guard, for the same reason, as
`requireBinding`.

### 10.4 `PushNotifier`

One `Message` fans out to every subscription belonging to that player, and
reports success if **any** device accepted it. A player whose old tablet has
been wiped is not a failed notification.

Push service responses:

- `201`/`200` — success; stamp `last_success_at`.
- **`404` or `410` — the subscription is permanently dead; delete the row now.**
  This is the only self-healing in the system. Without it the table accumulates
  stale endpoints forever and every subsequent send burns subrequests on
  devices that no longer exist.
- `429`, `5xx` — failure, stamp `last_failure_at`, **do not delete**.
- Payloads are capped at 4KB by the spec, so the copy layer asserts the
  encrypted size fits rather than discovering it in production.

### 10.5 Copy

Push copy is written per notification type, in `src/notify/push-copy.ts`,
mirroring `src/notify/templates/`. It is **not** derived from email subjects.
An email subject is a line of prose; a push title has roughly forty characters
before Android truncates it. This repo already keeps three separate fixture
wording tables on purpose, and this is the same judgement.

The `url` in each payload is the same token link the matching email already
carries, built from `SITE_ORIGIN`.

## 11. Install and permission

`layout.ts`'s head gains `<link rel="manifest">` and
`<link rel="apple-touch-icon">`. iOS ignores the manifest's icon list entirely
and reads only the second of those.

One component, five states, chosen by **feature detection and never by
user-agent sniffing**:

1. **Installable, not installed** — a `beforeinstallprompt` event was captured
   (Android). A real button that fires the saved prompt.
2. **Not installed, no install event** — iOS. Static instructions: Share → Add
   to Home Screen. There is no API. This is the only route Apple offers, and
   pretending otherwise produces a button that does nothing.
3. **Installed** — `display-mode: standalone` matches. The notification
   permission button, which calls `Notification.requestPermission()` **from
   inside the click handler**, because both platforms require a user gesture.
4. **Granted** — subscribe with `applicationServerKey` set to the VAPID public
   key, and `POST` the result to `/app/push/subscribe`.
5. **Denied** — say so plainly and point at browser settings. A denied
   permission cannot be re-requested by the page, and a button that silently
   does nothing is worse than a sentence explaining why.

It appears in exactly two places:

- **Once, contextually**, on the response-confirmation page after a player says
  they are in — the moment they have just demonstrated they care about this
  fixture. Gated on `players.push_offered_at` being null, and stamped on
  display, so it is offered once in the product's lifetime and never again.
- **Permanently**, in a section on `/app/account`, which also lists registered
  devices with a way to remove each. This is the route back for a player who
  dismissed the offer, and the route to revoke a device they did not register
  (§4).

Every state is server-rendered, with the script only *enhancing* what is
already there — the rule `src/views/scripts.ts` already sets for the passkey
scripts: **the page must be completely usable when the script never runs.** A
player with no JavaScript sees the account page and their device list, minus
the button that would need an API that is not there.

## 12. Privacy and erasure

Two consequences, neither optional.

**`erasePlayer` deletes that player's subscriptions.** It currently anonymises
the `players` row and clears the Better Auth records. An orphaned endpoint that
still successfully wakes a real phone after that player asked to be erased is
the worst thing this feature can do. The delete goes in the same batch, and a
test asserts no row survives.

**`/privacy` discloses the third party.** A push subscription hands an endpoint
operated by Google, Apple or Mozilla the ability to wake that device, and the
existence of that endpoint is itself a persistent identifier for it. There is
an exact precedent to follow: the project already records — in `csp.ts`, on
`/privacy`, and in `docs/known-issues.md` — that Google Fonts discloses every
visitor's IP address, adopted over an objection that is written down rather
than dropped. Push gets the same three-place treatment, and deserves it more,
because this disclosure is per-player, persistent, and opted into rather than
imposed on every visitor.

## 13. The VAPID keypair is not like the other secrets

`RESPONSE_TOKEN_SECRET`, `CANCEL_TOKEN_SECRET` and `RESEND_API_KEY` are all
recoverable without anyone else's involvement: rotate at the provider, or
regenerate and let the next sweep issue fresh links.

**VAPID is not.** The public key is baked into every subscription by the
browser at the moment it is created. If the private key is lost:

- every existing subscription becomes permanently undeliverable — `403` from
  the push service, forever;
- there is nothing that can be done from this side, at any price;
- recovery is: generate a new pair, delete every `push_subscriptions` row, and
  wait for each player to individually opt in again, on their own phone, one at
  a time.

And `wrangler secret put` is **write-only** — a Cloudflare secret cannot be
read back. So the only copy of that private key that will ever exist is the one
kept at the moment it is generated.

Therefore:

- `scripts/generate-vapid-keys.mjs` prints the pair once, writes nothing to
  disk, and prints the custody warning with it.
- The private key goes into long-term secret storage **before**
  `wrangler secret put` is run.
- `docs/runbooks/cloudflare.md`, which currently documents three secrets as a
  set, gains a fourth entry stating plainly that this one is not regenerable
  without cost, and carrying the recovery procedure — so that whoever needs it
  is not inventing it during an incident.

## 14. The encryptor

`src/notify/web-push.ts`, one file, two RFCs, no dependencies. The standard
`web-push` npm package does not work on Workers — it needs Node's
`createECDH` and `createCipheriv`, which `nodejs_compat` does not cover — and
the Workers-targeted alternatives are young, low-traffic packages that would sit
on the path handling every player's subscription secrets, in a repo with six
runtime dependencies. Both primitives are native to Workers' Web Crypto.

- **RFC 8292 (VAPID).** An ES256 JWT — `aud` the origin of the endpoint, `exp`
  twelve hours out, `sub` the configured `mailto:` — signed with
  `crypto.subtle.sign("ECDSA", …)` over P-256, sent as
  `Authorization: vapid t=<jwt>, k=<public key>`.
- **RFC 8291 (payload).** An ephemeral P-256 keypair, ECDH against the
  subscription's `p256dh`, HKDF-SHA256 with the `auth` secret as salt and
  `"WebPush: info"‖ua_public‖as_public` as info, giving the content encryption
  key and nonce; AES-128-GCM; then `aes128gcm` framing carrying the salt and
  the server public key in its header block.

The `info` strings and the order of key derivation are precisely where this
goes wrong, and it goes wrong **silently and remotely** — a wrong byte produces
a valid-looking request and a rejection from someone else's server. So the
tests are the **RFC 8291 §5 worked example**: fixed salt, fixed keypairs, fixed
expected ciphertext. That requires `encrypt()` to accept the salt and ephemeral
keypair as optional injected parameters, defaulting to random, so a test can
pin them. The VAPID side is tested by verifying a generated JWT against its own
public key rather than by asserting on a hardcoded string, which would only
prove the implementation still agrees with itself.

## 15. Testing

**Unit.**

- RFC 8291 §5 vectors — the encryptor produces the published ciphertext.
- A generated VAPID JWT verifies against its public key; `exp` and `aud` are
  what they should be.
- Router: for arbitrary mixed sequences, results come back same length, same
  order, each belonging to its own message.
- `410` and `404` delete the subscription; `429` and `5xx` do not.
- Push consumes no email quota — a regression test, because this is the whole
  point of §10.2.
- Push and email rows for the same notification coexist, and neither displaces
  the other (§9.3).
- Erasure removes every subscription for that player.
- The startup check throws when public and private keys disagree.

**Browser.**

- The manifest and `sw.js` are served with the right content types.
- The service worker registers, with no CSP violation — the failure mode §7 is
  about.
- `/offline` renders when a navigation fails.
- The affordance renders correctly in each of the five states.
- New routes are in the route catalogue; new pages are in the guide screenshot
  set.

**Not covered, and said so rather than implied.** Real push delivery cannot be
asserted from Playwright without driving CDP. It stays a manual check against a
real Android handset and a real iPhone, written into
`docs/runbooks/browser-testing.md` as a step, not left as an assumption.

## 16. Out of scope, named

- **Notification preferences per type.** Push is all-or-nothing per player. A
  player who wants reminders but not team announcements can have that
  conversation when someone asks for it.
- **Push for organisers' N-4 attention warnings** is in scope like any other
  type; a *separate organiser notification console* is not.
- **Badging, notification actions, inline replies.** A notification opens the
  fixture page. That page already has the buttons.
- **Offline responding.** No queued mutation, no background sync. A response
  submitted with no signal fails, and says so.
- **An `assets` binding.** §5.
- **Replacing email.** §1. Not now, and not without evidence about how push
  actually delivers for this set of players on their real phones.
