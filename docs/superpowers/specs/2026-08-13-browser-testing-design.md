# Browser testing — design

**Date:** 13 August 2026
**Status:** approved (steps 1–4; the product guide is deferred to its own spec)

## 1. Why this exists

The project has 1009 tests running in real workerd against real bindings, and
they have never once observed a browser. The `connect-src` post-mortem in
`docs/known-issues.md` is the governing case: both passkey buttons — register
*and* sign-in — were broken in every browser from the moment M4's CSP met M5's
scripts, and stayed broken in production for days while the entire server suite
stayed green. That failure was not a gap in coverage. It was a gap in *kind*:

> "any requirement that lives in the browser — a CSP directive, a form's
> `enctype`, a cookie attribute, a redirect a browser follows differently from
> `app.fetch` — has no mechanism [to be caught]".

This spec builds that mechanism. It also closes the outstanding manual
walkthroughs recorded against M6a and J6a, which were deferred for the plain
reason that every agent working on them had a headless machine and no browser.

## 2. Scope

**In:** a Playwright harness, a shared page catalogue, a console/CSP gate over
every page, the critical journeys with and without JavaScript, passkey
ceremonies via a virtual authenticator, and a CI job.

**Out, deliberately:** the visual product guide (`docs/guide/`). It reuses this
spec's page catalogue but is a separate piece of work with its own product
judgement; it gets its own spec. Also out: visual regression / screenshot
diffing, cross-browser matrices, and performance testing. None have earned
their keep yet.

### 2.1 The scope rule

**A browser test earns its place only if the server suite structurally cannot
perform the check.** Business logic — BR-3's removal pass, BR-6/7's waitlist
order, capacity, token signing, surname redaction, 404-not-403 — stays in
Vitest, where it is faster and more precise. Duplicating it here buys nothing
and costs flakiness.

What only a browser can answer:

| Question | Why Vitest cannot |
| --- | --- |
| Did the CSP block anything? | `SELF.fetch` never enforces a policy; it only returns the header. |
| Did inline script execute? | Nothing evaluates the script body. |
| Does the page work with JS off? | There is no JS on in the first place. |
| Do the passkey ceremonies complete? | WebAuthn is a browser API. |
| Does the layout hold at phone width? | Nothing lays anything out. |
| Are cookies applied as a browser applies them? | The test client does not implement cookie policy. |

## 3. Local environment

Four bindings must be overridden for local dev, each of which fails **silently**
when unset, because the sign-in flow deliberately answers the same 200 on every
branch to avoid an enumeration oracle:

| Binding | Local value | Failure when unset |
| --- | --- | --- |
| `SIGNIN_ALLOWLIST` | the test addresses | fails closed (TR-35); no link is ever sent. **Needed for driving the app by hand, not by the harness** — see §3.2 |
| `NOTIFIER` | `console` | `wrangler.jsonc` says `resend`; `createNotifier` throws and `signin.ts` swallows it |
| `BETTER_AUTH_URL` | `http://localhost:8787` | links are minted against production and cannot be followed |
| `BETTER_AUTH_SECRET`, `CANCEL_TOKEN_SECRET` | any string | session signing and cancel tokens fail |

These live in `.dev.vars`, which is gitignored. `.dev.vars.example` must
document all of them, because a working local environment is now a prerequisite
for a whole class of test rather than a convenience.

### 3.1 Signing a browser in

`ConsoleNotifier` logs a message's recipient, subject and dedupe key but **not
its URL**, so the magic link never reaches the terminal. Changing that would
alter production behaviour — production runs on the console notifier — so the
harness instead reads the token from local D1:

```
POST /sign-in                       email=<allowlisted>
SELECT identifier FROM verification ORDER BY rowid DESC LIMIT 1
GET  /api/auth/magic-link/verify?token=<t>&callbackURL=/sign-in/complete
```

**The callback must be `/sign-in/complete` and nothing else.** Session-to-Player
linking happens in that handler (`src/routes/signin.ts`), not inside Better
Auth's, so a callback pointed straight at the destination yields a session with
no Player and every authenticated page answers `403 We can't find your player`.

Reading D1 goes through `wrangler d1 execute --local --json`, not a direct
SQLite open: Miniflare holds its own connection and a second writer is the
WAL-deadlock hazard `src/auth/factory.ts` documents. The harness only reads,
but it uses the supported path regardless.

### 3.2 What signing in this way does not prove

**Reading the token from storage bypasses TR-35's allowlist.** That gate
suppresses the *send*; Better Auth has already written the `verification` row
by the time `sendMagicLink` runs, refused or not — stated in
`src/auth/factory.ts` and confirmed here by execution, since a `POST /sign-in`
for an address absent from `SIGNIN_ALLOWLIST` still leaves a usable token
behind.

Two consequences, both worth stating plainly rather than discovering later:

1. A browser test signing in proves nothing about whether a real person could.
   The allowlist stays covered in `test/routes/signin.test.ts`, where it can be
   asserted precisely, and must not be re-tested here.
2. The harness would keep passing if `SIGNIN_ALLOWLIST` were misconfigured or
   empty. It is kept in `.dev.vars` for a human driving the app by hand, who
   does need an email to actually arrive.

