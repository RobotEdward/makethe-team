# Browser testing

The Vitest suite runs inside workerd. It can return a CSP header but never
enforce one, so it cannot tell you whether a browser refused something. That
gap is not hypothetical here: both passkey buttons were broken in every
browser for days by a `connect-src` directive while all 1009 server tests
stayed green (`docs/known-issues.md`, the post-mortem). This suite closes it.

Design: `docs/superpowers/specs/2026-08-13-browser-testing-design.md`.

## Running it

```bash
npm run test:browser              # the whole suite
npm run test:browser -- --grep passkey
npm run test:browser:ui           # interactive
```

Playwright starts and stops `wrangler dev` itself. Nothing else needs to be
running — in fact **a dev server you started yourself is a hazard**, which is
why `reuseExistingServer` is off (see below).

The visual capture is excluded by default because it is slow and asserts
almost nothing:

```bash
CAPTURE=1 npx playwright test --grep @capture
```

Screenshots land in `test/browser/screenshots/` (gitignored) at 390px and
1280px. To look at them on a headless box, serve the directory and open it.

## The scope rule

**A browser test earns its place only if the Vitest suite structurally cannot
make the check.** Business logic — BR-3's removal pass, waitlist order,
capacity, tokens, redaction — stays in Vitest, where it is faster and more
precise. What belongs here: CSP violations, console errors, whether inline
script executed, JS-off degradation, WebAuthn, and layout.

If a test you are writing would pass identically in Vitest, write it there.

## The four things that will confuse you

Each of these cost real time, and each presents as something other than what
it is.

**1. `wrangler dev` rewrites the `Origin` header.** `wrangler.jsonc` declares
the custom domain `makethe.team`, and the dev server presents *that* host to
the Worker. Every state-changing handler compares `Origin` against
`BETTER_AUTH_URL` (`wrongOrigin`), so without `--local-upstream
localhost:8787` every form post is refused with a bare `403 Forbidden` — which
reads like an auth bug and is a configuration one. The port is required; bare
`localhost` is not enough.

**2. Bindings must not go in `.dev.vars`.** That file is read by the Vitest
workers pool too, and it *overrides* the bindings `vitest.config.ts` sets
explicitly. Putting `SIGNIN_ALLOWLIST` and `BETTER_AUTH_URL` there turns ~56
server tests red, because every signed-in test suddenly has a different
allowlist and origin from the ones it asserts against. They live in
`test/browser/browser.env` instead, passed with `--env-file`.

Nor `--var KEY:VALUE`, which splits on the colon and mangles any URL.

**3. The magic-link callback must be `/sign-in/complete`.** Session-to-Player
linking happens in that handler, not inside Better Auth's. A callback pointed
straight at the destination produces a valid session with **no Player**, and
every authenticated page then answers `403 We can't find your player`.

**4. A fixture must be *opened* before it accepts answers.** Materialisation
(`15 3 * * *`) creates fixtures; the hourly sweep (`0 * * * *`) opens them.
`seedWorld` runs both. With only the first, `/r/:token` renders its read-only
notice and a click on a button that isn't there hangs until the timeout.

## Adding a page

Add it to `CATALOGUE` in `test/browser/catalogue.ts`. That one list drives the
console gate, the visual capture, and later the product guide — so a new page
is CSP-checked automatically.

`catalogue.spec.ts` fails if a registered GET route is neither catalogued nor
listed in `NOT_CATALOGUED` with a stated reason. This replaced a hand-written
enumeration in `test/security/csp.test.ts` that had silently drifted to cover
no `/g/*` page at all — do not add an exclusion without saying why.

If the page answers a non-200 status by design, set `expectedStatus`:
Chromium logs the navigation's own non-2xx as a console error, and the gate
discounts that one message only for a page declared to answer it.

## Every detector must be proved to fire

A test whose job is to catch something must be demonstrated failing on a
deliberate fault. Two are pinned in the suite:

- `the CSP detector actually fires` injects a `<style>` no hash can cover.
- `the scan actually finds the routes it claims to` guards the route regex, so
  a router refactor cannot make the completeness check pass trivially.

When you add a detector, add its proof. A detector that cannot fail
manufactures confidence, which is worse than none — and it is the defect
J6a's review found twice.

## Local data

The local D1 accumulates a game per `seedWorld` call, and the materialisation
cron walks all of them, so runs get slower over time. To start clean:

```bash
rm -rf .wrangler/state/v3/d1
npx wrangler d1 migrations apply makethe-team --local
```

This destroys local development data only. It never touches production.

## The product guide

`docs/guide/` is a hand-written product guide — a README and seven chapters,
illustrated with 27 screenshots. Regenerate the screenshots with:

```bash
npm run guide:capture
```

This rebuilds the world, captures the 27 shots, optimises them and rewrites
`docs/guide/manifest.json`. **It writes images and the manifest and never a
`.md` file.** The chapters are hand-edited prose — that separation is the
whole reason the writing survives regeneration. Do not expect (or write)
tooling that generates chapter text.

Like the visual capture above, this needs a clean local database to be
reproducible:

```bash
rm -rf .wrangler/state/v3/d1
npx wrangler d1 migrations apply makethe-team --local
```

This destroys local development data only, never production.

Two kinds of churn are expected, and they have different causes.

**Every run, whatever the day**, two images change: `game-overview` and
`invite-qr`. Both show a freshly minted invite token — the QR code encodes it,
and the overview contains the code. `invite` does *not* change with it, despite
showing the same link: it is element-scoped to `.invite-link`, and the input is
visually truncated well before the token, so the rendered pixels are the same
whatever the token is. Measured by capturing twice in a row on one day: exactly
those two files differed.

**On a run made on a different day from the last one**, nine images change
instead of two, because they carry the fixture's date or its weekday:
`game-overview` (which changes anyway) plus `join`, `respond-pending`,
`respond-in`, `respond-waitlisted`, `respond-out`, `cancel`, `dashboard` and
`edit-game` (its **Day** field). The
weekday cannot be pinned — a fixture only opens once its reminder instant has
passed, so `guideSlot` has to derive the day from the clock — which is why the
chapters are written without naming a date or a weekday for the guide's own
game. If you change that prose, keep it that way.

Anything else changing is a signal: the page it captures has actually changed,
and its chapter probably needs a read before you commit.

Four checks in `test/browser/guide-references.spec.ts` run in the ordinary
browser suite and in CI: every chapter named in the shot list exists, every
image a chapter references exists on disk, every captured image is
referenced by some chapter, and the manifest matches the shot list. They
catch a broken image path or an orphaned picture. **They cannot catch a
chapter whose prose has quietly stopped describing the screen beside it** —
nothing can check that automatically.

**The standing obligation: when a page's behaviour changes, its chapter
changes in the same commit, and the capture is re-run.** Nothing enforces
this mechanically — it is a discipline, not a gate — so treat a page change
that touches something the guide shows as incomplete until the matching
chapter and screenshots are updated alongside it.

## CI

A separate `browser` job in `.github/workflows/pr.yml`, deliberately not extra
steps in `check`: a browser flake must be legible as a browser flake and must
never mask a lint, type or unit failure.

The repository is public on a standard runner, so Actions minutes are free and
unlimited. `~/.cache/ms-playwright` is cached against the resolved Playwright
version, and only the headless shell is installed.

**No secrets are needed.** Every binding is an obvious dummy in
`test/browser/browser.env`, committed on purpose, so the job runs identically
on a fork's pull request. The job applies migrations first: a runner's D1 is
empty, and `wrangler dev` will serve happily against a database with no
tables.

## What this suite cannot prove: the install itself (M13)

`test/browser/pwa.spec.ts` proves the service worker registers with no CSP
violation, that the manifest is fetched and parsed rather than refused, and
that a failed navigation under `context.setOffline(true)` falls back to
`/offline`. That is everything Playwright's Chromium-only, headless
environment can check. It cannot drive an actual install — there is no OS
chrome, no home screen, and no separate iOS engine to test against. Before a
production deploy that touches the manifest, the service worker or the icons,
check these by hand, on real hardware:

- **Android (Chrome).** The install prompt (or the browser menu's "Install
  app") appears; installing and opening it launches at `/app` with no address
  bar or browser chrome; the icon it adds to the home screen is the mark
  (`src/views/icon.ts`), not a screenshot of whatever page was open when the
  prompt fired.
- **iPhone (Safari).** Share → **Add to Home Screen** produces the mark as the
  icon. This is the *only* assertion that proves `apple-touch-icon` is wired
  correctly — iOS has no install API, reads no manifest for its icon, and
  Playwright cannot drive Safari's share sheet at all, so nothing short of
  doing this by hand exercises that code path. The installed app then opens
  without Safari's chrome.

Both checks matter for the same reason the rest of this document exists: each
failure mode is invisible from a server or a headless browser. A wrong or
missing `apple-touch-icon` link fails silently — iOS falls back to a
screenshot of the page, and nothing anywhere logs that it did.

## What this suite cannot prove: push delivery itself (M14)

`test/browser/push.spec.ts` proves three things, all in a real Chromium: the
account page's "Turn on notifications" affordance renders nothing at all
while no VAPID key is configured — the honest, currently-true state of this
project's own `wrangler dev` and of production tonight, not a hypothetical
one — so a broken deployment can never ship a button that could never have
worked; `POST /app/push/subscribe`, reached the way the real button reaches
it (a `fetch` issued from inside a loaded page, not a bare HTTP client),
rejects a malformed subscription with no CSP violation in the way; and the
account page's device list, together with its plain-`<form>` Remove control,
renders and actually removes a row with JavaScript switched off. `/app/account`
— the one page that always carries push UI, dark state or not — already runs
through `console-gate.spec.ts`'s CSP/console sweep as part of the catalogue,
so this file adds no duplicate of that check. (`/r/:token`'s GET, also
catalogued, is not push UI at all here: the one-time offer is rendered only
by the POST response handler, and only when a VAPID key exists — see
`resolvePushOffer` in `src/routes/respond.ts` — so in this environment, where
one never does, the catalogued GET never shows it. That gating is Vitest's to
prove, precisely, in `test/routes/respond-post.test.ts`.)

That is everything Playwright can prove, and it stops well short of "push
notifications work." **Nothing in this repository's test suite, browser or
Vitest, can assert that a real device receives a push, that a tap opens the
right fixture, or that removing a device on `/app/account` stops delivery to
it.** Chromium exposes no CDP domain for a synthetic `push` event delivered
through a real service-worker registration the way `WebAuthn.addVirtualAuthenticator`
exposes one for passkeys — the closest available substitute,
`self.dispatchEvent(new PushEvent(...))` run inside the worker via
`page.evaluate`, only proves the handler *runs*, which Task 11's
`test/routes/service-worker.test.ts` already does more precisely and without
a browser at all — it executes the served script text (`src/routes/pwa.ts`)
against a stubbed `self`. Real delivery — Cloudflare's edge, through Google's
or Apple's push service, onto a real lock screen — has no test double worth
writing, only a real phone.

**This is a documented manual gate, and it must block the production deploy
that turns push on** (`PUSH_NOTIFIER: "webpush"` in `wrangler.jsonc`), not an
assumption folded into "the suite is green." Run it once, after the VAPID
keypair exists and is deployed (`docs/runbooks/cloudflare.md`'s
`VAPID_PRIVATE_KEY` section — do that first; nothing below works against a
deployment still pinned to `PUSH_NOTIFIER: "null"`), and again after any
change that touches `src/notify/push-notifier.ts`, `src/notify/push-copy.ts`,
the push/notificationclick handling in `src/routes/pwa.ts` (served as
`/sw.js`), or the VAPID keys themselves.

**Android (Chrome).**

1. Install the app (see the M13 checklist above) and open it.
2. On `/app/account`, tap **Turn on notifications** and grant the OS
   permission prompt. The button disappears and the device appears in
   **Your devices** with a caption — confirms the subscribe round-trip
   succeeded, not merely that the browser accepted the permission.
3. From another signed-in identity (or as the game's organiser), trigger
   anything that sends this player a push — cancelling a fixture they are in,
   or promoting them off a waitlist are the two easiest to arrange on demand.
   A reminder email would also do it, but is slower to arrange than an
   organiser action taken right now.
4. **Confirm the notification arrives** — on the lock screen or in the
   notification shade, within a few seconds. If nothing arrives inside a
   couple of minutes, treat it as a failure rather than "still in flight":
   web push over FCM is not normally slow.
5. **Tap it, and confirm it opens the right fixture** — not the app's home
   screen, not a blank tab, the specific `/g/:id/f/:fixtureId` (or `/r/:token`)
   the event was about. This is `notificationclick`'s job in
   `src/routes/pwa.ts` (served as `/sw.js`), and it is the one behaviour Task
   11's stubbed-`self` test cannot watch a real browser actually perform.
6. Back on `/app/account`, tap **Remove** next to that device. The row
   disappears immediately (a real `<form>` `303` round-trip — confirmed
   automatically by `push.spec.ts` above).
7. Repeat step 3. **Confirm nothing arrives this time.** This is the step
   most likely to be skipped because step 6's row disappearing *looks* like
   proof enough — it proves the database row is gone, not that the push
   service has stopped trying to deliver to it. Only a second, deliberately
   provoked non-event proves that.

**iPhone (Safari).**

Repeat the same seven steps. iOS Safari's web push (16.4+) has its own
failure modes Android does not:

- The permission prompt only appears for an app already added to the home
  screen (Share → **Add to Home Screen**) and opened from there — granting
  notification permission from a Safari *tab* silently does nothing useful,
  and presents as step 2 above simply not offering the OS prompt at all.
- A notification tap on iOS can open the installed app fresh rather than
  resuming a backgrounded instance; step 5's "opens the right fixture" check
  still applies to wherever it lands, but do not read a fresh launch as a
  bug on its own.
- If the app was ever removed and reinstalled, or if notification permission
  was ever explicitly denied and iOS is asked again, iOS does not always
  re-offer the prompt through the same route — checking `Settings → [app
  name] → Notifications` directly is the reliable way to see or reset the
  current permission when step 2 seems stuck.

**What a failure at each step actually means**, so a failed run is
diagnosable rather than just "push doesn't work":

- **Step 2 never shows a device on `/app/account`.** The subscribe POST
  failed or was never sent — check `PUSH_NOTIFIER` is really `"webpush"` on
  the deployment under test (not `"null"`), and check the browser's own
  console for a CSP or network error `push.spec.ts`'s malformed-request test
  would have caught for a request shape, but not for a wrong or missing key.
- **Step 4 never arrives, but step 2 succeeded.** Either the push service
  refused the send (`last_failure_at` on the `push_subscriptions` row, per
  `src/notify/push-notifier.ts`'s doc comment, is the place to look first) or
  the event that was supposed to trigger it did not actually fire — confirm
  independently (an email for the same event, or the fixture's own state)
  that the event happened at all before concluding push itself is broken.
- **Step 5 opens the wrong place, or nothing.** `notificationclick` in
  `src/routes/pwa.ts` (served as `/sw.js`), or the `url` field on the
  `PushMessage` that produced it (`src/notify/push-copy.ts`) — not the
  subscribe path, which steps 2–4 having worked already rules out.
- **Step 7 still delivers.** The device row was removed from the wrong
  player, or a second row for the same physical device still exists (the
  upsert-on-`endpoint` behaviour `src/routes/push.ts` documents is what is
  supposed to prevent this) — check `push_subscriptions` for the player
  directly rather than trusting the account page's own list, which is
  reading the same table the bug would be in.
