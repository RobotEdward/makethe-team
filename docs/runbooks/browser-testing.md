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
illustrated with 17 screenshots. Regenerate the screenshots with:

```bash
npm run guide:capture
```

This rebuilds the world, captures the 17 shots, optimises them and rewrites
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