This is not a vulnerability: the token is disclosed only by email, so a refused
address still cannot sign in from outside. It is a limit on what this harness
can be read as evidence for.

## 4. The page catalogue

One module, `test/browser/catalogue.ts`, is the single list of every page the
app renders. Each entry declares:

- `id` — stable slug, used in test names and (later) screenshot filenames
- `title` — human name
- `path` — a route, resolved against seeded state for parameterised routes
- `persona` — `anonymous`, `owner`, or `player`
- `setup` — what state must exist before the page is reachable

Three consumers iterate it: the console gate (§5), the visual capture (§7), and
— in its own later spec — the product guide generator. A page added to the
catalogue is automatically CSP-checked; a page not in it fails the completeness
assertion in §5.1.

Pages to cover: `/`, `/sign-in`, `/sign-in/complete`, `/app`, `/app/passkeys`,
`/g/new`, `/g/:id`, `/g/:id/edit`, `/g/:id/squad/:playerId/remove`, `/j/:token`,
`/r/:token`, `/leave/:token`, `/cancel/:token`, and the 404 page.

## 5. Tier 1 — the console gate

For every catalogue entry: load it, and fail on any console error, any
uncaught page error, or any `securitypolicyviolation` event.

The CSP listener is registered via `addInitScript` so it is installed before
any document script runs — a listener added after load misses violations from
the page's own inline blocks, which is precisely the case that matters.

**The detector must be proved to fire.** A test injects a `<style>` element the
policy cannot cover and asserts the violation is observed. A silent detector is
worse than none, because it manufactures confidence — this is the same
deliberate-failure discipline J6a's review demanded of its email assertions.

### 5.1 Completeness

The existing `test/security/csp.test.ts` enumerates pages by hand, and J6a's
review found it had drifted: it covered eight public pages and no `/g/*` page
at all. An enumeration that can silently omit a page has the same blind spot it
exists to remove. So: a test asserts every GET route the app registers appears
in the catalogue, with an explicit, commented allowlist for the ones that are
deliberately excluded (`/robots.txt`, which is not a page). Adding a route
without cataloguing it fails the suite.

## 6. Tier 2 — journeys, twice

Each journey runs once with JavaScript enabled and once in a
`javaScriptEnabled: false` context. The project's stated policy is that
anything a person *must* do works with JS off, and the JS-off run is what
proves it rather than asserting it.

1. **Sign in** — request link, follow it, land on the dashboard.
2. **Create a game** — `/g/new`, submit, land on the overview.
3. **Invite and join** — open `/j/:token` as a second identity, join, appear in
   the squad.
4. **Respond** — open `/r/:token`, answer in, then out; confirm the change.
5. **Squad management (J6a)** — promote a member, demote and hit the last-owner
   refusal at 422, remove a member holding a place, and confirm the
   consequences on the fixture. This is the walkthrough J6a deferred.

The copy-invite button is JS-only by design and is asserted to be absent (or
inert) in the JS-off run rather than broken.

## 7. Tier 3 — passkeys

Chrome DevTools Protocol's `WebAuthn.addVirtualAuthenticator` makes the
ceremonies testable with no hardware and no OS prompt. Verified working during
this spec's spike. Covers registration on `/app/passkeys` and sign-in with the
registered credential — the two flows the `connect-src` bug broke, and the area
carrying two still-open known-issues rows.

## 8. Tier 4 — visual capture

Screenshots of catalogue pages at 390px and 1280px, written to a gitignored
directory and served for review. This is a judgement aid, not an assertion: no
pixel diffing. It exists so a layout can be *looked at*, which is how the
J6a squad row — three elements in a list item, never seen rendered — gets
checked.

## 9. CI

A **separate job** from `check` in `pr.yml`, not extra steps inside it. A
browser flake must be legible as a browser flake and must never mask a lint,
type or unit failure.

The repository is public and uses standard `ubuntu-latest` runners, so Actions
minutes are unlimited and free; cost is not a constraint, wall-clock is.
`~/.cache/ms-playwright` is cached, keyed on the resolved Playwright version,
and only the chromium headless shell is installed (`--only-shell`).

No GitHub secrets are required: every binding the harness needs is a local-only
dummy value, so they are declared as plain `env:` in the workflow and the suite
runs identically on a fork's pull request.

Playwright's `webServer` option starts `wrangler dev` and waits for it, so the
server's lifecycle is the harness's problem and not a shell script's.

## 10. Testing this harness

The harness is test code, so "how is it tested" has a specific answer: **every
detector must have a proved failure mode.** The console gate has its injected
violation (§5). The catalogue completeness check is proved by confirming it
fails when a route is removed from the catalogue. A journey assertion that
cannot fail is the defect J6a's review found twice, and it is the single most
likely defect in this work.

## 11. Not in this spec

- The visual product guide (`docs/guide/`) — own spec, reuses §4.
- Screenshot diffing / visual regression assertions.
- Cross-browser and mobile-device emulation matrices.
- Testing against production. Production keeps its existing post-deploy smoke
  check; browser tests run against local `wrangler dev`, because writes here
  create real rows and the daily email ceiling is shared and real.
